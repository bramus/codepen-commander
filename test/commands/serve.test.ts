import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { runServeCommand } from '../../src/commands/serve.js';
import { writeUnlinkedProjectInfo } from '../../src/config/project.js';
import { stripAnsi } from '../../src/utils/format.js';
import type { SelectOption } from '../../src/utils/prompts/index.js';
import { createBufferedOutput, createSilentOutput } from '../helpers/output.js';
import { withTempDir } from '../helpers/temp-dir.js';

describe('cdpn serve command (pre-serve block checks)', () => {
  it('suggests adding the classic block first and the packages block last, allowing both simultaneously and serving compiled Classic HTML with importmap', async () => {
    await withTempDir(async (tmpRoot) => {
      const penDir = path.join(tmpRoot, 'classic-and-packages');
      await fs.mkdir(path.join(penDir, '.codepen'), { recursive: true });
      await writeUnlinkedProjectInfo(penDir, { title: 'Missing Classic & Packages', access: 'Public' });
      await fs.writeFile(
        path.join(penDir, '.codepen', 'pen.config.json'),
        JSON.stringify({
          blocks: {
            'fingerprint-1': { name: 'fingerprint-1', disabled: false, version: 'latest' },
            'validate-1': { name: 'validate-1', disabled: false, version: 'latest' },
          },
        }),
      );
      await fs.writeFile(path.join(penDir, 'index.pen.html'), '<main>Hello Classic</main>\n');
      await fs.writeFile(path.join(penDir, 'style.css'), 'main { color: tomato; }\n');
      await fs.writeFile(path.join(penDir, 'script.js'), "import gsap from 'gsap';\nconsole.log(gsap);\n");
      await fs.writeFile(
        path.join(penDir, 'package.json'),
        JSON.stringify({ dependencies: { gsap: '3.12.5' } }),
      );

      // 1. Non-interactive warns for both classic (first) and packages (last) without modifying .codepen/pen.config.json
      const nonIntOut = createBufferedOutput();
      const nonIntServer = await runServeCommand({
        cwd: penDir,
        port: '0',
        allowEphemeralPort: true,
        interactive: false,
        output: nonIntOut,
      });
      try {
        const plain = stripAnsi(nonIntOut.stdout());
        const classicIdx = plain.indexOf('Found `index.pen.html`');
        const packagesIdx = plain.indexOf('Found `package.json` with dependencies');
        assert.ok(classicIdx !== -1, plain);
        assert.ok(packagesIdx !== -1, plain);
        assert.ok(classicIdx < packagesIdx, 'classic warning must appear before packages warning');
        assert.equal(nonIntServer.inspection.penBlocks?.hasClassic, false);
        assert.equal(nonIntServer.inspection.penBlocks?.hasPackages, false);
      } finally {
        await nonIntServer.close();
      }

      // 2. Interactive Yes to both adds classic first, then packages last, and serves compiled Classic HTML with importmap
      const confirms: Array<{ q: string; def?: boolean }> = [];
      const out = createBufferedOutput();
      const running = await runServeCommand({
        cwd: penDir,
        port: '0',
        allowEphemeralPort: true,
        interactive: true,
        output: out,
        prompts: {
          confirm: async (q, def) => {
            confirms.push({ q, def });
            return true;
          },
        },
      });

      try {
        assert.deepEqual(confirms, [
          { q: 'Add the `classic` block before serving?', def: true },
          { q: 'Add the `packages` block before serving?', def: true },
        ]);
        assert.equal(running.inspection.penBlocks?.hasClassic, true);
        assert.equal(running.inspection.penBlocks?.hasPackages, true);

        const penCfg = JSON.parse(
          await fs.readFile(path.join(penDir, '.codepen', 'pen.config.json'), 'utf8'),
        ) as { blocks: Record<string, { disabled: boolean }> };
        assert.deepEqual(Object.keys(penCfg.blocks).sort(), [
          'classic-1',
          'fingerprint-1',
          'packages-1',
          'validate-1',
        ]);

        const classicCfg = JSON.parse(
          await fs.readFile(path.join(penDir, '.codepen', 'classic.config.json'), 'utf8'),
        ) as { styles: string[]; scripts: string[] };
        assert.deepEqual(classicCfg.styles, ['/style.css']);
        assert.deepEqual(classicCfg.scripts, ['/script.js']);

        const res = await fetch(`${running.url}/`);
        assert.equal(res.status, 200);
        const html = await res.text();
        assert.ok(html.includes('<main>Hello Classic</main>'), html);
        assert.ok(html.includes('href="./style.css"'), html);
        assert.ok(html.includes('<script type="module" src="./script.js"></script>'), html);
        assert.ok(html.includes('<script type="importmap">'), html);
        assert.ok(html.includes('https://esm.sh/gsap@3.12.5'), html);
      } finally {
        await running.close();
      }

      // 3. Adding classic when packages is ALREADY enabled preserves packages without re-prompting for packages
      const existingPkgDir = path.join(tmpRoot, 'existing-packages');
      await fs.mkdir(path.join(existingPkgDir, '.codepen'), { recursive: true });
      await writeUnlinkedProjectInfo(existingPkgDir, { title: 'Existing Packages', access: 'Public' });
      await fs.writeFile(
        path.join(existingPkgDir, '.codepen', 'pen.config.json'),
        JSON.stringify({
          blocks: {
            'fingerprint-1': { name: 'fingerprint-1', disabled: false, version: 'latest' },
            'packages-1': { name: 'packages-1', disabled: false, version: 'latest' },
            'validate-1': { name: 'validate-1', disabled: false, version: 'latest' },
          },
        }),
      );
      await fs.writeFile(path.join(existingPkgDir, 'index.pen.html'), '<p>Keep Packages</p>\n');
      await fs.writeFile(
        path.join(existingPkgDir, 'package.json'),
        JSON.stringify({ dependencies: { gsap: '3.12.5' } }),
      );

      const existingPkgConfirms: string[] = [];
      const existingPkgServer = await runServeCommand({
        cwd: existingPkgDir,
        port: '0',
        allowEphemeralPort: true,
        interactive: true,
        output: createSilentOutput(),
        prompts: {
          confirm: async (q) => {
            existingPkgConfirms.push(q);
            return true;
          },
        },
      });
      try {
        assert.deepEqual(existingPkgConfirms, ['Add the `classic` block before serving?']);
        assert.equal(existingPkgServer.inspection.penBlocks?.hasClassic, true);
        assert.equal(existingPkgServer.inspection.penBlocks?.hasPackages, true);
        const penCfg = JSON.parse(
          await fs.readFile(path.join(existingPkgDir, '.codepen', 'pen.config.json'), 'utf8'),
        ) as { blocks: Record<string, unknown> };
        assert.deepEqual(Object.keys(penCfg.blocks).sort(), [
          'classic-1',
          'fingerprint-1',
          'packages-1',
          'validate-1',
        ]);
      } finally {
        await existingPkgServer.close();
      }
    }, 'cdpn-serve-add-classic-');
  });

  it('when classic is enabled and index.html exists, offers to rename to index.pen.html or remove classic (and always runs packages check last)', async () => {
    await withTempDir(async (tmpRoot) => {
      const setupClassicWithIndexHtml = async (name: string, withPkgDeps: boolean) => {
        const dir = path.join(tmpRoot, name);
        await fs.mkdir(path.join(dir, '.codepen'), { recursive: true });
        await writeUnlinkedProjectInfo(dir, { title: name, access: 'Public' });
        await fs.writeFile(
          path.join(dir, '.codepen', 'pen.config.json'),
          JSON.stringify({
            blocks: {
              'classic-1': { name: 'classic-1', disabled: false, version: 'latest' },
              'fingerprint-1': { name: 'fingerprint-1', disabled: false, version: 'latest' },
              'validate-1': { name: 'validate-1', disabled: false, version: 'latest' },
            },
          }),
        );
        await fs.writeFile(
          path.join(dir, 'index.html'),
          '<!DOCTYPE html><html><head><title>Demo</title></head><body><h1>Body</h1></body></html>',
        );
        if (withPkgDeps) {
          await fs.writeFile(
            path.join(dir, 'package.json'),
            JSON.stringify({ dependencies: { gsap: '3.12.5' } }),
          );
        }
        return dir;
      };

      // 1. Choice: rename index.html -> index.pen.html (keeps classic AND still runs packages check last)
      const renameDir = await setupClassicWithIndexHtml('rename-flow', true);
      let seenSelectOpts: SelectOption<string>[] = [];
      const renameSteps: string[] = [];
      const renameServer = await runServeCommand({
        cwd: renameDir,
        port: '0',
        allowEphemeralPort: true,
        interactive: true,
        output: createSilentOutput(),
        prompts: {
          select: async (q, opts) => {
            seenSelectOpts = opts;
            renameSteps.push(`select:${q}`);
            return 'rename' as never;
          },
          confirm: async (q) => {
            renameSteps.push(`confirm:${q}`);
            return true;
          },
        },
      });
      try {
        assert.deepEqual(
          seenSelectOpts.map((o) => o.value),
          ['rename', 'remove-classic', 'skip'],
        );
        assert.deepEqual(renameSteps, [
          'select:How would you like to proceed?',
          'confirm:Add the `packages` block before serving?',
        ]);
        await assert.rejects(() => fs.lstat(path.join(renameDir, 'index.html')));
        assert.ok((await fs.stat(path.join(renameDir, 'index.pen.html'))).isFile());
        assert.equal(renameServer.inspection.penBlocks?.hasClassic, true);
        assert.equal(renameServer.inspection.penBlocks?.hasPackages, true);

        const res = await fetch(`${renameServer.url}/`);
        assert.equal(res.status, 200);
        const body = await res.text();
        assert.ok(body.includes('<h1>Body</h1>'), body);
        assert.ok(body.includes('<script type="importmap">'), body);
        assert.ok(body.includes('https://esm.sh/gsap@3.12.5'), body);
      } finally {
        await renameServer.close();
      }

      // 2. Choice: remove-classic -> removes classic block AND THEN prompts to add packages block
      const removeDir = await setupClassicWithIndexHtml('remove-then-packages', true);
      const stepOrder: string[] = [];
      const removeServer = await runServeCommand({
        cwd: removeDir,
        port: '0',
        allowEphemeralPort: true,
        interactive: true,
        output: createSilentOutput(),
        prompts: {
          select: async (q) => {
            stepOrder.push(`select:${q}`);
            return 'remove-classic' as never;
          },
          confirm: async (q) => {
            stepOrder.push(`confirm:${q}`);
            return true;
          },
        },
      });
      try {
        assert.deepEqual(stepOrder, [
          'select:How would you like to proceed?',
          'confirm:Add the `packages` block before serving?',
        ]);
        assert.ok((await fs.stat(path.join(removeDir, 'index.html'))).isFile());
        await assert.rejects(() => fs.lstat(path.join(removeDir, 'index.pen.html')));
        assert.equal(removeServer.inspection.penBlocks?.hasClassic, false);
        assert.equal(removeServer.inspection.penBlocks?.hasPackages, true);

        const penCfg = JSON.parse(
          await fs.readFile(path.join(removeDir, '.codepen', 'pen.config.json'), 'utf8'),
        ) as { blocks: Record<string, unknown> };
        assert.deepEqual(Object.keys(penCfg.blocks).sort(), [
          'fingerprint-1',
          'packages-1',
          'validate-1',
        ]);

        // Served HTML immediately has the esm.sh importmap injected!
        const res = await fetch(`${removeServer.url}/`);
        assert.equal(res.status, 200);
        const html = await res.text();
        assert.ok(html.includes('<script type="importmap">'), html);
        assert.ok(html.includes('https://esm.sh/gsap@3.12.5'), html);
      } finally {
        await removeServer.close();
      }

      // 3. Choice: skip -> leaves files & config untouched
      const skipDir = await setupClassicWithIndexHtml('skip-flow', false);
      const skipServer = await runServeCommand({
        cwd: skipDir,
        port: '0',
        allowEphemeralPort: true,
        interactive: true,
        output: createSilentOutput(),
        prompts: {
          select: async () => 'skip' as never,
        },
      });
      try {
        assert.ok((await fs.stat(path.join(skipDir, 'index.html'))).isFile());
        await assert.rejects(() => fs.lstat(path.join(skipDir, 'index.pen.html')));
        assert.equal(skipServer.inspection.penBlocks?.hasClassic, true);
      } finally {
        await skipServer.close();
      }
    }, 'cdpn-serve-classic-conflict-');
  });

  it('suggests adding the packages block only when package.json has dependencies, and skips prompts when already configured or serving a collection', async () => {
    await withTempDir(async (tmpRoot) => {
      // 1. package.json WITHOUT dependencies (only devDependencies) -> NO prompt!
      const noDepsDir = path.join(tmpRoot, 'no-deps');
      await fs.mkdir(noDepsDir, { recursive: true });
      await writeUnlinkedProjectInfo(noDepsDir, { title: 'No Deps', access: 'Public' });
      await fs.writeFile(path.join(noDepsDir, 'index.html'), '<h1>No Deps</h1>');
      await fs.writeFile(
        path.join(noDepsDir, 'package.json'),
        JSON.stringify({ name: 'no-deps', devDependencies: { vite: '^5.0.0' } }),
      );

      let noDepsPrompted = false;
      const noDepsServer = await runServeCommand({
        cwd: noDepsDir,
        port: '0',
        allowEphemeralPort: true,
        interactive: true,
        output: createSilentOutput(),
        prompts: {
          confirm: async () => {
            noDepsPrompted = true;
            return true;
          },
        },
      });
      try {
        assert.equal(noDepsPrompted, false);
        assert.equal(noDepsServer.inspection.hasCodepenDir, false);
      } finally {
        await noDepsServer.close();
      }

      // 2. package.json WITH dependencies (even with missing .codepen/ dir) -> offers adding packages block
      const withDepsDir = path.join(tmpRoot, 'with-deps');
      await fs.mkdir(withDepsDir, { recursive: true });
      await writeUnlinkedProjectInfo(withDepsDir, { title: 'With Deps', access: 'Public' });
      await fs.writeFile(
        path.join(withDepsDir, 'index.html'),
        '<!DOCTYPE html><html><head><title>Deps</title></head><body>Hi</body></html>',
      );
      await fs.writeFile(
        path.join(withDepsDir, 'package.json'),
        JSON.stringify({ dependencies: { 'canvas-confetti': '^1.9.3' } }),
      );

      const confirms: Array<{ q: string; def?: boolean }> = [];
      const withDepsServer = await runServeCommand({
        cwd: withDepsDir,
        port: '0',
        allowEphemeralPort: true,
        interactive: true,
        output: createSilentOutput(),
        prompts: {
          confirm: async (q, def) => {
            confirms.push({ q, def });
            return true;
          },
        },
      });
      try {
        assert.deepEqual(confirms, [
          { q: 'Add the `packages` block before serving?', def: true },
        ]);
        assert.equal(withDepsServer.inspection.penBlocks?.hasPackages, true);
        const res = await fetch(`${withDepsServer.url}/`);
        const html = await res.text();
        assert.ok(html.includes('<script type="importmap">'), html);
        assert.ok(html.includes('https://esm.sh/canvas-confetti@^1.9.3'), html);
      } finally {
        await withDepsServer.close();
      }

      // 3. Re-serving now that packages IS enabled -> zero prompts!
      let rePrompted = false;
      const reServer = await runServeCommand({
        cwd: withDepsDir,
        port: '0',
        allowEphemeralPort: true,
        interactive: true,
        output: createSilentOutput(),
        prompts: {
          confirm: async () => {
            rePrompted = true;
            return true;
          },
        },
      });
      try {
        assert.equal(rePrompted, false);
      } finally {
        await reServer.close();
      }

      // 4. Serving parent collection directory (no root .cdpn.json) -> zero prompts!
      let colPrompted = false;
      const colServer = await runServeCommand({
        cwd: tmpRoot,
        port: '0',
        allowEphemeralPort: true,
        interactive: true,
        output: createSilentOutput(),
        prompts: {
          confirm: async () => {
            colPrompted = true;
            return true;
          },
          select: async () => {
            colPrompted = true;
            return 'skip' as never;
          },
        },
      });
      try {
        assert.equal(colServer.mode, 'collection');
        assert.equal(colPrompted, false);
      } finally {
        await colServer.close();
      }
    }, 'cdpn-serve-packages-');
  });

  it('generates missing .codepen/classic.config.json when classic block is already enabled, without overwriting an existing one', async () => {
    await withTempDir(async (penDir) => {
      await writeUnlinkedProjectInfo(penDir, { title: 'Classic No Config', access: 'Public' });
      await fs.mkdir(path.join(penDir, '.codepen'), { recursive: true });
      await fs.writeFile(
        path.join(penDir, '.codepen', 'pen.config.json'),
        JSON.stringify({
          blocks: {
            'classic-1': { name: 'classic-1', disabled: false, version: 'latest' },
            'fingerprint-1': { name: 'fingerprint-1', disabled: false, version: 'latest' },
            'validate-1': { name: 'validate-1', disabled: false, version: 'latest' },
          },
        }),
      );
      await fs.writeFile(path.join(penDir, 'index.pen.html'), '<section>Classic Content</section>\n');
      await fs.writeFile(path.join(penDir, 'style.css'), 'section { color: rebeccapurple; }\n');
      await fs.writeFile(path.join(penDir, 'script.js'), 'console.log("classic");\n');

      let prompted = false;
      const out = createBufferedOutput();
      const running = await runServeCommand({
        cwd: penDir,
        port: '0',
        allowEphemeralPort: true,
        interactive: true,
        output: out,
        prompts: {
          confirm: async () => {
            prompted = true;
            return true;
          },
          select: async () => {
            prompted = true;
            return 'skip' as never;
          },
        },
      });

      try {
        assert.equal(prompted, false);
        assert.match(stripAnsi(out.stdout()), /Generated missing \.codepen\/classic\.config\.json/);

        const classicCfgPath = path.join(penDir, '.codepen', 'classic.config.json');
        const classicCfg = JSON.parse(await fs.readFile(classicCfgPath, 'utf8')) as {
          head: string;
          htmlClasses: string;
          styles: string[];
          scripts: string[];
        };
        assert.deepEqual(classicCfg.styles, ['/style.css']);
        assert.deepEqual(classicCfg.scripts, ['/script.js']);

        const res = await fetch(`${running.url}/`);
        assert.equal(res.status, 200);
        const html = await res.text();
        assert.ok(html.includes('<section>Classic Content</section>'), html);
        assert.ok(html.includes('href="./style.css"'), html);
        assert.ok(html.includes('src="./script.js"'), html);
      } finally {
        await running.close();
      }

      // Customize classic.config.json and re-serve -> must NOT overwrite existing file
      const customConfig = {
        head: '<meta name="custom" content="kept" />',
        htmlClasses: 'my-class',
        styles: ['/style.css'],
        scripts: [],
      };
      await fs.writeFile(
        path.join(penDir, '.codepen', 'classic.config.json'),
        `${JSON.stringify(customConfig, null, 2)}\n`,
      );

      const out2 = createBufferedOutput();
      const running2 = await runServeCommand({
        cwd: penDir,
        port: '0',
        allowEphemeralPort: true,
        interactive: false,
        output: out2,
      });
      try {
        assert.doesNotMatch(stripAnsi(out2.stdout()), /Generated missing/);
        const afterCfg = JSON.parse(
          await fs.readFile(path.join(penDir, '.codepen', 'classic.config.json'), 'utf8'),
        );
        assert.deepEqual(afterCfg, customConfig);
      } finally {
        await running2.close();
      }
    }, 'cdpn-serve-missing-classic-cfg-');
  });
});
