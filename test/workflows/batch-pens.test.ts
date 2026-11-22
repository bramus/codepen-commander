import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { Pen, PenFile, Version } from '../../src/api/types.js';
import { runDeleteCommand } from '../../src/commands/delete.js';
import { runPullCommand } from '../../src/commands/pull.js';
import { runPushCommand } from '../../src/commands/push.js';
import { runSyncCommand } from '../../src/commands/sync.js';
import { runUnlinkCommand } from '../../src/commands/unlink.js';
import {
  buildSyncedFileMap,
  readProjectConfig,
  readProjectConfigFile,
  writeProjectConfig,
  writeUnlinkedProjectInfo,
} from '../../src/config/project.js';
import { saveProfileToFile } from '../../src/config/user-store.js';
import { CODEPEN_DIR, PROJECT_CONFIG_FILENAME } from '../../src/constants.js';
import { CliError } from '../../src/errors.js';
import { buildPenInfoConfigFields } from '../../src/sync/info.js';
import { stripAnsi } from '../../src/utils/format.js';
import { discoverPenDirectories } from '../../src/workflows/discover-pens.js';
import {
  makeBuild,
  makePen,
  makePenFile,
  makeVersion,
  startMockCodePenServer,
} from '../helpers/mock-codepen-api.js';
import { createBufferedOutput, createSilentOutput, parseJsonOutput } from '../helpers/output.js';
import { withTempDir } from '../helpers/temp-dir.js';

const KEY_BRAMUS = 'cp_user_batch_test_1234567890';

function sha256(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

interface RemotePenState {
  pen: Pen;
  files: PenFile[];
  versions: Map<string, Version>;
  deleted: boolean;
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
    tags: ['batch'],
    access: 'Public',
    saved_version: version,
  });
  return {
    pen,
    files: penFiles,
    versions: new Map([[versionId, version]]),
    deleted: false,
  };
}

async function materializeLinkedPen(
  dir: string,
  state: RemotePenState,
  options: { withCodepenDir?: boolean; profile?: string } = {},
): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const localShas = new Map<string, string>();
  for (const file of state.files) {
    const rel = file.path.replace(/^\/+/, '');
    const dest = path.join(dir, rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, file.content ?? '', 'utf8');
    localShas.set(file.path, sha256(file.content ?? ''));
  }
  if (options.withCodepenDir) {
    await fs.mkdir(path.join(dir, CODEPEN_DIR), { recursive: true });
    await fs.writeFile(
      path.join(dir, CODEPEN_DIR, 'pen.config.json'),
      JSON.stringify({ blocks: ['validate', 'fingerprint'] }, null, 2),
      'utf8',
    );
  }
  await writeProjectConfig(dir, {
    url: state.pen.urls.editor,
    pen_id: state.pen.id,
    profile: options.profile ?? 'bramus',
    last_synced_version_id: state.pen.saved_version?.id ?? null,
    editor: state.pen.editor,
    ...buildPenInfoConfigFields(state.pen),
    files: buildSyncedFileMap(state.files, localShas),
  });
}

async function startMultiPenMockServer(pens: Map<string, RemotePenState>) {
  let versionCounter = 10;
  let createCounter = 0;

  return startMockCodePenServer((ctx) => {
    const getPenMatch = ctx.pathname.match(/^\/v2\/pens\/([^/]+)$/);
    if (getPenMatch) {
      const id = getPenMatch[1]!;
      const st = pens.get(id);
      if (!st || st.deleted) {
        return { status: 404, body: { code: 'NOT_FOUND', message: 'Pen not found' } };
      }
      if (ctx.method === 'GET') {
        return { body: st.pen };
      }
      if (ctx.method === 'DELETE') {
        st.deleted = true;
        return { status: 204 };
      }
      if (ctx.method === 'PATCH') {
        const body = ctx.jsonBody();
        if (typeof body.title === 'string') st.pen = { ...st.pen, title: body.title };
        if (typeof body.description === 'string')
          st.pen = { ...st.pen, description: body.description };
        if (Array.isArray(body.tags)) st.pen = { ...st.pen, tags: body.tags as string[] };
        if (typeof body.access === 'string')
          st.pen = { ...st.pen, access: body.access as Pen['access'] };
        return { body: st.pen };
      }
    }

    const filesMatch = ctx.pathname.match(/^\/v2\/pens\/([^/]+)\/files$/);
    if (filesMatch) {
      const id = filesMatch[1]!;
      const st = pens.get(id);
      if (!st || st.deleted) {
        return { status: 404, body: { code: 'NOT_FOUND', message: 'Pen not found' } };
      }
      if (ctx.method === 'GET') {
        return { body: st.files };
      }
      if (ctx.method === 'PUT') {
        const body = ctx.jsonBody();
        const isDryRun = Boolean(body.dry_run);
        const nextFilesMap = new Map(st.files.map((f) => [f.path, f]));
        const changes =
          (body.files as Array<{ path: string; content?: string; delete?: boolean }>) ?? [];
        for (const ch of changes) {
          const p = ch.path.startsWith('/') ? ch.path : `/${ch.path}`;
          if (ch.delete) {
            nextFilesMap.delete(p);
          } else {
            const content = ch.content ?? '';
            nextFilesMap.set(p, makePenFile(p, content, { content_hash: sha256(content) }));
          }
        }
        const nextFiles = [...nextFilesMap.values()];
        const verId = isDryRun ? `ver_dry_${++versionCounter}` : `ver_${++versionCounter}`;
        const build = makeBuild({ id: `bld_${versionCounter}`, version_id: verId });
        const version = makeVersion({ id: verId, pen_id: id, build, files: nextFiles });
        if (!isDryRun) {
          st.files = nextFiles;
          st.versions.set(verId, version);
          st.pen = { ...st.pen, saved_version: version };
        }
        return { body: { pen: st.pen, version, build } };
      }
    }

    const verMatch = ctx.pathname.match(/^\/v2\/versions\/([^/]+)$/);
    if (ctx.method === 'GET' && verMatch) {
      for (const st of pens.values()) {
        const v = st.versions.get(verMatch[1]!);
        if (v) return { body: v };
      }
      return { status: 404, body: { code: 'NOT_FOUND', message: 'Version not found' } };
    }

    if (ctx.method === 'POST' && ctx.pathname === '/v2/pens') {
      const body = ctx.jsonBody();
      const id = `pen_new_${++createCounter}`;
      const reqFiles = (body.files as Array<{ path: string; content: string }>) ?? [];
      const fileMap: Record<string, string> = {};
      for (const f of reqFiles) {
        fileMap[f.path] = f.content;
      }
      const st = createPenState(id, String(body.title ?? 'Untitled'), fileMap, `ver_new_${createCounter}`);
      st.pen = {
        ...st.pen,
        access: (body.access as Pen['access']) ?? 'Public',
        description: String(body.description ?? ''),
        tags: Array.isArray(body.tags) ? (body.tags as string[]) : [],
      };
      pens.set(id, st);
      return {
        status: 201,
        body: {
          ...st.pen,
          build: st.pen.saved_version?.build,
        },
      };
    }

    if (ctx.method === 'GET' && ctx.pathname === '/v2/trash') {
      return { body: { items: [], next_cursor: null } };
    }

    return undefined;
  });
}

