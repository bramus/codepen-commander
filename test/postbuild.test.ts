import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';
import { validateBrowserUrl } from '../src/utils/browser.js';

const execFileAsync = promisify(execFile);

describe('dist subfolder packaging & CLI smoke tests', () => {
  const rootDir = path.resolve(process.cwd());
  const distDir = path.join(rootDir, 'dist');

  it('prepares a clean publishable ./dist folder with rewritten package.json', async () => {
    const distPkgRaw = await fs.readFile(path.join(distDir, 'package.json'), 'utf8');
    const distPkg = JSON.parse(distPkgRaw) as Record<string, unknown>;

    assert.equal(distPkg.name, 'cdpn');
    assert.equal(distPkg.main, './index.js');
    assert.equal(distPkg.types, './index.d.ts');
    assert.deepEqual(distPkg.bin, { cdpn: 'cli.js' });
    assert.equal('scripts' in distPkg, false);
    assert.equal('devDependencies' in distPkg, false);
    assert.equal(distPkgRaw.includes('./dist/'), false);

    // Essential files copied into ./dist
    assert.ok((await fs.stat(path.join(distDir, 'README.md'))).isFile());
    assert.ok((await fs.stat(path.join(distDir, 'LICENSE'))).isFile());
    assert.ok((await fs.stat(path.join(distDir, 'index.js'))).isFile());
    assert.ok((await fs.stat(path.join(distDir, 'index.d.ts'))).isFile());

    const cliStat = await fs.stat(path.join(distDir, 'cli.js'));
    assert.ok(cliStat.isFile());
    if (process.platform !== 'win32') {
      assert.ok((cliStat.mode & 0o111) !== 0, 'dist/cli.js should be executable');
    }

    // Verify npm publish from ./dist produces no bin auto-correction warnings
    const { stderr } = await execFileAsync('npm', ['publish', '--dry-run'], { cwd: distDir });
    assert.equal(stderr.includes('auto-corrected'), false, `Unexpected npm publish warning: ${stderr}`);
    assert.equal(stderr.includes('was invalid and removed'), false, `npm removed bin entry: ${stderr}`);
  });

  it('executes compiled dist/cli.js --help with all registered commands and global --profile flag', async () => {
    const { stdout } = await execFileAsync(process.execPath, [path.join(distDir, 'cli.js'), '--help']);
    assert.ok(stdout.includes('--profile'), 'Expected CLI help to list global --profile option');
    for (const cmd of [
      'auth',
      'clone',
      'fork',
      'pull',
      'status',
      'push',
      'deploy',
      'undeploy',
      'domains',
      'new',
      'privacy',
      'delete',
      'open',
      'list',
      'versions',
      'rollback',
      'info',
      'settings',
    ]) {
      assert.ok(stdout.includes(cmd), `Expected CLI help to list command "${cmd}"`);
    }

    const { stdout: newHelp } = await execFileAsync(process.execPath, [
      path.join(distDir, 'cli.js'),
      'new',
      '--help',
    ]);
    assert.ok(newHelp.includes('--template'));
    assert.ok(newHelp.includes('--as-template'));
    assert.equal(newHelp.includes('--scaffold'), false);
    assert.equal(newHelp.includes('--files'), false);
    assert.equal(newHelp.includes('--from'), false);

    // `cdpn clone` without mandatory <url> must fail
    await assert.rejects(
      () => execFileAsync(process.execPath, [path.join(distDir, 'cli.js'), 'clone']),
      /missing required argument 'url'/i,
    );

    // `cdpn pull` takes no positional arguments (rejects passing a URL)
    await assert.rejects(
      () =>
        execFileAsync(process.execPath, [
          path.join(distDir, 'cli.js'),
          'pull',
          'https://codepen.io/username/pen/abcde',
        ]),
      /too many arguments/i,
    );

    // `cdpn delete` takes no positional arguments (rejects passing a URL) and supports `del` / `rm` aliases
    await assert.rejects(
      () =>
        execFileAsync(process.execPath, [
          path.join(distDir, 'cli.js'),
          'delete',
          'https://codepen.io/username/pen/abcde',
        ]),
      /too many arguments/i,
    );
    for (const alias of ['del', 'rm']) {
      const { stdout: aliasHelp } = await execFileAsync(process.execPath, [
        path.join(distDir, 'cli.js'),
        alias,
        '--help',
      ]);
      assert.ok(aliasHelp.includes('Usage: cdpn delete'), `Expected "${alias}" to alias "delete"`);
    }

    // `cdpn fork` without mandatory <url> must fail
    await assert.rejects(
      () => execFileAsync(process.execPath, [path.join(distDir, 'cli.js'), 'fork']),
      /missing required argument 'url'/i,
    );

    const { stdout: openHelp } = await execFileAsync(process.execPath, [
      path.join(distDir, 'cli.js'),
      'open',
      '--help',
    ]);
    assert.ok(openHelp.includes('--deploy'), 'Expected open help to include --deploy');
    assert.ok(openHelp.includes('--live'), 'Expected open help to include --live');
    assert.ok(openHelp.includes('--preview'), 'Expected open help to include --preview');

    const { stdout: authHelp } = await execFileAsync(process.execPath, [
      path.join(distDir, 'cli.js'),
      'auth',
      '--help',
    ]);
    for (const sub of ['status', 'list', 'default', 'login', 'logout']) {
      assert.ok(authHelp.includes(sub), `Expected auth help to list subcommand "${sub}"`);
    }
    assert.ok(authHelp.includes('~/.cdpn'), 'Expected auth help to reference ~/.cdpn');
  });

  it('validates browser URLs strictly (HTTPS only, no control chars)', () => {
    assert.equal(
      validateBrowserUrl('https://codepen.io/settings/api'),
      'https://codepen.io/settings/api',
    );
    assert.throws(() => validateBrowserUrl('http://codepen.io/settings/api'), /non-HTTPS/i);
    assert.throws(() => validateBrowserUrl('javascript:alert(1)'), /non-HTTPS/i);
    assert.throws(() => validateBrowserUrl('file:///etc/passwd'), /non-HTTPS/i);
    assert.throws(() => validateBrowserUrl('https://codepen.io/\nfoo'), /control characters/i);
  });
});
