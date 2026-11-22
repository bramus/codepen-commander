import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { Pen, PenFile, Version } from '../../src/api/types.js';
import { runSyncCommand } from '../../src/commands/sync.js';
import {
  buildSyncedFileMap,
  readProjectConfig,
  writeProjectConfig,
  writeUnlinkedProjectInfo,
} from '../../src/config/project.js';
import { saveProfileToFile } from '../../src/config/user-store.js';
import { CliError } from '../../src/errors.js';
import { buildPenInfoConfigFields } from '../../src/sync/info.js';
import { stripAnsi } from '../../src/utils/format.js';
import {
  makeBuild,
  makePen,
  makePenFile,
  makeVersion,
  startMockCodePenServer,
} from '../helpers/mock-codepen-api.js';
import { createBufferedOutput, createSilentOutput, parseJsonOutput } from '../helpers/output.js';
import { withTempDir } from '../helpers/temp-dir.js';

const KEY_BRAMUS = 'cp_user_sync_test_1234567890';

function sha256(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

interface RemotePenState {
  pen: Pen;
  files: PenFile[];
  versions: Map<string, Version>;
}

function createPenState(id: string, title: string, files: Record<string, string>, versionId = 'ver_1'): RemotePenState {
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
    description: 'Initial description',
    tags: ['css'],
    access: 'Public',
    saved_version: version,
  });
  return {
    pen,
    files: penFiles,
    versions: new Map([[versionId, version]]),
  };
}

async function materializeLinkedPen(dir: string, state: RemotePenState, profile = 'bramus'): Promise<void> {
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
    profile,
    last_synced_version_id: state.pen.saved_version?.id ?? null,
    editor: state.pen.editor,
    ...buildPenInfoConfigFields(state.pen),
    files: buildSyncedFileMap(state.files, localShas),
  });
}