describe('discoverPenDirectories (symlink-safe recursive tree walk)', () => {
  it('discovers nested linked/unlinked Pens deterministically while skipping symlinks, hidden/ignored dirs, node_modules, built sites, and Pen interiors', async () => {
    await withTempDir(async (tmpRoot) => {
      const collection = path.join(tmpRoot, 'collection');
      const outside = path.join(tmpRoot, 'outside-pen');
      await fs.mkdir(collection, { recursive: true });
      await fs.mkdir(outside, { recursive: true });

      // Outside Pen pointed to by symlink (must NEVER be followed)
      await writeUnlinkedProjectInfo(outside, { title: 'Outside Escaping Pen' });

      // Regular Pens at multiple depths
      const penA = path.join(collection, 'alpha');
      const penNested = path.join(collection, 'group', 'sub', 'beta');
      const penCorrupt = path.join(collection, 'group', 'broken');
      const penInsidePen = path.join(penA, 'nested-child');
      await fs.mkdir(penA, { recursive: true });
      await fs.mkdir(penNested, { recursive: true });
      await fs.mkdir(penCorrupt, { recursive: true });
      await fs.mkdir(penInsidePen, { recursive: true });

      await writeProjectConfig(penA, {
        url: 'https://codepen.io/bramus/pen/p1',
        pen_id: 'p1',
        last_synced_version_id: 'v1',
        info: { title: 'Alpha' },
      });
      // Must NOT descend inside penA to find penInsidePen
      await writeUnlinkedProjectInfo(penInsidePen, { title: 'Should Be Ignored' });

      await writeUnlinkedProjectInfo(penNested, { title: 'Beta Unlinked' });
      await fs.writeFile(path.join(penCorrupt, PROJECT_CONFIG_FILENAME), '{ invalid json', 'utf8');

      // Directories that must be skipped: hidden, node_modules, .cdpnignore, built collection output, symlinks
      const hiddenPen = path.join(collection, '.hidden-pen');
      const nmPen = path.join(collection, 'node_modules', 'pkg-pen');
      const ignoredPen = path.join(collection, 'ignored-dir', 'skip-me');
      const builtDir = path.join(collection, 'dist');
      const builtSubPen = path.join(builtDir, 'sub-pen');
      await fs.mkdir(hiddenPen, { recursive: true });
      await fs.mkdir(nmPen, { recursive: true });
      await fs.mkdir(ignoredPen, { recursive: true });
      await fs.mkdir(builtSubPen, { recursive: true });

      await writeUnlinkedProjectInfo(hiddenPen, { title: 'Hidden' });
      await writeUnlinkedProjectInfo(nmPen, { title: 'Node Modules' });
      await writeUnlinkedProjectInfo(ignoredPen, { title: 'Ignored' });
      await fs.writeFile(path.join(collection, '.cdpnignore'), 'ignored-dir\n', 'utf8');

      await fs.writeFile(path.join(builtDir, 'index.html'), '<h1>Built</h1>', 'utf8');
      await fs.writeFile(path.join(builtDir, 'demos.json'), '{}', 'utf8');
      await writeUnlinkedProjectInfo(builtSubPen, { title: 'Inside Built' });

      await fs.symlink(outside, path.join(collection, 'symlink-outside'));
      await fs.symlink(penNested, path.join(collection, 'symlink-internal'));

      const discovered = await discoverPenDirectories(collection);
      assert.deepEqual(
        discovered.map((d) => d.relPath),
        ['alpha', 'group/broken', 'group/sub/beta'],
      );
      assert.equal(discovered[0]!.parsed?.linked, true);
      assert.ok(discovered[1]!.parseError);
      assert.equal(discovered[2]!.parsed?.linked, false);
    });
  });
});

