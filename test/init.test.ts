import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { runInitCommand } from '../src/commands/init.js';
import { readProjectConfigFile, writeProjectConfig } from '../src/config/project.js';
import { startDevServer } from '../src/site/server.js';
import { CliError } from '../src/utils/json.js';
import type { MultiSelectOption } from '../src/utils/prompts.js';

describe('cdpn init command', () => {
  it('asks interactively only for title, visibility, and blocks (with validate & fingerprint locked) and writes unlinked .cdpn.json + .codepen/', async () => {
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
        },
      });

      assert.equal(res.initialized, true);
      assert.equal(res.aborted, false);
      // Verify ONLY title, visibility, and blocks were prompted
      assert.equal(askedText.length, 1);
      assert.equal(askedText[0]?.question, 'Pen title');
      assert.equal(askedText[0]?.defaultValue, 'Scroll Cards HTML Title');
      assert.deepEqual(askedSelect, ['Pen visibility']);

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
});
