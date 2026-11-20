import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { CodePenClient } from '../src/api/client.js';
import { clonePenCommand } from '../src/commands/clone.js';
import { createPenFromDirectory } from '../src/commands/create-pen.js';
import { forkPenCommand } from '../src/commands/fork.js';
import { infoPenCommand } from '../src/commands/meta.js';
import { scaffoldNewPen } from '../src/commands/new.js';
import { managePenPrivacy } from '../src/commands/privacy.js';
import { pullPenCommand } from '../src/commands/pull.js';
import { executePush } from '../src/commands/push.js';
import { statusPenCommand } from '../src/commands/status.js';
import { saveProfileToFile } from '../src/config/auth.js';
import {
  buildSyncedFileMap,
  findProject,
  PROJECT_CONFIG_FILENAME,
  readProjectConfig,
  writeProjectConfig,
} from '../src/config/project.js';
import { sha256Hex } from '../src/sync/fs.js';
import {
  analyzeInfoSync,
  buildInfoUpdatePatch,
  extractPenInfo,
  hashPenInfo,
  isLocalInfoDirty,
  mergeUpdatedPenInfoIntoConfig,
} from '../src/sync/info.js';
import type { CompletePenInfo, Pen, PenAccess, PenFile } from '../src/types.js';
import { CliError } from '../src/utils/json.js';

const API_KEY = 'cp_user_bramus_infosync12345';

async function captureStdout<T>(fn: () => Promise<T>): Promise<{ result: T; output: string }> {
  const lines: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(' '));
  };
  try {
    const result = await fn();
    return { result, output: lines.join('\n') };
  } finally {
    console.log = origLog;
  }
}

describe('Pen info sync engine (unit tests)', () => {
  const basePen = {
    title: 'Scroll Demo',
    description: 'Smooth scroll animations',
    tags: ['css', 'scroll'],
    access: 'Public' as PenAccess,
    template: false,
  };

  it('produces identical hashes regardless of key ordering', () => {
    const a: CompletePenInfo = {
      title: 'Demo',
      description: 'Desc',
      tags: ['a', 'b'],
      access: 'Public',
      template: false,
    };
    const b: CompletePenInfo = {
      template: false,
      access: 'Public',
      tags: ['a', 'b'],
      description: 'Desc',
      title: 'Demo',
    };
    assert.equal(hashPenInfo(a), hashPenInfo(b));
  });

  it('handles legacy .cdpn.json without info cleanly (not tracked, not dirty, no diffs)', () => {
    assert.equal(isLocalInfoDirty(undefined, undefined), false);
    assert.equal(isLocalInfoDirty({}, undefined), false);

    const analysis = analyzeInfoSync(undefined, undefined, basePen);
    assert.equal(analysis.tracked, false);
    assert.equal(analysis.localChanged, false);
    assert.equal(analysis.remoteChanged, false);
    assert.deepEqual(analysis.changes, []);
    assert.deepEqual(analysis.remoteInfo, basePen);
  });

  it('distinguishes up-to-date, local-only, remote-only, conflict, and converged identical edits', () => {
    const baselineHash = hashPenInfo(extractPenInfo(basePen));

    // Up to date
    const same = analyzeInfoSync({ ...basePen }, baselineHash, basePen);
    assert.equal(same.tracked, true);
    assert.equal(same.localChanged, false);
    assert.equal(same.remoteChanged, false);
    assert.deepEqual(same.changes, []);
    assert.equal(isLocalInfoDirty({ ...basePen }, baselineHash), false);

    // Local-only edit
    const localEdit = { ...basePen, title: 'Local Title', tags: ['css', 'grid'] };
    const localOnly = analyzeInfoSync(localEdit, baselineHash, basePen);
    assert.equal(localOnly.localChanged, true);
    assert.equal(localOnly.remoteChanged, false);
    assert.deepEqual(
      localOnly.changes.map((c) => c.field),
      ['title', 'tags'],
    );
    assert.equal(isLocalInfoDirty(localEdit, baselineHash), true);

    // Remote-only edit
    const remoteEditedPen = { ...basePen, title: 'Remote Title' };
    const remoteOnly = analyzeInfoSync({ ...basePen }, baselineHash, remoteEditedPen);
    assert.equal(remoteOnly.localChanged, false);
    assert.equal(remoteOnly.remoteChanged, true);
    assert.deepEqual(remoteOnly.changes, [
      { field: 'title', local: 'Scroll Demo', remote: 'Remote Title' },
    ]);
    assert.equal(isLocalInfoDirty({ ...basePen }, baselineHash), false);

    // Conflict (both local & remote changed differently)
    const conflict = analyzeInfoSync(localEdit, baselineHash, remoteEditedPen);
    assert.equal(conflict.localChanged, true);
    assert.equal(conflict.remoteChanged, true);
    assert.equal(conflict.changes.length, 2);

    // Both changed to the exact same values -> effectively in sync
    const converged = analyzeInfoSync(
      { ...basePen, title: 'Same New Title' },
      baselineHash,
      { ...basePen, title: 'Same New Title' },
    );
    assert.equal(converged.localChanged, false);
    assert.equal(converged.remoteChanged, false);
    assert.deepEqual(converged.changes, []);

    // Manual partial info added to legacy .cdpn.json (no baseline hash)
    const partial = analyzeInfoSync({ title: 'Handcrafted Title' }, undefined, basePen);
    assert.equal(partial.tracked, true);
    assert.equal(partial.localChanged, true);
    assert.equal(partial.remoteChanged, false);
    assert.deepEqual(partial.changes, [
      { field: 'title', local: 'Handcrafted Title', remote: 'Scroll Demo' },
    ]);
    assert.equal(isLocalInfoDirty({ title: 'Handcrafted Title' }, undefined), true);
  });

  it('validates tag limits and blocks switching to Protected via .cdpn.json', () => {
    assert.throws(
      () =>
        buildInfoUpdatePatch([
          {
            field: 'tags',
            local: ['1', '2', '3', '4', '5', '6'],
            remote: [],
          },
        ]),
      /at most 5 tags/i,
    );

    assert.throws(
      () =>
        buildInfoUpdatePatch([
          {
            field: 'access',
            local: 'Protected',
            remote: 'Public',
          },
        ]),
      /Cannot change Pen access to "Protected" via \.cdpn\.json/i,
    );

    // Changing away from Protected is allowed without a password
    const patch = buildInfoUpdatePatch([
      {
        field: 'access',
        local: 'Public',
        remote: 'Protected',
      },
    ]);
    assert.deepEqual(patch, { access: 'Public' });
  });

  it('merges explicit metadata command updates without losing unpushed local edits to other info fields', () => {
    const baselineHash = hashPenInfo(extractPenInfo(basePen));
    const configWithLocalTitleEdit = {
      url: 'https://codepen.io/bramus/pen/p1',
      pen_id: 'p1',
      last_synced_version_id: 'v1',
      last_synced_info_hash: baselineHash,
      info: {
        ...basePen,
        title: 'Unpushed Local Title',
      },
    };
    const updatedRemotePen = {
      ...basePen,
      access: 'Private' as PenAccess,
    };

    const merged = mergeUpdatedPenInfoIntoConfig(configWithLocalTitleEdit, updatedRemotePen, {
      access: 'Private',
    });

    assert.equal(merged.info?.title, 'Unpushed Local Title');
    assert.equal(merged.info?.access, 'Private');
    assert.equal(merged.last_synced_info_hash, hashPenInfo(extractPenInfo(updatedRemotePen)));

    // Subsequent sync analysis sees ONLY title as locally changed (no false remote conflict!)
    const nextAnalysis = analyzeInfoSync(
      merged.info,
      merged.last_synced_info_hash,
      updatedRemotePen,
    );
    assert.equal(nextAnalysis.localChanged, true);
    assert.equal(nextAnalysis.remoteChanged, false);
    assert.deepEqual(nextAnalysis.changes, [
      { field: 'title', local: 'Unpushed Local Title', remote: 'Scroll Demo' },
    ]);
  });
});

