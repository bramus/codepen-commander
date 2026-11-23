import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createProgram } from '../../src/cli.js';
import { runBuildCommand } from '../../src/commands/build.js';
import { CliError } from '../../src/errors.js';
import type { DemoManifest } from '../../src/site/manifest.js';
import { startDevServer } from '../../src/site/server.js';
import { stripAnsi } from '../../src/utils/format.js';
import { createBufferedOutput, parseJsonOutput } from '../helpers/output.js';

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
        output: createBufferedOutput(),
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
        () =>
          runBuildCommand({
            cwd: tmpDir,
            out: 'build',
            interactive: false,
            output: createBufferedOutput(),
          }),
        (err: unknown) => err instanceof CliError && err.statusCode === 409,
      );

      // Interactive rebuild choosing "No" on overwrite aborts without deleting build/
      const aborted = await runBuildCommand({
        cwd: tmpDir,
        out: 'build',
        interactive: true,
        output: createBufferedOutput(),
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
        output: createBufferedOutput(),
      });
      assert.equal(second.built, true);
      assert.equal(second.cdpnIgnoreUpdated, false);
      assert.equal(await fs.readFile(path.join(tmpDir, '.cdpnignore'), 'utf8'), 'build/\n');

      // Building into another subfolder `dist` appends to both .cdpnignore and existing .gitignore
      const third = await runBuildCommand({
        cwd: tmpDir,
        out: 'dist',
        interactive: true,
        output: createBufferedOutput(),
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
        () =>
          runBuildCommand({
            cwd: penDir,
            out: '.',
            interactive: false,
            output: createBufferedOutput(),
          }),
        (err: unknown) => err instanceof CliError && err.statusCode === 400,
      );
      await assert.rejects(
        () =>
          runBuildCommand({
            cwd: penDir,
            out: '..',
            interactive: false,
            output: createBufferedOutput(),
          }),
        (err: unknown) => err instanceof CliError && err.statusCode === 400,
      );

      // Allows building into sibling "../exported-pen" without creating .cdpnignore or .gitignore
      const res = await runBuildCommand({
        cwd: penDir,
        out: '../exported-pen',
        interactive: false,
        output: createBufferedOutput(),
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
        () =>
          runBuildCommand({
            cwd: tmpDir,
            out: 'build',
            interactive: false,
            output: createBufferedOutput(),
          }),
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
        output: createBufferedOutput(),
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

      // Building again into a DIFFERENT folder ("build") with the built-in shell must NOT discover
      // the previous "dist" build as a demo, and must omit the local-dev "Missing a demo" warning box
      const out2 = await runBuildCommand({
        cwd: srcDir,
        out: 'build',
        homeDir: tmpHome,
        interactive: false,
        output: createBufferedOutput(),
      });
      assert.equal(out2.result?.demoCount, 2);
      await assert.rejects(() => fs.stat(path.join(srcDir, 'build', 'dist')));
      await assert.rejects(() => fs.stat(path.join(srcDir, 'build', 'unmarked-folder')));

      const builtinBuiltIndex = await fs.readFile(path.join(srcDir, 'build', 'index.html'), 'utf8');
      assert.ok(builtinBuiltIndex.includes('id="demo-card-template"'));
      assert.ok(builtinBuiltIndex.includes('id="empty-state-template"'));
      assert.equal(builtinBuiltIndex.includes('missing-demo-warning-template'), false);
      assert.equal(builtinBuiltIndex.includes('shell-warning'), false);
      assert.equal(builtinBuiltIndex.includes('Missing a demo?'), false);

      // Exported custom shell (which includes the warning template) also omits it in `cdpn build`
      const exportedShellDir = path.join(tmpRoot, 'exported-shell');
      const { exportBuiltinShell } = await import('../../src/site/shell.js');
      await exportBuiltinShell(exportedShellDir);
      const exportedRaw = await fs.readFile(path.join(exportedShellDir, 'index.html'), 'utf8');
      assert.ok(exportedRaw.includes('missing-demo-warning-template'));

      const out3 = await runBuildCommand({
        cwd: srcDir,
        out: 'build-exported',
        shell: exportedShellDir,
        homeDir: tmpHome,
        interactive: false,
        output: createBufferedOutput(),
      });
      assert.equal(out3.built, true);
      const exportedBuiltIndex = await fs.readFile(
        path.join(srcDir, 'build-exported', 'index.html'),
        'utf8',
      );
      assert.equal(exportedBuiltIndex.includes('missing-demo-warning-template'), false);
      assert.equal(exportedBuiltIndex.includes('shell-warning'), false);
      assert.equal(exportedBuiltIndex.includes('Missing a demo?'), false);
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
      await fs.rm(tmpHome, { recursive: true, force: true });
    }
  });

  it('includes only Public Pens by default in collection builds and supports --access / --visibility filtering', async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-build-access-'));
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-build-access-home-'));
    const srcDir = path.join(tmpRoot, 'mixed-demos');

    const writePen = async (
      relPath: string,
      cdpnJson: Record<string, unknown>,
      htmlBody: string,
      extra?: { unsupportedBlock?: string },
    ) => {
      const dir = path.join(srcDir, ...relPath.split('/'));
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, '.cdpn.json'), JSON.stringify(cdpnJson));
      await fs.writeFile(
        path.join(dir, 'index.html'),
        `<!DOCTYPE html><html><head><title>${relPath}</title></head><body>${htmlBody}</body></html>`,
      );
      if (extra?.unsupportedBlock) {
        await fs.mkdir(path.join(dir, '.codepen'), { recursive: true });
        await fs.writeFile(
          path.join(dir, '.codepen', 'pen.config.json'),
          JSON.stringify({
            blocks: {
              [extra.unsupportedBlock]: { name: extra.unsupportedBlock, disabled: false },
            },
          }),
        );
      }
    };

    try {
      // 1. Standalone Public Pen (case-insensitive access value)
      await writePen('public-demo', { info: { title: 'Public Demo', access: 'public' } }, 'Public');

      // 2. Private Pen (with unsupported block & a nested Public .cdpn.json that MUST NEVER leak!)
      await writePen(
        'private-demo',
        { info: { title: 'Private Draft', access: 'Private' } },
        'Secret Private',
        { unsupportedBlock: 'sass-1' },
      );
      await writePen(
        'private-demo/nested-public',
        { info: { title: 'Nested Trap', access: 'Public' } },
        'Must Not Leak',
      );

      // 3. Group containing ONLY non-Public Pens (Protected + Collaborators) -> group folder must not be created by default
      await writePen(
        'secret-group/protected-demo',
        { info: { title: 'Protected Talk', access: 'Protected' } },
        'Protected',
      );
      await writePen(
        'secret-group/collab-demo',
        { info: { title: 'Collab WIP', access: 'Collaborators' } },
        'Collab',
      );

      // 4. Legacy Pen without info.access & Pen with invalid access (fail-safe: excluded unless --access all)
      await writePen(
        'legacy-demo',
        { url: 'https://codepen.io/bramus/pen/leg1', pen_id: 'leg1', last_synced_version_id: 'v1' },
        'Legacy',
      );
      await writePen('invalid-access-demo', { info: { title: 'Weird', access: 'Secret' } }, 'Weird');

      // 5. Group with a mix of Public and Private Pens
      await writePen(
        'mixed-group/public-child',
        { info: { title: 'Public Child', access: 'Public' } },
        'Public Child',
      );
      await writePen(
        'mixed-group/private-child',
        { info: { title: 'Private Child', access: 'Private' } },
        'Private Child',
      );

      const collectPaths = (manifest: DemoManifest): string[] => {
        const paths: string[] = [];
        const walk = (groups: DemoManifest['groups']) => {
          for (const g of groups) {
            for (const d of g.demos) paths.push(d.path);
            walk(g.groups);
          }
        };
        for (const d of manifest.standalone) paths.push(d.path);
        walk(manifest.groups);
        return paths.sort();
      };

      // A. Default build (no --access): ONLY Public Pens included
      const defaultOut = createBufferedOutput();
      const defaultRes = await runBuildCommand({
        cwd: srcDir,
        out: 'out-default',
        homeDir: tmpHome,
        interactive: false,
        output: defaultOut,
      });

      assert.equal(defaultRes.built, true);
      assert.equal(defaultRes.result?.demoCount, 2);
      assert.deepEqual(defaultRes.result?.accessFilter, { levels: ['Public'], includeAll: false });
      assert.deepEqual(defaultRes.result?.unsupportedDemos, []);
      assert.equal(defaultRes.result?.excludedDemos.length, 6);

      const defaultManifest = JSON.parse(
        await fs.readFile(path.join(srcDir, 'out-default', 'demos.json'), 'utf8'),
      ) as DemoManifest;
      assert.deepEqual(collectPaths(defaultManifest), [
        'mixed-group/public-child/',
        'public-demo/',
      ]);
      // Excluded Pens and empty non-Public groups must NOT exist on disk in outDir
      assert.ok((await fs.stat(path.join(srcDir, 'out-default', 'public-demo', 'index.html'))).isFile());
      assert.ok(
        (await fs.stat(path.join(srcDir, 'out-default', 'mixed-group', 'public-child', 'index.html'))).isFile(),
      );
      await assert.rejects(() => fs.stat(path.join(srcDir, 'out-default', 'private-demo')));
      await assert.rejects(() => fs.stat(path.join(srcDir, 'out-default', 'secret-group')));
      await assert.rejects(() => fs.stat(path.join(srcDir, 'out-default', 'legacy-demo')));
      await assert.rejects(() => fs.stat(path.join(srcDir, 'out-default', 'invalid-access-demo')));
      await assert.rejects(() => fs.stat(path.join(srcDir, 'out-default', 'mixed-group', 'private-child')));

      const defaultLog = stripAnsi(defaultOut.stdout());
      assert.match(defaultLog, /Skipped:\s+6 Pens excluded by access filter/);
      assert.match(defaultLog, /2 Private, 1 Protected, 1 Collaborators, 2 unknown/);
      assert.match(defaultLog, /--access <levels> or --access all/);

      // B. --access Public,Private (case-insensitive & spaces around commas)
      const pubPrivOut = createBufferedOutput();
      const pubPrivRes = await runBuildCommand({
        cwd: srcDir,
        out: 'out-pub-priv',
        access: 'private, PUBLIC',
        homeDir: tmpHome,
        interactive: false,
        output: pubPrivOut,
      });

      assert.equal(pubPrivRes.result?.demoCount, 4);
      assert.deepEqual(pubPrivRes.result?.accessFilter, {
        levels: ['Public', 'Private'],
        includeAll: false,
      });
      // Now that private-demo is included, its unsupported block IS detected & rendered
      assert.deepEqual(pubPrivRes.result?.unsupportedDemos, [
        { path: 'private-demo/', blocks: ['sass-1'] },
      ]);
      const pubPrivManifest = JSON.parse(
        await fs.readFile(path.join(srcDir, 'out-pub-priv', 'demos.json'), 'utf8'),
      ) as DemoManifest;
      assert.deepEqual(collectPaths(pubPrivManifest), [
        'mixed-group/private-child/',
        'mixed-group/public-child/',
        'private-demo/',
        'public-demo/',
      ]);
      await assert.rejects(() => fs.stat(path.join(srcDir, 'out-pub-priv', 'secret-group')));
      await assert.rejects(() => fs.stat(path.join(srcDir, 'out-pub-priv', 'legacy-demo')));
      const pubPrivLog = stripAnsi(pubPrivOut.stdout());
      assert.match(pubPrivLog, /Access:\s+Public, Private/);
      assert.match(pubPrivLog, /Skipped:\s+4 Pens excluded by access filter/);

      // C. --access Private only (excludes Public!)
      const privOnlyRes = await runBuildCommand({
        cwd: srcDir,
        out: 'out-priv-only',
        access: 'Private',
        homeDir: tmpHome,
        interactive: false,
        output: createBufferedOutput(),
      });
      assert.equal(privOnlyRes.result?.demoCount, 2);
      const privOnlyManifest = JSON.parse(
        await fs.readFile(path.join(srcDir, 'out-priv-only', 'demos.json'), 'utf8'),
      ) as DemoManifest;
      assert.deepEqual(collectPaths(privOnlyManifest), [
        'mixed-group/private-child/',
        'private-demo/',
      ]);
      await assert.rejects(() => fs.stat(path.join(srcDir, 'out-priv-only', 'public-demo')));

      // D. --visibility alias + repeated flag array values
      const visRes = await runBuildCommand({
        cwd: srcDir,
        out: 'out-vis',
        visibility: ['Protected', 'Collaborators'],
        homeDir: tmpHome,
        interactive: false,
        output: createBufferedOutput(),
      });
      assert.equal(visRes.result?.demoCount, 2);
      const visManifest = JSON.parse(
        await fs.readFile(path.join(srcDir, 'out-vis', 'demos.json'), 'utf8'),
      ) as DemoManifest;
      assert.deepEqual(collectPaths(visManifest), [
        'secret-group/collab-demo/',
        'secret-group/protected-demo/',
      ]);

      // E. --access all includes all access levels AND legacy/unknown-access Pens (while still treating Pens as leaves)
      const allJsonOut = createBufferedOutput();
      const allRes = await runBuildCommand({
        cwd: srcDir,
        out: 'out-all',
        access: 'all',
        json: true,
        homeDir: tmpHome,
        interactive: false,
        output: allJsonOut,
      });
      assert.equal(allRes.result?.demoCount, 8);
      assert.deepEqual(allRes.result?.excludedDemos, []);
      assert.deepEqual(allRes.result?.accessFilter, {
        levels: ['Public', 'Private', 'Protected', 'Collaborators'],
        includeAll: true,
      });
      const allEnvelope = parseJsonOutput<{
        demo_count: number;
        access_levels: string[];
        include_all_access: boolean;
        excluded_demo_count: number;
        excluded_demos: Array<{ path: string; access: string | null }>;
      }>(allJsonOut);
      assert.equal(allEnvelope.status.code, 200);
      assert.equal(allEnvelope.contents.demo_count, 8);
      assert.deepEqual(allEnvelope.contents.access_levels, [
        'Public',
        'Private',
        'Protected',
        'Collaborators',
      ]);
      assert.equal(allEnvelope.contents.include_all_access, true);
      assert.equal(allEnvelope.contents.excluded_demo_count, 0);
      assert.deepEqual(allEnvelope.contents.excluded_demos, []);

      // F. --json envelope on default build reports excluded demos & access_levels accurately
      const defaultJsonOut = createBufferedOutput();
      await runBuildCommand({
        cwd: srcDir,
        out: 'out-default-json',
        json: true,
        homeDir: tmpHome,
        interactive: false,
        output: defaultJsonOut,
      });
      const defaultEnvelope = parseJsonOutput<{
        demo_count: number;
        access_levels: string[];
        include_all_access: boolean;
        excluded_demo_count: number;
        excluded_demos: Array<{ path: string; access: string | null }>;
      }>(defaultJsonOut);
      assert.equal(defaultEnvelope.status.code, 200);
      assert.equal(defaultEnvelope.contents.demo_count, 2);
      assert.deepEqual(defaultEnvelope.contents.access_levels, ['Public']);
      assert.equal(defaultEnvelope.contents.include_all_access, false);
      assert.equal(defaultEnvelope.contents.excluded_demo_count, 6);
      assert.deepEqual(defaultEnvelope.contents.excluded_demos, [
        { path: 'invalid-access-demo/', access: null },
        { path: 'legacy-demo/', access: null },
        { path: 'mixed-group/private-child/', access: 'Private' },
        { path: 'private-demo/', access: 'Private' },
        { path: 'secret-group/collab-demo/', access: 'Collaborators' },
        { path: 'secret-group/protected-demo/', access: 'Protected' },
      ]);

      // G. Commander CLI parsing supports repeated --access flags
      const program = createProgram();
      const buildCmd = program.commands.find((c) => c.name() === 'build');
      assert.ok(buildCmd);
      let capturedAccess: unknown;
      buildCmd.action((_dirArg: string | undefined, opts: { access?: unknown }) => {
        capturedAccess = opts.access;
      });
      await program.parseAsync([
        'node',
        'cdpn',
        'build',
        '--access',
        'Public',
        '--access',
        'Private,Protected',
      ]);
      assert.deepEqual(capturedAccess, ['Public', 'Private,Protected']);

      // H. Verify `cdpn serve` still serves ALL Pens (including Private/Protected/legacy) by default
      const server = await startDevServer({
        targetDir: srcDir,
        port: 0,
        allowEphemeralPort: true,
        homeDir: tmpHome,
      });
      try {
        assert.equal(server.mode, 'collection');
        assert.equal(server.demoCount, 8);
      } finally {
        await server.close();
      }
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
      await fs.rm(tmpHome, { recursive: true, force: true });
    }
  });

  it('rejects invalid or conflicting --access / --visibility flags with CliError(400) and allows single-Pen builds regardless of access', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-build-access-validation-'));
    try {
      await fs.writeFile(
        path.join(tmpDir, '.cdpn.json'),
        JSON.stringify({ info: { title: 'Private Pen', access: 'Private' } }),
      );
      await fs.writeFile(path.join(tmpDir, 'index.html'), '<h1>Private Single Pen</h1>');

      // Invalid values fail fast with 400
      for (const badOpts of [
        { access: '' },
        { access: ' , ' },
        { access: 'Secret' },
        { access: 'Public,Secret' },
        { access: '*' },
        { visibility: 'Unknown' },
        { access: 'Public', visibility: 'Private' },
        { access: 'all', visibility: 'Public,Private,Protected,Collaborators' },
      ]) {
        await assert.rejects(
          () =>
            runBuildCommand({
              cwd: tmpDir,
              out: 'out',
              interactive: false,
              output: createBufferedOutput(),
              ...badOpts,
            }),
          (err: unknown) => err instanceof CliError && err.statusCode === 400,
        );
      }

      // Matching --access and --visibility in different order/casing are accepted without conflict,
      // and single-Pen mode still builds the Private Pen while noting --access only applies to collections
      const out = createBufferedOutput();
      const res = await runBuildCommand({
        cwd: tmpDir,
        out: 'out',
        access: 'Public,Private',
        visibility: 'private,public',
        interactive: false,
        output: out,
      });
      assert.equal(res.built, true);
      assert.equal(res.result?.mode, 'pen');
      assert.equal(
        await fs.readFile(path.join(tmpDir, 'out', 'index.html'), 'utf8'),
        '<h1>Private Single Pen</h1>',
      );
      assert.match(
        stripAnsi(out.stdout()),
        /--access is only used when building a directory of Pens/,
      );
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('resolves --out (and default/prompted output paths) relative to cwd rather than the source directory', async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-build-rel-cwd-'));
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-build-rel-cwd-home-'));
    try {
      const blocksDir = path.join(tmpRoot, 'testdata', 'blocks');
      await fs.mkdir(path.join(blocksDir, 'demo-a'), { recursive: true });
      await fs.writeFile(
        path.join(blocksDir, 'demo-a', '.cdpn.json'),
        JSON.stringify({ info: { title: 'Demo A', access: 'Public' } }),
      );
      await fs.writeFile(path.join(blocksDir, 'demo-a', 'index.html'), '<h1>Demo A</h1>');

      // 1. `cdpn build testdata/blocks --out testdata-build` -> ./testdata-build (NOT testdata/blocks/testdata-build)
      const out = createBufferedOutput();
      const res = await runBuildCommand({
        cwd: tmpRoot,
        dirArg: 'testdata/blocks',
        out: 'testdata-build',
        homeDir: tmpHome,
        interactive: false,
        output: out,
      });

      const realRoot = await fs.realpath(tmpRoot);
      assert.equal(res.built, true);
      assert.equal(res.result?.mode, 'collection');
      assert.equal(res.result?.demoCount, 1);
      assert.equal(res.result?.outDir, path.join(realRoot, 'testdata-build'));
      assert.ok((await fs.stat(path.join(tmpRoot, 'testdata-build', 'demos.json'))).isFile());
      assert.ok((await fs.stat(path.join(tmpRoot, 'testdata-build', 'demo-a', 'index.html'))).isFile());
      await assert.rejects(() => fs.stat(path.join(blocksDir, 'testdata-build')));
      assert.match(stripAnsi(out.stdout()), /Built testdata-build \(1 demo\)/);

      // 2. Rejects `--out .` (ancestor of source dir) and `--out testdata/blocks` (same as source dir)
      await assert.rejects(
        () =>
          runBuildCommand({
            cwd: tmpRoot,
            dirArg: 'testdata/blocks',
            out: '.',
            homeDir: tmpHome,
            interactive: false,
            output: createBufferedOutput(),
          }),
        (err: unknown) => err instanceof CliError && err.statusCode === 400 && /ancestor/i.test(err.message),
      );
      await assert.rejects(
        () =>
          runBuildCommand({
            cwd: tmpRoot,
            dirArg: 'testdata/blocks',
            out: 'testdata/blocks',
            homeDir: tmpHome,
            interactive: false,
            output: createBufferedOutput(),
          }),
        (err: unknown) => err instanceof CliError && err.statusCode === 400 && /same as/i.test(err.message),
      );

      // 3. Explicit --out targeting a subfolder inside a single Pen (`testdata/blocks/demo-a/dist`) still updates its .cdpnignore
      const penRes = await runBuildCommand({
        cwd: tmpRoot,
        dirArg: 'testdata/blocks/demo-a',
        out: 'testdata/blocks/demo-a/dist',
        homeDir: tmpHome,
        interactive: false,
        output: createBufferedOutput(),
      });
      assert.equal(penRes.built, true);
      assert.equal(penRes.result?.mode, 'pen');
      assert.equal(penRes.result?.outDir, path.join(realRoot, 'testdata', 'blocks', 'demo-a', 'dist'));
      assert.equal(penRes.cdpnIgnoreUpdated, true);
      assert.equal(penRes.cdpnIgnoreEntry, 'dist/');
      assert.equal(
        await fs.readFile(path.join(blocksDir, 'demo-a', '.cdpnignore'), 'utf8'),
        'dist/\n',
      );
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
      await fs.rm(tmpHome, { recursive: true, force: true });
    }
  });
});
