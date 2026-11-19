import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { clonePenCommand } from '../src/commands/clone.js';
import { forkPenCommand } from '../src/commands/fork.js';
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
  const CLASSIC_PEN_SLUG = 'v1old';
  const CLASSIC_CONVERTED_ID = '01a22b33-4c5d-6e7f-8a9b-0c1d2e3f4a5b';

  let currentVersionId = 'ver-1';
  let currentFiles: PenFile[] = [];
  let otherFiles: PenFile[] = [];
  let classicFiles: PenFile[] = [];
  let classicConverted = false;
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
    versionId: string | null;
    editor?: 'V2' | 'Classic';
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
    editor: overrides.editor ?? 'V2',
    created_at: '2026-09-01T12:00:00Z',
    updated_at: '2026-09-10T12:00:00Z',
    urls: {
      editor: `https://codepen.io/${overrides.owner}/pen/${overrides.slug}`,
      preview: `https://${overrides.slug}.codepen.dev/`,
    },
    screenshot_urls: null,
    saved_version: overrides.versionId
      ? {
          id: overrides.versionId,
          pen_id: overrides.id,
          hash: `hash-${overrides.versionId}`,
          created_at: '2026-09-10T12:00:00Z',
          deployed: false,
          saved: true,
          label: null,
          build: null,
          preview_url: null,
        }
      : null,
    deployment: null,
    settings: {
      auto_deploy: false,
      auto_run: true,
      auto_save: true,
      indent_with: 'spaces',
      tab_size: 2,
    },
    ...(overrides.withBuild && overrides.versionId
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

      // Own Pen (owned by "username") — API expects clean extracted Pen IDs, not %2F-encoded URLs
      if (
        req.method === 'GET' &&
        (url.pathname === `/v2/pens/${PEN_ID}` || url.pathname === '/v2/pens/abcde')
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

      // CodePen 2.0 editor URL owned by "bramus" (`/editor/bramus/pen/<cpid>`) -> requested by extracted cpid
      if (
        req.method === 'GET' &&
        url.pathname === '/v2/pens/01a11c78-9eba-777b-98a7-fa51e8b7cb08'
      ) {
        const pen = makePen({
          id: '01a11c78-9eba-777b-98a7-fa51e8b7cb08',
          title: 'V2 Editor Demo',
          owner: 'bramus',
          slug: '01a11c78-9eba-777b-98a7-fa51e8b7cb08',
          versionId: 'ver-v2-1',
        });
        pen.urls.editor =
          'https://codepen.io/editor/bramus/pen/01a11c78-9eba-777b-98a7-fa51e8b7cb08';
        return sendJson(200, pen);
      }

      if (
        req.method === 'GET' &&
        (url.pathname === `/v2/pens/${PEN_ID}/files` ||
          url.pathname === '/v2/pens/01a11c78-9eba-777b-98a7-fa51e8b7cb08/files')
      ) {
        return sendJson(200, currentFiles);
      }

      // Another user's Pen (owned by "otheruser")
      if (
        req.method === 'GET' &&
        (url.pathname === `/v2/pens/${OTHER_PEN_ID}` || url.pathname === '/v2/pens/xyz99')
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

      // Classic (v1) Pen owned by "bramus" that can optionally be converted to V2 in-place
      if (
        req.method === 'GET' &&
        (url.pathname === `/v2/pens/${CLASSIC_PEN_SLUG}` ||
          url.pathname === `/v2/pens/${CLASSIC_CONVERTED_ID}`)
      ) {
        if (classicConverted || url.pathname === `/v2/pens/${CLASSIC_CONVERTED_ID}`) {
          const converted = makePen({
            id: CLASSIC_CONVERTED_ID,
            title: 'Legacy Classic Demo',
            owner: 'bramus',
            slug: CLASSIC_CONVERTED_ID,
            versionId: 'ver-converted-1',
            editor: 'V2',
          });
          converted.urls.editor = `https://codepen.io/editor/bramus/pen/${CLASSIC_CONVERTED_ID}`;
          return sendJson(200, converted);
        }

        return sendJson(
          200,
          makePen({
            id: CLASSIC_PEN_SLUG,
            title: 'Legacy Classic Demo',
            owner: 'bramus',
            slug: CLASSIC_PEN_SLUG,
            versionId: null,
            editor: 'Classic',
          }),
        );
      }

      if (
        req.method === 'GET' &&
        (url.pathname === `/v2/pens/${CLASSIC_PEN_SLUG}/files` ||
          url.pathname === `/v2/pens/${CLASSIC_CONVERTED_ID}/files`)
      ) {
        return sendJson(200, classicFiles);
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

      // 3. Interactive clone without [folder] automatically uses URL-matched stored profile ("username") WITHOUT prompting for profile
      let textPromptDefault = '';
      let interactiveSelectCalls = 0;
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
            interactiveSelectCalls++;
            return opts[defaultIdx]!.value;
          },
        },
      });
      assert.ok(clonedCustom);
      assert.equal(
        interactiveSelectCalls,
        0,
        'Should auto-select matching stored profile without prompting interactively',
      );
      assert.equal(clonedCustom.auth.profile, 'username');
      assert.equal(clonedCustom.linked, true);
      assert.equal(clonedCustom.forked, false);
      assert.equal(textPromptDefault, 'scroll-demo');
      assert.equal(clonedCustom.rootDir, path.resolve(tmpWork, 'custom-clone'));
      const customConfig = await readProjectConfig(path.join(tmpWork, 'custom-clone'));
      assert.equal(customConfig.profile, 'username');

      // 4. Cloning by raw Pen ID (no owner in input URL) automatically switches to matching stored profile once Pen owner is known
      let confirmCalledForIdClone = false;
      const clonedById = await clonePenCommand({
        urlArg: PEN_ID,
        folderArg: 'id-clone',
        cwd: tmpWork,
        baseUrl,
        interactive: false,
        env: {},
        homeDir: tmpHome,
        prompts: {
          confirm: async () => {
            confirmCalledForIdClone = true;
            return true;
          },
        },
      });
      assert.ok(clonedById);
      assert.equal(confirmCalledForIdClone, false);
      assert.equal(clonedById.auth.profile, 'username');
      assert.equal(clonedById.linked, true);
      assert.equal(clonedById.forked, false);
      const idConfig = await readProjectConfig(path.join(tmpWork, 'id-clone'));
      assert.equal(idConfig.profile, 'username');

      // 5. Explicit --profile override still wins and detects ownership mismatch (offers to fork / creates unlinked clone if declined)
      let overrideConfirmCalled = false;
      const explicitOverride = await clonePenCommand({
        urlArg: 'https://codepen.io/username/pen/abcde',
        folderArg: 'override-clone',
        explicitProfile: 'bramus',
        cwd: tmpWork,
        baseUrl,
        interactive: true,
        env: {},
        homeDir: tmpHome,
        prompts: {
          confirm: async () => {
            overrideConfirmCalled = true;
            return false;
          },
        },
      });
      assert.ok(explicitOverride);
      assert.equal(overrideConfirmCalled, true);
      assert.equal(explicitOverride.auth.profile, 'bramus');
      assert.equal(explicitOverride.linked, false);
      assert.equal(explicitOverride.project, null);

      // 6. CodePen 2.0 editor URL (`https://codepen.io/editor/bramus/pen/<cpid>`) auto-selects "bramus" with zero prompts
      let v2SelectCalls = 0;
      let v2ConfirmCalls = 0;
      const clonedV2Url = await clonePenCommand({
        urlArg: 'https://codepen.io/editor/bramus/pen/01a11c78-9eba-777b-98a7-fa51e8b7cb08',
        folderArg: 'v2-editor-clone',
        cwd: tmpWork,
        baseUrl,
        interactive: true,
        env: {},
        homeDir: tmpHome,
        prompts: {
          select: async (_q, opts, defaultIdx = 0) => {
            v2SelectCalls++;
            return opts[defaultIdx]!.value;
          },
          confirm: async () => {
            v2ConfirmCalls++;
            return true;
          },
        },
      });
      assert.ok(clonedV2Url);
      assert.equal(v2SelectCalls, 0, 'Must not prompt for profile on /editor/<username>/pen/<cpid> URL');
      assert.equal(v2ConfirmCalls, 0, 'Must not offer to fork when /editor/<username>/pen/<cpid> matches profile');
      assert.equal(clonedV2Url.auth.profile, 'bramus');
      assert.equal(clonedV2Url.linked, true);
      assert.equal(clonedV2Url.forked, false);
      const v2Config = await readProjectConfig(path.join(tmpWork, 'v2-editor-clone'));
      assert.equal(v2Config.profile, 'bramus');
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

  it('fails fast on unowned Pen URLs and offers a browser fork-and-clone fallback for fork and clone', async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-unowned-home-'));
    const tmpSingleHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-unowned-single-'));
    const tmpWork = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-unowned-work-'));

    const FOREIGN_URL =
      'https://codepen.io/editor/chriscoyier/pen/01a1d7ac-929d-7b6d-9867-73987a930c40';
    const OWNED_FORK_URL =
      'https://codepen.io/editor/bramus/pen/01a11c78-9eba-777b-98a7-fa51e8b7cb08';

    try {
      await saveProfileToFile('bramus', KEY_BRAMUS, { homeDir: tmpHome, setAsDefault: true });
      await saveProfileToFile('username', KEY_USERNAME, { homeDir: tmpHome });
      await saveProfileToFile('bramus', KEY_BRAMUS, { homeDir: tmpSingleHome, setAsDefault: true });

      currentFiles = [makeTextFile('f1', '/index.html', 'h-v2', '<h1>Browser Forked</h1>\n')];

      // 1. Multi-profile non-interactive `cdpn fork` fails fast before profile prompt or API calls
      requestLog = [];
      let selectCalls = 0;
      await assert.rejects(
        () =>
          forkPenCommand({
            urlArg: FOREIGN_URL,
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
          }),
        /Cannot fork chriscoyier’s Pen via CodePen API v2[\s\S]*Stored profiles: bramus, username[\s\S]*cdpn clone <your-fork-url>/i,
      );
      assert.equal(selectCalls, 0, 'Should not prompt for profile when failing fast');
      assert.equal(requestLog.length, 0, 'Should fail fast with zero API requests');

      // 2. Multi-profile interactive `cdpn fork` -> opens browser -> user pastes forked URL -> clones under bramus
      requestLog = [];
      const openedUrls: string[] = [];
      let forkSelectCalls = 0;
      const forkedViaBrowser = await forkPenCommand({
        urlArg: FOREIGN_URL,
        folderArg: 'chris-fork',
        cwd: tmpWork,
        baseUrl,
        interactive: true,
        env: {},
        homeDir: tmpHome,
        openBrowser: async (url) => {
          openedUrls.push(url);
          return true;
        },
        prompts: {
          confirm: async () => true,
          text: async () => OWNED_FORK_URL,
          select: async (_q, opts) => {
            forkSelectCalls++;
            return opts[0]!.value;
          },
        },
      });
      assert.ok(forkedViaBrowser);
      assert.equal(forkSelectCalls, 0, 'Should neither prompt on fail-fast nor when cloning matched fork URL');
      assert.deepEqual(openedUrls, [FOREIGN_URL]);
      assert.equal(forkedViaBrowser.forkedInBrowser, true);
      assert.equal(forkedViaBrowser.sourcePen, null);
      assert.equal(forkedViaBrowser.auth.profile, 'bramus');
      assert.equal(forkedViaBrowser.project.rootDir, path.resolve(tmpWork, 'chris-fork'));
      assert.equal(
        await fs.readFile(path.join(tmpWork, 'chris-fork', 'index.html'), 'utf8'),
        '<h1>Browser Forked</h1>\n',
      );
      const forkedCfg = await readProjectConfig(path.join(tmpWork, 'chris-fork'));
      assert.equal(forkedCfg.profile, 'bramus');
      assert.equal(forkedCfg.pen_id, '01a11c78-9eba-777b-98a7-fa51e8b7cb08');

      // 3. Interactive `cdpn clone` on unowned URL -> user declines opening browser -> exits cleanly (null)
      requestLog = [];
      const declinedClone = await clonePenCommand({
        urlArg: FOREIGN_URL,
        cwd: tmpWork,
        baseUrl,
        interactive: true,
        env: {},
        homeDir: tmpHome,
        openBrowser: async () => {
          throw new Error('Must not open browser when declined');
        },
        prompts: {
          confirm: async () => false,
        },
      });
      assert.equal(declinedClone, null);
      assert.equal(requestLog.length, 0);

      // 4. Interactive `cdpn clone` on unowned URL -> opens browser -> user pastes forked URL -> clones cleanly
      const cloneOpenedUrls: string[] = [];
      const clonedViaBrowser = await clonePenCommand({
        urlArg: FOREIGN_URL,
        folderArg: 'chris-clone',
        cwd: tmpWork,
        baseUrl,
        interactive: true,
        env: {},
        homeDir: tmpHome,
        openBrowser: async (url) => {
          cloneOpenedUrls.push(url);
          return true;
        },
        prompts: {
          confirm: async () => true,
          text: async () => OWNED_FORK_URL,
        },
      });
      assert.ok(clonedViaBrowser);
      assert.deepEqual(cloneOpenedUrls, [FOREIGN_URL]);
      assert.equal(clonedViaBrowser.auth.profile, 'bramus');
      assert.equal(clonedViaBrowser.linked, true);
      assert.equal(clonedViaBrowser.rootDir, path.resolve(tmpWork, 'chris-clone'));

      // 5. Single-profile `cdpn fork` hits 404 on API -> catches 404 -> offers browser fallback cleanly
      const singleOpenedUrls: string[] = [];
      const singleExited = await forkPenCommand({
        urlArg: FOREIGN_URL,
        cwd: tmpWork,
        baseUrl,
        interactive: true,
        env: {},
        homeDir: tmpSingleHome,
        openBrowser: async (url) => {
          singleOpenedUrls.push(url);
          return true;
        },
        prompts: {
          confirm: async () => true,
          // User presses Enter without pasting a URL
          text: async () => '',
        },
      });
      assert.equal(singleExited, null);
      assert.deepEqual(singleOpenedUrls, [FOREIGN_URL]);

      // 6. Single-profile non-interactive 404 on raw Pen ID explains CodePen API v2 owner-only scope
      await assert.rejects(
        () =>
          clonePenCommand({
            urlArg: '01a1d7ac-929d-7b6d-9867-73987a930c40',
            cwd: tmpWork,
            baseUrl,
            interactive: false,
            env: {},
            homeDir: tmpSingleHome,
          }),
        /was not found for profile "bramus"[\s\S]*CodePen API v2 keys can only access/i,
      );
    } finally {
      await fs.rm(tmpHome, { recursive: true, force: true });
      await fs.rm(tmpSingleHome, { recursive: true, force: true });
      await fs.rm(tmpWork, { recursive: true, force: true });
    }
  });

  it('offers to convert Classic (v1) Pens in browser or clone them unlinked without .cdpn.json', async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-classic-home-'));
    const tmpWork = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-classic-work-'));

    const CLASSIC_URL = `https://codepen.io/bramus/pen/${CLASSIC_PEN_SLUG}`;
    const CONVERTED_V2_URL = `https://codepen.io/editor/bramus/pen/${CLASSIC_CONVERTED_ID}`;

    try {
      await saveProfileToFile('bramus', KEY_BRAMUS, { homeDir: tmpHome, setAsDefault: true });
      classicFiles = [
        makeTextFile('cf1', '/index.html', 'ch1', '<h1>Classic Pen</h1>\n'),
        makeTextFile('cf2', '/style.css', 'ch2', 'body { color: rebeccapurple; }\n'),
      ];

      // 1. Interactive choice: "Just clone without linking" -> downloads files without .cdpn.json and never opens browser
      classicConverted = false;
      let capturedOptions: Array<{ value: string; label: string }> = [];
      let capturedDefaultIndex: number | undefined;
      const unlinkedInteractive = await clonePenCommand({
        urlArg: CLASSIC_URL,
        folderArg: 'classic-unlinked',
        cwd: tmpWork,
        baseUrl,
        interactive: true,
        env: {},
        homeDir: tmpHome,
        openBrowser: async () => {
          throw new Error('Must not open browser when user chooses clone-unlinked');
        },
        prompts: {
          select: async (_question, opts, defaultIndex) => {
            capturedOptions = opts.map((o) => ({ value: o.value, label: o.label }));
            capturedDefaultIndex = defaultIndex;
            return 'clone-unlinked' as never;
          },
        },
      });

      assert.ok(unlinkedInteractive);
      assert.equal(capturedDefaultIndex, 0);
      assert.deepEqual(
        capturedOptions.map((o) => o.value),
        ['convert', 'clone-unlinked'],
      );
      assert.equal(unlinkedInteractive.linked, false);
      assert.equal(unlinkedInteractive.forked, false);
      assert.equal(unlinkedInteractive.project, null);
      assert.equal(unlinkedInteractive.pen.editor, 'Classic');
      assert.equal(
        await fs.readFile(path.join(tmpWork, 'classic-unlinked', 'index.html'), 'utf8'),
        '<h1>Classic Pen</h1>\n',
      );
      await assert.rejects(
        () => fs.stat(path.join(tmpWork, 'classic-unlinked', PROJECT_CONFIG_FILENAME)),
        /ENOENT/,
        'Classic unlinked clone must not create .cdpn.json',
      );

      // 2. Interactive choice: "Open the Pen to convert it first" -> converts in-place -> Enter -> clones linked V2 Pen
      classicConverted = false;
      const openedInPlace: string[] = [];
      const convertedInPlace = await clonePenCommand({
        urlArg: CLASSIC_URL,
        folderArg: 'classic-converted-inplace',
        cwd: tmpWork,
        baseUrl,
        interactive: true,
        env: {},
        homeDir: tmpHome,
        openBrowser: async (url) => {
          openedInPlace.push(url);
          return true;
        },
        prompts: {
          select: async () => 'convert' as never,
          text: async () => {
            // Simulate the user converting the Pen to CodePen 2.0 in the browser before pressing Enter
            classicConverted = true;
            return '';
          },
        },
      });

      assert.ok(convertedInPlace);
      assert.deepEqual(openedInPlace, [CLASSIC_URL]);
      assert.equal(convertedInPlace.linked, true);
      assert.equal(convertedInPlace.forked, false);
      assert.equal(convertedInPlace.pen.editor, 'V2');
      assert.equal(convertedInPlace.pen.id, CLASSIC_CONVERTED_ID);
      assert.ok(convertedInPlace.project);

      const inPlaceConfig = await readProjectConfig(path.join(tmpWork, 'classic-converted-inplace'));
      assert.equal(inPlaceConfig.pen_id, CLASSIC_CONVERTED_ID);
      assert.equal(inPlaceConfig.url, CONVERTED_V2_URL);
      assert.equal(inPlaceConfig.editor, 'V2');
      assert.equal(inPlaceConfig.profile, 'bramus');
      assert.equal(inPlaceConfig.last_synced_version_id, 'ver-converted-1');

      // 3. Interactive choice: "Open the Pen to convert it first" -> user pastes a new 2.0 Pen URL -> clones linked
      classicConverted = false;
      const openedPasted: string[] = [];
      const convertedPasted = await clonePenCommand({
        urlArg: CLASSIC_URL,
        folderArg: 'classic-converted-pasted',
        cwd: tmpWork,
        baseUrl,
        interactive: true,
        env: {},
        homeDir: tmpHome,
        openBrowser: async (url) => {
          openedPasted.push(url);
          return true;
        },
        prompts: {
          select: async () => 'convert' as never,
          text: async () => CONVERTED_V2_URL,
        },
      });

      assert.ok(convertedPasted);
      assert.deepEqual(openedPasted, [CLASSIC_URL]);
      assert.equal(convertedPasted.linked, true);
      assert.equal(convertedPasted.pen.editor, 'V2');
      assert.equal(convertedPasted.pen.id, CLASSIC_CONVERTED_ID);
      const pastedConfig = await readProjectConfig(path.join(tmpWork, 'classic-converted-pasted'));
      assert.equal(pastedConfig.pen_id, CLASSIC_CONVERTED_ID);
      assert.equal(pastedConfig.url, CONVERTED_V2_URL);
      assert.equal(pastedConfig.editor, 'V2');

      // 4. Pen still Classic on first Enter -> retry menu -> user retries after converting -> browser only opened once
      classicConverted = false;
      const openedRetry: string[] = [];
      const selectAnswersRetry = ['convert', 'retry'];
      let textCallsRetry = 0;
      const retriedThenConverted = await clonePenCommand({
        urlArg: CLASSIC_URL,
        folderArg: 'classic-retried',
        cwd: tmpWork,
        baseUrl,
        interactive: true,
        env: {},
        homeDir: tmpHome,
        openBrowser: async (url) => {
          openedRetry.push(url);
          return true;
        },
        prompts: {
          select: async () => selectAnswersRetry.shift()! as never,
          text: async () => {
            textCallsRetry++;
            if (textCallsRetry === 2) {
              classicConverted = true;
            }
            return '';
          },
        },
      });

      assert.ok(retriedThenConverted);
      assert.equal(openedRetry.length, 1, 'Should not reopen the browser on retry');
      assert.equal(textCallsRetry, 2);
      assert.equal(retriedThenConverted.linked, true);
      assert.equal(retriedThenConverted.pen.editor, 'V2');

      // 5. Pen still Classic on Enter (or invalid pasted URL) -> retry menu -> user chooses clone-unlinked or cancel
      classicConverted = false;
      const selectAnswersFallback = ['convert', 'clone-unlinked'];
      const fallbackUnlinked = await clonePenCommand({
        urlArg: CLASSIC_URL,
        folderArg: 'classic-retry-unlinked',
        cwd: tmpWork,
        baseUrl,
        interactive: true,
        env: {},
        homeDir: tmpHome,
        openBrowser: async () => true,
        prompts: {
          select: async () => selectAnswersFallback.shift()! as never,
          text: async () => 'https://example.com/not-codepen',
        },
      });
      assert.ok(fallbackUnlinked);
      assert.equal(fallbackUnlinked.linked, false);
      assert.equal(fallbackUnlinked.project, null);
      await assert.rejects(
        () => fs.stat(path.join(tmpWork, 'classic-retry-unlinked', PROJECT_CONFIG_FILENAME)),
        /ENOENT/,
      );

      classicConverted = false;
      const selectAnswersCancel = ['convert', 'cancel'];
      const canceled = await clonePenCommand({
        urlArg: CLASSIC_URL,
        folderArg: 'classic-canceled',
        cwd: tmpWork,
        baseUrl,
        interactive: true,
        env: {},
        homeDir: tmpHome,
        openBrowser: async () => true,
        prompts: {
          select: async () => selectAnswersCancel.shift()! as never,
          text: async () => '',
        },
      });
      assert.equal(canceled, null);
      await assert.rejects(
        () => fs.stat(path.join(tmpWork, 'classic-canceled')),
        /ENOENT/,
        'Canceled clone must not create target folder',
      );

      // 6. Non-interactive & --json clone of a Classic Pen -> unlinked local copy without prompting or opening browser
      classicConverted = false;
      const nonInteractiveClassic = await clonePenCommand({
        urlArg: CLASSIC_URL,
        folderArg: 'classic-ci',
        cwd: tmpWork,
        baseUrl,
        interactive: false,
        env: {},
        homeDir: tmpHome,
        openBrowser: async () => {
          throw new Error('Must not open browser non-interactively');
        },
      });
      assert.ok(nonInteractiveClassic);
      assert.equal(nonInteractiveClassic.linked, false);
      assert.equal(nonInteractiveClassic.project, null);
      assert.equal(nonInteractiveClassic.pen.editor, 'Classic');
      await assert.rejects(
        () => fs.stat(path.join(tmpWork, 'classic-ci', PROJECT_CONFIG_FILENAME)),
        /ENOENT/,
      );

      const jsonLogs: string[] = [];
      const origLog = console.log;
      console.log = (...args: unknown[]) => {
        jsonLogs.push(args.map(String).join(' '));
      };
      try {
        await clonePenCommand({
          urlArg: CLASSIC_URL,
          folderArg: 'classic-json',
          cwd: tmpWork,
          baseUrl,
          json: true,
          interactive: false,
          env: {},
          homeDir: tmpHome,
        });
      } finally {
        console.log = origLog;
      }

      const parsedJson = JSON.parse(jsonLogs.join('\n')) as {
        status: { code: number; message: string };
        contents: { linked: boolean; config_path: string | null; pen: Pen };
      };
      assert.equal(parsedJson.status.code, 200);
      assert.equal(parsedJson.contents.linked, false);
      assert.equal(parsedJson.contents.config_path, null);
      assert.equal(parsedJson.contents.pen.editor, 'Classic');
      await assert.rejects(
        () => fs.stat(path.join(tmpWork, 'classic-json', PROJECT_CONFIG_FILENAME)),
        /ENOENT/,
      );
    } finally {
      classicConverted = false;
      await fs.rm(tmpHome, { recursive: true, force: true });
      await fs.rm(tmpWork, { recursive: true, force: true });
    }
  });
});


