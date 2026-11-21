import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { Pen } from '../../src/api/types.js';
import { runDeleteCommand } from '../../src/commands/delete.js';
import { runRestoreCommand } from '../../src/commands/restore.js';
import { runStatusCommand } from '../../src/commands/status.js';
import {
  buildSyncedFileMap,
  readProjectConfigFile,
  writeProjectConfig,
  writeUnlinkedProjectInfo,
} from '../../src/config/project.js';
import { saveProfileToFile } from '../../src/config/user-store.js';
import { CliError } from '../../src/errors.js';
import { sha256Hex } from '../../src/sync/fs.js';
import { buildPenInfoConfigFields } from '../../src/sync/info.js';
import { stripAnsi } from '../../src/utils/format.js';
import {
  makePen,
  makePenFile,
  makeTrashItem,
  makeVersion,
  startMockCodePenServer,
  type MockApiServer,
} from '../helpers/mock-codepen-api.js';
import { createBufferedOutput, parseJsonOutput } from '../helpers/output.js';
import { withTempDir } from '../helpers/temp-dir.js';

const API_KEY = 'cp_user_bramus_restore_test_1';
const PEN_ID = 'pen-restore-1';
const OTHER_PEN_ID = 'pen-restore-other';

describe('cdpn restore command & delete -> status -> restore workflow', () => {
  let mock: MockApiServer;
  let penState: 'active' | 'trashed' | 'purged' = 'active';
  let otherState: 'active' | 'trashed' | 'purged' = 'trashed';
  const indexHtml = '<h1>Restore Me</h1>\n';

  before(async () => {
    mock = await startMockCodePenServer((ctx) => {
      if (ctx.headers.authorization !== `Bearer ${API_KEY}`) {
        return { status: 401, body: { code: 'UNAUTHENTICATED', message: 'Invalid key' } };
      }

      if (ctx.method === 'GET' && ctx.pathname === `/v2/pens/${PEN_ID}`) {
        if (penState !== 'active') {
          return { status: 404, body: { code: 'NOT_FOUND', message: 'Not found' } };
        }
        return {
          status: 200,
          body: makePen({
            id: PEN_ID,
            title: 'Restorable Demo',
            saved_version: makeVersion({ id: 'ver-1', pen_id: PEN_ID }),
          }),
        };
      }

      if (ctx.method === 'GET' && ctx.pathname === `/v2/pens/${OTHER_PEN_ID}`) {
        if (otherState !== 'active') {
          return { status: 404, body: { code: 'NOT_FOUND', message: 'Not found' } };
        }
        return {
          status: 200,
          body: makePen({
            id: OTHER_PEN_ID,
            title: 'Other Trashed Demo',
            saved_version: makeVersion({ id: 'ver-o1', pen_id: OTHER_PEN_ID }),
          }),
        };
      }

      if (ctx.method === 'GET' && ctx.pathname === `/v2/pens/${PEN_ID}/files`) {
        if (penState !== 'active') {
          return { status: 404, body: { code: 'NOT_FOUND', message: 'Not found' } };
        }
        return {
          status: 200,
          body: [
            makePenFile('/index.html', indexHtml, {
              id: 'file-1',
              content_hash: sha256Hex(indexHtml),
            }),
            makePenFile('/.codepen/pen.config.json', '{}', {
              id: 'file-cfg',
              content_hash: sha256Hex('{}'),
            }),
          ],
        };
      }

      if (ctx.method === 'DELETE' && ctx.pathname === `/v2/pens/${PEN_ID}`) {
        penState = 'trashed';
        return { status: 204 };
      }

      if (ctx.method === 'GET' && ctx.pathname === '/v2/trash') {
        const items = [];
        if (penState === 'trashed') {
          items.push(
            makeTrashItem({
              id: 'tr-1',
              item_id: PEN_ID,
              title: 'Restorable Demo',
            }),
          );
        }
        if (otherState === 'trashed') {
          items.push(
            makeTrashItem({
              id: 'tr-2',
              item_id: OTHER_PEN_ID,
              title: 'Other Trashed Demo',
            }),
          );
        }
        return { status: 200, body: items };
      }

      if (ctx.method === 'POST' && ctx.pathname === `/v2/pens/${PEN_ID}/restore`) {
        if (penState !== 'trashed') {
          return { status: 404, body: { code: 'NOT_FOUND', message: 'Not in trash' } };
        }
        penState = 'active';
        return {
          status: 200,
          body: makePen({
            id: PEN_ID,
            title: 'Restorable Demo',
            saved_version: makeVersion({ id: 'ver-1', pen_id: PEN_ID }),
          }),
        };
      }

      if (ctx.method === 'POST' && ctx.pathname === `/v2/pens/${OTHER_PEN_ID}/restore`) {
        if (otherState !== 'trashed') {
          return { status: 404, body: { code: 'NOT_FOUND', message: 'Not in trash' } };
        }
        otherState = 'active';
        return {
          status: 200,
          body: makePen({
            id: OTHER_PEN_ID,
            title: 'Other Trashed Demo',
            saved_version: makeVersion({ id: 'ver-o1', pen_id: OTHER_PEN_ID }),
          }),
        };
      }
    });
  });

  after(async () => {
    await mock.close();
  });

  it('supports end-to-end cdpn delete (keeping .cdpn.json & .codepen/) -> cdpn status (in Trash) -> cdpn restore -> cdpn status (up to date)', async () => {
    await withTempDir(async (tmpRoot) => {
      const tmpHome = path.join(tmpRoot, 'home');
      const tmpPen = path.join(tmpRoot, 'demo');
      await fs.mkdir(tmpHome, { recursive: true });
      await fs.mkdir(path.join(tmpPen, '.codepen'), { recursive: true });
      await saveProfileToFile('bramus', API_KEY, { homeDir: tmpHome, setAsDefault: true });

      const pen = makePen({
        id: PEN_ID,
        title: 'Restorable Demo',
        saved_version: makeVersion({ id: 'ver-1', pen_id: PEN_ID }),
      });
      const remoteFiles = [
        makePenFile('/index.html', indexHtml, {
          id: 'file-1',
          content_hash: sha256Hex(indexHtml),
        }),
        makePenFile('/.codepen/pen.config.json', '{}', {
          id: 'file-cfg',
          content_hash: sha256Hex('{}'),
        }),
      ];
      await fs.writeFile(path.join(tmpPen, 'index.html'), indexHtml, 'utf8');
      await fs.writeFile(path.join(tmpPen, '.codepen', 'pen.config.json'), '{}', 'utf8');
      await writeProjectConfig(tmpPen, {
        url: pen.urls.editor,
        pen_id: PEN_ID,
        profile: 'bramus',
        last_synced_version_id: 'ver-1',
        editor: 'V2',
        ...buildPenInfoConfigFields(pen),
        files: buildSyncedFileMap(
          remoteFiles,
          new Map([
            ['/index.html', sha256Hex(indexHtml)],
            ['/.codepen/pen.config.json', sha256Hex('{}')],
          ]),
        ),
      });

      penState = 'active';

      // 1. Default `cdpn delete --yes` moves Pen to Trash while keeping .cdpn.json & .codepen/ intact
      const delOut = createBufferedOutput();
      const delRes = await runDeleteCommand({
        cwd: tmpPen,
        yes: true,
        baseUrl: mock.baseUrl,
        homeDir: tmpHome,
        env: {},
        interactive: false,
        output: delOut,
      });
      assert.ok(delRes);
      assert.equal(delRes.configRemoved, false);
      assert.equal(delRes.codepenDirRemoved, false);
      assert.equal(delRes.configKeptLinked, true);
      assert.equal(penState, 'trashed');
      assert.equal((await readProjectConfigFile(tmpPen)).linked, true);
      assert.ok((await fs.stat(path.join(tmpPen, '.codepen', 'pen.config.json'))).isFile());
      assert.match(stripAnsi(delOut.stdout()), /cdpn restore/);

      // 2. Successive `cdpn status` detects the Pen is in Trash and recommends `cdpn restore`
      await assert.rejects(
        () =>
          runStatusCommand({
            cwd: tmpPen,
            baseUrl: mock.baseUrl,
            homeDir: tmpHome,
            env: {},
            interactive: false,
            output: createBufferedOutput(),
          }),
        (err: unknown) => {
          assert.ok(err instanceof CliError);
          assert.equal(err.statusCode, 404);
          assert.match(err.message, /Deleted Items \(Trash/i);
          assert.match(err.message, /`cdpn restore`/);
          return true;
        },
      );

      // 3. `cdpn restore` restores the Pen online from Trash
      const restoreOut = createBufferedOutput();
      const restored = await runRestoreCommand({
        cwd: tmpPen,
        baseUrl: mock.baseUrl,
        homeDir: tmpHome,
        env: {},
        interactive: false,
        output: restoreOut,
      });
      assert.ok(restored);
      assert.equal(restored.restored, true);
      assert.equal(restored.alreadyActive, false);
      assert.equal(restored.pen.id, PEN_ID);
      assert.equal(penState, 'active');
      assert.match(stripAnsi(restoreOut.stdout()), /Restored Restorable Demo/);

      // 4. Re-running `cdpn restore` when already active is a friendly no-op
      const activeOut = createBufferedOutput();
      const alreadyActive = await runRestoreCommand({
        cwd: tmpPen,
        json: true,
        baseUrl: mock.baseUrl,
        homeDir: tmpHome,
        env: {},
        interactive: false,
        output: activeOut,
      });
      assert.ok(alreadyActive);
      assert.equal(alreadyActive.restored, false);
      assert.equal(alreadyActive.alreadyActive, true);
      const activeEnv = parseJsonOutput<{ restored: boolean; already_active: boolean }>(activeOut);
      assert.equal(activeEnv.status.code, 200);
      assert.equal(activeEnv.contents.restored, false);
      assert.equal(activeEnv.contents.already_active, true);

      // 5. `cdpn status` now succeeds and reports up to date!
      const statusOut = createBufferedOutput();
      const statusRes = await runStatusCommand({
        cwd: tmpPen,
        baseUrl: mock.baseUrl,
        homeDir: tmpHome,
        env: {},
        interactive: false,
        output: statusOut,
      });
      assert.ok(statusRes);
      assert.equal(statusRes.upToDate, true);
    }, 'cdpn-restore-e2e-');
  });

  it('supports explicit <pen> URL/ID, interactive Trash picker outside a Pen folder, and clear errors when missing', async () => {
    await withTempDir(async (tmpRoot) => {
      const tmpHome = path.join(tmpRoot, 'home');
      const emptyDir = path.join(tmpRoot, 'empty');
      const unlinkedDir = path.join(tmpRoot, 'unlinked');
      await fs.mkdir(tmpHome, { recursive: true });
      await fs.mkdir(emptyDir, { recursive: true });
      await fs.mkdir(unlinkedDir, { recursive: true });
      await saveProfileToFile('bramus', API_KEY, { homeDir: tmpHome, setAsDefault: true });

      // 1. Non-interactive outside a Pen folder without <pen> throws CliError(400)
      await assert.rejects(
        () =>
          runRestoreCommand({
            cwd: emptyDir,
            baseUrl: mock.baseUrl,
            homeDir: tmpHome,
            env: {},
            interactive: false,
            output: createBufferedOutput(),
          }),
        (err: unknown) => err instanceof CliError && err.statusCode === 400,
      );

      // 2. Unlinked info-only .cdpn.json without <pen> throws CliError(404)
      await writeUnlinkedProjectInfo(unlinkedDir, { title: 'Unlinked', access: 'Public' });
      await assert.rejects(
        () =>
          runRestoreCommand({
            cwd: unlinkedDir,
            baseUrl: mock.baseUrl,
            homeDir: tmpHome,
            env: {},
            interactive: false,
            output: createBufferedOutput(),
          }),
        (err: unknown) =>
          err instanceof CliError && err.statusCode === 404 && /not linked/i.test(err.message),
      );

      // 3. Explicit URL/ID from outside a Pen folder restores with --json
      otherState = 'trashed';
      const byUrlOut = createBufferedOutput();
      const byUrlRes = await runRestoreCommand({
        penArg: `https://codepen.io/bramus/pen/${OTHER_PEN_ID}`,
        cwd: emptyDir,
        json: true,
        baseUrl: mock.baseUrl,
        homeDir: tmpHome,
        env: {},
        interactive: false,
        output: byUrlOut,
      });
      assert.ok(byUrlRes);
      assert.equal(byUrlRes.restored, true);
      assert.equal(byUrlRes.pen.id, OTHER_PEN_ID);
      assert.equal(otherState, 'active');
      const byUrlEnv = parseJsonOutput<{ pen: Pen; restored: boolean; linked_project: boolean }>(
        byUrlOut,
      );
      assert.equal(byUrlEnv.status.code, 200);
      assert.equal(byUrlEnv.contents.restored, true);
      assert.equal(byUrlEnv.contents.linked_project, false);

      // 4. Interactive Trash picker outside a Pen folder restores chosen Pen
      penState = 'trashed';
      otherState = 'purged';
      const pickerOut = createBufferedOutput();
      let seenChoices: string[] = [];
      const picked = await runRestoreCommand({
        cwd: emptyDir,
        baseUrl: mock.baseUrl,
        homeDir: tmpHome,
        env: {},
        interactive: true,
        output: pickerOut,
        prompts: {
          select: async (_q, opts) => {
            seenChoices = opts.map((o) => o.value);
            return opts[0]!.value;
          },
        },
      });
      assert.deepEqual(seenChoices, [PEN_ID]);
      assert.ok(picked);
      assert.equal(picked.restored, true);
      assert.equal(penState, 'active');

      // 5. Interactive outside a Pen folder when Trash is empty returns null cleanly
      penState = 'purged';
      otherState = 'purged';
      const emptyTrashOut = createBufferedOutput();
      const emptyTrashRes = await runRestoreCommand({
        cwd: emptyDir,
        baseUrl: mock.baseUrl,
        homeDir: tmpHome,
        env: {},
        interactive: true,
        output: emptyTrashOut,
      });
      assert.equal(emptyTrashRes, null);
      assert.match(stripAnsi(emptyTrashOut.stdout()), /No deleted Pens found/);

      // 6. Explicit purged/missing Pen throws CliError(404)
      await assert.rejects(
        () =>
          runRestoreCommand({
            penArg: PEN_ID,
            cwd: emptyDir,
            baseUrl: mock.baseUrl,
            homeDir: tmpHome,
            env: {},
            interactive: false,
            output: createBufferedOutput(),
          }),
        (err: unknown) =>
          err instanceof CliError &&
          err.statusCode === 404 &&
          /not found in CodePen’s Deleted Items/i.test(err.message),
      );
    }, 'cdpn-restore-variants-');
  });
});
