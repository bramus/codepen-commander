import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { Pen, PenFile, TrashItem } from '../../src/api/types.js';
import { runStatusCommand } from '../../src/commands/status.js';
import {
  buildSyncedFileMap,
  readProjectConfig,
  writeProjectConfig,
  writeUnlinkedProjectInfo,
} from '../../src/config/project.js';
import { saveProfileToFile } from '../../src/config/user-store.js';
import { PROJECT_CONFIG_FILENAME } from '../../src/constants.js';
import { CliError } from '../../src/errors.js';
import { buildPenInfoConfigFields } from '../../src/sync/info.js';
import { stripAnsi } from '../../src/utils/format.js';
import {
  makeBuild,
  makePen,
  makePenFile,
  makeTrashItem,
  makeVersion,
  startMockCodePenServer,
} from '../helpers/mock-codepen-api.js';
import { createBufferedOutput, parseJsonOutput } from '../helpers/output.js';
import { withTempDir } from '../helpers/temp-dir.js';

const KEY_BRAMUS = 'cp_user_status_batch_1234567890';

function sha256(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

interface RemotePenState {
  pen: Pen;
  files: PenFile[];
  deleted?: boolean;
}

function createPenState(
  id: string,
  title: string,
  files: Record<string, string>,
  versionId = 'ver_1',
): RemotePenState {
  const penFiles = Object.entries(files).map(([p, c]) =>
    makePenFile(p, c, { content_hash: sha256(c) }),
  );
  const version = makeVersion({
    id: versionId,
    pen_id: id,
    build: makeBuild({ version_id: versionId }),
    files: penFiles,
  });
  const pen = makePen({
    id,
    title,
    description: `${title} description`,
    tags: ['status'],
    access: 'Public',
    saved_version: version,
  });
  return { pen, files: penFiles };
}

async function materializeLinkedPen(dir: string, state: RemotePenState): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const localShas = new Map<string, string>();
  for (const file of state.files) {
    const rel = file.path.replace(/^\/+/, '');
    const dest = path.join(dir, rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, file.content ?? '', 'utf8');
    localShas.set(file.path, sha256(file.content ?? ''));
  }
  await writeProjectConfig(dir, {
    url: state.pen.urls.editor,
    pen_id: state.pen.id,
    profile: 'bramus',
    last_synced_version_id: state.pen.saved_version?.id ?? null,
    editor: state.pen.editor,
    ...buildPenInfoConfigFields(state.pen),
    files: buildSyncedFileMap(state.files, localShas),
  });
}

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