describe('cdpn sync (single-Pen mode)', () => {
  it('handles up-to-date, local-ahead, remote-ahead, metadata-ahead, conflict, unlinked create, and --dry-run', async () => {
    const pens = new Map<string, RemotePenState>();
    let versionCounter = 1;
    let createCounter = 0;

    const penState = createPenState('pen_sync_1', 'Sync Demo', {
      '/index.html': '<h1>v1</h1>\n',
      '/style.css': 'body { color: black; }\n',
    });
    pens.set(penState.pen.id, penState);

    const server = await startMockCodePenServer((ctx) => {
      // GET /v2/pens/:id
      const getPenMatch = ctx.pathname.match(/^\/v2\/pens\/([^/]+)$/);
      if (ctx.method === 'GET' && getPenMatch) {
        const st = pens.get(getPenMatch[1]!);
        if (!st) return { status: 404, body: { code: 'NOT_FOUND', message: 'Not found' } };
        return { body: st.pen };
      }

      // PATCH /v2/pens/:id
      if (ctx.method === 'PATCH' && getPenMatch) {
        const st = pens.get(getPenMatch[1]!);
        if (!st) return { status: 404, body: { code: 'NOT_FOUND', message: 'Not found' } };
        const body = ctx.jsonBody();
        if (typeof body.title === 'string') st.pen = { ...st.pen, title: body.title };
        if (typeof body.description === 'string') st.pen = { ...st.pen, description: body.description };
        if (Array.isArray(body.tags)) st.pen = { ...st.pen, tags: body.tags as string[] };
        if (typeof body.access === 'string') st.pen = { ...st.pen, access: body.access as Pen['access'] };
        return { body: st.pen };
      }

      // GET /v2/pens/:id/files
      const filesMatch = ctx.pathname.match(/^\/v2\/pens\/([^/]+)\/files$/);
      if (ctx.method === 'GET' && filesMatch) {
        const st = pens.get(filesMatch[1]!);
        if (!st) return { status: 404, body: { code: 'NOT_FOUND', message: 'Not found' } };
        return { body: st.files };
      }

      // PUT /v2/pens/:id/files
      if (ctx.method === 'PUT' && filesMatch) {
        const st = pens.get(filesMatch[1]!);
        if (!st) return { status: 404, body: { code: 'NOT_FOUND', message: 'Not found' } };
        const body = ctx.jsonBody();
        const isDryRun = Boolean(body.dry_run);
        const nextFilesMap = new Map(st.files.map((f) => [f.path, f]));
        const changes = (body.files as Array<{ path: string; content?: string; delete?: boolean }>) ?? [];
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
        const build = makeBuild({ id: `bld_${versionCounter}`, version_id: verId, status: 'Success' });
        const version = makeVersion({ id: verId, pen_id: st.pen.id, build, files: nextFiles });
        if (!isDryRun) {
          st.files = nextFiles;
          st.versions.set(verId, version);
          st.pen = { ...st.pen, saved_version: version };
        }
        return { body: { pen: st.pen, version, build } };
      }

      // GET /v2/versions/:id
      const verMatch = ctx.pathname.match(/^\/v2\/versions\/([^/]+)$/);
      if (ctx.method === 'GET' && verMatch) {
        for (const st of pens.values()) {
          const v = st.versions.get(verMatch[1]!);
          if (v) return { body: v };
        }
        return { status: 404, body: { code: 'NOT_FOUND', message: 'Version not found' } };
      }

      // POST /v2/pens (create new Pen)
      if (ctx.method === 'POST' && ctx.pathname === '/v2/pens') {
        const body = ctx.jsonBody();
        const id = `pen_created_${++createCounter}`;
        const reqFiles = (body.files as Array<{ path: string; content: string }>) ?? [];
        const fileMap: Record<string, string> = {};
        for (const f of reqFiles) {
          fileMap[f.path] = f.content;
        }
        const verId = `ver_created_${createCounter}`;
        const createdState = createPenState(id, String(body.title ?? 'Untitled'), fileMap, verId);
        createdState.pen = {
          ...createdState.pen,
          access: (body.access as Pen['access']) ?? 'Public',
          description: String(body.description ?? ''),
          tags: Array.isArray(body.tags) ? (body.tags as string[]) : [],
        };
        pens.set(id, createdState);
        return {
          status: 201,
          body: {
            ...createdState.pen,
            build: createdState.pen.saved_version?.build,
          },
        };
      }

      return undefined;
    });

    try {
      await withTempDir(async (tmpRoot) => {
        const tmpHome = path.join(tmpRoot, 'home');
        const penDir = path.join(tmpRoot, 'demo');
        const emptyDir = path.join(tmpRoot, 'empty');
        await fs.mkdir(tmpHome, { recursive: true });
        await fs.mkdir(emptyDir, { recursive: true });
        await saveProfileToFile('bramus', KEY_BRAMUS, { homeDir: tmpHome, setAsDefault: true });
        await materializeLinkedPen(penDir, penState);

        // 1. Empty directory with no .cdpn.json anywhere throws 404
        await assert.rejects(
          () =>
            runSyncCommand({
              cwd: emptyDir,
              baseUrl: server.baseUrl,
              interactive: false,
              env: {},
              homeDir: tmpHome,
              output: createSilentOutput(),
            }),
          (err: unknown) => err instanceof CliError && err.statusCode === 404,
        );

        // 2. Up-to-date Pen -> no writes
        const reqBeforeUpToDate = server.requests.length;
        const upBuf = createBufferedOutput();
        const upRes = await runSyncCommand({
          cwd: penDir,
          json: true,
          baseUrl: server.baseUrl,
          interactive: false,
          env: {},
          homeDir: tmpHome,
          output: upBuf,
        });
        assert.equal(upRes.action, 'up-to-date');
        assert.equal(upRes.state, 'up-to-date');
        const upEnv = parseJsonOutput<{ action: string; state: string }>(upBuf);
        assert.equal(upEnv.status.code, 200);
        assert.equal(upEnv.contents.action, 'up-to-date');
        assert.equal(
          server.requests.slice(reqBeforeUpToDate).some((r) => r.method !== 'GET'),
          false,
        );

        // 3. Local-ahead (file + info) -> --dry-run first, then real sync pushes
        await fs.writeFile(path.join(penDir, 'index.html'), '<h1>v2 local</h1>\n', 'utf8');
        const cfgLocal = await readProjectConfig(penDir);
        cfgLocal.info = { ...cfgLocal.info, title: 'Sync Demo Local Title' };
        await writeProjectConfig(penDir, cfgLocal);

        const dryPushRes = await runSyncCommand({
          cwd: penDir,
          dryRun: true,
          baseUrl: server.baseUrl,
          interactive: false,
          env: {},
          homeDir: tmpHome,
          output: createSilentOutput(),
        });
        assert.equal(dryPushRes.action, 'pushed');
        assert.equal(dryPushRes.dryRun, true);
        // Remote head unchanged after dry-run
        assert.equal(penState.pen.saved_version?.id, 'ver_1');
        assert.equal(penState.pen.title, 'Sync Demo');

        const pushRes = await runSyncCommand({
          cwd: penDir,
          baseUrl: server.baseUrl,
          interactive: false,
          env: {},
          homeDir: tmpHome,
          output: createSilentOutput(),
        });
        assert.equal(pushRes.action, 'pushed');
        assert.equal(pushRes.dryRun, false);
        assert.equal(penState.pen.title, 'Sync Demo Local Title');
        assert.equal(
          penState.files.find((f) => f.path === '/index.html')?.content,
          '<h1>v2 local</h1>\n',
        );

        // 4. Remote-ahead -> --dry-run does not mutate local disk, real sync pulls
        const remoteV3Content = '<h1>v3 remote</h1>\n';
        const v3Files = [
          makePenFile('/index.html', remoteV3Content, { content_hash: sha256(remoteV3Content) }),
          makePenFile('/style.css', 'body { color: black; }\n', {
            content_hash: sha256('body { color: black; }\n'),
          }),
          makePenFile('/app.js', 'console.log(3);\n', { content_hash: sha256('console.log(3);\n') }),
        ];
        const v3 = makeVersion({
          id: 'ver_remote_3',
          pen_id: penState.pen.id,
          build: makeBuild({ version_id: 'ver_remote_3' }),
          files: v3Files,
        });
        penState.files = v3Files;
        penState.versions.set('ver_remote_3', v3);
        penState.pen = { ...penState.pen, saved_version: v3, title: 'Sync Demo Remote Title' };

        const dryPullBuf = createBufferedOutput();
        const dryPullRes = await runSyncCommand({
          cwd: penDir,
          dryRun: true,
          baseUrl: server.baseUrl,
          interactive: false,
          env: {},
          homeDir: tmpHome,
          output: dryPullBuf,
        });
        assert.equal(dryPullRes.action, 'pulled');
        assert.equal(dryPullRes.dryRun, true);
        assert.equal(await fs.readFile(path.join(penDir, 'index.html'), 'utf8'), '<h1>v2 local</h1>\n');
        assert.match(stripAnsi(dryPullBuf.stdout()), /Dry run complete/i);

        const pullRes = await runSyncCommand({
          cwd: penDir,
          baseUrl: server.baseUrl,
          interactive: false,
          env: {},
          homeDir: tmpHome,
          output: createSilentOutput(),
        });
        assert.equal(pullRes.action, 'pulled');
        assert.equal(await fs.readFile(path.join(penDir, 'index.html'), 'utf8'), remoteV3Content);
        assert.equal(await fs.readFile(path.join(penDir, 'app.js'), 'utf8'), 'console.log(3);\n');
        assert.equal((await readProjectConfig(penDir)).info?.title, 'Sync Demo Remote Title');

        // 5. Remote-metadata-ahead (version ID changed with identical file content) -> sync refreshes .cdpn.json
        const v4 = makeVersion({
          id: 'ver_remote_4',
          pen_id: penState.pen.id,
          build: makeBuild({ version_id: 'ver_remote_4' }),
          files: v3Files,
        });
        penState.versions.set('ver_remote_4', v4);
        penState.pen = { ...penState.pen, saved_version: v4 };

        const metaRes = await runSyncCommand({
          cwd: penDir,
          baseUrl: server.baseUrl,
          interactive: false,
          env: {},
          homeDir: tmpHome,
          output: createSilentOutput(),
        });
        assert.equal(metaRes.action, 'pulled');
        assert.equal(metaRes.state, 'remote-metadata-ahead');
        assert.equal((await readProjectConfig(penDir)).last_synced_version_id, 'ver_remote_4');

        // 6. Conflict (both local and remote edited) -> rejects with CliError(409)
        await fs.writeFile(path.join(penDir, 'index.html'), '<h1>local conflict</h1>\n', 'utf8');
        const v5Content = '<h1>remote conflict</h1>\n';
        const v5Files = [
          makePenFile('/index.html', v5Content, { content_hash: sha256(v5Content) }),
          ...v3Files.slice(1),
        ];
        const v5 = makeVersion({
          id: 'ver_remote_5',
          pen_id: penState.pen.id,
          build: makeBuild({ version_id: 'ver_remote_5' }),
          files: v5Files,
        });
        penState.files = v5Files;
        penState.versions.set('ver_remote_5', v5);
        penState.pen = { ...penState.pen, saved_version: v5 };

        await assert.rejects(
          () =>
            runSyncCommand({
              cwd: penDir,
              baseUrl: server.baseUrl,
              interactive: false,
              env: {},
              homeDir: tmpHome,
              output: createSilentOutput(),
            }),
          (err: unknown) =>
            err instanceof CliError &&
            err.statusCode === 409 &&
            /Sync conflict detected/i.test(err.message),
        );
        // Neither side was clobbered
        assert.equal(
          await fs.readFile(path.join(penDir, 'index.html'), 'utf8'),
          '<h1>local conflict</h1>\n',
        );

        // 7. Unlinked info-only `.cdpn.json` -> dry-run previews creation, real sync creates Pen
        const unlinkedDir = path.join(tmpRoot, 'unlinked-demo');
        await fs.mkdir(unlinkedDir, { recursive: true });
        await fs.writeFile(path.join(unlinkedDir, 'index.html'), '<h1>Brand New</h1>\n', 'utf8');
        await writeUnlinkedProjectInfo(unlinkedDir, {
          title: 'Unlinked Sync Pen',
          access: 'Private',
          tags: ['demo'],
        });

        const dryCreateBuf = createBufferedOutput();
        const dryCreateRes = await runSyncCommand({
          cwd: unlinkedDir,
          dryRun: true,
          json: true,
          baseUrl: server.baseUrl,
          interactive: false,
          env: {},
          homeDir: tmpHome,
          output: dryCreateBuf,
        });
        assert.equal(dryCreateRes.action, 'created');
        assert.equal(dryCreateRes.dryRun, true);
        assert.equal(createCounter, 0);
        const dryCreateEnv = parseJsonOutput<{ action: string; dry_run: boolean; title: string }>(
          dryCreateBuf,
        );
        assert.equal(dryCreateEnv.contents.action, 'created');
        assert.equal(dryCreateEnv.contents.dry_run, true);
        assert.equal(dryCreateEnv.contents.title, 'Unlinked Sync Pen');

        const realCreateRes = await runSyncCommand({
          cwd: unlinkedDir,
          baseUrl: server.baseUrl,
          interactive: false,
          env: {},
          homeDir: tmpHome,
          output: createSilentOutput(),
        });
        assert.equal(realCreateRes.action, 'created');
        assert.equal(realCreateRes.dryRun, false);
        assert.equal(createCounter, 1);
        const linkedCfg = await readProjectConfig(unlinkedDir);
        assert.equal(linkedCfg.pen_id, 'pen_created_1');
        assert.equal(linkedCfg.info?.title, 'Unlinked Sync Pen');
      }, 'cdpn-sync-single-');
    } finally {
      await server.close();
    }
  });
});
