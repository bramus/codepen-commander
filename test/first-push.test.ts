import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createPenFromDirectory } from '../src/commands/create-pen.js';
import { saveProfileToFile } from '../src/config/auth.js';
import { readProjectConfig } from '../src/config/project.js';
import { extractHtmlTitle } from '../src/utils/html.js';

const KEY_BRAMUS = 'cp_user_bramus_firstpush1234';
const KEY_USERNAME = 'cp_team_user_firstpush5678';

describe('first-time local demo push & HTML title extraction', () => {
  it('extracts and decodes <title> from index.html while ignoring comments', () => {
    assert.equal(
      extractHtmlTitle('<!doctype html><html><head><title>CSS &amp; View Transitions</title></head></html>'),
      'CSS & View Transitions',
    );
    assert.equal(
      extractHtmlTitle('<!-- <title>Old Title</title> --><TITLE lang="en">\n  Scroll\n  Animations &#8212; Demo\n</TITLE>'),
      'Scroll Animations — Demo',
    );
    assert.equal(extractHtmlTitle('<html><head><title>   </title></head></html>'), null);
    assert.equal(extractHtmlTitle('<h1>No title tag here</h1>'), null);
  });

  let server: http.Server;
  let baseUrl = '';
  let capturedRequests: Array<{
    auth: string | undefined;
    body: Record<string, unknown>;
  }> = [];

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

      if (req.method === 'POST' && url.pathname === '/v2/pens') {
        const parsed = JSON.parse(rawBody) as Record<string, unknown>;
        capturedRequests.push({ auth, body: parsed });

        const uploadedFiles = Array.isArray(parsed.files)
          ? (parsed.files as Array<{ path: string; content: string }>)
          : [];
        const responseFiles = [
          {
            id: 'f-cfg',
            path: '/.codepen/pen.config.json',
            name: 'pen.config.json',
            content_hash: 'h-cfg',
            is_binary: false,
            bytes: 2,
            content_type: 'application/json',
            content: '{}',
            url: null,
            download_url: null,
          },
          ...uploadedFiles.map((f, i) => ({
            id: `f-${i}`,
            path: f.path,
            name: path.posix.basename(f.path),
            content_hash: `h-${i}`,
            is_binary: false,
            bytes: Buffer.byteLength(f.content),
            content_type: 'text/plain',
            content: f.content,
            url: null,
            download_url: null,
          })),
        ];

        const pen = {
          id: 'pen-created-1',
          title: (parsed.title as string) || 'Untitled',
          description: '',
          tags: [],
          access: (parsed.access as string) || 'Public',
          password: null,
          template: false,
          popularity: 0,
          views_count: 0,
          loves_count: 0,
          editor: 'V2',
          created_at: '2026-09-01T12:00:00Z',
          updated_at: '2026-09-01T12:00:00Z',
          urls: {
            editor: 'https://codepen.io/username/pen/pen-created-1',
            preview: 'https://pen-created-1.codepen.dev/',
          },
          screenshot_urls: null,
          saved_version: {
            id: 'ver-created-1',
            pen_id: 'pen-created-1',
            hash: 'vhash1',
            created_at: '2026-09-01T12:00:00Z',
            deployed: false,
            saved: true,
            label: null,
            build: null,
            preview_url: 'https://pv-ver1.codepen.dev/',
            files: responseFiles,
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
            id: 'bld-created-1',
            status: 'Success',
            started_at: '2026-09-01T12:00:00Z',
            ended_at: '2026-09-01T12:00:01Z',
            rounds: 1,
            diagnostics: [],
            errors: [],
            applied_patches: [],
            patches: [],
            version_id: 'ver-created-1',
            next_id: null,
            previous_id: null,
          },
        };

        return sendJson(201, pen);
      }

      if (req.method === 'GET' && url.pathname === '/v2/versions/ver-created-1') {
        const last = capturedRequests[capturedRequests.length - 1];
        const uploadedFiles = Array.isArray(last?.body.files)
          ? (last.body.files as Array<{ path: string; content: string }>)
          : [];
        return sendJson(200, {
          id: 'ver-created-1',
          pen_id: 'pen-created-1',
          hash: 'vhash1',
          created_at: '2026-09-01T12:00:00Z',
          deployed: false,
          saved: true,
          label: null,
          build: null,
          preview_url: 'https://pv-ver1.codepen.dev/',
          files: [
            {
              id: 'f-cfg',
              path: '/.codepen/pen.config.json',
              name: 'pen.config.json',
              content_hash: 'h-cfg',
              is_binary: false,
              bytes: 2,
              content_type: 'application/json',
              content: '{}',
              url: null,
              download_url: null,
            },
            ...uploadedFiles.map((f, i) => ({
              id: `f-${i}`,
              path: f.path,
              name: path.posix.basename(f.path),
              content_hash: `h-${i}`,
              is_binary: false,
              bytes: Buffer.byteLength(f.content),
              content_type: 'text/plain',
              content: f.content,
              url: null,
              download_url: null,
            })),
          ],
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

  it('warns and aborts when index.html is missing and user declines confirmation', async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-fp-home-'));
    const tmpDemo = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-fp-noindex-'));
    capturedRequests = [];

    try {
      await saveProfileToFile('bramus', KEY_BRAMUS, { homeDir: tmpHome, setAsDefault: true });
      await fs.writeFile(path.join(tmpDemo, 'style.css'), 'body { color: red; }\n', 'utf8');

      let confirmCalled = false;
      let confirmDefault: boolean | undefined;
      let profilePromptCalled = false;

      const result = await createPenFromDirectory({
        targetDir: tmpDemo,
        folderDisplay: '.',
        baseUrl,
        env: {},
        homeDir: tmpHome,
        interactive: true,
        prompts: {
          confirm: async (_q, def) => {
            confirmCalled = true;
            confirmDefault = def;
            return false;
          },
          select: async () => {
            profilePromptCalled = true;
            return 'Public' as never;
          },
        },
      });

      assert.equal(result, null);
      assert.equal(confirmCalled, true, 'Expected missing index.html confirmation prompt');
      assert.equal(confirmDefault, false, 'Confirmation should default to No');
      assert.equal(profilePromptCalled, false, 'Should abort before asking account/title/access');
      assert.equal(capturedRequests.length, 0, 'Should not call CodePen API when aborted');
    } finally {
      await fs.rm(tmpHome, { recursive: true, force: true });
      await fs.rm(tmpDemo, { recursive: true, force: true });
    }
  });

  it('refuses non-interactive first push without index.html unless --force is passed', async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-fp-home-'));
    const tmpDemo = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-fp-noindex-ni-'));

    try {
      await saveProfileToFile('bramus', KEY_BRAMUS, { homeDir: tmpHome, setAsDefault: true });
      await fs.writeFile(path.join(tmpDemo, 'app.js'), 'console.log(1);\n', 'utf8');

      await assert.rejects(
        () =>
          createPenFromDirectory({
            targetDir: tmpDemo,
            folderDisplay: '.',
            baseUrl,
            env: {},
            homeDir: tmpHome,
            interactive: false,
          }),
        /No index\.html found/,
      );
    } finally {
      await fs.rm(tmpHome, { recursive: true, force: true });
      await fs.rm(tmpDemo, { recursive: true, force: true });
    }
  });

  it('prompts for account (when multiple keys), title (from index.html <title>), and visibility (Public default)', async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-fp-home-'));
    const tmpDemo = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-fp-ok-'));
    capturedRequests = [];

    try {
      await saveProfileToFile('bramus', KEY_BRAMUS, { homeDir: tmpHome, setAsDefault: true });
      await saveProfileToFile('username', KEY_USERNAME, { homeDir: tmpHome });

      await fs.writeFile(
        path.join(tmpDemo, 'index.html'),
        '<!doctype html><html><head><title>Anchor Positioning &amp; Popovers</title></head><body>Hi</body></html>',
        'utf8',
      );
      await fs.writeFile(path.join(tmpDemo, 'style.css'), 'body { margin: 0; }\n', 'utf8');

      const promptOrder: string[] = [];
      let seenDefaultTitle: string | undefined;
      let seenVisibilityDefaultIdx: number | undefined;
      let seenVisibilityChoices: string[] = [];
      let confirmCalled = false;

      const result = await createPenFromDirectory({
        targetDir: tmpDemo,
        folderDisplay: '.',
        baseUrl,
        env: {},
        homeDir: tmpHome,
        interactive: true,
        prompts: {
          confirm: async () => {
            confirmCalled = true;
            return true;
          },
          select: async (question, opts, defaultIdx) => {
            if (question.toLowerCase().includes('account') || question.toLowerCase().includes('profile')) {
              promptOrder.push('account');
              return 'username' as never;
            }
            promptOrder.push('visibility');
            seenVisibilityDefaultIdx = defaultIdx;
            seenVisibilityChoices = opts.map((o) => o.value);
            return 'Private' as never;
          },
          text: async (_question, defaultVal) => {
            promptOrder.push('title');
            seenDefaultTitle = defaultVal;
            return defaultVal ?? '';
          },
        },
      });

      assert.ok(result);
      assert.equal(confirmCalled, false, 'Should NOT warn when index.html is present');
      assert.deepEqual(promptOrder, ['account', 'title', 'visibility']);
      assert.equal(seenDefaultTitle, 'Anchor Positioning & Popovers');
      assert.equal(seenVisibilityDefaultIdx, 0, 'Public should be default (index 0)');
      assert.deepEqual(seenVisibilityChoices, ['Public', 'Private', 'Protected', 'Collaborators']);

      assert.equal(capturedRequests.length, 1);
      assert.equal(capturedRequests[0]?.auth, `Bearer ${KEY_USERNAME}`);
      assert.equal(capturedRequests[0]?.body.title, 'Anchor Positioning & Popovers');
      assert.equal(capturedRequests[0]?.body.access, 'Private');

      // .cdpn.json written with chosen profile & files
      const cfg = await readProjectConfig(tmpDemo);
      assert.equal(cfg.pen_id, 'pen-created-1');
      assert.equal(cfg.profile, 'username');
      assert.equal(cfg.last_synced_version_id, 'ver-created-1');
    } finally {
      await fs.rm(tmpHome, { recursive: true, force: true });
      await fs.rm(tmpDemo, { recursive: true, force: true });
    }
  });

  it('skips account prompt when only 1 key exists and prompts for password when Protected is chosen', async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-fp-home-'));
    const tmpDemo = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-fp-protected-'));
    capturedRequests = [];

    try {
      await saveProfileToFile('bramus', KEY_BRAMUS, { homeDir: tmpHome, setAsDefault: true });
      await fs.writeFile(path.join(tmpDemo, 'index.html'), '<p>No title tag</p>', 'utf8');

      const promptsSeen: string[] = [];
      const result = await createPenFromDirectory({
        targetDir: tmpDemo,
        folderDisplay: '.',
        baseUrl,
        env: {},
        homeDir: tmpHome,
        interactive: true,
        prompts: {
          select: async (question) => {
            promptsSeen.push(question);
            return 'Protected' as never;
          },
          text: async (_q, def) => {
            promptsSeen.push(`title:${def}`);
            return 'Custom Demo Title';
          },
          secret: async () => {
            promptsSeen.push('password');
            return 'supersecret99';
          },
        },
      });

      assert.ok(result);
      // Should NOT have prompted for account since only 1 profile exists
      assert.equal(promptsSeen.length, 3);
      assert.equal(promptsSeen[0], `title:${path.basename(tmpDemo)}`);
      assert.equal(promptsSeen[1], 'Pen visibility:');
      assert.equal(promptsSeen[2], 'password');

      assert.equal(capturedRequests[0]?.auth, `Bearer ${KEY_BRAMUS}`);
      assert.equal(capturedRequests[0]?.body.title, 'Custom Demo Title');
      assert.equal(capturedRequests[0]?.body.access, 'Protected');
      assert.equal(capturedRequests[0]?.body.password, 'supersecret99');
    } finally {
      await fs.rm(tmpHome, { recursive: true, force: true });
      await fs.rm(tmpDemo, { recursive: true, force: true });
    }
  });
});
