import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { scaffoldNewPen } from '../src/commands/new.js';
import { buildStarterFiles, parseCustomFileList } from '../src/commands/scaffold.js';
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

describe('cdpn new scaffolding & templates', () => {
  it('generates escaped HTML5 starter files and links stylesheets/scripts accurately', () => {
    const files = buildStarterFiles(
      ['index.html', 'src/style.scss', 'src/app.ts', 'data.json'],
      'A & B <Demo>',
    );
    assert.deepEqual(
      files.map((f) => f.path),
      ['/index.html', '/src/style.scss', '/src/app.ts', '/data.json'],
    );
    const html = files[0]!.content;
    assert.ok(html.includes('<title>A &amp; B &lt;Demo&gt;</title>'));
    assert.ok(html.includes('<link rel="stylesheet" href="src/style.scss">'));
    assert.ok(html.includes('<script type="module" src="src/app.ts"></script>'));
    assert.equal(files[1]!.content, '');
    assert.equal(files[2]!.content, '');
    assert.equal(files[3]!.content, '{}\n');

    assert.throws(() => parseCustomFileList('../escape.html'), /Unsafe path segment/);
    assert.throws(() => parseCustomFileList('.cdpn.json'), /reserved path/);
    assert.throws(() => parseCustomFileList('.cdpnignore'), /reserved CLI file/);
  });

  let server: http.Server;
  let baseUrl = '';
  let createCalls: Array<{
    auth: string | undefined;
    isMultipart: boolean;
    body: Record<string, unknown>;
    rawBody: string;
  }> = [];
  let forkCalls: Array<{
    penId: string;
    body: Record<string, unknown>;
  }> = [];
  let createdFilesByVersion = new Map<string, PenFile[]>();
  let createCounter = 0;

  const TEMPLATE_CSS_ID = 'tpl-css-01';
  const TEMPLATE_BLANK_ID = 'tpl-blank-02';
  const EXISTING_PEN_ID = 'pen-source-99';

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
            makePen({ id: TEMPLATE_BLANK_ID, title: 'Blank Starter', template: true, editor: 'Classic' }),
          ]);
        }
        return sendJson(200, []);
      }

      if (req.method === 'GET' && url.pathname === `/v2/pens/${TEMPLATE_CSS_ID}`) {
        return sendJson(200, makePen({ id: TEMPLATE_CSS_ID, title: 'CSS Demo Base', template: true }));
      }

      if (req.method === 'GET' && url.pathname === `/v2/pens/${EXISTING_PEN_ID}`) {
        return sendJson(200, makePen({ id: EXISTING_PEN_ID, title: 'Original Pen', template: false }));
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
          // CodePen's built-in default starter files
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

        const created = makePen({
          id: penId,
          title: (parsed.title as string) || 'Untitled',
          access: (parsed.access as Pen['access']) || 'Public',
          template: Boolean(parsed.template),
        });
        return sendJson(201, created);
      }

      if (req.method === 'POST' && url.pathname === `/v2/pens/${EXISTING_PEN_ID}/fork`) {
        createCounter++;
        const penId = `forked-pen-${createCounter}`;
        const verId = `ver-${penId}`;
        const parsed = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
        forkCalls.push({ penId: EXISTING_PEN_ID, body: parsed });

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

        return sendJson(
          201,
          makePen({
            id: penId,
            title: (parsed.title as string) || 'Original Pen',
            access: (parsed.access as Pen['access']) || 'Public',
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

  it('refuses to scaffold into a non-empty folder or already-linked folder and points to cdpn push', async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-new-home-'));
    const tmpWork = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-new-nonempty-'));
    createCalls = [];

    try {
      await saveProfileToFile('bramus', KEY_BRAMUS, { homeDir: tmpHome, setAsDefault: true });
      await fs.writeFile(path.join(tmpWork, 'index.html'), '<h1>Existing demo</h1>', 'utf8');

      await assert.rejects(
        () =>
          scaffoldNewPen({
            folderArg: '.',
            cwd: tmpWork,
            baseUrl,
            env: {},
            homeDir: tmpHome,
            interactive: false,
          }),
        /is not empty[\s\S]*cdpn push/,
      );
      assert.equal(createCalls.length, 0, 'Must not call CodePen API when folder is non-empty');

      await writeProjectConfig(tmpWork, {
        url: 'https://codepen.io/bramus/pen/existing',
        pen_id: 'existing',
        last_synced_version_id: null,
      });

      await assert.rejects(
        () =>
          scaffoldNewPen({
            folderArg: '.',
            cwd: tmpWork,
            baseUrl,
            env: {},
            homeDir: tmpHome,
            interactive: false,
          }),
        /already contains \.cdpn\.json/,
      );
    } finally {
      await fs.rm(tmpHome, { recursive: true, force: true });
      await fs.rm(tmpWork, { recursive: true, force: true });
    }
  });

  it('fetches CodePen Templates interactively and scaffolds a clean independent Pen with text + binary files', async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-new-home-'));
    const tmpParent = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-new-parent-'));
    createCalls = [];

    try {
      await saveProfileToFile('bramus', KEY_BRAMUS, { homeDir: tmpHome, setAsDefault: true });
      await saveProfileToFile('username', KEY_USERNAME, { homeDir: tmpHome });
      // Make parent non-empty (like ~/demos/) to verify `cdpn new` without folder creates a subfolder!
      await fs.writeFile(path.join(tmpParent, 'other-demo.txt'), 'existing sibling\n', 'utf8');

      let seenScaffoldOptions: string[] = [];
      const result = await scaffoldNewPen({
        cwd: tmpParent,
        baseUrl,
        env: {},
        homeDir: tmpHome,
        interactive: true,
        prompts: {
          select: async (question, opts) => {
            if (question.toLowerCase().includes('account') || question.toLowerCase().includes('profile')) {
              return 'username' as never;
            }
            if (question.toLowerCase().includes('scaffold')) {
              seenScaffoldOptions = opts.map((o) => o.value);
              return `template:${TEMPLATE_CSS_ID}` as never;
            }
            return 'Private' as never;
          },
          text: async (question, defaultVal) => {
            if (question.toLowerCase().includes('title')) {
              return 'Anchor Popover Demo';
            }
            // Local folder prompt should default to slugified title because parent cwd is non-empty!
            assert.equal(defaultVal, 'anchor-popover-demo');
            return defaultVal ?? '';
          },
        },
      });

      assert.ok(seenScaffoldOptions.includes('starter'));
      assert.ok(seenScaffoldOptions.includes(`template:${TEMPLATE_CSS_ID}`));
      assert.ok(seenScaffoldOptions.includes(`template:${TEMPLATE_BLANK_ID}`));
      assert.ok(seenScaffoldOptions.includes('preset:html-css'));
      assert.ok(seenScaffoldOptions.includes('preset:html-css-js'));
      assert.ok(seenScaffoldOptions.includes('preset:blank'));
      assert.ok(seenScaffoldOptions.includes('custom-files'));
      assert.ok(seenScaffoldOptions.includes('from-source'));

      assert.equal(createCalls.length, 1);
      assert.equal(createCalls[0]?.auth, `Bearer ${KEY_USERNAME}`);
      assert.equal(createCalls[0]?.isMultipart, true, 'Template binary asset should upload via multipart');
      assert.equal(createCalls[0]?.body.title, 'Anchor Popover Demo');
      assert.equal(createCalls[0]?.body.access, 'Private');
      assert.equal(createCalls[0]?.body.template, undefined, 'New Pen from template should NOT be marked template');

      const outDir = path.join(tmpParent, 'anchor-popover-demo');
      assert.equal(result.project.rootDir, outDir);
      assert.equal(
        await fs.readFile(path.join(outDir, 'index.html'), 'utf8'),
        '<h1>From CSS Template</h1>\n',
      );
      assert.equal(
        await fs.readFile(path.join(outDir, '.codepen', 'pen.config.json'), 'utf8'),
        '{"blocks":["sass-1"]}',
      );
      assert.deepEqual(await fs.readFile(path.join(outDir, 'img', 'icon.png')), PNG_BYTES);

      const cfg = await readProjectConfig(outDir);
      assert.equal(cfg.profile, 'username');
    } finally {
      await fs.rm(tmpHome, { recursive: true, force: true });
      await fs.rm(tmpParent, { recursive: true, force: true });
    }
  });

  it('supports --template by title, --scaffold starter, --files custom, --from local dir, and --fork', async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-new-home-'));
    const tmpParent = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-new-flags-'));
    createCalls = [];
    forkCalls = [];

    try {
      await saveProfileToFile('bramus', KEY_BRAMUS, { homeDir: tmpHome, setAsDefault: true });

      // 1. --template by case-insensitive title
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

      // 2. --scaffold starter omits `files` so CodePen supplies its default starter
      await scaffoldNewPen({
        folderArg: 'from-starter',
        cwd: tmpParent,
        scaffold: 'starter',
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
        await fs.readFile(path.join(tmpParent, 'from-starter', 'index.html'), 'utf8'),
        '<h1>CodePen Default Starter</h1>\n',
      );

      // 3. --files custom starter files
      await scaffoldNewPen({
        folderArg: 'from-custom',
        cwd: tmpParent,
        files: 'index.html,style.css',
        title: 'CSS Only Demo',
        baseUrl,
        env: {},
        homeDir: tmpHome,
        interactive: false,
      });
      const customHtml = await fs.readFile(path.join(tmpParent, 'from-custom', 'index.html'), 'utf8');
      assert.ok(customHtml.includes('<title>CSS Only Demo</title>'));
      assert.ok(customHtml.includes('<link rel="stylesheet" href="style.css">'));
      assert.equal(customHtml.includes('<script'), false);

      // 4. --from local template directory (ignoring .cdpn.json inside source dir)
      const localTplDir = path.join(tmpParent, 'my-local-template');
      await fs.mkdir(localTplDir, { recursive: true });
      await fs.writeFile(path.join(localTplDir, 'index.html'), '<main>Local Scaffold</main>', 'utf8');
      await writeProjectConfig(localTplDir, {
        url: 'https://codepen.io/bramus/pen/old',
        pen_id: 'old',
        last_synced_version_id: null,
      });

      await scaffoldNewPen({
        folderArg: 'from-local-dir',
        cwd: tmpParent,
        from: './my-local-template',
        baseUrl,
        env: {},
        homeDir: tmpHome,
        interactive: false,
      });
      assert.equal(
        await fs.readFile(path.join(tmpParent, 'from-local-dir', 'index.html'), 'utf8'),
        '<main>Local Scaffold</main>',
      );
      const localDirCfg = await readProjectConfig(path.join(tmpParent, 'from-local-dir'));
      assert.notEqual(localDirCfg.pen_id, 'old');

      // 5. --fork existing Pen via POST /v2/pens/{id}/fork
      await scaffoldNewPen({
        folderArg: 'from-fork',
        cwd: tmpParent,
        fork: EXISTING_PEN_ID,
        title: 'My Forked Pen',
        baseUrl,
        env: {},
        homeDir: tmpHome,
        interactive: false,
      });
      assert.equal(forkCalls.length, 1);
      assert.equal(forkCalls[0]?.penId, EXISTING_PEN_ID);
      assert.equal(forkCalls[0]?.body.title, 'My Forked Pen');
      assert.equal(
        await fs.readFile(path.join(tmpParent, 'from-fork', 'index.html'), 'utf8'),
        '<h1>Forked Pen</h1>',
      );

      // 6. Rejects combining mutually exclusive scaffold sources
      await assert.rejects(
        () =>
          scaffoldNewPen({
            folderArg: 'bad-combo',
            cwd: tmpParent,
            template: 'CSS Demo Base',
            scaffold: 'html-css',
            baseUrl,
            env: {},
            homeDir: tmpHome,
            interactive: false,
          }),
        /Specify only one scaffold source/,
      );
    } finally {
      await fs.rm(tmpHome, { recursive: true, force: true });
      await fs.rm(tmpParent, { recursive: true, force: true });
    }
  });
});