describe('batch tree-walk push, pull, and sync', () => {
  it('walks tree for push (--dry-run, real run, --force, --json) and reports summary counts', async () => {
    const pens = new Map<string, RemotePenState>();
    const penUp = createPenState('pen_up', 'Up To Date', { '/index.html': '<h1>same</h1>\n' });
    const penLocal = createPenState('pen_local', 'Local Ahead', { '/index.html': '<h1>v1</h1>\n' });
    const penRemote = createPenState('pen_remote', 'Remote Ahead', { '/index.html': '<h1>v1</h1>\n' });
    const penConflict = createPenState('pen_conflict', 'Conflict', { '/index.html': '<h1>v1</h1>\n' });
    pens.set(penUp.pen.id, penUp);
    pens.set(penLocal.pen.id, penLocal);
    pens.set(penRemote.pen.id, penRemote);
    pens.set(penConflict.pen.id, penConflict);

    const server = await startMultiPenMockServer(pens);
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

        // 05-unlinked: info-only .cdpn.json
        const unlinkedDir = path.join(col, 'group', '05-unlinked');
        await fs.mkdir(unlinkedDir, { recursive: true });
        await fs.writeFile(path.join(unlinkedDir, 'index.html'), '<h1>Unlinked</h1>\n', 'utf8');
        await writeUnlinkedProjectInfo(unlinkedDir, { title: 'New Batch Pen', access: 'Private' });

        // Local edits on 02-local & 04-conflict
        await fs.writeFile(path.join(col, '02-local', 'index.html'), '<h1>v2 local</h1>\n', 'utf8');
        await fs.writeFile(
          path.join(col, '04-conflict', 'index.html'),
          '<h1>local conflict</h1>\n',
          'utf8',
        );

        // Remote edits on 03-remote & 04-conflict
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
          st.versions.set('ver_2', v2);
          st.pen = { ...st.pen, saved_version: v2 };
        }

        // Passing --title in batch push is rejected
        await assert.rejects(
          () =>
            runPushCommand({
              cwd: col,
              target: 'all',
              title: 'Invalid Shared Title',
              baseUrl: server.baseUrl,
              interactive: false,
              env: {},
              homeDir: tmpHome,
              output: createSilentOutput(),
            }),
          (err: unknown) => err instanceof CliError && err.statusCode === 400,
        );

        // 1. Batch push --dry-run makes zero mutations and reports counts
        const reqBeforeDry = server.requests.length;
        const dryOut = createBufferedOutput();
        const dryRes = await runPushCommand({
          cwd: col,
          target: 'all',
          dryRun: true,
          baseUrl: server.baseUrl,
          interactive: false,
          env: {},
          homeDir: tmpHome,
          output: dryOut,
        });
        assert.equal(dryRes.dryRun, true);
        assert.equal(dryRes.exitCode, undefined);
        assert.deepEqual(dryRes.batch?.counts, {
          discovered: 5,
          created: 1,
          pushed: 1,
          pulled: 0,
          deleted: 0,
          unlinked: 0,
          upToDate: 1,
          skipped: 1,
          conflicts: 1,
          errors: 0,
        });
        assert.equal(
          server.requests.slice(reqBeforeDry).some((r) => r.method !== 'GET'),
          false,
        );
        const dryText = stripAnsi(dryOut.stdout());
        assert.match(dryText, /\[DRY RUN\] Summary \(push\):/);
        assert.match(dryText, /Found:\s+5/);
        assert.match(dryText, /Created:\s+1/);
        assert.match(dryText, /Pushed:\s+1/);
        assert.match(dryText, /Conflicts:\s+1/);

        // 2. Real batch push --json: creates unlinked, pushes local-ahead, skips remote-ahead, flags conflict (exitCode 1)
        const jsonOut = createBufferedOutput();
        const realRes = await runPushCommand({
          cwd: col,
          target: 'all',
          json: true,
          baseUrl: server.baseUrl,
          interactive: false,
          env: {},
          homeDir: tmpHome,
          output: jsonOut,
        });
        assert.equal(realRes.exitCode, 1);
        assert.equal(realRes.batch?.counts.created, 1);
        assert.equal(realRes.batch?.counts.pushed, 1);
        assert.equal(realRes.batch?.counts.upToDate, 1);
        assert.equal(realRes.batch?.counts.skipped, 1);
        assert.equal(realRes.batch?.counts.conflicts, 1);
        const env = parseJsonOutput<{
          batch: boolean;
          mode: string;
          counts: Record<string, number>;
          results: Array<{ path: string; action: string }>;
        }>(jsonOut);
        assert.equal(env.status.code, 409);
        assert.equal(env.contents.batch, true);
        assert.equal(env.contents.mode, 'push');
        assert.equal(env.contents.counts.created, 1);
        assert.equal(env.contents.counts.pushed, 1);
        assert.equal((await readProjectConfigFile(unlinkedDir)).linked, true);
        assert.equal(
          penLocal.files.find((f) => f.path === '/index.html')?.content,
          '<h1>v2 local</h1>\n',
        );

        // 3. Batch push --force overwrites remote-ahead and conflict Pens cleanly (exitCode undefined)
        const forceRes = await runPushCommand({
          cwd: col,
          target: 'all',
          force: true,
          baseUrl: server.baseUrl,
          interactive: false,
          env: {},
          homeDir: tmpHome,
          output: createSilentOutput(),
        });
        assert.equal(forceRes.exitCode, undefined);
        assert.equal(forceRes.batch?.counts.pushed, 2);
        assert.equal(forceRes.batch?.counts.upToDate, 3);
        assert.equal(
          penConflict.files.find((f) => f.path === '/index.html')?.content,
          '<h1>local conflict</h1>\n',
        );
      });
    } finally {
      await server.close();
    }
  });

  it('walks tree for pull & sync (--dry-run, real run, --force, --json) and supports single-Pen pull --dry-run', async () => {
    const pens = new Map<string, RemotePenState>();
    const penUp = createPenState('pen_s_up', 'Up', { '/index.html': '<h1>same</h1>\n' });
    const penLocal = createPenState('pen_s_local', 'Local', { '/index.html': '<h1>v1</h1>\n' });
    const penRemote = createPenState('pen_s_remote', 'Remote', { '/index.html': '<h1>v1</h1>\n' });
    const penConflict = createPenState('pen_s_conflict', 'Conflict', { '/index.html': '<h1>v1</h1>\n' });
    pens.set(penUp.pen.id, penUp);
    pens.set(penLocal.pen.id, penLocal);
    pens.set(penRemote.pen.id, penRemote);
    pens.set(penConflict.pen.id, penConflict);

    const server = await startMultiPenMockServer(pens);
    try {
      await withTempDir(async (tmpRoot) => {
        const tmpHome = path.join(tmpRoot, 'home');
        const col = path.join(tmpRoot, 'demos');
        await fs.mkdir(tmpHome, { recursive: true });
        await saveProfileToFile('bramus', KEY_BRAMUS, { homeDir: tmpHome, setAsDefault: true });

        await materializeLinkedPen(path.join(col, 'a-up'), penUp);
        await materializeLinkedPen(path.join(col, 'b-local'), penLocal);
        await materializeLinkedPen(path.join(col, 'c-remote'), penRemote);
        await materializeLinkedPen(path.join(col, 'd-conflict'), penConflict);
        const unlinkedDir = path.join(col, 'e-unlinked');
        await fs.mkdir(unlinkedDir, { recursive: true });
        await fs.writeFile(path.join(unlinkedDir, 'index.html'), '<h1>New</h1>\n', 'utf8');
        await writeUnlinkedProjectInfo(unlinkedDir, { title: 'Sync Created' });

        await fs.writeFile(path.join(col, 'b-local', 'index.html'), '<h1>local edit</h1>\n', 'utf8');
        await fs.writeFile(
          path.join(col, 'd-conflict', 'index.html'),
          '<h1>local conflict</h1>\n',
          'utf8',
        );

        for (const st of [penRemote, penConflict]) {
          const content = '<h1>remote updated</h1>\n';
          const files = [makePenFile('/index.html', content, { content_hash: sha256(content) })];
          const v2 = makeVersion({
            id: 'ver_2',
            pen_id: st.pen.id,
            build: makeBuild({ version_id: 'ver_2' }),
            files,
          });
          st.files = files;
          st.versions.set('ver_2', v2);
          st.pen = { ...st.pen, saved_version: v2 };
        }

        // 1. Single-Pen pull --dry-run inside c-remote leaves disk untouched
        const singlePullDryOut = createBufferedOutput();
        const singlePullDry = await runPullCommand({
          cwd: path.join(col, 'c-remote'),
          dryRun: true,
          json: true,
          baseUrl: server.baseUrl,
          interactive: false,
          env: {},
          homeDir: tmpHome,
          output: singlePullDryOut,
        });
        assert.ok(singlePullDry);
        assert.equal(singlePullDry.dryRun, true);
        assert.deepEqual(singlePullDry.writtenPaths, ['/index.html']);
        assert.equal(
          await fs.readFile(path.join(col, 'c-remote', 'index.html'), 'utf8'),
          '<h1>v1</h1>\n',
        );
        const spEnv = parseJsonOutput<{ dry_run: boolean; written_paths: string[] }>(singlePullDryOut);
        assert.equal(spEnv.contents.dry_run, true);
        assert.deepEqual(spEnv.contents.written_paths, ['/index.html']);

        // 2. Batch pull all --dry-run from collection root
        const pullDryOut = createBufferedOutput();
        const pullDry = await runPullCommand({
          cwd: col,
          target: 'all',
          dryRun: true,
          baseUrl: server.baseUrl,
          interactive: false,
          env: {},
          homeDir: tmpHome,
          output: pullDryOut,
        });
        assert.ok(pullDry?.batch);
        assert.equal(pullDry.batch.counts.discovered, 5);
        assert.equal(pullDry.batch.counts.pulled, 1);
        assert.equal(pullDry.batch.counts.upToDate, 1);
        assert.equal(pullDry.batch.counts.skipped, 2); // b-local + e-unlinked
        assert.equal(pullDry.batch.counts.conflicts, 1);
        assert.equal(
          await fs.readFile(path.join(col, 'c-remote', 'index.html'), 'utf8'),
          '<h1>v1</h1>\n',
        );

        // 3. Batch sync all --dry-run previews push + pull + create + conflict with zero mutations
        const syncDry = await runSyncCommand({
          cwd: col,
          target: 'all',
          dryRun: true,
          baseUrl: server.baseUrl,
          interactive: false,
          env: {},
          homeDir: tmpHome,
          output: createSilentOutput(),
        });
        assert.equal(syncDry.mode, 'batch');
        assert.equal(syncDry.exitCode, undefined);
        assert.deepEqual(syncDry.batch?.counts, {
          discovered: 5,
          created: 1,
          pushed: 1,
          pulled: 1,
          deleted: 0,
          unlinked: 0,
          upToDate: 1,
          skipped: 0,
          conflicts: 1,
          errors: 0,
        });

        // 4. Real batch sync all executes push + pull + create and reports conflict (exitCode 1)
        const syncOut = createBufferedOutput();
        const syncReal = await runSyncCommand({
          cwd: col,
          target: 'all',
          baseUrl: server.baseUrl,
          interactive: false,
          env: {},
          homeDir: tmpHome,
          output: syncOut,
        });
        assert.equal(syncReal.exitCode, 1);
        assert.equal(syncReal.batch?.counts.created, 1);
        assert.equal(syncReal.batch?.counts.pushed, 1);
        assert.equal(syncReal.batch?.counts.pulled, 1);
        assert.equal(syncReal.batch?.counts.upToDate, 1);
        assert.equal(syncReal.batch?.counts.conflicts, 1);
        assert.equal(
          penLocal.files.find((f) => f.path === '/index.html')?.content,
          '<h1>local edit</h1>\n',
        );
        assert.equal(
          await fs.readFile(path.join(col, 'c-remote', 'index.html'), 'utf8'),
          '<h1>remote updated</h1>\n',
        );
        assert.equal((await readProjectConfigFile(unlinkedDir)).linked, true);
        assert.match(stripAnsi(syncOut.stdout()), /Summary \(sync\):/);

        // 5. Batch pull all --force resolves remaining conflict from remote
        const pullForce = await runPullCommand({
          cwd: col,
          target: 'all',
          force: true,
          baseUrl: server.baseUrl,
          interactive: false,
          env: {},
          homeDir: tmpHome,
          output: createSilentOutput(),
        });
        assert.equal(pullForce?.exitCode, undefined);
        assert.equal(pullForce?.batch?.counts.pulled, 5);
        assert.equal(
          await fs.readFile(path.join(col, 'd-conflict', 'index.html'), 'utf8'),
          '<h1>remote updated</h1>\n',
        );
      });
    } finally {
      await server.close();
    }
  });
});

