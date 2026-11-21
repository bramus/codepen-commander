import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { runBuildCommand } from '../src/commands/build.js';
import { CliError } from '../src/utils/json.js';

describe('cdpn build (single Pen, collection, .cdpnignore/.gitignore, overwrite, safety guards)', () => {
  it('builds a single Pen into a subfolder, strips dotfiles, updates .cdpnignore without duplicates, and creates/appends .gitignore', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-build-pen-'));
    try {
      await fs.mkdir(path.join(tmpDir, '.codepen'), { recursive: true });
      await fs.writeFile(
        path.join(tmpDir, '.cdpn.json'),
        JSON.stringify({
          url: 'https://codepen.io/bramus/pen/bld1',
          pen_id: 'bld1',
          last_synced_version_id: 'v1',
          info: { title: 'Build Pen' },
        }),
      );
      await fs.writeFile(
        path.join(tmpDir, '.codepen', 'pen.config.json'),
        JSON.stringify({ blocks: { 'classic-1': { name: 'classic-1', disabled: false } } }),
      );
      await fs.writeFile(
        path.join(tmpDir, '.codepen', 'classic.config.json'),
        JSON.stringify({ styles: ['/style.css'], scripts: [] }),
      );
      await fs.writeFile(path.join(tmpDir, 'index.pen.html'), '<main>Built!</main>');
      await fs.writeFile(path.join(tmpDir, 'style.css'), 'main { color: green; }');

      // Interactive build choosing default "build" and accepting .gitignore generation
      const confirmPrompts: string[] = [];
      const first = await runBuildCommand({
        cwd: tmpDir,
        interactive: true,
        prompts: {
          askOutDir: async (_q, def, validate) => {
            const res = await validate(def);
            assert.equal(res.ok, true);
            return res.ok ? res.value : (() => { throw new Error('unexpected'); })();
          },
          confirm: async (question) => {
            confirmPrompts.push(question);
            return true;
          },
        },
      });

      assert.equal(first.built, true);
      assert.equal(first.result?.mode, 'pen');
      assert.equal(first.cdpnIgnoreUpdated, true);
      assert.equal(first.cdpnIgnoreEntry, 'build/');
      assert.equal(first.gitIgnoreUpdated, true);
      assert.equal(first.gitIgnoreCreated, true);
      assert.ok(confirmPrompts.some((q) => q.includes('.gitignore')));

      // Verify compiled HTML exists and dotfiles were stripped from build/
      const builtHtml = await fs.readFile(path.join(tmpDir, 'build', 'index.html'), 'utf8');
      assert.ok(builtHtml.includes('<main>Built!</main>'));
      assert.ok(builtHtml.includes('<title>Build Pen</title>'));
      await assert.rejects(() => fs.stat(path.join(tmpDir, 'build', '.cdpn.json')));
      await assert.rejects(() => fs.stat(path.join(tmpDir, 'build', '.codepen')));

      // Verify .cdpnignore and .gitignore contents
      const cdpnIgnore = await fs.readFile(path.join(tmpDir, '.cdpnignore'), 'utf8');
      assert.equal(cdpnIgnore, 'build/\n');
      const gitIgnore = await fs.readFile(path.join(tmpDir, '.gitignore'), 'utf8');
      assert.ok(gitIgnore.includes('build/'));

      // Non-interactive rebuild without --yes/--force fails with 409 Conflict
      await assert.rejects(
        () => runBuildCommand({ cwd: tmpDir, out: 'build', interactive: false }),
        (err: unknown) => err instanceof CliError && err.statusCode === 409,
      );

      // Interactive rebuild choosing "No" on overwrite aborts without deleting build/
      const aborted = await runBuildCommand({
        cwd: tmpDir,
        out: 'build',
        interactive: true,
        prompts: { confirm: async () => false },
      });
      assert.equal(aborted.built, false);
      assert.equal(aborted.aborted, true);

      // Rebuilding into `build` with --yes succeeds and does NOT duplicate `build/` in .cdpnignore
      const second = await runBuildCommand({
        cwd: tmpDir,
        out: 'build',
        yes: true,
        interactive: false,
      });
      assert.equal(second.built, true);
      assert.equal(second.cdpnIgnoreUpdated, false);
      assert.equal(await fs.readFile(path.join(tmpDir, '.cdpnignore'), 'utf8'), 'build/\n');

      // Building into another subfolder `dist` appends to both .cdpnignore and existing .gitignore
      const third = await runBuildCommand({
        cwd: tmpDir,
        out: 'dist',
        interactive: true,
        prompts: { confirm: async () => true },
      });
      assert.equal(third.built, true);
      assert.equal(third.cdpnIgnoreUpdated, true);
      assert.equal(third.gitIgnoreUpdated, true);
      assert.equal(third.gitIgnoreCreated, false);
      assert.equal(await fs.readFile(path.join(tmpDir, '.cdpnignore'), 'utf8'), 'build/\ndist/\n');
      const updatedGitIgnore = await fs.readFile(path.join(tmpDir, '.gitignore'), 'utf8');
      assert.ok(updatedGitIgnore.includes('build/'));
      assert.ok(updatedGitIgnore.includes('dist/'));
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('allows building outside cwd without touching .cdpnignore/.gitignore and rejects . and ancestor directories', async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-build-outside-'));
    const penDir = path.join(tmpRoot, 'my-pen');
    const outsideDir = path.join(tmpRoot, 'exported-pen');

    try {
      await fs.mkdir(penDir, { recursive: true });
      await fs.writeFile(
        path.join(penDir, '.cdpn.json'),
        JSON.stringify({ url: 'https://codepen.io/bramus/pen/ext1', pen_id: 'ext1', last_synced_version_id: 'v1' }),
      );
      await fs.writeFile(path.join(penDir, 'index.html'), '<h1>Outside</h1>');

      // Rejects building into "." or ".."
      await assert.rejects(
        () => runBuildCommand({ cwd: penDir, out: '.', interactive: false }),
        (err: unknown) => err instanceof CliError && err.statusCode === 400,
      );
      await assert.rejects(
        () => runBuildCommand({ cwd: penDir, out: '..', interactive: false }),
        (err: unknown) => err instanceof CliError && err.statusCode === 400,
      );

      // Allows building into sibling "../exported-pen" without creating .cdpnignore or .gitignore
      const res = await runBuildCommand({
        cwd: penDir,
        out: '../exported-pen',
        interactive: false,
      });
      assert.equal(res.built, true);
      assert.equal(res.cdpnIgnoreUpdated, false);
      assert.equal(res.gitIgnoreUpdated, false);
      assert.equal(await fs.readFile(path.join(outsideDir, 'index.html'), 'utf8'), '<h1>Outside</h1>');
      await assert.rejects(() => fs.stat(path.join(penDir, '.cdpnignore')));
      await assert.rejects(() => fs.stat(path.join(penDir, '.gitignore')));
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('fails with 422 when building a single Pen that has unsupported CodePen blocks', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-build-unsupported-'));
    try {
      await fs.mkdir(path.join(tmpDir, '.codepen'), { recursive: true });
      await fs.writeFile(
        path.join(tmpDir, '.cdpn.json'),
        JSON.stringify({ info: { title: 'Sass Pen', access: 'Public' } }),
      );
      await fs.writeFile(
        path.join(tmpDir, '.codepen', 'pen.config.json'),
        JSON.stringify({ blocks: { 'sass-1': { name: 'sass-1', disabled: false } } }),
      );
      await fs.writeFile(path.join(tmpDir, 'index.html'), '<h1>Hi</h1>');

      await assert.rejects(
        () => runBuildCommand({ cwd: tmpDir, out: 'build', interactive: false }),
        (err: unknown) => err instanceof CliError && err.statusCode === 422 && /sass-1/.test(err.message),
      );
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('builds a collection directory with custom --shell, preserves root index.html when present, excludes unmarked dirs/repo files/previous builds, and renders unsupported sub-demo pages', async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-build-collection-'));
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-build-home-'));
    const srcDir = path.join(tmpRoot, 'cool-demos');
    const customShellDir = path.join(tmpRoot, 'my-shell');

    try {
      await fs.mkdir(path.join(srcDir, 'demo-one'), { recursive: true });
      await fs.writeFile(
        path.join(srcDir, 'demo-one', '.cdpn.json'),
        JSON.stringify({ info: { title: 'Demo One', access: 'Public' } }),
      );
      await fs.writeFile(
        path.join(srcDir, 'demo-one', 'index.html'),
        '<!DOCTYPE html><html><head><title>Demo One</title></head><body>One</body></html>',
      );
      await fs.mkdir(path.join(srcDir, 'broken-demo', '.codepen'), { recursive: true });
      await fs.writeFile(
        path.join(srcDir, 'broken-demo', '.cdpn.json'),
        JSON.stringify({ info: { title: 'Broken Demo', access: 'Public' } }),
      );
      await fs.writeFile(
        path.join(srcDir, 'broken-demo', '.codepen', 'pen.config.json'),
        JSON.stringify({ blocks: { 'markdown-1': { name: 'markdown-1', disabled: false } } }),
      );
      await fs.writeFile(path.join(srcDir, 'broken-demo', 'index.md'), '# Hi');

      // Unmarked directory (NO .cdpn.json) must NOT be indexed or copied into build output
      await fs.mkdir(path.join(srcDir, 'unmarked-folder'), { recursive: true });
      await fs.writeFile(
        path.join(srcDir, 'unmarked-folder', 'index.html'),
        '<h1>Should Not Be Built</h1>',
      );

      // Repo-root metadata files should not leak into collection build output
      await fs.writeFile(path.join(srcDir, 'README.md'), '# Repo readme');
      await fs.writeFile(path.join(srcDir, 'package.json'), '{"name":"repo"}');

      await fs.mkdir(customShellDir, { recursive: true });
      await fs.writeFile(
        path.join(customShellDir, 'index.html'),
        '<!DOCTYPE html><html><head><title>{{SITE_TITLE}}</title></head><body><h1>{{SITE_TITLE}}</h1><p>{{SITE_SUBTITLE}}</p></body></html>',
      );
      await fs.writeFile(path.join(customShellDir, 'extra.txt'), 'shell-extra');

      const out = await runBuildCommand({
        cwd: srcDir,
        out: 'dist',
        shell: customShellDir,
        title: 'Bramus Demos',
        subtitle: 'Custom build subtitle',
        homeDir: tmpHome,
        interactive: false,
      });

      assert.equal(out.built, true);
      assert.equal(out.result?.mode, 'collection');
      assert.equal(out.result?.demoCount, 2);
      assert.equal(out.result?.unsupportedDemos.length, 1);
      assert.equal(out.result?.unsupportedDemos[0]?.path, 'broken-demo/');

      const builtIndex = await fs.readFile(path.join(srcDir, 'dist', 'index.html'), 'utf8');
      assert.ok(builtIndex.includes('Bramus Demos'));
      assert.ok(builtIndex.includes('Custom build subtitle'));
      assert.equal(await fs.readFile(path.join(srcDir, 'dist', 'extra.txt'), 'utf8'), 'shell-extra');
      // Partial shell fallback copied built-in styles.css & scripts.js
      assert.ok((await fs.stat(path.join(srcDir, 'dist', 'styles.css'))).isFile());
      assert.ok((await fs.stat(path.join(srcDir, 'dist', 'scripts.js'))).isFile());
      // Unsupported demo received error page
      const brokenHtml = await fs.readFile(path.join(srcDir, 'dist', 'broken-demo', 'index.html'), 'utf8');
      assert.ok(brokenHtml.includes('Unsupported CodePen Block'));
      // Unmarked directory and repo-root README.md / package.json were excluded
      await assert.rejects(() => fs.stat(path.join(srcDir, 'dist', 'unmarked-folder')));
      await assert.rejects(() => fs.stat(path.join(srcDir, 'dist', 'README.md')));
      await assert.rejects(() => fs.stat(path.join(srcDir, 'dist', 'package.json')));

      // Building again into a DIFFERENT folder ("build") must NOT discover the previous "dist" build as a demo!
      const out2 = await runBuildCommand({
        cwd: srcDir,
        out: 'build',
        homeDir: tmpHome,
        interactive: false,
      });
      assert.equal(out2.result?.demoCount, 2);
      await assert.rejects(() => fs.stat(path.join(srcDir, 'build', 'dist')));
      await assert.rejects(() => fs.stat(path.join(srcDir, 'build', 'unmarked-folder')));
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
      await fs.rm(tmpHome, { recursive: true, force: true });
    }
  });
});