describe('Pen info syncing integration (127.0.0.1 mock API)', () => {
  let server: http.Server;
  let baseUrl = '';

  const PEN_ID = 'pen-info-sync-1';

  let remoteTitle = 'Initial Title';
  let remoteDescription = 'Initial description';
  let remoteTags = ['css', 'demo'];
  let remoteAccess: PenAccess = 'Public';
  let remoteTemplate = false;
  let remoteVersionCounter = 1;
  let remoteVersionId = 'ver-1';
  let remoteFiles: PenFile[] = [];

  let patchCalls: Array<Record<string, unknown>> = [];
  let putFileCalls: Array<Record<string, unknown>> = [];
  let failNextPatchStatus: number | null = null;

  function makeTextFile(id: string, filePath: string, content: string): PenFile {
    return {
      id,
      path: filePath,
      name: path.posix.basename(filePath),
      content_hash: sha256Hex(content),
      is_binary: false,
      bytes: Buffer.byteLength(content, 'utf8'),
      content_type: 'text/plain',
      content,
      url: null,
      download_url: null,
    };
  }

  function makeCurrentPen(overrides: Partial<Pen> = {}): Pen {
    return {
      id: PEN_ID,
      title: remoteTitle,
      description: remoteDescription,
      tags: [...remoteTags],
      access: remoteAccess,
      password: null,
      template: remoteTemplate,
      popularity: 0,
      views_count: 10,
      loves_count: 2,
      editor: 'V2',
      created_at: '2026-09-01T12:00:00Z',
      updated_at: '2026-09-10T12:00:00Z',
      urls: {
        editor: `https://codepen.io/bramus/pen/${PEN_ID}`,
        preview: `https://${PEN_ID}.codepen.dev/`,
      },
      screenshot_urls: null,
      saved_version: {
        id: remoteVersionId,
        pen_id: PEN_ID,
        hash: `hash-${remoteVersionId}`,
        created_at: '2026-09-10T12:00:00Z',
        deployed: false,
        saved: true,
        label: null,
        build: {
          id: `bld-${remoteVersionId}`,
          status: 'Success',
          started_at: '2026-09-10T12:00:00Z',
          ended_at: '2026-09-10T12:00:01Z',
          rounds: 1,
          diagnostics: [],
          errors: [],
          applied_patches: [],
          patches: [],
          version_id: remoteVersionId,
          next_id: null,
          previous_id: null,
        },
        preview_url: `https://pv-${remoteVersionId}.codepen.dev/`,
      },
      deployment: null,
      settings: {
        auto_deploy: false,
        auto_run: true,
        auto_save: true,
        indent_with: 'spaces',
        tab_size: 2,
      },
      ...overrides,
    };
  }

  function resetRemoteState(): void {
    remoteTitle = 'Initial Title';
    remoteDescription = 'Initial description';
    remoteTags = ['css', 'demo'];
    remoteAccess = 'Public';
    remoteTemplate = false;
    remoteVersionCounter = 1;
    remoteVersionId = 'ver-1';
    remoteFiles = [makeTextFile('f1', '/index.html', '<h1>Hello</h1>\n')];
    patchCalls = [];
    putFileCalls = [];
    failNextPatchStatus = null;
  }

  before(async () => {
    resetRemoteState();

    server = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const rawBody = Buffer.concat(chunks).toString('utf8');

      const sendJson = (status: number, body: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };

      if (req.headers.authorization !== `Bearer ${API_KEY}`) {
        return sendJson(401, { code: 'UNAUTHENTICATED', message: 'invalid key' });
      }

      if (req.method === 'GET' && url.pathname === '/v2/pens') {
        return sendJson(200, [makeCurrentPen()]);
      }

      if (req.method === 'GET' && url.pathname === `/v2/pens/${PEN_ID}`) {
        return sendJson(200, makeCurrentPen());
      }

      if (req.method === 'GET' && url.pathname === `/v2/pens/${PEN_ID}/files`) {
        return sendJson(200, remoteFiles);
      }

      if (req.method === 'PATCH' && url.pathname === `/v2/pens/${PEN_ID}`) {
        const parsed = JSON.parse(rawBody) as Record<string, unknown>;
        patchCalls.push(parsed);

        if (failNextPatchStatus !== null) {
          const status = failNextPatchStatus;
          failNextPatchStatus = null;
          return sendJson(status, { code: 'BAD_USER_INPUT', message: 'Simulated metadata validation error' });
        }

        if (typeof parsed.title === 'string') remoteTitle = parsed.title;
        if (typeof parsed.description === 'string') remoteDescription = parsed.description;
        if (Array.isArray(parsed.tags)) remoteTags = parsed.tags as string[];
        if (typeof parsed.access === 'string') remoteAccess = parsed.access as PenAccess;
        if (typeof parsed.template === 'boolean') remoteTemplate = parsed.template;

        return sendJson(200, makeCurrentPen());
      }

      if (req.method === 'PUT' && url.pathname === `/v2/pens/${PEN_ID}/files`) {
        const parsed = JSON.parse(rawBody) as {
          files?: Array<{ path?: string; content?: string; delete?: boolean }>;
          dry_run?: boolean;
        };
        putFileCalls.push(parsed as Record<string, unknown>);

        const nextFiles = new Map(remoteFiles.map((f) => [f.path, f]));
        for (const change of parsed.files ?? []) {
          if (!change.path) continue;
          if (change.delete) {
            nextFiles.delete(change.path);
          } else {
            nextFiles.set(change.path, makeTextFile(`f-${change.path}`, change.path, change.content ?? ''));
          }
        }

        const newVerId = parsed.dry_run ? `ver-dry-${remoteVersionCounter + 1}` : `ver-${++remoteVersionCounter}`;
        if (!parsed.dry_run) {
          remoteVersionId = newVerId;
          remoteFiles = [...nextFiles.values()];
        }

        const penSnapshot = makeCurrentPen();
        const build = {
          id: `bld-${newVerId}`,
          status: 'Success' as const,
          started_at: '2026-09-10T12:01:00Z',
          ended_at: '2026-09-10T12:01:01Z',
          rounds: 1,
          diagnostics: [],
          errors: [],
          applied_patches: [],
          patches: [],
          version_id: newVerId,
          next_id: null,
          previous_id: null,
        };
        return sendJson(200, {
          pen: penSnapshot,
          version: {
            ...penSnapshot.saved_version,
            id: newVerId,
            files: [...nextFiles.values()],
          },
          build,
        });
      }

      if (req.method === 'GET' && url.pathname.startsWith('/v2/versions/')) {
        const id = url.pathname.split('/').pop()!;
        return sendJson(200, {
          id,
          pen_id: PEN_ID,
          hash: `hash-${id}`,
          created_at: '2026-09-10T12:01:00Z',
          deployed: false,
          saved: true,
          label: null,
          build: null,
          preview_url: `https://pv-${id}.codepen.dev/`,
          files: remoteFiles,
        });
      }

      if (req.method === 'POST' && url.pathname === '/v2/pens') {
        const parsed = JSON.parse(rawBody) as {
          title?: string;
          description?: string;
          tags?: string[];
          access?: PenAccess;
          template?: boolean;
          files?: Array<{ path: string; content: string }>;
        };
        const createdFiles =
          parsed.files && parsed.files.length > 0
            ? parsed.files.map((f, i) => makeTextFile(`cf-${i}`, f.path, f.content))
            : [makeTextFile('cf-0', '/index.html', '<h1>Starter</h1>\n')];
        remoteFiles = createdFiles;
        const createdPen = makeCurrentPen({
          title: parsed.title ?? 'Untitled',
          description: parsed.description ?? '',
          tags: parsed.tags ?? [],
          access: parsed.access ?? 'Public',
          template: Boolean(parsed.template),
          build: {
            id: 'bld-create-1',
            status: 'Success',
            started_at: '2026-09-10T12:00:00Z',
            ended_at: '2026-09-10T12:00:01Z',
            rounds: 1,
            diagnostics: [],
            errors: [],
            applied_patches: [],
            patches: [],
            version_id: remoteVersionId,
            next_id: null,
            previous_id: null,
          },
        });
        return sendJson(201, createdPen);
      }

      if (req.method === 'POST' && url.pathname === `/v2/pens/${PEN_ID}/fork`) {
        const parsed = JSON.parse(rawBody) as {
          title?: string;
          description?: string;
          tags?: string[];
          access?: PenAccess;
        };
        const forkedPen = makeCurrentPen({
          title: parsed.title ?? remoteTitle,
          description: parsed.description ?? remoteDescription,
          tags: parsed.tags ?? remoteTags,
          access: parsed.access ?? remoteAccess,
          build: {
            id: 'bld-fork-1',
            status: 'Success',
            started_at: '2026-09-10T12:00:00Z',
            ended_at: '2026-09-10T12:00:01Z',
            rounds: 1,
            diagnostics: [],
            errors: [],
            applied_patches: [],
            patches: [],
            version_id: remoteVersionId,
            next_id: null,
            previous_id: null,
          },
        });
        return sendJson(201, forkedPen);
      }

      sendJson(404, { code: 'NOT_FOUND', message: `Unhandled ${req.method} ${url.pathname}` });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  });

  it('writes info on clone, new, fork, and first-time push', async () => {
    resetRemoteState();
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-info-life-home-'));
    const tmpWork = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-info-life-work-'));

    try {
      await saveProfileToFile('bramus', API_KEY, { homeDir: tmpHome, setAsDefault: true });

      // 1. clone
      const cloned = await clonePenCommand({
        urlArg: `https://codepen.io/bramus/pen/${PEN_ID}`,
        folderArg: 'cloned-pen',
        cwd: tmpWork,
        baseUrl,
        interactive: false,
        env: {},
        homeDir: tmpHome,
      });
      assert.ok(cloned?.project);
      const cloneCfg = await readProjectConfig(cloned.project.rootDir);
      assert.deepEqual(cloneCfg.info, {
        title: 'Initial Title',
        description: 'Initial description',
        tags: ['css', 'demo'],
        access: 'Public',
        template: false,
      });
      assert.ok(cloneCfg.last_synced_info_hash);

      // 2. new
      const scaffolded = await scaffoldNewPen({
        folderArg: 'new-pen',
        cwd: tmpWork,
        title: 'Scaffolded Pen',
        description: 'Fresh demo',
        tags: ['html', 'js'],
        access: 'Private',
        asTemplate: true,
        baseUrl,
        interactive: false,
        env: {},
        homeDir: tmpHome,
      });
      const newCfg = await readProjectConfig(scaffolded.project.rootDir);
      assert.deepEqual(newCfg.info, {
        title: 'Scaffolded Pen',
        description: 'Fresh demo',
        tags: ['html', 'js'],
        access: 'Private',
        template: true,
      });
      assert.ok(newCfg.last_synced_info_hash);

      // 3. fork
      const forked = await forkPenCommand({
        urlArg: `https://codepen.io/bramus/pen/${PEN_ID}`,
        folderArg: 'forked-pen',
        cwd: tmpWork,
        title: 'Forked Title',
        tags: ['fork'],
        baseUrl,
        interactive: false,
        env: {},
        homeDir: tmpHome,
      });
      assert.ok(forked?.project);
      const forkCfg = await readProjectConfig(forked.project.rootDir);
      assert.deepEqual(forkCfg.info, {
        title: 'Forked Title',
        description: 'Initial description',
        tags: ['fork'],
        access: 'Public',
        template: false,
      });
      assert.ok(forkCfg.last_synced_info_hash);

      // 4. first-time push (createPenFromDirectory)
      const localDemoDir = path.join(tmpWork, 'local-demo');
      await fs.mkdir(localDemoDir, { recursive: true });
      await fs.writeFile(
        path.join(localDemoDir, 'index.html'),
        '<title>From HTML Title</title><h1>Hi</h1>\n',
        'utf8',
      );
      const created = await createPenFromDirectory({
        targetDir: localDemoDir,
        folderDisplay: 'local-demo',
        access: 'Private',
        baseUrl,
        interactive: false,
        env: {},
        homeDir: tmpHome,
      });
      assert.ok(created?.project);
      const createCfg = await readProjectConfig(localDemoDir);
      assert.deepEqual(createCfg.info, {
        title: 'From HTML Title',
        description: '',
        tags: [],
        access: 'Private',
        template: false,
      });
      assert.ok(createCfg.last_synced_info_hash);
    } finally {
      await fs.rm(tmpHome, { recursive: true, force: true });
      await fs.rm(tmpWork, { recursive: true, force: true });
    }
  });

  it('syncs local .cdpn.json info edits via status and push (info-only, dry-run, combined with files, and failure recovery)', async () => {
    resetRemoteState();
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-info-push-home-'));
    const tmpWork = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-info-push-work-'));

    try {
      await saveProfileToFile('bramus', API_KEY, { homeDir: tmpHome, setAsDefault: true });

      const cloned = await clonePenCommand({
        urlArg: `https://codepen.io/bramus/pen/${PEN_ID}`,
        folderArg: 'demo',
        cwd: tmpWork,
        baseUrl,
        interactive: false,
        env: {},
        homeDir: tmpHome,
      });
      assert.ok(cloned?.project);
      const dir = cloned.project.rootDir;
      const client = new CodePenClient({ apiKey: API_KEY, baseUrl });

      // 1. Author edits title, description, tags, access, and template directly in .cdpn.json (0 file edits)
      const cfg1 = await readProjectConfig(dir);
      cfg1.info = {
        title: 'Author Controlled Title',
        description: 'Updated description from .cdpn.json',
        tags: ['css', 'animations', 'v2'],
        access: 'Private',
        template: true,
      };
      await writeProjectConfig(dir, cfg1);

      // status --json reports all 5 info changes
      const { output: statusJsonOut } = await captureStdout(() =>
        statusPenCommand({ cwd: dir, json: true, baseUrl, env: {}, homeDir: tmpHome }),
      );
      const statusEnv = JSON.parse(statusJsonOut) as {
        status: { code: number; message: string };
        contents: {
          up_to_date: boolean;
          info_tracked: boolean;
          info_local_changed: boolean;
          info_remote_changed: boolean;
          info_changes: Array<{ field: string; local: unknown; remote: unknown }>;
        };
      };
      assert.equal(statusEnv.status.code, 200);
      assert.equal(statusEnv.contents.up_to_date, false);
      assert.equal(statusEnv.contents.info_tracked, true);
      assert.equal(statusEnv.contents.info_local_changed, true);
      assert.equal(statusEnv.contents.info_remote_changed, false);
      assert.deepEqual(
        statusEnv.contents.info_changes.map((c) => c.field),
        ['title', 'description', 'tags', 'access', 'template'],
      );

      // 2. push --dry-run reports infoChanges without calling PATCH or modifying .cdpn.json
      const projForDry = (await findProject(dir))!;
      const dryRes = await executePush(client, projForDry, { dryRun: true, silent: true });
      assert.equal(dryRes.pushed, false);
      assert.equal(dryRes.dryRun, true);
      assert.equal(dryRes.infoChanges.length, 5);
      assert.equal(patchCalls.length, 0);
      assert.equal(putFileCalls.length, 0);
      assert.equal(remoteTitle, 'Initial Title');

      // 3. Real push with 0 file edits -> calls PATCH only, no PUT /files
      const projForInfoPush = (await findProject(dir))!;
      const infoPushRes = await executePush(client, projForInfoPush, { silent: true });
      assert.equal(infoPushRes.pushed, true);
      assert.equal(putFileCalls.length, 0, 'Info-only push must not call PUT /files');
      assert.equal(patchCalls.length, 1);
      assert.deepEqual(patchCalls[0], {
        title: 'Author Controlled Title',
        description: 'Updated description from .cdpn.json',
        tags: ['css', 'animations', 'v2'],
        access: 'Private',
        template: true,
      });
      assert.equal(remoteTitle, 'Author Controlled Title');
      assert.equal(remoteAccess, 'Private');
      assert.equal(remoteTemplate, true);

      // status is now completely up to date
      const afterInfoStatus = await statusPenCommand({
        cwd: dir,
        json: true,
        baseUrl,
        env: {},
        homeDir: tmpHome,
      });
      assert.equal(afterInfoStatus.upToDate, true);
      assert.deepEqual(afterInfoStatus.infoAnalysis.changes, []);

      // 4. Combined file + info edit, where PATCH fails after PUT /files succeeds:
      //    file version & hashes must be persisted while local info edit is preserved for retry!
      await fs.writeFile(path.join(dir, 'index.html'), '<h1>Updated File</h1>\n', 'utf8');
      const cfg2 = await readProjectConfig(dir);
      cfg2.info = { ...cfg2.info, title: 'Combined Title Retry' };
      await writeProjectConfig(dir, cfg2);

      failNextPatchStatus = 400;
      const projCombined = (await findProject(dir))!;
      await assert.rejects(() => executePush(client, projCombined, { silent: true }), /Simulated metadata validation error/);

      // Files were pushed and recorded (ver-2), local info edit still present & dirty
      const midCfg = await readProjectConfig(dir);
      assert.equal(midCfg.last_synced_version_id, 'ver-2');
      assert.equal(midCfg.info?.title, 'Combined Title Retry');

      // Retrying push succeeds cleanly with ONLY PATCH (no 409 conflict and no duplicate PUT /files)
      const prevPutCount = putFileCalls.length;
      const projRetry = (await findProject(dir))!;
      const retryRes = await executePush(client, projRetry, { silent: true });
      assert.equal(retryRes.pushed, true);
      assert.equal(putFileCalls.length, prevPutCount, 'Retry should not re-upload already synced files');
      assert.equal(remoteTitle, 'Combined Title Retry');

      // 5. Rejects switching access to Protected via .cdpn.json before any API writes
      const cfgProtected = await readProjectConfig(dir);
      cfgProtected.info = { ...cfgProtected.info, access: 'Protected' };
      await writeProjectConfig(dir, cfgProtected);
      const prevPatchCount = patchCalls.length;
      const projProt = (await findProject(dir))!;
      await assert.rejects(
        () => executePush(client, projProt, { silent: true }),
        /Cannot change Pen access to "Protected" via \.cdpn\.json/i,
      );
      assert.equal(patchCalls.length, prevPatchCount);
    } finally {
      await fs.rm(tmpHome, { recursive: true, force: true });
      await fs.rm(tmpWork, { recursive: true, force: true });
    }
  });

  it('handles remote info changes, conflicts, and local dirty info protection on pull and push', async () => {
    resetRemoteState();
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-info-conflict-home-'));
    const tmpWork = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-info-conflict-work-'));

    try {
      await saveProfileToFile('bramus', API_KEY, { homeDir: tmpHome, setAsDefault: true });

      const cloned = await clonePenCommand({
        urlArg: `https://codepen.io/bramus/pen/${PEN_ID}`,
        folderArg: 'demo',
        cwd: tmpWork,
        baseUrl,
        interactive: false,
        env: {},
        homeDir: tmpHome,
      });
      assert.ok(cloned?.project);
      const dir = cloned.project.rootDir;
      const client = new CodePenClient({ apiKey: API_KEY, baseUrl });

      // 1. Remote title changes on CodePen web UI (local .cdpn.json untouched)
      remoteTitle = 'Edited In CodePen Web UI';

      const statusRemote = await statusPenCommand({
        cwd: dir,
        json: true,
        baseUrl,
        env: {},
        homeDir: tmpHome,
      });
      assert.equal(statusRemote.upToDate, false);
      assert.equal(statusRemote.infoAnalysis.localChanged, false);
      assert.equal(statusRemote.infoAnalysis.remoteChanged, true);

      // Push with NO file edits does NOT clobber the remote title
      const pushNoop = await executePush(client, (await findProject(dir))!, { silent: true });
      assert.equal(pushNoop.pushed, false);
      assert.equal(pushNoop.remoteInfoChanged, true);
      assert.equal(patchCalls.length, 0);
      assert.equal(remoteTitle, 'Edited In CodePen Web UI');

      // Push WITH a local file edit pushes the file without clobbering remote title, and refreshes .cdpn.json
      await fs.writeFile(path.join(dir, 'index.html'), '<h1>Edited CSS/HTML</h1>\n', 'utf8');
      const pushFile = await executePush(client, (await findProject(dir))!, { silent: true });
      assert.equal(pushFile.pushed, true);
      assert.equal(patchCalls.length, 0, 'Must not clobber remote title when local info was untouched');
      assert.equal(remoteTitle, 'Edited In CodePen Web UI');
      const cfgAfterFilePush = await readProjectConfig(dir);
      assert.equal(cfgAfterFilePush.info?.title, 'Edited In CodePen Web UI');

      // 2. Remote changes again -> clean `cdpn pull` pulls new remote info with zero dirty prompt!
      remoteTitle = 'Pulled Remote Title';
      remoteTags = ['pulled'];
      const pulledClean = await pullPenCommand({
        cwd: dir,
        baseUrl,
        interactive: false,
        env: {},
        homeDir: tmpHome,
      });
      assert.ok(pulledClean);
      const cfgAfterPull = await readProjectConfig(dir);
      assert.equal(cfgAfterPull.info?.title, 'Pulled Remote Title');
      assert.deepEqual(cfgAfterPull.info?.tags, ['pulled']);

      // 3. Conflict: BOTH local .cdpn.json AND remote CodePen edit info differently
      cfgAfterPull.info = { ...cfgAfterPull.info, title: 'My Local Conflict Title' };
      await writeProjectConfig(dir, cfgAfterPull);
      remoteTitle = 'Remote Conflict Title';

      // Push without --force throws 409 Conflict
      await assert.rejects(
        async () => executePush(client, (await findProject(dir))!, { silent: true }),
        (err: unknown) => {
          assert.ok(err instanceof CliError);
          assert.equal(err.statusCode, 409);
          assert.match(err.message, /Remote Pen info has changed/i);
          return true;
        },
      );
      assert.equal(patchCalls.length, 0);

      // Pull without --force rejects with 409 and dirty_info: true
      await assert.rejects(
        () =>
          pullPenCommand({
            cwd: dir,
            baseUrl,
            interactive: false,
            env: {},
            homeDir: tmpHome,
          }),
        (err: unknown) => {
          assert.ok(err instanceof CliError);
          assert.equal(err.statusCode, 409);
          assert.deepEqual(err.contents, {
            dirty_files: { added: [], modified: [], deleted: [] },
            dirty_info: true,
          });
          return true;
        },
      );

      // Interactive pull cancel preserves local .cdpn.json edit
      let confirmAsked = false;
      const cancelled = await pullPenCommand({
        cwd: dir,
        baseUrl,
        interactive: true,
        env: {},
        homeDir: tmpHome,
        prompts: {
          confirm: async () => {
            confirmAsked = true;
            return false;
          },
        },
      });
      assert.equal(confirmAsked, true);
      assert.equal(cancelled, null);
      assert.equal((await readProjectConfig(dir)).info?.title, 'My Local Conflict Title');

      // Push WITH --force overwrites remote info with local .cdpn.json
      const forcedPush = await executePush(client, (await findProject(dir))!, {
        force: true,
        silent: true,
      });
      assert.equal(forcedPush.pushed, true);
      assert.equal(patchCalls.length, 1);
      assert.equal(remoteTitle, 'My Local Conflict Title');
      assert.equal((await readProjectConfig(dir)).info?.title, 'My Local Conflict Title');

      // Pull WITH --force overwrites dirty local info edit
      const cfgDirty = await readProjectConfig(dir);
      cfgDirty.info = { ...cfgDirty.info, title: 'Discard Me' };
      await writeProjectConfig(dir, cfgDirty);
      const forcedPull = await pullPenCommand({
        cwd: dir,
        force: true,
        baseUrl,
        interactive: false,
        env: {},
        homeDir: tmpHome,
      });
      assert.ok(forcedPull);
      assert.equal((await readProjectConfig(dir)).info?.title, 'My Local Conflict Title');
    } finally {
      await fs.rm(tmpHome, { recursive: true, force: true });
      await fs.rm(tmpWork, { recursive: true, force: true });
    }
  });

  it('maintains backwards compatibility for legacy .cdpn.json files lacking info', async () => {
    resetRemoteState();
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-info-legacy-home-'));
    const tmpWork = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-info-legacy-work-'));

    try {
      await saveProfileToFile('bramus', API_KEY, { homeDir: tmpHome, setAsDefault: true });
      const client = new CodePenClient({ apiKey: API_KEY, baseUrl });

      const createLegacyProject = async (name: string): Promise<string> => {
        const dir = path.join(tmpWork, name);
        await fs.mkdir(dir, { recursive: true });
        const html = '<h1>Hello</h1>\n';
        await fs.writeFile(path.join(dir, 'index.html'), html, 'utf8');
        await writeProjectConfig(dir, {
          url: `https://codepen.io/bramus/pen/${PEN_ID}`,
          pen_id: PEN_ID,
          profile: 'bramus',
          last_synced_version_id: remoteVersionId,
          editor: 'V2',
          files: buildSyncedFileMap(remoteFiles, new Map([['/index.html', sha256Hex(html)]])),
        });
        return dir;
      };

      // 1. Legacy project + `status` -> up to date, no false info diffs, `info_tracked: false`
      const legacyStatusDir = await createLegacyProject('legacy-status');
      const { output: legacyHumanStatus, result: legacyStatusRes } = await captureStdout(() =>
        statusPenCommand({ cwd: legacyStatusDir, baseUrl, env: {}, homeDir: tmpHome }),
      );
      assert.equal(legacyStatusRes.upToDate, true);
      assert.equal(legacyStatusRes.infoAnalysis.tracked, false);
      assert.deepEqual(legacyStatusRes.infoAnalysis.changes, []);
      assert.match(legacyHumanStatus, /does not include Pen info yet/i);

      // 2. Legacy project + `push --dry-run` -> does NOT modify .cdpn.json or call PATCH
      await executePush(client, (await findProject(legacyStatusDir))!, {
        dryRun: true,
        silent: true,
      });
      assert.equal((await readProjectConfig(legacyStatusDir)).info, undefined);
      assert.equal(patchCalls.length, 0);

      // 3. Legacy project + `push` with 0 file edits -> does NOT call PATCH, backfills info into .cdpn.json
      const backfillRes = await executePush(client, (await findProject(legacyStatusDir))!, {
        silent: true,
      });
      assert.equal(backfillRes.pushed, false);
      assert.equal(patchCalls.length, 0);
      assert.equal(putFileCalls.length, 0);
      assert.equal(remoteTitle, 'Initial Title');
      const upgradedCfg = await readProjectConfig(legacyStatusDir);
      assert.deepEqual(upgradedCfg.info, {
        title: 'Initial Title',
        description: 'Initial description',
        tags: ['css', 'demo'],
        access: 'Public',
        template: false,
      });
      assert.ok(upgradedCfg.last_synced_info_hash);

      // 4. Legacy project + `push` WITH file edit -> pushes file only (NEVER overwrites remote info), upgrades .cdpn.json
      const legacyFileDir = await createLegacyProject('legacy-file-push');
      await fs.writeFile(path.join(legacyFileDir, 'index.html'), '<h1>Legacy Edit</h1>\n', 'utf8');
      const legacyFilePush = await executePush(client, (await findProject(legacyFileDir))!, {
        silent: true,
      });
      assert.equal(legacyFilePush.pushed, true);
      assert.equal(patchCalls.length, 0, 'Must never clobber remote Pen info from a legacy .cdpn.json');
      assert.equal(remoteTitle, 'Initial Title');
      const upgradedAfterFilePush = await readProjectConfig(legacyFileDir);
      assert.equal(upgradedAfterFilePush.info?.title, 'Initial Title');
      assert.ok(upgradedAfterFilePush.last_synced_info_hash);

      // 5. Legacy project + `pull` -> pulls cleanly WITHOUT false dirty warning, upgrades .cdpn.json
      const legacyPullDir = await createLegacyProject('legacy-pull');
      const legacyPulled = await pullPenCommand({
        cwd: legacyPullDir,
        baseUrl,
        interactive: false,
        env: {},
        homeDir: tmpHome,
      });
      assert.ok(legacyPulled);
      const upgradedAfterPull = await readProjectConfig(legacyPullDir);
      assert.equal(upgradedAfterPull.info?.title, 'Initial Title');
      assert.ok(upgradedAfterPull.last_synced_info_hash);

      // 6. Legacy project where author manually adds partial `info: { title: "Manual Title" }`
      const legacyPartialDir = await createLegacyProject('legacy-partial');
      const partialRaw = JSON.parse(
        await fs.readFile(path.join(legacyPartialDir, PROJECT_CONFIG_FILENAME), 'utf8'),
      ) as Record<string, unknown>;
      partialRaw.info = { title: 'Manual Partial Title' };
      await fs.writeFile(
        path.join(legacyPartialDir, PROJECT_CONFIG_FILENAME),
        JSON.stringify(partialRaw, null, 2),
        'utf8',
      );

      const partialPush = await executePush(client, (await findProject(legacyPartialDir))!, {
        silent: true,
      });
      assert.equal(partialPush.pushed, true);
      assert.equal(patchCalls.length, 1);
      assert.deepEqual(patchCalls[0], { title: 'Manual Partial Title' });
      assert.equal(remoteDescription, 'Initial description', 'Omitted fields must not be wiped');
      assert.deepEqual(remoteTags, ['css', 'demo'], 'Omitted tags must not be wiped');
      const fullAfterPartial = await readProjectConfig(legacyPartialDir);
      assert.deepEqual(fullAfterPartial.info, {
        title: 'Manual Partial Title',
        description: 'Initial description',
        tags: ['css', 'demo'],
        access: 'Public',
        template: false,
      });
      assert.ok(fullAfterPartial.last_synced_info_hash);
    } finally {
      await fs.rm(tmpHome, { recursive: true, force: true });
      await fs.rm(tmpWork, { recursive: true, force: true });
    }
  });

  it('keeps .cdpn.json info synced when using `cdpn info` and `cdpn privacy` without leaking passwords', async () => {
    resetRemoteState();
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-info-meta-home-'));
    const tmpWork = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-info-meta-work-'));

    try {
      await saveProfileToFile('bramus', API_KEY, { homeDir: tmpHome, setAsDefault: true });

      const cloned = await clonePenCommand({
        urlArg: `https://codepen.io/bramus/pen/${PEN_ID}`,
        folderArg: 'demo',
        cwd: tmpWork,
        baseUrl,
        interactive: false,
        env: {},
        homeDir: tmpHome,
      });
      assert.ok(cloned?.project);
      const dir = cloned.project.rootDir;
      const client = new CodePenClient({ apiKey: API_KEY, baseUrl });

      // Edit title locally in .cdpn.json, then run `cdpn info --tags "one,two"`
      const cfg = await readProjectConfig(dir);
      cfg.info = { ...cfg.info, title: 'Pending Local Title' };
      await writeProjectConfig(dir, cfg);

      await infoPenCommand({
        cwd: dir,
        tags: 'one, two',
        json: true,
        baseUrl,
        env: {},
        homeDir: tmpHome,
      });

      // Tags synced to .cdpn.json, pending local title edit preserved!
      const afterMetaCfg = await readProjectConfig(dir);
      assert.deepEqual(afterMetaCfg.info?.tags, ['one', 'two']);
      assert.equal(afterMetaCfg.info?.title, 'Pending Local Title');

      // Next push sends ONLY { title: "Pending Local Title" } without conflict
      patchCalls = [];
      const pushRes = await executePush(client, (await findProject(dir))!, { silent: true });
      assert.equal(pushRes.pushed, true);
      assert.deepEqual(patchCalls, [{ title: 'Pending Local Title' }]);

      // `cdpn privacy protected --password ...` updates info.access to Protected and NEVER writes password
      const secretPw = 'supersecretpassword99';
      await managePenPrivacy({
        cwd: dir,
        levelArg: 'protected',
        password: secretPw,
        json: true,
        baseUrl,
        env: {},
        homeDir: tmpHome,
        interactive: false,
      });

      const rawConfigText = await fs.readFile(path.join(dir, PROJECT_CONFIG_FILENAME), 'utf8');
      assert.equal(rawConfigText.includes(secretPw), false, 'Password must NEVER be written to .cdpn.json');
      assert.equal(rawConfigText.includes('"password"'), false);

      const afterPrivCfg = await readProjectConfig(dir);
      assert.equal(afterPrivCfg.info?.access, 'Protected');

      // Pushing a title edit while Pen remains Protected succeeds (does not send `access`)
      afterPrivCfg.info = { ...afterPrivCfg.info, title: 'Protected Pen Renamed' };
      await writeProjectConfig(dir, afterPrivCfg);
      patchCalls = [];
      const renamedProtected = await executePush(client, (await findProject(dir))!, { silent: true });
      assert.equal(renamedProtected.pushed, true);
      assert.deepEqual(patchCalls, [{ title: 'Protected Pen Renamed' }]);
    } finally {
      await fs.rm(tmpHome, { recursive: true, force: true });
      await fs.rm(tmpWork, { recursive: true, force: true });
    }
  });
});