describe('batch tree-walk delete and unlink (upfront double confirmation & --dry-run)', () => {
  it('enforces two-step confirmation ("Are you really sure?") for batch delete, supports --dry-run, default keep, --cleanup, and --full-cleanup', async () => {
    const pens = new Map<string, RemotePenState>();
    const p1 = createPenState('pen_del_1', 'Del One', { '/index.html': '<h1>1</h1>\n' });
    const p2 = createPenState('pen_del_2', 'Del Two', { '/index.html': '<h1>2</h1>\n' });
    pens.set(p1.pen.id, p1);
    pens.set(p2.pen.id, p2);

    const server = await startMultiPenMockServer(pens);
    try {
      await withTempDir(async (tmpRoot) => {
        const tmpHome = path.join(tmpRoot, 'home');
        const col = path.join(tmpRoot, 'demos');
        await fs.mkdir(tmpHome, { recursive: true });
        await saveProfileToFile('bramus', KEY_BRAMUS, { homeDir: tmpHome, setAsDefault: true });

        const dir1 = path.join(col, 'pen-one');
        const dir2 = path.join(col, 'nested', 'pen-two');
        const dirUnlinked = path.join(col, 'pen-unlinked');

        const resetFixtures = async () => {
          p1.deleted = false;
          p2.deleted = false;
          await fs.rm(col, { recursive: true, force: true });
          await materializeLinkedPen(dir1, p1, { withCodepenDir: true });
          await materializeLinkedPen(dir2, p2, { withCodepenDir: true });
          await fs.mkdir(dirUnlinked, { recursive: true });
          await fs.writeFile(path.join(dirUnlinked, 'index.html'), '<h1>U</h1>\n', 'utf8');
          await writeUnlinkedProjectInfo(dirUnlinked, { title: 'Already Unlinked' });
        };

        await resetFixtures();

        // 1. Single-Pen delete --dry-run makes zero DELETE calls and does not prompt
        const reqBeforeSingleDry = server.requests.length;
        const singleDryOut = createBufferedOutput();
        const singleDry = await runDeleteCommand({
          cwd: dir1,
          dryRun: true,
          json: true,
          baseUrl: server.baseUrl,
          interactive: false,
          env: {},
          homeDir: tmpHome,
          output: singleDryOut,
        });
        assert.equal(singleDry?.dryRun, true);
        assert.equal(p1.deleted, false);
        assert.equal(
          server.requests.slice(reqBeforeSingleDry).some((r) => r.method === 'DELETE'),
          false,
        );
        const sdEnv = parseJsonOutput<{ dry_run: boolean; deleted: boolean; would_delete: boolean }>(
          singleDryOut,
        );
        assert.equal(sdEnv.contents.dry_run, true);
        assert.equal(sdEnv.contents.deleted, false);
        assert.equal(sdEnv.contents.would_delete, true);

        // 2. Non-interactive batch delete all without --yes rejects with 400 and zero DELETE calls
        await assert.rejects(
          () =>
            runDeleteCommand({
              cwd: col,
              target: 'all',
              baseUrl: server.baseUrl,
              interactive: false,
              env: {},
              homeDir: tmpHome,
              output: createSilentOutput(),
            }),
          (err: unknown) => err instanceof CliError && err.statusCode === 400,
        );
        assert.equal(p1.deleted, false);
        assert.equal(p2.deleted, false);

        // 3. Batch delete all --dry-run skips confirmation, makes zero DELETE calls, reports counts
        const reqBeforeBatchDry = server.requests.length;
        const dryOut = createBufferedOutput();
        const dryRes = await runDeleteCommand({
          cwd: col,
          target: 'all',
          dryRun: true,
          baseUrl: server.baseUrl,
          interactive: false,
          env: {},
          homeDir: tmpHome,
          output: dryOut,
        });
        assert.equal(dryRes?.dryRun, true);
        assert.equal(dryRes?.batch?.counts.discovered, 3);
        assert.equal(dryRes?.batch?.counts.deleted, 2);
        assert.equal(dryRes?.batch?.counts.skipped, 1);
        assert.equal(server.requests.length, reqBeforeBatchDry);
        assert.match(stripAnsi(dryOut.stdout()), /\[DRY RUN\] Summary \(delete\):/);

        // 4. First confirmation declined (No) -> bails immediately without asking "Are you really sure?"
        const prompts1: Array<{ q: string; def?: boolean }> = [];
        const abort1 = await runDeleteCommand({
          cwd: col,
          target: 'all',
          baseUrl: server.baseUrl,
          interactive: true,
          env: {},
          homeDir: tmpHome,
          output: createSilentOutput(),
          prompts: {
            confirm: async (q, def) => {
              prompts1.push({ q, def });
              return false;
            },
          },
        });
        assert.equal(abort1, null);
        assert.equal(prompts1.length, 1);
        assert.equal(prompts1[0]!.def, false);
        assert.equal(p1.deleted, false);
        assert.equal(p2.deleted, false);

        // 5. First confirmation Yes, second confirmation ("Are you really sure?") No -> bails with zero DELETEs
        const prompts2: Array<{ q: string; def?: boolean }> = [];
        const abort2 = await runDeleteCommand({
          cwd: col,
          target: 'all',
          baseUrl: server.baseUrl,
          interactive: true,
          env: {},
          homeDir: tmpHome,
          output: createSilentOutput(),
          prompts: {
            confirm: async (q, def) => {
              prompts2.push({ q, def });
              return prompts2.length === 1;
            },
          },
        });
        assert.equal(abort2, null);
        assert.equal(prompts2.length, 2);
        assert.equal(prompts2[1]!.q, 'Are you really sure?');
        assert.equal(prompts2[1]!.def, false);
        assert.equal(p1.deleted, false);
        assert.equal(p2.deleted, false);

        // 6. Both confirmations Yes -> deletes ALL linked Pens, keeps .cdpn.json & .codepen/ by default
        const prompts3: string[] = [];
        const delOut = createBufferedOutput();
        const delDefault = await runDeleteCommand({
          cwd: col,
          target: 'all',
          baseUrl: server.baseUrl,
          interactive: true,
          env: {},
          homeDir: tmpHome,
          output: delOut,
          prompts: {
            confirm: async (q) => {
              prompts3.push(q);
              return true;
            },
          },
        });
        assert.equal(prompts3.length, 2);
        assert.equal(prompts3[1], 'Are you really sure?');
        assert.equal(delDefault?.batch?.counts.deleted, 2);
        assert.equal(delDefault?.batch?.counts.skipped, 1);
        assert.equal(delDefault?.batch?.counts.errors, 0);
        assert.equal(p1.deleted, true);
        assert.equal(p2.deleted, true);
        assert.equal((await readProjectConfigFile(dir1)).linked, true);
        assert.equal((await readProjectConfigFile(dir2)).linked, true);
        assert.ok((await fs.stat(path.join(dir1, CODEPEN_DIR))).isDirectory());
        assert.match(stripAnsi(delOut.stdout()), /Deleted:\s+2/);

        // 7. Batch delete all --cleanup --yes -> removes .codepen/ and keeps unlinked info-only .cdpn.json
        await resetFixtures();
        const delCleanup = await runDeleteCommand({
          cwd: col,
          target: 'all',
          cleanup: true,
          yes: true,
          baseUrl: server.baseUrl,
          interactive: false,
          env: {},
          homeDir: tmpHome,
          output: createSilentOutput(),
        });
        assert.equal(delCleanup?.batch?.counts.deleted, 2);
        assert.equal((await readProjectConfigFile(dir1)).linked, false);
        assert.equal((await readProjectConfigFile(dir2)).linked, false);
        await assert.rejects(() => fs.stat(path.join(dir1, CODEPEN_DIR)), /ENOENT/);
        await assert.rejects(() => fs.stat(path.join(dir2, CODEPEN_DIR)), /ENOENT/);
        assert.equal(await fs.readFile(path.join(dir1, 'index.html'), 'utf8'), '<h1>1</h1>\n');

        // 8. Batch delete all --full-cleanup --yes --json -> removes both .codepen/ and .cdpn.json
        await resetFixtures();
        const fullOut = createBufferedOutput();
        const delFull = await runDeleteCommand({
          cwd: col,
          target: 'all',
          fullCleanup: true,
          yes: true,
          json: true,
          baseUrl: server.baseUrl,
          interactive: false,
          env: {},
          homeDir: tmpHome,
          output: fullOut,
        });
        assert.equal(delFull?.batch?.counts.deleted, 2);
        await assert.rejects(() => fs.stat(path.join(dir1, PROJECT_CONFIG_FILENAME)), /ENOENT/);
        await assert.rejects(() => fs.stat(path.join(dir1, CODEPEN_DIR)), /ENOENT/);
        await assert.rejects(() => fs.stat(path.join(dir2, PROJECT_CONFIG_FILENAME)), /ENOENT/);
        await assert.rejects(() => fs.stat(path.join(dir2, CODEPEN_DIR)), /ENOENT/);
        // Local source files stay untouched
        assert.equal(await fs.readFile(path.join(dir1, 'index.html'), 'utf8'), '<h1>1</h1>\n');
        const fullEnv = parseJsonOutput<{ batch: boolean; mode: string; counts: { deleted: number } }>(
          fullOut,
        );
        assert.equal(fullEnv.status.code, 200);
        assert.equal(fullEnv.contents.batch, true);
        assert.equal(fullEnv.contents.mode, 'delete');
        assert.equal(fullEnv.contents.counts.deleted, 2);
      });
    } finally {
      await server.close();
    }
  });

  it('enforces two-step confirmation ("Are you really sure?") for batch unlink all and supports --dry-run (batch & single-Pen)', async () => {
    await withTempDir(async (tmpRoot) => {
      const col = path.join(tmpRoot, 'demos');
      const dir1 = path.join(col, 'pen-a');
      const dir2 = path.join(col, 'group', 'pen-b');
      const dirUnlinked = path.join(col, 'pen-c-unlinked');

      const p1 = createPenState('pen_u_1', 'Unlink One', { '/index.html': '<h1>1</h1>\n' });
      const p2 = createPenState('pen_u_2', 'Unlink Two', { '/index.html': '<h1>2</h1>\n' });
      await materializeLinkedPen(dir1, p1, { withCodepenDir: true });
      await materializeLinkedPen(dir2, p2, { withCodepenDir: true });
      await fs.mkdir(dirUnlinked, { recursive: true });
      await writeUnlinkedProjectInfo(dirUnlinked, { title: 'Already Unlinked' });

      // 1. Single-Pen unlink --dry-run does not modify .cdpn.json or prompt
      const singleDryOut = createBufferedOutput();
      const singleDry = await runUnlinkCommand({
        cwd: dir1,
        dryRun: true,
        json: true,
        interactive: false,
        output: singleDryOut,
      });
      assert.equal(singleDry?.dryRun, true);
      assert.equal(singleDry?.unlinked, false);
      assert.equal((await readProjectConfigFile(dir1)).linked, true);
      const suEnv = parseJsonOutput<{ dry_run: boolean; unlinked: boolean; would_unlink: boolean }>(
        singleDryOut,
      );
      assert.equal(suEnv.contents.dry_run, true);
      assert.equal(suEnv.contents.would_unlink, true);

      // 2. Non-interactive batch unlink all without --yes rejects with 400
      await assert.rejects(
        () =>
          runUnlinkCommand({
            cwd: col,
            target: 'all',
            interactive: false,
            output: createSilentOutput(),
          }),
        (err: unknown) => err instanceof CliError && err.statusCode === 400,
      );

      // 3. Batch unlink all --dry-run skips confirmation, leaves files untouched, reports counts
      const dryOut = createBufferedOutput();
      const dryRes = await runUnlinkCommand({
        cwd: col,
        target: 'all',
        dryRun: true,
        interactive: false,
        output: dryOut,
      });
      assert.equal(dryRes?.dryRun, true);
      assert.equal(dryRes?.batch?.counts.discovered, 3);
      assert.equal(dryRes?.batch?.counts.unlinked, 2);
      assert.equal(dryRes?.batch?.counts.skipped, 1);
      assert.equal((await readProjectConfigFile(dir1)).linked, true);
      assert.equal((await readProjectConfigFile(dir2)).linked, true);
      assert.match(stripAnsi(dryOut.stdout()), /\[DRY RUN\] Summary \(unlink\):/);

      // 4. Confirmation 1 declined -> bails immediately (only 1 prompt asked)
      const prompts1: string[] = [];
      const abort1 = await runUnlinkCommand({
        cwd: col,
        target: 'all',
        interactive: true,
        output: createSilentOutput(),
        prompts: {
          confirm: async (q) => {
            prompts1.push(q);
            return false;
          },
        },
      });
      assert.equal(abort1, null);
      assert.equal(prompts1.length, 1);
      assert.equal((await readProjectConfigFile(dir1)).linked, true);

      // 5. Confirmation 1 Yes, Confirmation 2 ("Are you really sure?") No -> bails immediately
      const prompts2: string[] = [];
      const abort2 = await runUnlinkCommand({
        cwd: col,
        target: 'all',
        interactive: true,
        output: createSilentOutput(),
        prompts: {
          confirm: async (q) => {
            prompts2.push(q);
            return prompts2.length === 1;
          },
        },
      });
      assert.equal(abort2, null);
      assert.equal(prompts2.length, 2);
      assert.equal(prompts2[1], 'Are you really sure?');
      assert.equal((await readProjectConfigFile(dir1)).linked, true);
      assert.equal((await readProjectConfigFile(dir2)).linked, true);

      // 6. Both confirmations Yes -> unlinks all linked Pens while keeping info & .codepen/
      const prompts3: string[] = [];
      const unlinkOut = createBufferedOutput();
      const unlinked = await runUnlinkCommand({
        cwd: col,
        target: 'all',
        interactive: true,
        output: unlinkOut,
        prompts: {
          confirm: async (q) => {
            prompts3.push(q);
            return true;
          },
        },
      });
      assert.equal(prompts3.length, 2);
      assert.equal(prompts3[1], 'Are you really sure?');
      assert.equal(unlinked?.unlinked, true);
      assert.equal(unlinked?.batch?.counts.unlinked, 2);
      assert.equal(unlinked?.batch?.counts.skipped, 1);
      assert.equal((await readProjectConfigFile(dir1)).linked, false);
      assert.equal((await readProjectConfigFile(dir2)).linked, false);
      assert.ok((await fs.stat(path.join(dir1, CODEPEN_DIR))).isDirectory());
      assert.ok((await fs.stat(path.join(dir2, CODEPEN_DIR))).isDirectory());
      assert.match(stripAnsi(unlinkOut.stdout()), /Unlinked:\s+2/);

      // Re-linking one pen inside dir1 and testing parent-dir refusal inside dir1/sub even if dir1/sub has nested dirs
      await writeProjectConfig(dir1, {
        url: p1.pen.urls.editor,
        pen_id: p1.pen.id,
        profile: 'bramus',
        last_synced_version_id: 'ver_1',
      });
      const insidePenSub = path.join(dir1, 'src');
      const fakeNested = path.join(insidePenSub, 'child');
      await fs.mkdir(fakeNested, { recursive: true });
      await writeUnlinkedProjectInfo(fakeNested, { title: 'Nested' });

      await assert.rejects(
        () =>
          runUnlinkCommand({
            cwd: insidePenSub,
            yes: true,
            interactive: false,
            output: createSilentOutput(),
          }),
        /found one in parent folder/i,
      );
      assert.equal((await readProjectConfig(dir1)).pen_id, p1.pen.id);
    });
  });
});

