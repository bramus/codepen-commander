import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { clonePenCommand } from '../src/commands/clone.js';
import { pullPenCommand } from '../src/commands/pull.js';
import { saveProfileToFile } from '../src/config/auth.js';
import { PROJECT_CONFIG_FILENAME, readProjectConfig } from '../src/config/project.js';
import type { Pen, PenFile } from '../src/types.js';

const KEY_BRAMUS = 'cp_user_bramus_clonepull1234';
const KEY_USERNAME = 'cp_team_username_clonepull5678';

describe('cdpn clone and cdpn pull commands', () => {
  let server: http.Server;
  let baseUrl = '';
  let requestLog: string[] = [];

  const PEN_ID = 'pen-clone-1';
  const OTHER_PEN_ID = 'pen-other-99';
  const FORKED_PEN_ID = 'pen-forked-1';
  const FORKED_VERSION_ID = 'ver-fork-1';

  let currentVersionId = 'ver-1';
  let currentFiles: PenFile[] = [];
  let otherFiles: PenFile[] = [];
  let forkCalls = 0;

  const makeTextFile = (
    id: string,
    filePath: string,
    content_hash: string,
    content: string,
  ): PenFile => ({
    id,
    path: filePath,
    name: path.posix.basename(filePath),
    content_hash,
    is_binary: false,
    bytes: Buffer.byteLength(content, 'utf8'),
    content_type: 'text/plain',
    content,
    url: null,
    download_url: null,
  });

  const makePen = (overrides: {
    id: string;
    title: string;
    owner: string;
    slug: string;
    versionId: string;
    withBuild?: boolean;
  }): Pen => ({
    id: overrides.id,
    title: overrides.title,
    description: '',
    tags: [],
    access: 'Public',
    password: null,
    template: false,
    popularity: 0,
    views_count: 0,
    loves_count: 0,
    editor: 'V2',
    created_at: '2026-09-01T12:00:00Z',
    updated_at: '2026-09-10T12:00:00Z',
    urls: {
      editor: `https://codepen.io/${overrides.owner}/pen/${overrides.slug}`,
      preview: `https://${overrides.slug}.codepen.dev/`,
    },
    screenshot_urls: null,
    saved_version: {
      id: overrides.versionId,
      pen_id: overrides.id,
      hash: `hash-${overrides.versionId}`,
      created_at: '2026-09-10T12:00:00Z',
      deployed: false,
      saved: true,
      label: null,
      build: null,
      preview_url: null,
    },
    deployment: null,
    settings: {
      auto_deploy: false,
      auto_run: true,
      auto_save: true,
      indent_with: 'spaces',
      tab_size: 2,
    },
    ...(overrides.withBuild
      ? {
          build: {
            id: 'build-fork-1',
            status: 'Success' as const,
            started_at: '2026-09-10T12:00:00Z',
            ended_at: '2026-09-10T12:00:01Z',
            rounds: 1,
            diagnostics: [],
            errors: [],
            applied_patches: [],
            patches: [],
            version_id: overrides.versionId,
            next_id: null,
            previous_id: null,
          },
        }
      : {}),
  });

  before(async () => {
    server = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      requestLog.push(`${req.method} ${url.pathname}`);

      const sendJson = (status: number, body: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };

      const auth = req.headers.authorization;
      const callerOwner =
        auth === `Bearer ${KEY_BRAMUS}`
          ? 'bramus'
          : auth === `Bearer ${KEY_USERNAME}`
            ? 'username'
            : null;
      if (!callerOwner) {
        return sendJson(401, { code: 'UNAUTHENTICATED', message: 'invalid key' });
      }

      // `verifyAuth()` / listPens -> returns 1 sample Pen owned by the authenticated key
      if (req.method === 'GET' && url.pathname === '/v2/pens') {
        return sendJson(200, [
          makePen({
            id: `sample-${callerOwner}`,
            title: 'Sample Owned Pen',
            owner: callerOwner,
            slug: 'sample1',
            versionId: 'ver-sample',
          }),
        ]);
      }

      // Own Pen (owned by "username")
      if (
        req.method === 'GET' &&
        (url.pathname === `/v2/pens/${PEN_ID}` ||
          url.pathname === `/v2/pens/${encodeURIComponent('https://codepen.io/username/pen/abcde')}`)
      ) {
        return sendJson(
          200,
          makePen({
            id: PEN_ID,
            title: 'Scroll Demo',
            owner: 'username',
            slug: 'abcde',
            versionId: currentVersionId,
          }),
        );
      }

      if (req.method === 'GET' && url.pathname === `/v2/pens/${PEN_ID}/files`) {
        return sendJson(200, currentFiles);
      }

      // Another user's Pen (owned by "otheruser")
      if (
        req.method === 'GET' &&
        (url.pathname === `/v2/pens/${OTHER_PEN_ID}` ||
          url.pathname === `/v2/pens/${encodeURIComponent('https://codepen.io/otheruser/pen/xyz99')}`)
      ) {
        return sendJson(
          200,
          makePen({
            id: OTHER_PEN_ID,
            title: 'Cool Shader',
            owner: 'otheruser',
            slug: 'xyz99',
            versionId: 'ver-other-1',
          }),
        );
      }

      if (req.method === 'GET' && url.pathname === `/v2/pens/${OTHER_PEN_ID}/files`) {
        return sendJson(200, otherFiles);
      }

      if (req.method === 'POST' && url.pathname === `/v2/pens/${OTHER_PEN_ID}/fork`) {
        forkCalls++;
        return sendJson(
          201,
          makePen({
            id: FORKED_PEN_ID,
            title: 'Cool Shader',
            owner: callerOwner,
            slug: FORKED_PEN_ID,
            versionId: FORKED_VERSION_ID,
            withBuild: true,
          }),
        );
      }

      if (req.method === 'GET' && url.pathname === `/v2/versions/${FORKED_VERSION_ID}`) {
        return sendJson(200, {
          id: FORKED_VERSION_ID,
          pen_id: FORKED_PEN_ID,
          hash: 'hash-fork-1',
          created_at: '2026-09-10T12:00:01Z',
          deployed: false,
          saved: true,
          label: null,
          build: null,
          preview_url: null,
          files: otherFiles,
        });
      }

      if (req.method === 'GET' && url.pathname === `/v2/pens/${FORKED_PEN_ID}/files`) {
        return sendJson(200, otherFiles);
      }

      sendJson(404, { code: 'NOT_FOUND', message: 'Not found' });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  });

  it('clones an owned Pen into an explicit or auto-suggested folder, persists .cdpn.json, and guards non-empty folders', async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-clone-home-'));
    const tmpWork = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-clone-work-'));

    try {
      await saveProfileToFile('bramus', KEY_BRAMUS, { homeDir: tmpHome, setAsDefault: true });
      await saveProfileToFile('username', KEY_USERNAME, { homeDir: tmpHome });

      currentVersionId = 'ver-1';
      currentFiles = [
        makeTextFile('f1', '/index.html', 'h1', '<h1>Version 1</h1>\n'),
        makeTextFile('f2', '/src/style.css', 'h2', 'body { color: red; }\n'),
      ];

      // 1. Clone without [folder] non-interactively -> auto-suggests "scroll-demo" and matches profile "username" from URL
      let selectCalls = 0;
      const cloned = await clonePenCommand({
        urlArg: 'https://codepen.io/username/pen/abcde',
        cwd: tmpWork,
        baseUrl,
        interactive: false,
        env: {},
        homeDir: tmpHome,
        prompts: {
          select: async (_q, opts) => {
            selectCalls++;
            return opts[0]!.value;
          },
        },
      });

      assert.ok(cloned);
      assert.equal(selectCalls, 0);
      assert.equal(cloned.auth.profile, 'username');
      assert.equal(cloned.forked, false);
      assert.equal(cloned.linked, true);
      assert.ok(cloned.project);
      assert.equal(cloned.project.rootDir, path.resolve(tmpWork, 'scroll-demo'));

      const html = await fs.readFile(path.join(tmpWork, 'scroll-demo', 'index.html'), 'utf8');
      assert.equal(html, '<h1>Version 1</h1>\n');

      const config = await readProjectConfig(path.join(tmpWork, 'scroll-demo'));
      assert.equal(config.url, 'https://codepen.io/username/pen/abcde');
      assert.equal(config.pen_id, PEN_ID);
      assert.equal(config.profile, 'username');
      assert.equal(config.last_synced_version_id, 'ver-1');
      assert.ok(config.files?.['/index.html']);
      assert.ok(config.files?.['/src/style.css']);

      // 2. Cloning into the same non-empty folder without --force fails fast before API calls
      requestLog = [];
      await assert.rejects(
        () =>
          clonePenCommand({
            urlArg: 'https://codepen.io/username/pen/abcde',
            folderArg: 'scroll-demo',
            cwd: tmpWork,
            baseUrl,
            interactive: false,
            env: {},
            homeDir: tmpHome,
          }),
        /is not empty/i,
      );
      assert.equal(requestLog.length, 0, 'Should fail fast on non-empty target directory');

      // 3. Interactive clone without [folder] pre-selects URL-matched profile ("username") and prompts with suggested folder
      let textPromptDefault = '';
      let preselectedProfile = '';
      const clonedCustom = await clonePenCommand({
        urlArg: 'https://codepen.io/username/pen/abcde',
        cwd: tmpWork,
        baseUrl,
        interactive: true,
        env: {},
        homeDir: tmpHome,
        prompts: {
          text: async (_q, defaultVal) => {
            textPromptDefault = defaultVal ?? '';
            return 'custom-clone';
          },
          select: async (_q, opts, defaultIdx = 0) => {
            preselectedProfile = opts[defaultIdx]!.value;
            return preselectedProfile as never;
          },
        },
      });
      assert.ok(clonedCustom);
      assert.equal(clonedCustom.linked, true);
      assert.equal(clonedCustom.forked, false);
      assert.equal(preselectedProfile, 'username', 'Should pre-select URL-matching profile interactively');
      assert.equal(textPromptDefault, 'scroll-demo');
      assert.equal(clonedCustom.rootDir, path.resolve(tmpWork, 'custom-clone'));
      const customConfig = await readProjectConfig(path.join(tmpWork, 'custom-clone'));
      assert.equal(customConfig.profile, 'username');
    } finally {
      await fs.rm(tmpHome, { recursive: true, force: true });
      await fs.rm(tmpWork, { recursive: true, force: true });
    }
  });

  it('offers to fork when cloning another user’s Pen, or creates an unlinked local copy without .cdpn.json', async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-other-home-'));
    const tmpWork = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-other-work-'));

    try {
      await saveProfileToFile('bramus', KEY_BRAMUS, { homeDir: tmpHome, setAsDefault: true });

      otherFiles = [
        makeTextFile('of1', '/index.html', 'oh1', '<h1>Shader by otheruser</h1>\n'),
      ];

      // 1. Interactive clone of another user's Pen -> accepts offer to fork
      forkCalls = 0;
      requestLog = [];
      let forkPromptQuestion = '';
      let forkPromptDefault: boolean | undefined;

      const acceptedFork = await clonePenCommand({
        urlArg: 'https://codepen.io/otheruser/pen/xyz99',
        folderArg: 'forked-shader',
        cwd: tmpWork,
        baseUrl,
        interactive: true,
        env: {},
        homeDir: tmpHome,
        prompts: {
          confirm: async (question, defaultYes) => {
            forkPromptQuestion = question;
            forkPromptDefault = defaultYes;
            return true;
          },
        },
      });

      assert.ok(acceptedFork);
      assert.match(forkPromptQuestion, /Fork this Pen under bramus instead/i);
      assert.equal(forkPromptDefault, true);
      assert.equal(forkCalls, 1);
      assert.equal(acceptedFork.forked, true);
      assert.equal(acceptedFork.linked, true);
      assert.equal(acceptedFork.sourcePen?.id, OTHER_PEN_ID);
      assert.equal(acceptedFork.pen.id, FORKED_PEN_ID);
      assert.ok(acceptedFork.project);

      // Should not have fetched source Pen twice
      const getSourceCalls = requestLog.filter((r) => r.startsWith('GET /v2/pens/') && !r.endsWith('/files'));
      assert.equal(getSourceCalls.length, 1);

      const forkedConfig = await readProjectConfig(path.join(tmpWork, 'forked-shader'));
      assert.equal(forkedConfig.pen_id, FORKED_PEN_ID);
      assert.equal(forkedConfig.url, `https://codepen.io/bramus/pen/${FORKED_PEN_ID}`);
      assert.equal(forkedConfig.profile, 'bramus');
      assert.equal(
        await fs.readFile(path.join(tmpWork, 'forked-shader', 'index.html'), 'utf8'),
        '<h1>Shader by otheruser</h1>\n',
      );

      // 2. Interactive clone of another user's Pen -> declines fork -> local copy WITHOUT .cdpn.json
      forkCalls = 0;
      const declinedFork = await clonePenCommand({
        urlArg: 'https://codepen.io/otheruser/pen/xyz99',
        folderArg: 'unlinked-shader',
        cwd: tmpWork,
        baseUrl,
        interactive: true,
        env: {},
        homeDir: tmpHome,
        prompts: {
          confirm: async () => false,
        },
      });

      assert.ok(declinedFork);
      assert.equal(forkCalls, 0, 'Must not fork on CodePen when user declines');
      assert.equal(declinedFork.forked, false);
      assert.equal(declinedFork.linked, false);
      assert.equal(declinedFork.project, null);
      assert.equal(declinedFork.rootDir, path.resolve(tmpWork, 'unlinked-shader'));
      assert.equal(
        await fs.readFile(path.join(tmpWork, 'unlinked-shader', 'index.html'), 'utf8'),
        '<h1>Shader by otheruser</h1>\n',
      );
      await assert.rejects(
        () => fs.stat(path.join(tmpWork, 'unlinked-shader', PROJECT_CONFIG_FILENAME)),
        /ENOENT/,
        'Unlinked clone must not write .cdpn.json',
      );

      // `cdpn pull` inside the unlinked copy must fail because there is no .cdpn.json
      await assert.rejects(
        () =>
          pullPenCommand({
            cwd: path.join(tmpWork, 'unlinked-shader'),
            baseUrl,
            interactive: false,
            env: {},
            homeDir: tmpHome,
          }),
        /No \.cdpn\.json found/i,
      );

      // 3. Non-interactive clone of another user's Pen -> unlinked local copy without creating a remote fork
      forkCalls = 0;
      const nonInteractiveUnowned = await clonePenCommand({
        urlArg: 'https://codepen.io/otheruser/pen/xyz99',
        folderArg: 'ci-unlinked-shader',
        cwd: tmpWork,
        baseUrl,
        interactive: false,
        env: {},
        homeDir: tmpHome,
      });

      assert.ok(nonInteractiveUnowned);
      assert.equal(forkCalls, 0);
      assert.equal(nonInteractiveUnowned.forked, false);
      assert.equal(nonInteractiveUnowned.linked, false);
      assert.equal(nonInteractiveUnowned.project, null);
      await assert.rejects(
        () => fs.stat(path.join(tmpWork, 'ci-unlinked-shader', PROJECT_CONFIG_FILENAME)),
        /ENOENT/,
      );

      // 4. Profile alias ("work") whose API key actually owns "username" -> recognized as owned (no fork prompt, writes .cdpn.json)
      await saveProfileToFile('work', KEY_USERNAME, { homeDir: tmpHome });
      currentVersionId = 'ver-1';
      currentFiles = [makeTextFile('f1', '/index.html', 'h1', '<h1>Team Pen</h1>\n')];

      let aliasConfirmCalls = 0;
      const aliasOwned = await clonePenCommand({
        urlArg: 'https://codepen.io/username/pen/abcde',
        folderArg: 'alias-owned',
        explicitProfile: 'work',
        cwd: tmpWork,
        baseUrl,
        interactive: true,
        env: {},
        homeDir: tmpHome,
        prompts: {
          confirm: async () => {
            aliasConfirmCalls++;
            return true;
          },
        },
      });
      assert.ok(aliasOwned);
      assert.equal(aliasConfirmCalls, 0, 'Should detect true owner via API key and not prompt to fork');
      assert.equal(aliasOwned.linked, true);
      assert.equal(aliasOwned.forked, false);
      const aliasConfig = await readProjectConfig(path.join(tmpWork, 'alias-owned'));
      assert.equal(aliasConfig.profile, 'work');

      // 5. CODEPEN_API_KEY env var (no profile name) still detects ownership mismatch via API key owner
      let envConfirmCalled = false;
      const envUnowned = await clonePenCommand({
        urlArg: 'https://codepen.io/otheruser/pen/xyz99',
        folderArg: 'env-unlinked',
        cwd: tmpWork,
        baseUrl,
        interactive: true,
        env: { CODEPEN_API_KEY: KEY_BRAMUS },
        homeDir: path.join(tmpHome, 'unused'),
        prompts: {
          confirm: async () => {
            envConfirmCalled = true;
            return false;
          },
        },
      });
      assert.ok(envUnowned);
      assert.equal(envConfirmCalled, true);
      assert.equal(envUnowned.linked, false);
      await assert.rejects(
        () => fs.stat(path.join(tmpWork, 'env-unlinked', PROJECT_CONFIG_FILENAME)),
        /ENOENT/,
      );
    } finally {
      await fs.rm(tmpHome, { recursive: true, force: true });
      await fs.rm(tmpWork, { recursive: true, force: true });
    }
  });

  it('cdpn pull requires .cdpn.json, syncs remote updates & deletions, and protects uncommitted local changes', async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-pull-home-'));
    const tmpWork = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-pull-work-'));

    try {
      await saveProfileToFile('username', KEY_USERNAME, { homeDir: tmpHome, setAsDefault: true });

      // 1. Running `cdpn pull` outside a clone must fail with zero API calls and point to `cdpn clone`
      requestLog = [];
      await assert.rejects(
        () =>
          pullPenCommand({
            cwd: tmpWork,
            baseUrl,
            interactive: false,
            env: {},
            homeDir: tmpHome,
          }),
        /No \.cdpn\.json found[\s\S]*cdpn clone <url>/i,
      );
      assert.equal(requestLog.length, 0);

      // 2. Clone initial v1 files
      currentVersionId = 'ver-1';
      currentFiles = [
        makeTextFile('f1', '/index.html', 'h1', '<h1>Version 1</h1>\n'),
        makeTextFile('f2', '/src/old.css', 'h2', 'a { color: blue; }\n'),
      ];

      const cloned = await clonePenCommand({
        urlArg: 'https://codepen.io/username/pen/abcde',
        folderArg: 'my-clone',
        cwd: tmpWork,
        baseUrl,
        interactive: false,
        env: {},
        homeDir: tmpHome,
      });
      assert.ok(cloned?.project);
      const cloneDir = cloned.project.rootDir;

      // 3. Remote advances to v2 (edits index.html, adds app.js, deletes /src/old.css)
      currentVersionId = 'ver-2';
      currentFiles = [
        makeTextFile('f1', '/index.html', 'h1-v2', '<h1>Version 2</h1>\n'),
        makeTextFile('f3', '/app.js', 'h3', 'console.log(2);\n'),
      ];

      // Pull from nested subdirectory inside the clone -> discovers parent .cdpn.json and syncs
      const pulled = await pullPenCommand({
        cwd: path.join(cloneDir, 'src'),
        baseUrl,
        interactive: false,
        env: {},
        homeDir: tmpHome,
      });

      assert.ok(pulled);
      assert.equal(await fs.readFile(path.join(cloneDir, 'index.html'), 'utf8'), '<h1>Version 2</h1>\n');
      assert.equal(await fs.readFile(path.join(cloneDir, 'app.js'), 'utf8'), 'console.log(2);\n');
      await assert.rejects(() => fs.stat(path.join(cloneDir, 'src', 'old.css')), /ENOENT/);
      assert.deepEqual(pulled.deletedPaths, ['/src/old.css']);

      const updatedConfig = await readProjectConfig(cloneDir);
      assert.equal(updatedConfig.last_synced_version_id, 'ver-2');

      // 4. Uncommitted local change blocks non-forced pull (non-interactive rejects; interactive cancel aborts)
      await fs.writeFile(path.join(cloneDir, 'index.html'), '<h1>Local Edit</h1>\n', 'utf8');

      await assert.rejects(
        () =>
          pullPenCommand({
            cwd: cloneDir,
            baseUrl,
            interactive: false,
            env: {},
            homeDir: tmpHome,
          }),
        /Local changes detected/i,
      );

      let confirmCalled = false;
      const aborted = await pullPenCommand({
        cwd: cloneDir,
        baseUrl,
        interactive: true,
        env: {},
        homeDir: tmpHome,
        prompts: {
          confirm: async () => {
            confirmCalled = true;
            return false;
          },
        },
      });
      assert.equal(confirmCalled, true);
      assert.equal(aborted, null);
      assert.equal(await fs.readFile(path.join(cloneDir, 'index.html'), 'utf8'), '<h1>Local Edit</h1>\n');

      // 5. `--force` overwrites local edits with remote version
      const forced = await pullPenCommand({
        cwd: cloneDir,
        force: true,
        baseUrl,
        interactive: false,
        env: {},
        homeDir: tmpHome,
      });
      assert.ok(forced);
      assert.equal(await fs.readFile(path.join(cloneDir, 'index.html'), 'utf8'), '<h1>Version 2</h1>\n');
    } finally {
      await fs.rm(tmpHome, { recursive: true, force: true });
      await fs.rm(tmpWork, { recursive: true, force: true });
    }
  });
});
