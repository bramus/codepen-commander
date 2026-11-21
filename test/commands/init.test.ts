import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { runInitCommand } from '../../src/commands/init.js';
import { readProjectConfigFile, writeProjectConfig } from '../../src/config/project.js';
import { saveProfileToFile } from '../../src/config/user-store.js';
import { CliError } from '../../src/errors.js';
import { startDevServer } from '../../src/site/server.js';
import type { MultiSelectOption } from '../../src/utils/prompts/index.js';

describe('cdpn init command', () => {
  it('asks interactively only for title, visibility, blocks (with validate & fingerprint locked), and push confirmation (default No)', async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-init-interactive-'));
    const demoDir = path.join(tmpRoot, 'scroll-cards');
    try {
      await fs.mkdir(demoDir, { recursive: true });
      await fs.writeFile(
        path.join(demoDir, 'index.html'),
        '<!DOCTYPE html><html><head><title>Scroll Cards HTML Title</title></head><body>Hi</body></html>',
      );
      await fs.writeFile(
        path.join(demoDir, 'package.json'),
        JSON.stringify({ dependencies: { gsap: '3.12.5' } }),
      );
      await fs.writeFile(path.join(demoDir, 'style.css'), 'body { margin: 0; }');

      const askedText: Array<{ question: string; defaultValue?: string }> = [];
      const askedSelect: string[] = [];
      const askedConfirm: Array<{ question: string; defaultYes?: boolean }> = [];
      let receivedBlockOptions: MultiSelectOption<string>[] = [];

      const res = await runInitCommand({
        cwd: demoDir,
        interactive: true,
        // Extra CLI-only flags should apply without prompting
        description: 'CLI-supplied description',
        tags: ['css', 'scroll'],
        template: true,
        prompts: {
          text: async (question, defaultValue) => {
            askedText.push({ question, defaultValue });
            return 'My Scroll Cards';
          },
          select: async (question) => {
            askedSelect.push(question);
            return 'Private' as never;
          },
          multiSelect: async (_question, options) => {
            receivedBlockOptions = options;
            // Even if caller returned only classic-1, validate-1 & fingerprint-1 are always enforced
            return ['classic-1', 'packages-1'] as never;
          },
          confirm: async (question, defaultYes) => {
            askedConfirm.push({ question, defaultYes });
            return false;
          },
        },
      });

      assert.equal(res.initialized, true);
      assert.equal(res.aborted, false);
      assert.equal(res.pushed, false);
      assert.equal(res.pushResult, null);
      // Verify ONLY title, visibility, blocks, and post-init push offer (default No) were prompted
      assert.equal(askedText.length, 1);
      assert.equal(askedText[0]?.question, 'Pen title');
      assert.equal(askedText[0]?.defaultValue, 'Scroll Cards HTML Title');
      assert.deepEqual(askedSelect, ['Pen visibility']);
      assert.deepEqual(askedConfirm, [
        { question: 'Do you want to push this to CodePen right now?', defaultYes: false },
      ]);

      // Verify validate & fingerprint are locked and checked, and packages was auto-checked due to package.json
      const validateOpt = receivedBlockOptions.find((o) => o.value === 'validate-1');
      const fingerprintOpt = receivedBlockOptions.find((o) => o.value === 'fingerprint-1');
      const packagesOpt = receivedBlockOptions.find((o) => o.value === 'packages-1');
      const classicOpt = receivedBlockOptions.find((o) => o.value === 'classic-1');
      assert.equal(validateOpt?.locked, true);
      assert.equal(validateOpt?.checked, true);
      assert.equal(fingerprintOpt?.locked, true);
      assert.equal(fingerprintOpt?.checked, true);
      assert.equal(packagesOpt?.locked, false);
      assert.equal(packagesOpt?.checked, true);
      assert.equal(classicOpt?.locked, false);
      assert.equal(classicOpt?.checked, false);

      // Verify unlinked .cdpn.json contents
      const parsedCdpn = await readProjectConfigFile(demoDir);
      assert.equal(parsedCdpn.linked, false);
      assert.equal(parsedCdpn.config.info.title, 'My Scroll Cards');
      assert.equal(parsedCdpn.config.info.description, 'CLI-supplied description');
      assert.deepEqual(parsedCdpn.config.info.tags, ['css', 'scroll']);
      assert.equal(parsedCdpn.config.info.access, 'Private');
      assert.equal(parsedCdpn.config.info.template, true);

      // Verify .codepen/pen.config.json & starter .codepen/classic.config.json
      const penConfig = JSON.parse(
        await fs.readFile(path.join(demoDir, '.codepen', 'pen.config.json'), 'utf8'),
      ) as { blocks: Record<string, { name: string; disabled: boolean; version: string }> };
      assert.deepEqual(Object.keys(penConfig.blocks).sort(), [
        'classic-1',
        'fingerprint-1',
        'packages-1',
        'validate-1',
      ]);
      assert.equal(penConfig.blocks['validate-1']?.disabled, false);
      assert.equal(penConfig.blocks['fingerprint-1']?.disabled, false);

      const classicConfig = JSON.parse(
        await fs.readFile(path.join(demoDir, '.codepen', 'classic.config.json'), 'utf8'),
      ) as { styles: string[]; scripts: string[] };
      assert.deepEqual(classicConfig.styles, ['/style.css']);
      assert.deepEqual(classicConfig.scripts, []);
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('supports non-interactive CLI flags, always keeps validate & fingerprint, and enforces overwrite and symlink guards', async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-init-flags-'));
    const demoDir = path.join(tmpRoot, 'flag-demo');
    const linkedDir = path.join(tmpRoot, 'linked-demo');
    const symlinkDemoDir = path.join(tmpRoot, 'symlink-demo');
    const outsideDir = path.join(tmpRoot, 'outside');

    try {
      // 1. Non-interactive init creates target dir & initializes with empty --blocks (still keeps validate + fingerprint)
      const res = await runInitCommand({
        cwd: tmpRoot,
        dirArg: 'flag-demo',
        title: 'Flag Demo',
        visibility: 'Collaborators',
        blocks: '',
        description: 'Initialized via flags',
        tags: ['codepen', 'demo'],
        template: false,
        interactive: false,
      });

      assert.equal(res.initialized, true);
      assert.deepEqual(res.blocks, ['fingerprint-1', 'validate-1']);
      assert.equal(res.classicConfigPath, null);
      await assert.rejects(() => fs.stat(path.join(demoDir, '.codepen', 'classic.config.json')));

      // 2. Re-running non-interactively on existing unlinked .cdpn.json rejects with 409 without --force
      await assert.rejects(
        () => runInitCommand({ cwd: demoDir, interactive: false }),
        (err: unknown) => err instanceof CliError && err.statusCode === 409,
      );

      // Interactive decline aborts cleanly
      const aborted = await runInitCommand({
        cwd: demoDir,
        interactive: true,
        prompts: { confirm: async () => false },
      });
      assert.equal(aborted.initialized, false);
      assert.equal(aborted.aborted, true);

      // Re-running with --force overwrites and updates blocks
      const forced = await runInitCommand({
        cwd: demoDir,
        title: 'Flag Demo v2',
        access: 'Public',
        blocks: 'packages',
        force: true,
        interactive: false,
      });
      assert.equal(forced.initialized, true);
      assert.equal(forced.info.title, 'Flag Demo v2');
      assert.deepEqual(forced.blocks, ['fingerprint-1', 'packages-1', 'validate-1']);

      // 3. Linked .cdpn.json rejects with 409 without --force
      await fs.mkdir(linkedDir, { recursive: true });
      await writeProjectConfig(linkedDir, {
        url: 'https://codepen.io/bramus/pen/abc123',
        pen_id: 'abc123',
        last_synced_version_id: 'v1',
        editor: 'V2',
        info: { title: 'Linked Pen' },
        files: {},
      });
      await assert.rejects(
        () => runInitCommand({ cwd: linkedDir, interactive: false }),
        (err: unknown) => err instanceof CliError && err.statusCode === 409,
      );

      // 4. Rejects conflicting --access and --visibility, and > 5 tags
      await assert.rejects(
        () => runInitCommand({ cwd: tmpRoot, dirArg: 'bad-access', access: 'Public', visibility: 'Private', interactive: false }),
        (err: unknown) => err instanceof CliError && err.statusCode === 400,
      );
      await assert.rejects(
        () =>
          runInitCommand({
            cwd: tmpRoot,
            dirArg: 'too-many-tags',
            tags: ['1', '2', '3', '4', '5', '6'],
            interactive: false,
          }),
        (err: unknown) => err instanceof CliError && err.statusCode === 400,
      );

      // 5. Rejects symlinked .codepen directory
      await fs.mkdir(symlinkDemoDir, { recursive: true });
      await fs.mkdir(outsideDir, { recursive: true });
      await fs.symlink(outsideDir, path.join(symlinkDemoDir, '.codepen'));
      await assert.rejects(
        () => runInitCommand({ cwd: symlinkDemoDir, interactive: false }),
        (err: unknown) => err instanceof CliError && err.statusCode === 400,
      );
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('makes an unmarked demo folder discoverable and servable by cdpn serve immediately after cdpn init', async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-init-serve-e2e-'));
    const demoDir = path.join(tmpRoot, 'cool-demo');
    try {
      await fs.mkdir(demoDir, { recursive: true });
      await fs.writeFile(
        path.join(demoDir, 'index.html'),
        '<!DOCTYPE html><html><head><title>Cool Demo</title></head><body><h1>Hello!</h1></body></html>',
      );

      // Before `cdpn init`: unmarked subdirectory is NOT indexed and returns 404
      const beforeServer = await startDevServer({
        targetDir: tmpRoot,
        port: 0,
        allowEphemeralPort: true,
      });
      try {
        assert.equal(beforeServer.demoCount, 0);
        const beforeRes = await fetch(`${beforeServer.url}/cool-demo/`);
        assert.equal(beforeRes.status, 404);
        const shellHtml = await (await fetch(`${beforeServer.url}/`)).text();
        assert.ok(
          shellHtml.includes('Missing a demo? Run <code>cdpn init</code> in it to mark it as a CodePen demo.'),
        );
      } finally {
        await beforeServer.close();
      }

      // Run `cdpn init` in `cool-demo`
      await runInitCommand({
        cwd: tmpRoot,
        dirArg: 'cool-demo',
        title: 'Cool Initialized Demo',
        description: 'Now discovered by cdpn serve',
        tags: ['css'],
        visibility: 'Public',
        blocks: 'packages',
        interactive: false,
      });

      // After `cdpn init`: subdirectory IS indexed in demos.json and served at 200
      const afterServer = await startDevServer({
        targetDir: tmpRoot,
        port: 0,
        allowEphemeralPort: true,
      });
      try {
        assert.equal(afterServer.demoCount, 1);
        const demoRes = await fetch(`${afterServer.url}/cool-demo/`);
        assert.equal(demoRes.status, 200);
        assert.ok((await demoRes.text()).includes('<h1>Hello!</h1>'));

        const manifest = (await (await fetch(`${afterServer.url}/demos.json`)).json()) as {
          standalone: Array<{ title: string; description: string; tags: string[]; path: string }>;
        };
        assert.equal(manifest.standalone.length, 1);
        assert.equal(manifest.standalone[0]?.title, 'Cool Initialized Demo');
        assert.equal(manifest.standalone[0]?.description, 'Now discovered by cdpn serve');
        assert.deepEqual(manifest.standalone[0]?.tags, ['css']);
      } finally {
        await afterServer.close();
      }
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('pushes to CodePen immediately after cdpn init when the user answers Yes to the push prompt', async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-init-push-'));
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-init-push-home-'));
    const demoDir = path.join(tmpRoot, 'push-now-demo');
    const createRequests: Array<{ auth: string | undefined; body: Record<string, unknown> }> = [];

    const server = http.createServer(async (req, res) => {
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

      if (req.method === 'POST' && url.pathname === '/v2/pens') {
        const parsed = JSON.parse(rawBody) as Record<string, unknown>;
        createRequests.push({ auth: req.headers.authorization, body: parsed });

        return sendJson(201, {
          id: 'pen-pushed-1',
          title: (parsed.title as string) || 'Untitled',
          description: (parsed.description as string) || '',
          tags: Array.isArray(parsed.tags) ? parsed.tags : [],
          access: (parsed.access as string) || 'Public',
          password: null,
          template: Boolean(parsed.template),
          popularity: 0,
          views_count: 0,
          loves_count: 0,
          editor: 'V2',
          created_at: '2026-11-21T12:00:00Z',
          updated_at: '2026-11-21T12:00:00Z',
          urls: {
            editor: 'https://codepen.io/bramus/pen/pen-pushed-1',
            preview: 'https://pen-pushed-1.codepen.dev/',
          },
          screenshot_urls: null,
          saved_version: {
            id: 'ver-pushed-1',
            pen_id: 'pen-pushed-1',
            hash: 'hash-1',
            created_at: '2026-11-21T12:00:00Z',
            deployed: false,
            saved: true,
            label: null,
            build: null,
            preview_url: 'https://pen-pushed-1.codepen.dev/',
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
            id: 'bld-pushed-1',
            status: 'Success',
            started_at: '2026-11-21T12:00:00Z',
            ended_at: '2026-11-21T12:00:01Z',
            rounds: 1,
            diagnostics: [],
            errors: [],
            applied_patches: [],
            patches: [],
            version_id: 'ver-pushed-1',
            next_id: null,
            previous_id: null,
          },
        });
      }

      if (req.method === 'GET' && url.pathname === '/v2/versions/ver-pushed-1') {
        const uploaded = (createRequests[0]?.body.files as Array<{ path: string; content: string }>) ?? [];
        return sendJson(200, {
          id: 'ver-pushed-1',
          pen_id: 'pen-pushed-1',
          hash: 'hash-1',
          created_at: '2026-11-21T12:00:00Z',
          deployed: false,
          saved: true,
          label: null,
          build: null,
          preview_url: null,
          files: uploaded.map((f, idx) => ({
            id: `f-${idx}`,
            path: f.path,
            name: path.posix.basename(f.path),
            content_hash: `h-${idx}`,
            is_binary: false,
            bytes: Buffer.byteLength(f.content),
            content_type: 'text/plain',
            content: f.content,
            url: null,
            download_url: null,
          })),
        });
      }

      sendJson(404, { code: 'NOT_FOUND', message: 'Not found' });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      await saveProfileToFile('bramus', 'cp_user_bramus_initpush', {
        homeDir: tmpHome,
        setAsDefault: true,
      });
      await fs.mkdir(demoDir, { recursive: true });
      await fs.writeFile(
        path.join(demoDir, 'index.html'),
        '<!DOCTYPE html><html><head><title>Push Now</title></head><body>Hi</body></html>',
      );

      const confirmCalls: Array<{ question: string; defaultYes?: boolean }> = [];
      const res = await runInitCommand({
        cwd: demoDir,
        description: 'Pushed right after init',
        tags: ['css', 'init'],
        template: false,
        interactive: true,
        baseUrl,
        env: {},
        homeDir: tmpHome,
        prompts: {
          text: async () => 'Push Now Demo',
          select: async () => 'Private' as never,
          multiSelect: async () => ['validate-1', 'fingerprint-1', 'packages-1'] as never,
          confirm: async (question, defaultYes) => {
            confirmCalls.push({ question, defaultYes });
            return true;
          },
        },
      });

      assert.equal(res.initialized, true);
      assert.equal(res.pushed, true);
      assert.equal(res.pushResult?.pen.id, 'pen-pushed-1');
      assert.deepEqual(confirmCalls, [
        { question: 'Do you want to push this to CodePen right now?', defaultYes: false },
      ]);

      // Verify POST /v2/pens received init's metadata + index.html + .codepen/pen.config.json
      assert.equal(createRequests.length, 1);
      assert.equal(createRequests[0]?.auth, 'Bearer cp_user_bramus_initpush');
      assert.equal(createRequests[0]?.body.title, 'Push Now Demo');
      assert.equal(createRequests[0]?.body.description, 'Pushed right after init');
      assert.deepEqual(createRequests[0]?.body.tags, ['css', 'init']);
      assert.equal(createRequests[0]?.body.access, 'Private');
      const sentPaths = (createRequests[0]?.body.files as Array<{ path: string }>).map((f) => f.path).sort();
      assert.deepEqual(sentPaths, ['/.codepen/pen.config.json', '/index.html']);

      // Verify .cdpn.json is now linked to the created CodePen Pen
      const linked = await readProjectConfigFile(demoDir);
      assert.equal(linked.linked, true);
      if (linked.linked) {
        assert.equal(linked.config.pen_id, 'pen-pushed-1');
        assert.equal(linked.config.url, 'https://codepen.io/bramus/pen/pen-pushed-1');
      }
    } finally {
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
      await fs.rm(tmpRoot, { recursive: true, force: true });
      await fs.rm(tmpHome, { recursive: true, force: true });
    }
  });
});