describe('batch target gating (all keyword, directory targeting, ./all disambiguation, and fallback prompt)', () => {
  it('gates tree walking behind "all", supports `cdpn pull <dir>`, disambiguates a directory named "all", and offers `cdpn pull all` interactively in non-Pen directories', async () => {
    const pens = new Map<string, RemotePenState>();
    const penAllDir = createPenState('pen_named_all', 'All Dir Pen', { '/index.html': '<h1>v1</h1>\n' });
    const penOther = createPenState('pen_other', 'Other Pen', { '/index.html': '<h1>v1</h1>\n' });
    pens.set(penAllDir.pen.id, penAllDir);
    pens.set(penOther.pen.id, penOther);

    const server = await startMultiPenMockServer(pens);
    try {
      await withTempDir(async (tmpRoot) => {
        const tmpHome = path.join(tmpRoot, 'home');
        const col = path.join(tmpRoot, 'demos');
        await fs.mkdir(tmpHome, { recursive: true });
        await saveProfileToFile('bramus', KEY_BRAMUS, { homeDir: tmpHome, setAsDefault: true });

        const allDir = path.join(col, 'all');
        const otherDir = path.join(col, 'other');

        const resetBothBehind = async () => {
          await fs.rm(col, { recursive: true, force: true });
          const v1Files = [makePenFile('/index.html', '<h1>v1</h1>\n', { content_hash: sha256('<h1>v1</h1>\n') })];
          const v1All = makeVersion({ id: 'ver_1', pen_id: penAllDir.pen.id, files: v1Files });
          const v1Other = makeVersion({ id: 'ver_1', pen_id: penOther.pen.id, files: v1Files });
          penAllDir.files = v1Files;
          penAllDir.pen = { ...penAllDir.pen, saved_version: v1All };
          penOther.files = v1Files;
          penOther.pen = { ...penOther.pen, saved_version: v1Other };

          await materializeLinkedPen(allDir, penAllDir);
          await materializeLinkedPen(otherDir, penOther);

          // Advance both remotely to v2
          for (const st of [penAllDir, penOther]) {
            const content = `<h1>remote ${st.pen.id}</h1>\n`;
            const files = [makePenFile('/index.html', content, { content_hash: sha256(content) })];
            const v2 = makeVersion({
              id: 'ver_2',
              pen_id: st.pen.id,
              build: makeBuild({ version_id: 'ver_2' }),
              files,
            });
            st.files = files;
            st.versions.set('ver_2', v2);
            st.pen = { ...st.pen, saved_version: v2 };
          }
        };

        await resetBothBehind();

        // 1. Non-interactive `cdpn pull` (no "all") refuses to auto-walk and suggests `cdpn pull all`
        await assert.rejects(
          () =>
            runPullCommand({
              cwd: col,
              baseUrl: server.baseUrl,
              interactive: false,
              env: {},
              homeDir: tmpHome,
              output: createSilentOutput(),
            }),
          (err: unknown) =>
            err instanceof CliError &&
            err.statusCode === 404 &&
            /cdpn pull all/i.test(err.message),
        );
        assert.equal(await fs.readFile(path.join(allDir, 'index.html'), 'utf8'), '<h1>v1</h1>\n');
        assert.equal(await fs.readFile(path.join(otherDir, 'index.html'), 'utf8'), '<h1>v1</h1>\n');

        // 2. Non-interactive `cdpn push`, `sync`, `delete`, `unlink` without "all" also refuse to auto-walk
        for (const [cmd, runner] of [
          ['push', () => runPushCommand({ cwd: col, baseUrl: server.baseUrl, interactive: false, env: {}, homeDir: tmpHome, output: createSilentOutput() })],
          ['sync', () => runSyncCommand({ cwd: col, baseUrl: server.baseUrl, interactive: false, env: {}, homeDir: tmpHome, output: createSilentOutput() })],
          ['delete', () => runDeleteCommand({ cwd: col, yes: true, baseUrl: server.baseUrl, interactive: false, env: {}, homeDir: tmpHome, output: createSilentOutput() })],
          ['unlink', () => runUnlinkCommand({ cwd: col, yes: true, interactive: false, output: createSilentOutput() })],
        ] as const) {
          await assert.rejects(
            runner,
            (err: unknown) =>
              err instanceof CliError &&
              err.statusCode === 404 &&
              new RegExp(`cdpn ${cmd} all`, 'i').test(err.message),
          );
        }

        // 3. `cdpn pull other` pulls ONLY the "other" directory, leaving "all" untouched
        const pullOne = await runPullCommand({
          cwd: col,
          target: 'other',
          baseUrl: server.baseUrl,
          interactive: false,
          env: {},
          homeDir: tmpHome,
          output: createSilentOutput(),
        });
        assert.equal(pullOne?.batch, undefined);
        assert.equal(pullOne?.pen?.id, 'pen_other');
        assert.equal(
          await fs.readFile(path.join(otherDir, 'index.html'), 'utf8'),
          '<h1>remote pen_other</h1>\n',
        );
        assert.equal(await fs.readFile(path.join(allDir, 'index.html'), 'utf8'), '<h1>v1</h1>\n');

        // 4. `cdpn pull ./all` unambiguously targets the ./all directory without prompting
        await resetBothBehind();
        const pullDotAll = await runPullCommand({
          cwd: col,
          target: './all',
          baseUrl: server.baseUrl,
          interactive: false,
          env: {},
          homeDir: tmpHome,
          output: createSilentOutput(),
        });
        assert.equal(pullDotAll?.batch, undefined);
        assert.equal(pullDotAll?.pen?.id, 'pen_named_all');
        assert.equal(
          await fs.readFile(path.join(allDir, 'index.html'), 'utf8'),
          '<h1>remote pen_named_all</h1>\n',
        );
        assert.equal(await fs.readFile(path.join(otherDir, 'index.html'), 'utf8'), '<h1>v1</h1>\n');

        // 5. `cdpn pull all` when directory "all" exists:
        //    a) Non-interactive rejects with 409 ambiguity error advising "./all"
        await resetBothBehind();
        await assert.rejects(
          () =>
            runPullCommand({
              cwd: col,
              target: 'all',
              baseUrl: server.baseUrl,
              interactive: false,
              env: {},
              homeDir: tmpHome,
              output: createSilentOutput(),
            }),
          (err: unknown) =>
            err instanceof CliError &&
            err.statusCode === 409 &&
            /Ambiguous target "all"/i.test(err.message) &&
            /\.\/all/.test(err.message),
        );

        //    b) Interactive choice -> selecting "directory" pulls ONLY ./all
        let seenValues: string[] = [];
        const choseDir = await runPullCommand({
          cwd: col,
          target: 'all',
          baseUrl: server.baseUrl,
          interactive: true,
          env: {},
          homeDir: tmpHome,
          output: createSilentOutput(),
          prompts: {
            select: async (_q, opts) => {
              seenValues = opts.map((o) => o.value);
              return 'directory' as never;
            },
          },
        });
        assert.deepEqual(seenValues, ['directory', 'batch']);
        assert.equal(choseDir?.batch, undefined);
        assert.equal(choseDir?.pen?.id, 'pen_named_all');
        assert.equal(
          await fs.readFile(path.join(allDir, 'index.html'), 'utf8'),
          '<h1>remote pen_named_all</h1>\n',
        );
        assert.equal(await fs.readFile(path.join(otherDir, 'index.html'), 'utf8'), '<h1>v1</h1>\n');

        //    c) Interactive choice -> selecting "batch" pulls ALL Pens (both ./all and other)
        await resetBothBehind();
        const choseBatch = await runPullCommand({
          cwd: col,
          target: 'all',
          baseUrl: server.baseUrl,
          interactive: true,
          env: {},
          homeDir: tmpHome,
          output: createSilentOutput(),
          prompts: {
            select: async () => 'batch' as never,
          },
        });
        assert.equal(choseBatch?.batch?.counts.pulled, 2);
        assert.equal(
          await fs.readFile(path.join(allDir, 'index.html'), 'utf8'),
          '<h1>remote pen_named_all</h1>\n',
        );
        assert.equal(
          await fs.readFile(path.join(otherDir, 'index.html'), 'utf8'),
          '<h1>remote pen_other</h1>\n',
        );

        // 6. Interactive `cdpn pull` (without "all") in a non-Pen dir offers `cdpn pull all` (yes/No)
        await resetBothBehind();
        const declinePrompts: Array<{ q: string; def?: boolean }> = [];
        const declined = await runPullCommand({
          cwd: col,
          baseUrl: server.baseUrl,
          interactive: true,
          env: {},
          homeDir: tmpHome,
          output: createSilentOutput(),
          prompts: {
            confirm: async (q, def) => {
              declinePrompts.push({ q, def });
              return false;
            },
          },
        });
        assert.equal(declined, null);
        assert.equal(declinePrompts.length, 1);
        assert.equal(declinePrompts[0]!.def, false);
        assert.match(declinePrompts[0]!.q, /Run `cdpn pull all`/);
        assert.equal(await fs.readFile(path.join(otherDir, 'index.html'), 'utf8'), '<h1>v1</h1>\n');

        // Accepting the offer walks the subtree and pulls all Pens!
        const accepted = await runPullCommand({
          cwd: col,
          baseUrl: server.baseUrl,
          interactive: true,
          env: {},
          homeDir: tmpHome,
          output: createSilentOutput(),
          prompts: {
            confirm: async () => true,
          },
        });
        assert.equal(accepted?.batch?.counts.pulled, 2);
        assert.equal(
          await fs.readFile(path.join(allDir, 'index.html'), 'utf8'),
          '<h1>remote pen_named_all</h1>\n',
        );
        assert.equal(
          await fs.readFile(path.join(otherDir, 'index.html'), 'utf8'),
          '<h1>remote pen_other</h1>\n',
        );

        // 7. `cdpn pull all` inside a single Pen folder (no child Pens) gives helpful 404 hint
        await assert.rejects(
          () =>
            runPullCommand({
              cwd: otherDir,
              target: 'all',
              baseUrl: server.baseUrl,
              interactive: false,
              env: {},
              homeDir: tmpHome,
              output: createSilentOutput(),
            }),
          (err: unknown) =>
            err instanceof CliError &&
            err.statusCode === 404 &&
            /without "all"/i.test(err.message),
        );

        // 8. Nonexistent directory or file target throws clean 404 / 400
        await assert.rejects(
          () =>
            runPullCommand({
              cwd: col,
              target: 'does-not-exist',
              baseUrl: server.baseUrl,
              interactive: false,
              env: {},
              homeDir: tmpHome,
              output: createSilentOutput(),
            }),
          (err: unknown) => err instanceof CliError && err.statusCode === 404,
        );
        await assert.rejects(
          () =>
            runPullCommand({
              cwd: otherDir,
              target: 'index.html',
              baseUrl: server.baseUrl,
              interactive: false,
              env: {},
              homeDir: tmpHome,
              output: createSilentOutput(),
            }),
          (err: unknown) => err instanceof CliError && err.statusCode === 400,
        );
      }, 'cdpn-batch-gating-');
    } finally {
      await server.close();
    }
  });
});
