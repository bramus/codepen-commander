import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { forkPenCommand } from '../src/commands/fork.js';
import { scaffoldNewPen } from '../src/commands/new.js';
import { saveProfileToFile } from '../src/config/auth.js';
import { readProjectConfig, writeProjectConfig } from '../src/config/project.js';
import type { Pen, PenFile } from '../src/types.js';

const KEY_BRAMUS = 'cp_user_bramus_scaffold1234';
const KEY_USERNAME = 'cp_team_user_scaffold5678';
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function makePen(overrides: Partial<Pen> & { id: string; title: string }): Pen {
  return {
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
      editor: `https://codepen.io/username/pen/${overrides.id}`,
      preview: `https://${overrides.id}.codepen.dev/`,
    },
    screenshot_urls: null,
    saved_version: {
      id: `ver-${overrides.id}`,
      pen_id: overrides.id,
      hash: `hash-${overrides.id}`,
      created_at: '2026-09-10T12:00:00Z',
      deployed: false,
      saved: true,
      label: null,
      build: null,
      preview_url: `https://pv-${overrides.id}.codepen.dev/`,
    },
    deployment: null,
    settings: {
      auto_deploy: false,
      auto_run: true,
      auto_save: true,
      indent_with: 'spaces',
      tab_size: 2,
    },
    build: {
      id: `bld-${overrides.id}`,
      status: 'Success',
      started_at: '2026-09-10T12:00:00Z',
      ended_at: '2026-09-10T12:00:01Z',
      rounds: 1,
      diagnostics: [],
      errors: [],
      applied_patches: [],
      patches: [],
      version_id: `ver-${overrides.id}`,
      next_id: null,
      previous_id: null,
    },
    ...overrides,
  };
}