describe('cdpn status command (batch tree-walk mode)', () => {
  it('walks subdirectories and reports up-to-date, local-ahead, remote-ahead, conflict, unlinked, trashed (cached), missing, and error states with summary counts and --json', async () => {
    const pens = new Map<string, RemotePenState>();
    const penUp = createPenState('pen_st_up', 'Up Pen', { '/index.html': '<h1>same</h1>\n' });
    const penLocal = createPenState('pen_st_local', 'Local Pen', { '/index.html': '<h1>v1</h1>\n' });
    const penRemote = createPenState('pen_st_remote', 'Remote Pen', { '/index.html': '<h1>v1</h1>\n' });
    const penConflict = createPenState('pen_st_conflict', 'Conflict Pen', {
      '/index.html': '<h1>v1</h1>\n',
    });
    const penTrashed1 = createPenState('pen_st_trash_1', 'Trashed 1', { '/index.html': '<h1>t1</h1>\n' });
    const penTrashed2 = createPenState('pen_st_trash_2', 'Trashed 2', { '/index.html': '<h1>t2</h1>\n' });
    const penMissing = createPenState('pen_st_missing', 'Missing Pen', { '/index.html': '<h1>m</h1>\n' });

    penTrashed1.deleted = true;
    penTrashed2.deleted = true;
    penMissing.deleted = true;

    for (const p of [penUp, penLocal, penRemote, penConflict, penTrashed1, penTrashed2, penMissing]) {
      pens.set(p.pen.id, p);
    }

    const trashItems: TrashItem[] = [
      makeTrashItem({ id: 'tr_1', item_id: 'pen_st_trash_1', title: 'Trashed 1' }),
      makeTrashItem({ id: 'tr_2', item_id: 'pen_st_trash_2', title: 'Trashed 2' }),
    ];
    let trashRequests = 0;

    const server = await startMockCodePenServer((ctx) => {
      if (ctx.method === 'GET' && ctx.pathname === '/v2/trash') {
        trashRequests++;
        return { body: trashItems };
      }

      const penMatch = ctx.pathname.match(/^\/v2\/pens\/([^/]+)$/);
      if (ctx.method === 'GET' && penMatch) {
        const st = pens.get(penMatch[1]!);
        if (!st || st.deleted) {
          return { status: 404, body: { code: 'NOT_FOUND', message: 'Not found' } };
        }
        return { body: st.pen };
      }

      const filesMatch = ctx.pathname.match(/^\/v2\/pens\/([^/]+)\/files$/);
      if (ctx.method === 'GET' && filesMatch) {
        const st = pens.get(filesMatch[1]!);
        if (!st || st.deleted) {
          return { status: 404, body: { code: 'NOT_FOUND', message: 'Not found' } };
        }
        return { body: st.files };
      }

      return undefined;
    });

    try {
      await withTempDir(async (tmpRoot) => {
        const tmpHome = path.join(tmpRoot, 'home');
        const col = path.join(tmpRoot, 'demos');
        await fs.mkdir(tmpHome, { recursive: true });
        await saveProfileToFile('bramus', KEY_BRAMUS, { homeDir: tmpHome, setAsDefault: true });

        await materializeLinkedPen(path.join(col, '01-up'), penUp);
        await materializeLinkedPen(path.join(col, '02-local'), penLocal);
        await materializeLinkedPen(path.join(col, '03-remote'), penRemote);
        await materializeLinkedPen(path.join(col, '04-conflict'), penConflict);
        await materializeLinkedPen(path.join(col, '05-trash-a'), penTrashed1);
        await materializeLinkedPen(path.join(col, '06-trash-b'), penTrashed2);
        await materializeLinkedPen(path.join(col, '07-missing'), penMissing);

        // 08-unlinked: info-only .cdpn.json
        const unlinkedDir = path.join(col, 'nested', '08-unlinked');
        await fs.mkdir(unlinkedDir, { recursive: true });
        await fs.writeFile(path.join(unlinkedDir, 'index.html'), '<h1>Draft</h1>\n', 'utf8');
        await writeUnlinkedProjectInfo(unlinkedDir, { title: 'Local Draft', access: 'Private' });

        // Local edits on 02-local (file + info) and 04-conflict
        await fs.writeFile(path.join(col, '02-local', 'index.html'), '<h1>v2 local</h1>\n', 'utf8');
        const cfgLocal = await readProjectConfig(path.join(col, '02-local'));
        cfgLocal.info = { ...cfgLocal.info, title: 'Renamed Locally' };
        await writeProjectConfig(path.join(col, '02-local'), cfgLocal);

        await fs.writeFile(
          path.join(col, '04-conflict', 'index.html'),
          '<h1>local conflict</h1>\n',
          'utf8',
        );

        // Remote edits on 03-remote and 04-conflict
        for (const st of [penRemote, penConflict]) {
          const content = '<h1>remote v2</h1>\n';
          const files = [makePenFile('/index.html', content, { content_hash: sha256(content) })];
          const v2 = makeVersion({
            id: 'ver_2',
            pen_id: st.pen.id,
            build: makeBuild({ version_id: 'ver_2' }),
            files,
          });
          st.files = files;
          st.pen = { ...st.pen, saved_version: v2 };
        }

        // 1. Human-readable batch status (no errors -> exitCode undefined)
        const out = createBufferedOutput();
        const res = await runStatusCommand({
          cwd: col,
          baseUrl: server.baseUrl,
          interactive: false,
          env: {},
          homeDir: tmpHome,
          output: out,
        });

        assert.ok(res?.batch);
        assert.equal(res.exitCode, undefined);
        assert.equal(res.upToDate, false);
        assert.equal(res.remoteMoved, true);
        assert.deepEqual(res.batch.counts, {
          discovered: 8,
          upToDate: 1,
          localAhead: 1,
          remoteAhead: 1,
          unlinked: 1,
          conflicts: 1,
          inTrash: 2,
          missing: 1,
          errors: 0,
        });
        // Trash endpoint should only be queried ONCE across all 3 missing/trashed Pens!
        assert.equal(trashRequests, 1);

        const text = stripAnsi(out.stdout());
        assert.match(text, /\[UP TO DATE\]\s+01-up/);
        assert.match(text, /\[LOCAL AHEAD\]\s+02-local/);
        assert.match(text, /info\.title:/);
        assert.match(text, /\[REMOTE AHEAD\]\s+03-remote/);
        assert.match(text, /\[CONFLICT\]\s+04-conflict/);
        assert.match(text, /\[IN TRASH\]\s+05-trash-a/);
        assert.match(text, /\[IN TRASH\]\s+06-trash-b/);
        assert.match(text, /\[MISSING\]\s+07-missing/);
        assert.match(text, /\[UNLINKED\]\s+nested\/08-unlinked/);
        assert.match(text, /Summary \(status\):/);
        assert.match(text, /Found:\s+8/);
        assert.match(text, /In Trash:\s+2/);
        assert.match(text, /Missing:\s+1/);
        assert.match(text, /cdpn restore/);
        assert.match(text, /cdpn sync/);

        // 2. Add a malformed `.cdpn.json` -> reported as error with exitCode 1 and JSON status 500
        const brokenDir = path.join(col, '09-broken');
        await fs.mkdir(brokenDir, { recursive: true });
        await fs.writeFile(path.join(brokenDir, PROJECT_CONFIG_FILENAME), '{ broken', 'utf8');

        const jsonOut = createBufferedOutput();
        const jsonRes = await runStatusCommand({
          cwd: col,
          json: true,
          baseUrl: server.baseUrl,
          interactive: false,
          env: {},
          homeDir: tmpHome,
          output: jsonOut,
        });

        assert.equal(jsonRes?.exitCode, 1);
        assert.equal(jsonRes?.batch?.counts.errors, 1);
        const env = parseJsonOutput<{
          batch: boolean;
          mode: string;
          up_to_date: boolean;
          counts: Record<string, number>;
          results: Array<{ path: string; state: string }>;
        }>(jsonOut);
        assert.equal(env.status.code, 500);
        assert.equal(env.contents.batch, true);
        assert.equal(env.contents.mode, 'status');
        assert.equal(env.contents.up_to_date, false);
        assert.equal(env.contents.counts.discovered, 9);
        assert.equal(env.contents.counts.in_trash, 2);
        assert.equal(env.contents.counts.missing, 1);
        assert.equal(env.contents.counts.errors, 1);
        assert.equal(
          env.contents.results.find((r) => r.path === '09-broken')?.state,
          'error',
        );

        // 3. Purely up-to-date tree -> upToDate: true, JSON status 200, exitCode undefined
        const cleanCol = path.join(tmpRoot, 'clean-demos');
        await materializeLinkedPen(path.join(cleanCol, 'only-up'), penUp);
        const cleanJsonOut = createBufferedOutput();
        const cleanRes = await runStatusCommand({
          cwd: cleanCol,
          json: true,
          baseUrl: server.baseUrl,
          interactive: false,
          env: {},
          homeDir: tmpHome,
          output: cleanJsonOut,
        });
        assert.equal(cleanRes?.upToDate, true);
        assert.equal(cleanRes?.remoteMoved, false);
        assert.equal(cleanRes?.exitCode, undefined);
        const cleanEnv = parseJsonOutput<{ up_to_date: boolean; counts: { up_to_date: number } }>(
          cleanJsonOut,
        );
        assert.equal(cleanEnv.status.code, 200);
        assert.equal(cleanEnv.contents.up_to_date, true);
        assert.equal(cleanEnv.contents.counts.up_to_date, 1);

        // Never made any mutating API calls across all status runs
        assert.equal(
          server.requests.some((r) => r.method !== 'GET'),
          false,
        );
      }, 'cdpn-status-batch-');
    } finally {
      await server.close();
    }
  });
});
