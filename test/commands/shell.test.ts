import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  runShellExportCommand,
  runShellResetCommand,
  runShellSetCommand,
  runShellShowCommand,
} from '../../src/commands/shell.js';
import { getConfiguredShellDir, saveProfileToFile } from '../../src/config/user-store.js';
import { CliError } from '../../src/errors.js';
import { resolveCommandAuth } from '../../src/workflows/auth-context.js';
import { createSilentOutput } from '../helpers/output.js';

describe('cdpn shell (show, export, set, reset)', () => {
  it('shows built-in shell by default, exports to a directory, sets globally in ~/.cdpn, and resets cleanly while preserving auth profiles', async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-shell-cmd-'));
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-shell-home-'));
    const exportDir = path.join(tmpRoot, 'my-custom-shell');
    const output = createSilentOutput();

    try {
      // Seed an auth profile first to verify shell commands never lose profiles
      await saveProfileToFile('bramus', 'cp_user_shelltest12345', { homeDir: tmpHome });

      // 1. Default `shell show` reports built-in
      const initial = await runShellShowCommand({ homeDir: tmpHome, output });
      assert.equal(initial.source, 'builtin');
      assert.equal(initial.exists, true);
      assert.equal(initial.exitCode, undefined);
      assert.ok(initial.files.includes('index.html'));
      assert.ok(initial.files.includes('styles.css'));
      assert.ok(initial.files.includes('scripts.js'));

      // 2. Export built-in shell and pass --set
      const exported = await runShellExportCommand({
        dirArg: 'my-custom-shell',
        cwd: tmpRoot,
        homeDir: tmpHome,
        set: true,
        interactive: false,
        output,
      });
      assert.equal(exported.exported, true);
      assert.equal(exported.configuredGlobally, true);
      assert.deepEqual(exported.copiedFiles.sort(), ['index.html', 'scripts.js', 'styles.css']);
      assert.equal(await getConfiguredShellDir({ homeDir: tmpHome }), exportDir);

      // Auth profile is untouched
      assert.equal(
        (await resolveCommandAuth({ env: {}, homeDir: tmpHome, interactive: false })).profile,
        'bramus',
      );

      // Exporting into non-empty dir without --force/--yes fails with 409 in non-interactive mode
      await assert.rejects(
        () =>
          runShellExportCommand({
            dirArg: 'my-custom-shell',
            cwd: tmpRoot,
            homeDir: tmpHome,
            interactive: false,
            output,
          }),
        (err: unknown) => err instanceof CliError && err.statusCode === 409,
      );

      // 3. `shell show` now reports configured shell
      const configured = await runShellShowCommand({ homeDir: tmpHome, output });
      assert.equal(configured.source, 'config');
      assert.equal(configured.activeDir, exportDir);
      assert.equal(configured.exists, true);
      assert.equal(configured.exitCode, undefined);

      // 4. `shell set` validates shell directory contents (rejects empty dir)
      const emptyDir = path.join(tmpRoot, 'empty-dir');
      await fs.mkdir(emptyDir, { recursive: true });
      await assert.rejects(
        () => runShellSetCommand({ dirArg: emptyDir, cwd: tmpRoot, homeDir: tmpHome, output }),
        (err: unknown) => err instanceof CliError && err.statusCode === 400,
      );

      // Valid custom shell with only styles.css (partial override) succeeds
      const partialDir = path.join(tmpRoot, 'partial-shell');
      await fs.mkdir(partialDir, { recursive: true });
      await fs.writeFile(path.join(partialDir, 'styles.css'), 'body { background: hotpink; }');
      const setRes = await runShellSetCommand({
        dirArg: partialDir,
        cwd: tmpRoot,
        homeDir: tmpHome,
        output,
      });
      assert.equal(setRes.shellDir, partialDir);
      assert.equal(await getConfiguredShellDir({ homeDir: tmpHome }), partialDir);

      // Missing configured shell returns exitCode: 1 without mutating global process.exitCode
      await fs.rm(partialDir, { recursive: true, force: true });
      const missing = await runShellShowCommand({ homeDir: tmpHome, output });
      assert.equal(missing.exists, false);
      assert.equal(missing.exitCode, 1);

      // 5. `shell reset` restores built-in while keeping auth profile intact
      const resetRes = await runShellResetCommand({ homeDir: tmpHome, output });
      assert.equal(resetRes.cleared, true);
      assert.equal(resetRes.fileDeleted, false);
      assert.equal(await getConfiguredShellDir({ homeDir: tmpHome }), null);
      assert.equal(
        (await resolveCommandAuth({ env: {}, homeDir: tmpHome, interactive: false })).profile,
        'bramus',
      );
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
      await fs.rm(tmpHome, { recursive: true, force: true });
    }
  });
});
