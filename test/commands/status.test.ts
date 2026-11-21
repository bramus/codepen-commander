import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { runStatusCommand } from '../../src/commands/status.js';
import { writeUnlinkedProjectInfo } from '../../src/config/project.js';
import { CliError } from '../../src/errors.js';
import { createBufferedOutput } from '../helpers/output.js';
import { withTempDir } from '../helpers/temp-dir.js';

describe('cdpn status command (unlinked directory guidance)', () => {
  it('offers cdpn clone / cdpn new in an empty directory without .cdpn.json', async () => {
    await withTempDir(async (emptyDir) => {
      await assert.rejects(
        () =>
          runStatusCommand({
            cwd: emptyDir,
            interactive: false,
            env: {},
            output: createBufferedOutput(),
          }),
        (err: unknown) => {
          assert.ok(err instanceof CliError);
          assert.equal(err.statusCode, 404);
          assert.match(err.message, /No \.cdpn\.json found/);
          assert.match(err.message, /`cdpn clone <url>`/);
          assert.match(err.message, /`cdpn new`/);
          assert.doesNotMatch(err.message, /`cdpn init`/);
          return true;
        },
      );
    }, 'cdpn-status-empty-');
  });

  it('offers cdpn init (and not cdpn clone) in a non-empty directory without .cdpn.json', async () => {
    await withTempDir(async (nonEmptyDir) => {
      await fs.writeFile(path.join(nonEmptyDir, 'index.html'), '<h1>Hello</h1>\n', 'utf8');

      await assert.rejects(
        () =>
          runStatusCommand({
            cwd: nonEmptyDir,
            interactive: false,
            env: {},
            output: createBufferedOutput(),
          }),
        (err: unknown) => {
          assert.ok(err instanceof CliError);
          assert.equal(err.statusCode, 404);
          assert.match(err.message, /No \.cdpn\.json found/);
          assert.match(err.message, /`cdpn init`/);
          assert.doesNotMatch(err.message, /cdpn clone/);
          assert.doesNotMatch(err.message, /cdpn new/);
          return true;
        },
      );
    }, 'cdpn-status-nonempty-');
  });

  it('offers cdpn push when directory has an unlinked info-only .cdpn.json', async () => {
    await withTempDir(async (initDir) => {
      await fs.writeFile(path.join(initDir, 'index.html'), '<h1>Initialized</h1>\n', 'utf8');
      await writeUnlinkedProjectInfo(initDir, { title: 'Initialized Demo', access: 'Public' });

      await assert.rejects(
        () =>
          runStatusCommand({
            cwd: initDir,
            interactive: false,
            env: {},
            output: createBufferedOutput(),
          }),
        (err: unknown) => {
          assert.ok(err instanceof CliError);
          assert.equal(err.statusCode, 404);
          assert.match(err.message, /not linked to an online Pen yet/);
          assert.match(err.message, /`cdpn push`/);
          return true;
        },
      );
    }, 'cdpn-status-unlinked-info-');
  });
});