describe('template-only cdpn new and dedicated cdpn fork', () => {
  let server: http.Server;
  let baseUrl = '';
  let createCalls: Array<{
    auth: string | undefined;
    isMultipart: boolean;
    body: Record<string, unknown>;
    rawBody: string;
  }> = [];
  let forkCalls: Array<{
    auth: string | undefined;
    penId: string;
    body: Record<string, unknown>;
  }> = [];
  let writeFileCalls: Array<{
    auth: string | undefined;
    penId: string;
    body: Record<string, unknown>;
  }> = [];
  let createdFilesByVersion = new Map<string, PenFile[]>();
  let createCounter = 0;

  const TEMPLATE_CSS_ID = 'tpl-css-01';
  const TEMPLATE_CLASSIC_ID = 'tpl-classic-02';
  const SOURCE_PEN_ID = 'pen-source-99';
  const PROTECTED_PEN_ID = 'pen-protected-88';

  before(async () => {
    server = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const auth = req.headers.authorization;
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const rawBody = Buffer.concat(chunks).toString('utf8');

      const sendJson = (status: number, body: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };

      // Signed download route for binary template asset (no auth required)
      if (req.method === 'GET' && url.pathname === `/v2/pens/${TEMPLATE_CSS_ID}/download/img/icon.png`) {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(PNG_BYTES);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/v2/pens') {
        if (url.searchParams.get('template') === 'true') {
          return sendJson(200, [
            makePen({ id: TEMPLATE_CSS_ID, title: 'CSS Demo Base', template: true }),
            makePen({ id: TEMPLATE_CLASSIC_ID, title: 'Classic Starter', template: true, editor: 'Classic' }),
          ]);
        }
        return sendJson(200, []);
      }

      if (req.method === 'GET' && url.pathname === `/v2/pens/${TEMPLATE_CSS_ID}`) {
        return sendJson(200, makePen({ id: TEMPLATE_CSS_ID, title: 'CSS Demo Base', template: true }));
      }

      if (req.method === 'GET' && url.pathname === `/v2/pens/${SOURCE_PEN_ID}`) {
        return sendJson(200, makePen({ id: SOURCE_PEN_ID, title: 'Scroll Cards', access: 'Private' }));
      }

      if (req.method === 'GET' && url.pathname === `/v2/pens/${PROTECTED_PEN_ID}`) {
        return sendJson(200, makePen({ id: PROTECTED_PEN_ID, title: 'Secret Demo', access: 'Protected' }));
      }

      if (req.method === 'GET' && url.pathname === `/v2/pens/${TEMPLATE_CSS_ID}/files`) {
        const files: PenFile[] = [
          {
            id: 'tf-cfg',
            path: '/.codepen/pen.config.json',
            name: 'pen.config.json',
            content_hash: 'hc-cfg',
            is_binary: false,
            bytes: 21,
            content_type: 'application/json',
            content: '{"blocks":["sass-1"]}',
            url: null,
            download_url: null,
          },
          {
            id: 'tf-html',
            path: '/index.html',
            name: 'index.html',
            content_hash: 'hc-html',
            is_binary: false,
            bytes: 29,
            content_type: 'text/html',
            content: '<h1>From CSS Template</h1>\n',
            url: null,
            download_url: null,
          },
          {
            id: 'tf-css',
            path: '/style.scss',
            name: 'style.scss',
            content_hash: 'hc-css',
            is_binary: false,
            bytes: 22,
            content_type: 'text/x-scss',
            content: 'body { color: rebeccapurple; }\n',
            url: null,
            download_url: null,
          },
          {
            id: 'tf-png',
            path: '/img/icon.png',
            name: 'icon.png',
            content_hash: 'hc-png',
            is_binary: true,
            bytes: PNG_BYTES.length,
            content_type: 'image/png',
            content: null,
            url: null,
            download_url: `${baseUrl}/v2/pens/${TEMPLATE_CSS_ID}/download/img/icon.png`,
          },
        ];
        return sendJson(200, files);
      }

      if (req.method === 'POST' && url.pathname === '/v2/pens') {
        createCounter++;
        const penId = `new-pen-${createCounter}`;
        const verId = `ver-${penId}`;
        const contentType = req.headers['content-type'] ?? '';
        const isMultipart = contentType.includes('multipart/form-data');

        let parsed: Record<string, unknown> = {};
        if (isMultipart) {
          const match = rawBody.match(/name="pen"\r\n\r\n([\s\S]*?)\r\n--/);
          if (match?.[1]) {
            parsed = JSON.parse(match[1]) as Record<string, unknown>;
          }
        } else {
          parsed = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
        }

        createCalls.push({ auth, isMultipart, body: parsed, rawBody });

        const uploaded = Array.isArray(parsed.files)
          ? (parsed.files as Array<{ path: string; content: string }>)
          : null;

        let files: PenFile[];
        if (uploaded === null) {
          files = [
            {
              id: 'sf-cfg',
              path: '/.codepen/pen.config.json',
              name: 'pen.config.json',
              content_hash: 'h-scfg',
              is_binary: false,
              bytes: 2,
              content_type: 'application/json',
              content: '{}',
              url: null,
              download_url: null,
            },
            {
              id: 'sf-html',
              path: '/index.html',
              name: 'index.html',
              content_hash: 'h-shtml',
              is_binary: false,
              bytes: 31,
              content_type: 'text/html',
              content: '<h1>CodePen Default Starter</h1>\n',
              url: null,
              download_url: null,
            },
          ];
        } else {
          const hasConfig = uploaded.some((f) => f.path === '/.codepen/pen.config.json');
          files = [
            ...(hasConfig
              ? []
              : [
                  {
                    id: 'sf-cfg',
                    path: '/.codepen/pen.config.json',
                    name: 'pen.config.json',
                    content_hash: 'h-scfg',
                    is_binary: false,
                    bytes: 2,
                    content_type: 'application/json',
                    content: '{}',
                    url: null,
                    download_url: null,
                  },
                ]),
            ...uploaded.map((f, idx) => ({
              id: `f-${idx}`,
              path: f.path.startsWith('/') ? f.path : `/${f.path}`,
              name: path.posix.basename(f.path),
              content_hash: `h-${idx}`,
              is_binary: false,
              bytes: Buffer.byteLength(f.content),
              content_type: 'text/plain',
              content: f.content,
              url: null,
              download_url: null,
            })),
          ];
          if (isMultipart && rawBody.includes('name="/img/icon.png"')) {
            files.push({
              id: 'f-bin',
              path: '/img/icon.png',
              name: 'icon.png',
              content_hash: 'h-bin',
              is_binary: true,
              bytes: PNG_BYTES.length,
              content_type: 'image/png',
              content: null,
              url: null,
              download_url: `${baseUrl}/v2/pens/${TEMPLATE_CSS_ID}/download/img/icon.png`,
            });
          }
        }

        createdFilesByVersion.set(verId, files);

        return sendJson(
          201,
          makePen({
            id: penId,
            title: (parsed.title as string) || 'Untitled',
            description: (parsed.description as string) || '',
            tags: Array.isArray(parsed.tags) ? (parsed.tags as string[]) : [],
            access: (parsed.access as Pen['access']) || 'Public',
            template: Boolean(parsed.template),
          }),
        );
      }

      const writeFilesMatch = url.pathname.match(/^\/v2\/pens\/([^/]+)\/files$/);
      if (req.method === 'PUT' && writeFilesMatch?.[1]) {
        const penId = decodeURIComponent(writeFilesMatch[1]);
        const parsed = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
        writeFileCalls.push({ auth, penId, body: parsed });

        const prevVerId = (parsed.expected_version_id as string | undefined) ?? `ver-${penId}`;
        const nextVerId = `${prevVerId}-blocks`;
        const existingFiles = [...(createdFilesByVersion.get(prevVerId) ?? [])];
        const changes = Array.isArray(parsed.files)
          ? (parsed.files as Array<{ id?: string; path?: string; content?: string }>)
          : [];

        for (const [idx, change] of changes.entries()) {
          if (!change.path || change.content === undefined) continue;
          const normalized = change.path.startsWith('/') ? change.path : `/${change.path}`;
          const existingIdx = existingFiles.findIndex((f) => f.path === normalized);
          const nextFile: PenFile = {
            id: change.id ?? `wf-${idx}`,
            path: normalized,
            name: path.posix.basename(normalized),
            content_hash: `hw-${idx}`,
            is_binary: false,
            bytes: Buffer.byteLength(change.content),
            content_type: 'application/json',
            content: change.content,
            url: null,
            download_url: null,
          };
          if (existingIdx >= 0) {
            existingFiles[existingIdx] = nextFile;
          } else {
            existingFiles.push(nextFile);
          }
        }
        createdFilesByVersion.set(nextVerId, existingFiles);

        return sendJson(200, {
          pen: null,
          version: {
            id: nextVerId,
            pen_id: penId,
            hash: 'vh-blocks',
            created_at: '2026-09-10T12:00:02Z',
            deployed: false,
            saved: true,
            label: null,
            build: null,
            preview_url: null,
          },
          build: {
            id: `bld-${nextVerId}`,
            status: 'Success',
            started_at: '2026-09-10T12:00:02Z',
            ended_at: '2026-09-10T12:00:03Z',
            rounds: 1,
            diagnostics: [],
            errors: [],
            applied_patches: [],
            patches: [],
            version_id: nextVerId,
            next_id: null,
            previous_id: null,
          },
        });
      }

      const forkMatch = url.pathname.match(/^\/v2\/pens\/([^/]+)\/fork$/);
      if (req.method === 'POST' && forkMatch?.[1]) {
        const sourceId = decodeURIComponent(forkMatch[1]);
        createCounter++;
        const penId = `forked-pen-${createCounter}`;
        const verId = `ver-${penId}`;
        const parsed = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
        forkCalls.push({ auth, penId: sourceId, body: parsed });

        createdFilesByVersion.set(verId, [
          {
            id: 'ff-html',
            path: '/index.html',
            name: 'index.html',
            content_hash: 'h-ff',
            is_binary: false,
            bytes: 18,
            content_type: 'text/html',
            content: '<h1>Forked Pen</h1>',
            url: null,
            download_url: null,
          },
        ]);

        const fallbackAccess: Pen['access'] = sourceId === PROTECTED_PEN_ID ? 'Protected' : 'Private';
        const fallbackTitle = sourceId === PROTECTED_PEN_ID ? 'Secret Demo' : 'Scroll Cards';

        return sendJson(
          201,
          makePen({
            id: penId,
            title: (parsed.title as string) || fallbackTitle,
            access: (parsed.access as Pen['access']) || fallbackAccess,
          }),
        );
      }

      const verMatch = url.pathname.match(/^\/v2\/versions\/([^/]+)$/);
      if (req.method === 'GET' && verMatch?.[1]) {
        const verId = verMatch[1];
        const files = createdFilesByVersion.get(verId) ?? [];
        return sendJson(200, {
          id: verId,
          pen_id: verId.replace(/^ver-/, ''),
          hash: 'vh',
          created_at: '2026-09-10T12:00:00Z',
          deployed: false,
          saved: true,
          label: null,
          build: null,
          preview_url: null,
          files,
        });
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

  it('disallows running cdpn new in a non-empty or already-linked folder and refers to cdpn init', async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-new-home-'));
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-new-nonempty-'));
    const existingDemo = path.join(tmpRoot, 'existing-demo');
    createCalls = [];

    try {
      await saveProfileToFile('bramus', KEY_BRAMUS, { homeDir: tmpHome, setAsDefault: true });
      await fs.mkdir(existingDemo, { recursive: true });
      await fs.writeFile(path.join(existingDemo, 'index.html'), '<h1>Existing demo</h1>', 'utf8');

      // 1. Bare `cdpn new` (no folderArg) in a directory with files must be disallowed
      await assert.rejects(
        () =>
          scaffoldNewPen({
            cwd: existingDemo,
            baseUrl,
            env: {},
            homeDir: tmpHome,
            interactive: true,
          }),
        /is not empty[\s\S]*cdpn init/,
      );

      // 2. `cdpn new .` in a directory with files must be disallowed
      await assert.rejects(
        () =>
          scaffoldNewPen({
            folderArg: '.',
            cwd: existingDemo,
            baseUrl,
            env: {},
            homeDir: tmpHome,
            interactive: false,
          }),
        /is not empty[\s\S]*cdpn init/,
      );

      // 3. `cdpn new existing-demo` targeting a non-empty folder must be disallowed
      await assert.rejects(
        () =>
          scaffoldNewPen({
            folderArg: 'existing-demo',
            cwd: tmpRoot,
            baseUrl,
            env: {},
            homeDir: tmpHome,
            interactive: false,
          }),
        /is not empty[\s\S]*cdpn init/,
      );
      assert.equal(createCalls.length, 0, 'Must not call CodePen API when folder is non-empty');

      await writeProjectConfig(existingDemo, {
        url: 'https://codepen.io/bramus/pen/existing',
        pen_id: 'existing',
        last_synced_version_id: null,
      });

      await assert.rejects(
        () =>
          scaffoldNewPen({
            cwd: existingDemo,
            baseUrl,
            env: {},
            homeDir: tmpHome,
            interactive: false,
          }),
        /already contains \.cdpn\.json[\s\S]*cdpn init/,
      );
      assert.equal(createCalls.length, 0);
    } finally {
      await fs.rm(tmpHome, { recursive: true, force: true });
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('presents only CodePen default starter and account CodePen Templates interactively in an empty folder', async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-new-home-'));
    const tmpParent = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-new-parent-'));
    const emptyDemoDir = path.join(tmpParent, 'anchor-popover-demo');
    createCalls = [];

    try {
      await saveProfileToFile('bramus', KEY_BRAMUS, { homeDir: tmpHome, setAsDefault: true });
      await saveProfileToFile('username', KEY_USERNAME, { homeDir: tmpHome });
      await fs.mkdir(emptyDemoDir, { recursive: true });

      let seenTemplateChoices: string[] = [];
      const result = await scaffoldNewPen({
        cwd: emptyDemoDir,
        baseUrl,
        env: {},
        homeDir: tmpHome,
        interactive: true,
        prompts: {
          select: async (question, opts) => {
            if (question.toLowerCase().includes('account') || question.toLowerCase().includes('profile')) {
              return 'username' as never;
            }
            if (question.toLowerCase().includes('template')) {
              seenTemplateChoices = opts.map((o) => o.value);
              return `template:${TEMPLATE_CSS_ID}` as never;
            }
            return 'Private' as never;
          },
          text: async (question, defaultVal) => {
            assert.ok(question.toLowerCase().includes('title'));
            assert.equal(defaultVal, 'anchor-popover-demo');
            return 'Anchor Popover Demo';
          },
        },
      });

      assert.deepEqual(seenTemplateChoices, [
        'default-starter',
        `template:${TEMPLATE_CSS_ID}`,
        `template:${TEMPLATE_CLASSIC_ID}`,
      ]);

      assert.equal(createCalls.length, 1);
      assert.equal(createCalls[0]?.auth, `Bearer ${KEY_USERNAME}`);
      assert.equal(createCalls[0]?.isMultipart, true, 'Template binary asset should upload via multipart');
      assert.equal(createCalls[0]?.body.title, 'Anchor Popover Demo');
      assert.equal(createCalls[0]?.body.access, 'Private');
      assert.equal(createCalls[0]?.body.template, undefined);

      assert.equal(result.project.rootDir, emptyDemoDir);
      assert.equal(
        await fs.readFile(path.join(emptyDemoDir, 'index.html'), 'utf8'),
        '<h1>From CSS Template</h1>\n',
      );
      assert.equal(
        await fs.readFile(path.join(emptyDemoDir, '.codepen', 'pen.config.json'), 'utf8'),
        '{"blocks":["sass-1"]}',
      );
      assert.deepEqual(await fs.readFile(path.join(emptyDemoDir, 'img', 'icon.png')), PNG_BYTES);

      const cfg = await readProjectConfig(emptyDemoDir);
      assert.equal(cfg.profile, 'username');
    } finally {
      await fs.rm(tmpHome, { recursive: true, force: true });
      await fs.rm(tmpParent, { recursive: true, force: true });
    }
  });

  it('supports --template by title and default starter with --as-template', async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-new-home-'));
    const tmpParent = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-new-flags-'));
    createCalls = [];

    try {
      await saveProfileToFile('bramus', KEY_BRAMUS, { homeDir: tmpHome, setAsDefault: true });

      await scaffoldNewPen({
        folderArg: 'from-title-tpl',
        cwd: tmpParent,
        template: 'css demo base',
        title: 'Using Title Match',
        baseUrl,
        env: {},
        homeDir: tmpHome,
        interactive: false,
      });
      assert.equal(
        await fs.readFile(path.join(tmpParent, 'from-title-tpl', 'style.scss'), 'utf8'),
        'body { color: rebeccapurple; }\n',
      );

      await scaffoldNewPen({
        folderArg: 'new-template',
        cwd: tmpParent,
        asTemplate: true,
        baseUrl,
        env: {},
        homeDir: tmpHome,
        interactive: false,
      });
      const starterCall = createCalls[createCalls.length - 1]!;
      assert.equal(starterCall.body.files, undefined);
      assert.equal(starterCall.body.template, true);
      assert.equal(
        await fs.readFile(path.join(tmpParent, 'new-template', 'index.html'), 'utf8'),
        '<h1>CodePen Default Starter</h1>\n',
      );
    } finally {
      await fs.rm(tmpHome, { recursive: true, force: true });
      await fs.rm(tmpParent, { recursive: true, force: true });
    }
  });

  it('cdpn fork <url> [folder] supports explicit folder, prompted/generated folder with -fork fallback, and URL profile matching', async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-fork-home-'));
    const tmpParent = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-fork-work-'));
    forkCalls = [];

    try {
      await saveProfileToFile('bramus', KEY_BRAMUS, { homeDir: tmpHome, setAsDefault: true });
      await saveProfileToFile('username', KEY_USERNAME, { homeDir: tmpHome });

      // 1. Explicit folder + CodePen URL pre-selecting matching profile `username`
      let profileDefaultIdx: number | undefined;
      let profileOptions: string[] = [];
      const explicitRes = await forkPenCommand({
        urlArg: `https://codepen.io/username/pen/${SOURCE_PEN_ID}`,
        folderArg: 'custom-fork-dir',
        cwd: tmpParent,
        title: 'Scroll Cards v2',
        baseUrl,
        env: {},
        homeDir: tmpHome,
        interactive: true,
        prompts: {
          select: async (_q, opts, defaultIdx) => {
            profileOptions = opts.map((o) => o.value);
            profileDefaultIdx = defaultIdx;
            return opts[defaultIdx ?? 0]!.value;
          },
        },
      });

      assert.equal(profileOptions[profileDefaultIdx ?? 0], 'username');
      assert.equal(forkCalls.length, 1);
      assert.equal(forkCalls[0]?.auth, `Bearer ${KEY_USERNAME}`);
      assert.equal(forkCalls[0]?.penId, SOURCE_PEN_ID);
      assert.equal(forkCalls[0]?.body.title, 'Scroll Cards v2');
      assert.equal(
        await fs.readFile(path.join(tmpParent, 'custom-fork-dir', 'index.html'), 'utf8'),
        '<h1>Forked Pen</h1>',
      );
      assert.ok(explicitRes);
      const explicitCfg = await readProjectConfig(explicitRes.project.rootDir);
      assert.equal(explicitCfg.profile, 'username');

      // 2. Omitted folder when `./scroll-cards` is ALREADY occupied -> auto-suggests `scroll-cards-fork`
      await fs.mkdir(path.join(tmpParent, 'scroll-cards'), { recursive: true });
      await fs.writeFile(path.join(tmpParent, 'scroll-cards', 'index.html'), 'original\n', 'utf8');

      let promptedDefaultFolder: string | undefined;
      const autoRes = await forkPenCommand({
        urlArg: `https://codepen.io/username/pen/${SOURCE_PEN_ID}`,
        cwd: tmpParent,
        explicitProfile: 'username',
        baseUrl,
        env: {},
        homeDir: tmpHome,
        interactive: true,
        prompts: {
          text: async (_q, def) => {
            promptedDefaultFolder = def;
            return def ?? '';
          },
        },
      });

      assert.ok(autoRes);
      assert.equal(promptedDefaultFolder, 'scroll-cards-fork');
      assert.equal(autoRes.project.rootDir, path.join(tmpParent, 'scroll-cards-fork'));
      assert.equal(
        await fs.readFile(path.join(tmpParent, 'scroll-cards-fork', 'index.html'), 'utf8'),
        '<h1>Forked Pen</h1>',
      );

      // 3. Omitted folder in non-interactive mode -> auto-generates `scroll-cards-fork-2`
      const nonInteractiveRes = await forkPenCommand({
        urlArg: SOURCE_PEN_ID,
        cwd: tmpParent,
        explicitProfile: 'username',
        baseUrl,
        env: {},
        homeDir: tmpHome,
        interactive: false,
      });
      assert.ok(nonInteractiveRes);
      assert.equal(nonInteractiveRes.project.rootDir, path.join(tmpParent, 'scroll-cards-fork-2'));

      // 4. Rejects non-empty explicit folder before calling API
      const callsBefore = forkCalls.length;
      await assert.rejects(
        () =>
          forkPenCommand({
            urlArg: SOURCE_PEN_ID,
            folderArg: 'scroll-cards',
            cwd: tmpParent,
            explicitProfile: 'username',
            baseUrl,
            env: {},
            homeDir: tmpHome,
            interactive: false,
          }),
        /is not empty/,
      );
      assert.equal(forkCalls.length, callsBefore);

      // 5. Protected Pen fork requires password unless access is overridden
      await assert.rejects(
        () =>
          forkPenCommand({
            urlArg: PROTECTED_PEN_ID,
            folderArg: 'protected-no-pw',
            cwd: tmpParent,
            explicitProfile: 'username',
            baseUrl,
            env: {},
            homeDir: tmpHome,
            interactive: false,
          }),
        /requires --password/,
      );

      let secretPromptCalled = false;
      await forkPenCommand({
        urlArg: PROTECTED_PEN_ID,
        folderArg: 'protected-with-pw',
        cwd: tmpParent,
        explicitProfile: 'username',
        baseUrl,
        env: {},
        homeDir: tmpHome,
        interactive: true,
        prompts: {
          secret: async () => {
            secretPromptCalled = true;
            return 'forksecret99';
          },
        },
      });
      assert.equal(secretPromptCalled, true);
      assert.equal(forkCalls[forkCalls.length - 1]?.body.password, 'forksecret99');
    } finally {
      await fs.rm(tmpHome, { recursive: true, force: true });
      await fs.rm(tmpParent, { recursive: true, force: true });
    }
  });

  it('supports --visibility, --blocks, --description, --tags, and --as-template on cdpn new (default starter & template)', async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-new-blocks-home-'));
    const tmpParent = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-new-blocks-dir-'));

    try {
      await saveProfileToFile('bramus', KEY_BRAMUS, { homeDir: tmpHome, setAsDefault: true });

      // 1. Default starter with --visibility, --blocks, --description, --tags, --as-template
      const writeCallsBefore = writeFileCalls.length;
      const defaultRes = await scaffoldNewPen({
        folderArg: 'starter-with-blocks',
        cwd: tmpParent,
        title: 'Blocks Starter',
        description: 'Demo created with extra flags',
        tags: ['css', 'animation'],
        visibility: 'Private',
        blocks: 'packages,classic',
        asTemplate: true,
        baseUrl,
        env: {},
        homeDir: tmpHome,
        interactive: false,
      });

      assert.equal(defaultRes.pen.access, 'Private');
      assert.equal(defaultRes.pen.description, 'Demo created with extra flags');
      assert.deepEqual(defaultRes.pen.tags, ['css', 'animation']);
      assert.equal(defaultRes.pen.template, true);
      assert.deepEqual(defaultRes.blocks, ['classic-1', 'fingerprint-1', 'packages-1', 'validate-1']);
      assert.equal(writeFileCalls.length, writeCallsBefore + 1);

      const penConfigRaw = await fs.readFile(
        path.join(tmpParent, 'starter-with-blocks', '.codepen', 'pen.config.json'),
        'utf8',
      );
      const penConfig = JSON.parse(penConfigRaw) as { blocks: Record<string, { name: string; disabled: boolean }> };
      assert.deepEqual(Object.keys(penConfig.blocks).sort(), [
        'classic-1',
        'fingerprint-1',
        'packages-1',
        'validate-1',
      ]);
      const classicConfigRaw = await fs.readFile(
        path.join(tmpParent, 'starter-with-blocks', '.codepen', 'classic.config.json'),
        'utf8',
      );
      assert.ok(classicConfigRaw.includes('"head"'));

      const linkedCfg = await readProjectConfig(path.join(tmpParent, 'starter-with-blocks'));
      assert.equal(linkedCfg.info?.description, 'Demo created with extra flags');
      assert.deepEqual(linkedCfg.info?.tags, ['css', 'animation']);
      assert.equal(linkedCfg.info?.access, 'Private');
      assert.equal(linkedCfg.info?.template, true);

      // 2. Custom template with --blocks merges pen.config.json directly in initial POST /v2/pens
      const writeCallsBeforeTpl = writeFileCalls.length;
      const tplRes = await scaffoldNewPen({
        folderArg: 'template-with-blocks',
        cwd: tmpParent,
        template: TEMPLATE_CSS_ID,
        title: 'Template With Packages',
        visibility: 'Collaborators',
        blocks: 'packages',
        baseUrl,
        env: {},
        homeDir: tmpHome,
        interactive: false,
      });

      assert.equal(tplRes.pen.access, 'Collaborators');
      assert.equal(writeFileCalls.length, writeCallsBeforeTpl);
      const tplPenConfig = JSON.parse(
        await fs.readFile(path.join(tmpParent, 'template-with-blocks', '.codepen', 'pen.config.json'), 'utf8'),
      ) as { blocks: Record<string, unknown> };
      assert.deepEqual(Object.keys(tplPenConfig.blocks).sort(), [
        'fingerprint-1',
        'packages-1',
        'validate-1',
      ]);

      // 3. Rejects conflicting --access and --visibility before hitting API
      const createCallsBefore = createCalls.length;
      await assert.rejects(
        () =>
          scaffoldNewPen({
            folderArg: 'conflict-dir',
            cwd: tmpParent,
            access: 'Public',
            visibility: 'Private',
            baseUrl,
            env: {},
            homeDir: tmpHome,
            interactive: false,
          }),
        /Conflicting --access/,
      );
      assert.equal(createCalls.length, createCallsBefore);
    } finally {
      await fs.rm(tmpHome, { recursive: true, force: true });
      await fs.rm(tmpParent, { recursive: true, force: true });
    }
  });
});
