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
import { stripAnsi } from '../../src/utils/format.js';
import type { MultiSelectOption } from '../../src/utils/prompts/index.js';
import { createBufferedOutput, createSilentOutput } from '../helpers/output.js';

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
            return ['classic-1'] as never;
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
      // Verify title, visibility, blocks, Classic rename offer (default Yes), and post-init push offer (default No) were prompted
      assert.equal(askedText.length, 1);
      assert.equal(askedText[0]?.question, 'Pen title');
      assert.equal(askedText[0]?.defaultValue, 'Scroll Cards HTML Title');
      assert.deepEqual(askedSelect, ['Pen visibility']);
      assert.deepEqual(askedConfirm, [
        { question: 'Rename index.html to index.pen.html?', defaultYes: true },
        { question: 'Do you want to push this to CodePen right now?', defaultYes: false },
      ]);

      // Verify validate & fingerprint are locked and checked, packages is last and auto-checked due to package.json dependencies, and classic is not exclusive
      assert.deepEqual(
        receivedBlockOptions.map((o) => o.value),
        ['validate-1', 'fingerprint-1', 'classic-1', 'packages-1'],
      );
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
      assert.equal(packagesOpt?.exclusive, undefined);
      assert.equal(classicOpt?.locked, false);
      assert.equal(classicOpt?.checked, false);
      assert.equal(classicOpt?.exclusive, undefined);

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

  it('auto-checks packages only when package.json has dependencies, auto-checks classic for index.pen.html, and allows combining classic and packages', async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-init-blocks-rules-'));
    try {
      const inspectInteractiveOptions = async (dir: string): Promise<MultiSelectOption<string>[]> => {
        let captured: MultiSelectOption<string>[] = [];
        await runInitCommand({
          cwd: dir,
          interactive: true,
          force: true,
          output: createSilentOutput(),
          prompts: {
            text: async (_q, def) => def ?? 'Demo',
            select: async () => 'Public' as never,
            multiSelect: async (_q, opts) => {
              captured = opts;
              return opts.filter((o) => o.checked).map((o) => o.value) as never;
            },
            confirm: async () => false,
          },
        });
        return captured;
      };

      // 1. package.json WITHOUT dependencies (only name + devDependencies) -> packages NOT auto-checked
      const noDepsDir = path.join(tmpRoot, 'pkg-no-deps');
      await fs.mkdir(noDepsDir, { recursive: true });
      await fs.writeFile(
        path.join(noDepsDir, 'package.json'),
        JSON.stringify({ name: 'no-deps', type: 'module', devDependencies: { vite: '^5.0.0' } }),
      );
      const noDepsOpts = await inspectInteractiveOptions(noDepsDir);
      assert.equal(noDepsOpts.find((o) => o.value === 'packages-1')?.checked, false);
      assert.equal(noDepsOpts.find((o) => o.value === 'classic-1')?.checked, false);

      // 2. package.json with empty dependencies: {} -> packages NOT auto-checked (interactive & non-interactive)
      const emptyDepsDir = path.join(tmpRoot, 'pkg-empty-deps');
      await fs.mkdir(emptyDepsDir, { recursive: true });
      await fs.writeFile(
        path.join(emptyDepsDir, 'package.json'),
        JSON.stringify({ name: 'empty-deps', dependencies: {} }),
      );
      const emptyDepsNonInt = await runInitCommand({
        cwd: emptyDepsDir,
        interactive: false,
        output: createSilentOutput(),
      });
      assert.deepEqual(emptyDepsNonInt.blocks, ['fingerprint-1', 'validate-1']);
      const emptyDepsOpts = await inspectInteractiveOptions(emptyDepsDir);
      assert.equal(emptyDepsOpts.find((o) => o.value === 'packages-1')?.checked, false);

      // 3. package.json WITH dependencies -> packages auto-checked (interactive & non-interactive)
      const withDepsDir = path.join(tmpRoot, 'pkg-with-deps');
      await fs.mkdir(withDepsDir, { recursive: true });
      await fs.writeFile(
        path.join(withDepsDir, 'package.json'),
        JSON.stringify({ name: 'with-deps', dependencies: { 'canvas-confetti': '^1.9.3' } }),
      );
      const withDepsNonInt = await runInitCommand({
        cwd: withDepsDir,
        interactive: false,
        output: createSilentOutput(),
      });
      assert.deepEqual(withDepsNonInt.blocks, ['fingerprint-1', 'packages-1', 'validate-1']);
      const withDepsOpts = await inspectInteractiveOptions(withDepsDir);
      assert.equal(withDepsOpts.find((o) => o.value === 'packages-1')?.checked, true);
      assert.equal(withDepsOpts.find((o) => o.value === 'classic-1')?.checked, false);

      // 4. index.pen.html present -> classic auto-checked (non-exclusive) + classic.config.json created
      const classicDir = path.join(tmpRoot, 'classic-pen');
      await fs.mkdir(classicDir, { recursive: true });
      await fs.writeFile(path.join(classicDir, 'index.pen.html'), '<h1>Classic</h1>\n');
      const classicOpts = await inspectInteractiveOptions(classicDir);
      assert.equal(classicOpts.find((o) => o.value === 'classic-1')?.checked, true);
      assert.equal(classicOpts.find((o) => o.value === 'classic-1')?.exclusive, undefined);
      assert.equal(classicOpts.find((o) => o.value === 'packages-1')?.checked, false);
      const classicNonInt = await runInitCommand({
        cwd: classicDir,
        interactive: false,
        force: true,
        output: createSilentOutput(),
      });
      assert.deepEqual(classicNonInt.blocks, ['classic-1', 'fingerprint-1', 'validate-1']);
      assert.ok((await fs.stat(path.join(classicDir, '.codepen', 'classic.config.json'))).isFile());

      // 5. Both index.pen.html AND package.json with dependencies -> BOTH classic and packages auto-checked!
      const bothDir = path.join(tmpRoot, 'both-classic-and-pkg');
      await fs.mkdir(bothDir, { recursive: true });
      await fs.writeFile(path.join(bothDir, 'index.pen.html'), '<h1>Classic</h1>\n');
      await fs.writeFile(
        path.join(bothDir, 'package.json'),
        JSON.stringify({ dependencies: { gsap: '3.12.5' } }),
      );
      const bothOpts = await inspectInteractiveOptions(bothDir);
      assert.equal(bothOpts.find((o) => o.value === 'classic-1')?.checked, true);
      assert.equal(bothOpts.find((o) => o.value === 'packages-1')?.checked, true);
      const bothNonInt = await runInitCommand({
        cwd: bothDir,
        interactive: false,
        force: true,
        output: createSilentOutput(),
      });
      assert.deepEqual(bothNonInt.blocks, [
        'classic-1',
        'fingerprint-1',
        'packages-1',
        'validate-1',
      ]);

      // 6. Allows combining classic with packages and other optional blocks via --blocks
      const combined = await runInitCommand({
        cwd: tmpRoot,
        dirArg: 'combined-blocks',
        blocks: 'classic,packages',
        interactive: false,
        output: createSilentOutput(),
      });
      assert.deepEqual(combined.blocks, [
        'classic-1',
        'fingerprint-1',
        'packages-1',
        'validate-1',
      ]);
      assert.ok(
        (await fs.stat(path.join(tmpRoot, 'combined-blocks', '.codepen', 'classic.config.json'))).isFile(),
      );

      // 7. Re-initializing with --force switching from packages -> classic prunes unselected packages-1
      const switchDir = path.join(tmpRoot, 'switch-blocks');
      await runInitCommand({
        cwd: tmpRoot,
        dirArg: 'switch-blocks',
        blocks: 'packages',
        interactive: false,
        output: createSilentOutput(),
      });
      await runInitCommand({
        cwd: switchDir,
        blocks: 'classic',
        force: true,
        interactive: false,
        output: createSilentOutput(),
      });
      const switchedPenConfig = JSON.parse(
        await fs.readFile(path.join(switchDir, '.codepen', 'pen.config.json'), 'utf8'),
      ) as { blocks: Record<string, unknown> };
      assert.deepEqual(Object.keys(switchedPenConfig.blocks).sort(), [
        'classic-1',
        'fingerprint-1',
        'validate-1',
      ]);
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('offers to rename index.html or create index.pen.html after choosing classic, and skips when index.pen.html already exists', async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-init-classic-html-'));
    try {
      // 1. index.html exists (no index.pen.html) -> offers rename; accepting renames file and keeps content
      const renameDir = path.join(tmpRoot, 'rename-yes');
      await fs.mkdir(renameDir, { recursive: true });
      await fs.writeFile(path.join(renameDir, 'index.html'), '<main>Hello Classic</main>\n', 'utf8');

      const renameConfirms: Array<{ q: string; def?: boolean }> = [];
      const renameOut = createBufferedOutput();
      const renameRes = await runInitCommand({
        cwd: renameDir,
        interactive: true,
        output: renameOut,
        prompts: {
          text: async () => 'Renamed Classic',
          select: async () => 'Public' as never,
          multiSelect: async () => ['classic-1'] as never,
          confirm: async (q, def) => {
            renameConfirms.push({ q, def });
            return q.startsWith('Rename index.html');
          },
        },
      });
      assert.deepEqual(renameConfirms, [
        { q: 'Rename index.html to index.pen.html?', def: true },
        { q: 'Do you want to push this to CodePen right now?', def: false },
      ]);
      assert.ok(renameRes.writtenFiles.includes('index.pen.html'));
      await assert.rejects(() => fs.lstat(path.join(renameDir, 'index.html')));
      assert.equal(
        await fs.readFile(path.join(renameDir, 'index.pen.html'), 'utf8'),
        '<main>Hello Classic</main>\n',
      );
      const renameStdout = stripAnsi(renameOut.stdout());
      assert.ok(
        renameStdout.includes(
          '\n⚠ The classic block requires an `index.pen.html` file, which was not found in this folder.\n\n',
        ),
        renameStdout,
      );
      assert.match(renameStdout, /index\.html → index\.pen\.html/);

      // 1b. Declining rename leaves index.html intact and does not create index.pen.html
      const renameDeclineDir = path.join(tmpRoot, 'rename-no');
      await fs.mkdir(renameDeclineDir, { recursive: true });
      await fs.writeFile(path.join(renameDeclineDir, 'index.html'), '<p>Keep me</p>\n', 'utf8');
      const renameNoRes = await runInitCommand({
        cwd: renameDeclineDir,
        interactive: true,
        output: createSilentOutput(),
        prompts: {
          text: async () => 'Keep HTML',
          select: async () => 'Public' as never,
          multiSelect: async () => ['classic-1'] as never,
          confirm: async () => false,
        },
      });
      assert.equal(renameNoRes.writtenFiles.includes('index.pen.html'), false);
      assert.equal(
        await fs.readFile(path.join(renameDeclineDir, 'index.html'), 'utf8'),
        '<p>Keep me</p>\n',
      );
      await assert.rejects(() => fs.lstat(path.join(renameDeclineDir, 'index.pen.html')));

      // 2. Neither index.html nor index.pen.html exists -> offers creating index.pen.html
      const createDir = path.join(tmpRoot, 'create-yes');
      await fs.mkdir(createDir, { recursive: true });
      const createConfirms: Array<{ q: string; def?: boolean }> = [];
      const createOut = createBufferedOutput();
      const createRes = await runInitCommand({
        cwd: createDir,
        interactive: true,
        output: createOut,
        prompts: {
          text: async () => 'Fresh Classic',
          select: async () => 'Public' as never,
          multiSelect: async () => ['classic-1'] as never,
          confirm: async (q, def) => {
            createConfirms.push({ q, def });
            return q.startsWith('Create an index.pen.html');
          },
        },
      });
      assert.deepEqual(createConfirms, [
        { q: 'Create an index.pen.html file?', def: true },
        { q: 'Do you want to push this to CodePen right now?', def: false },
      ]);
      assert.ok(createRes.writtenFiles.includes('index.pen.html'));
      assert.equal(await fs.readFile(path.join(createDir, 'index.pen.html'), 'utf8'), '');
      const createStdout = stripAnsi(createOut.stdout());
      assert.ok(
        createStdout.includes(
          '\n⚠ The classic block requires an `index.pen.html` file, which was not found in this folder.\n\n',
        ),
        createStdout,
      );
      assert.match(createStdout, /\+\s+index\.pen\.html/);

      // 2b. Declining create does not create index.pen.html
      const createDeclineDir = path.join(tmpRoot, 'create-no');
      await fs.mkdir(createDeclineDir, { recursive: true });
      const createNoRes = await runInitCommand({
        cwd: createDeclineDir,
        interactive: true,
        output: createSilentOutput(),
        prompts: {
          text: async () => 'No Pen HTML',
          select: async () => 'Public' as never,
          multiSelect: async () => ['classic-1'] as never,
          confirm: async () => false,
        },
      });
      assert.equal(createNoRes.writtenFiles.includes('index.pen.html'), false);
      await assert.rejects(() => fs.lstat(path.join(createDeclineDir, 'index.pen.html')));

      // 3. index.pen.html already exists -> skips the prompt completely (even if index.html also exists)
      const existingPenHtmlDir = path.join(tmpRoot, 'already-has-pen-html');
      await fs.mkdir(existingPenHtmlDir, { recursive: true });
      await fs.writeFile(path.join(existingPenHtmlDir, 'index.html'), '<h1>Other</h1>\n', 'utf8');
      await fs.writeFile(
        path.join(existingPenHtmlDir, 'index.pen.html'),
        '<h1>Existing Classic</h1>\n',
        'utf8',
      );
      const skipConfirms: Array<{ q: string; def?: boolean }> = [];
      const skipOut = createBufferedOutput();
      const skipRes = await runInitCommand({
        cwd: existingPenHtmlDir,
        interactive: true,
        output: skipOut,
        prompts: {
          text: async () => 'Existing Classic',
          select: async () => 'Public' as never,
          multiSelect: async () => ['classic-1'] as never,
          confirm: async (q, def) => {
            skipConfirms.push({ q, def });
            return false;
          },
        },
      });
      assert.deepEqual(skipConfirms, [
        { q: 'Do you want to push this to CodePen right now?', def: false },
      ]);
      assert.equal(skipRes.writtenFiles.includes('index.pen.html'), false);
      assert.doesNotMatch(stripAnsi(skipOut.stdout()), /requires an `index\.pen\.html`/);
      assert.equal(
        await fs.readFile(path.join(existingPenHtmlDir, 'index.pen.html'), 'utf8'),
        '<h1>Existing Classic</h1>\n',
      );
      assert.equal(
        await fs.readFile(path.join(existingPenHtmlDir, 'index.html'), 'utf8'),
        '<h1>Other</h1>\n',
      );
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });
});
