import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { setConfiguredShellDir } from '../src/config/auth.js';
import { startDevServer } from '../src/site/server.js';

describe('cdpn serve (single Pen, standalone, collection, blocks, custom shells, security)', () => {
  it('serves a single Pen with .cdpn.json + .codepen/ (packages & classic blocks) and blocks dotfiles', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-serve-pen-'));
    try {
      await fs.mkdir(path.join(tmpDir, '.codepen'), { recursive: true });
      await fs.writeFile(
        path.join(tmpDir, '.cdpn.json'),
        JSON.stringify({
          url: 'https://codepen.io/bramus/pen/test123',
          pen_id: 'test123',
          last_synced_version_id: 'v1',
          editor: 'V2',
          info: { title: 'Packages Pen' },
        }),
      );
      await fs.writeFile(
        path.join(tmpDir, '.codepen', 'pen.config.json'),
        JSON.stringify({
          blocks: { 'packages-1': { name: 'packages-1', disabled: false } },
        }),
      );
      await fs.writeFile(
        path.join(tmpDir, 'package.json'),
        JSON.stringify({ dependencies: { gsap: '3.12.5' } }),
      );
      await fs.writeFile(
        path.join(tmpDir, 'index.html'),
        '<!DOCTYPE html><html><head><title>Hi</title></head><body>Demo</body></html>',
      );
      await fs.writeFile(path.join(tmpDir, '.env'), 'SECRET=topsecret\n');

      const running = await startDevServer({
        targetDir: tmpDir,
        port: 0,
        allowEphemeralPort: true,
      });

      try {
        assert.equal(running.mode, 'pen');
        assert.equal(running.host, '127.0.0.1');

        const res = await fetch(`${running.url}/`);
        assert.equal(res.status, 200);
        const body = await res.text();
        assert.ok(body.includes('<script type="importmap">'));
        assert.ok(body.includes('https://esm.sh/gsap@3.12.5'));

        // Dotfiles & traversal must be blocked with 403
        const cdpnRes = await fetch(`${running.url}/.cdpn.json`);
        assert.equal(cdpnRes.status, 403);
        const envRes = await fetch(`${running.url}/.env`);
        assert.equal(envRes.status, 403);
        const penCfgRes = await fetch(`${running.url}/.codepen/pen.config.json`);
        assert.equal(penCfgRes.status, 403);

        // Non-GET/HEAD methods must return 405
        const postRes = await fetch(`${running.url}/`, { method: 'POST' });
        assert.equal(postRes.status, 405);
      } finally {
        await running.close();
      }
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('serves a Pen with .cdpn.json and missing .codepen/ folder as plain static files', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-serve-no-codepen-'));
    try {
      await fs.writeFile(
        path.join(tmpDir, '.cdpn.json'),
        JSON.stringify({
          url: 'https://codepen.io/bramus/pen/plain1',
          pen_id: 'plain1',
          last_synced_version_id: 'v1',
          editor: 'V2',
        }),
      );
      await fs.writeFile(path.join(tmpDir, 'index.html'), '<h1>Plain Pen</h1>');

      const running = await startDevServer({
        targetDir: tmpDir,
        port: 0,
        allowEphemeralPort: true,
      });

      try {
        assert.equal(running.mode, 'pen');
        assert.equal(running.inspection.hasCodepenDir, false);
        const res = await fetch(`${running.url}/`);
        assert.equal(res.status, 200);
        assert.equal(await res.text(), '<h1>Plain Pen</h1>');
      } finally {
        await running.close();
      }
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('serves a Pen with .codepen/ alone (no .cdpn.json) in pen mode and renders 501 for unsupported blocks', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-serve-codepen-only-'));
    try {
      await fs.mkdir(path.join(tmpDir, '.codepen'), { recursive: true });
      await fs.writeFile(
        path.join(tmpDir, '.codepen', 'pen.config.json'),
        JSON.stringify({
          blocks: { 'markdown-1': { name: 'markdown-1', disabled: false } },
        }),
      );
      await fs.writeFile(path.join(tmpDir, 'index.md'), '# Markdown Pen');

      const running = await startDevServer({
        targetDir: tmpDir,
        port: 0,
        allowEphemeralPort: true,
      });

      try {
        assert.equal(running.mode, 'pen');
        const res = await fetch(`${running.url}/`);
        assert.equal(res.status, 501);
        const body = await res.text();
        assert.ok(body.includes('Unsupported CodePen Block'));
        assert.ok(body.includes('markdown-1'));
        assert.equal(body.includes('Back to Homepage'), false);
      } finally {
        await running.close();
      }
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('serves a collection directory dynamically with in-memory demos.json, built-in shell, and custom --shell / ~/.cdpn shell', async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-serve-collection-'));
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-serve-home-'));
    const collectionDir = path.join(tmpRoot, 'my-css-demos');
    const customShellDir = path.join(tmpRoot, 'custom-shell');

    try {
      // Create nested demos: one with .cdpn.json, one plain index.html, one classic Pen
      await fs.mkdir(path.join(collectionDir, 'alpha-demo'), { recursive: true });
      await fs.writeFile(
        path.join(collectionDir, 'alpha-demo', 'index.html'),
        '<!DOCTYPE html><html><head><title>Alpha Demo</title><meta name="description" content="Plain demo"></head><body>Alpha</body></html>',
      );

      await fs.mkdir(path.join(collectionDir, 'css', 'classic-pen', '.codepen'), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(collectionDir, 'css', 'classic-pen', '.cdpn.json'),
        JSON.stringify({
          url: 'https://codepen.io/bramus/pen/cls1',
          pen_id: 'cls1',
          last_synced_version_id: 'v1',
          info: { title: 'Classic Pen', tags: ['css'] },
        }),
      );
      await fs.writeFile(
        path.join(collectionDir, 'css', 'classic-pen', '.codepen', 'pen.config.json'),
        JSON.stringify({ blocks: { 'classic-1': { name: 'classic-1', disabled: false } } }),
      );
      await fs.writeFile(
        path.join(collectionDir, 'css', 'classic-pen', '.codepen', 'classic.config.json'),
        JSON.stringify({ styles: ['/style.css'], scripts: [] }),
      );
      await fs.writeFile(path.join(collectionDir, 'css', 'classic-pen', 'index.pen.html'), '<p>Classic</p>');
      await fs.writeFile(path.join(collectionDir, 'css', 'classic-pen', 'style.css'), 'p { color: blue; }');

      // 1. Default built-in shell with folder-derived title + custom --subtitle
      const running = await startDevServer({
        targetDir: collectionDir,
        port: 0,
        allowEphemeralPort: true,
        site: { subtitle: 'Custom subtitle here' },
        homeDir: tmpHome,
      });

      try {
        assert.equal(running.mode, 'collection');
        assert.equal(running.demoCount, 2);

        // Ensure serving NEVER writes a dist/ folder to disk
        await assert.rejects(() => fs.stat(path.join(collectionDir, 'dist')));

        const indexRes = await fetch(`${running.url}/`);
        assert.equal(indexRes.status, 200);
        assert.ok(indexRes.headers.get('content-security-policy')?.includes("script-src 'self'"));
        const indexHtml = await indexRes.text();
        assert.ok(indexHtml.includes('<title>My CSS Demos</title>'));
        assert.ok(indexHtml.includes('Custom subtitle here'));
        assert.ok(indexHtml.includes('codepen-commander'));

        const demosRes = await fetch(`${running.url}/demos.json`);
        assert.equal(demosRes.status, 200);
        const manifest = (await demosRes.json()) as {
          standalone: Array<{ title: string; path: string }>;
          groups: Array<{ title: string; demos: Array<{ title: string; codepenUrl: string }> }>;
        };
        assert.equal(manifest.standalone.length, 1);
        assert.equal(manifest.standalone[0]?.title, 'Alpha Demo');
        assert.equal(manifest.groups.length, 1);
        assert.equal(manifest.groups[0]?.title, 'CSS');
        assert.equal(manifest.groups[0]?.demos[0]?.title, 'Classic Pen');
        assert.equal(manifest.groups[0]?.demos[0]?.codepenUrl, 'https://codepen.io/bramus/pen/cls1');

        // Classic sub-pen compiles on the fly
        const classicRes = await fetch(`${running.url}/css/classic-pen/`);
        assert.equal(classicRes.status, 200);
        const classicHtml = await classicRes.text();
        assert.ok(classicHtml.includes('<p>Classic</p>'));
        assert.ok(classicHtml.includes('./style.css'));
      } finally {
        await running.close();
      }

      // 2. Global shell from ~/.cdpn (partial custom shell with extra asset + built-in fallback)
      await fs.mkdir(customShellDir, { recursive: true });
      await fs.writeFile(
        path.join(customShellDir, 'index.html'),
        '<!DOCTYPE html><html><head><title>{{SITE_TITLE}}</title></head><body><h1>CUSTOM SHELL</h1></body></html>',
      );
      await fs.writeFile(path.join(customShellDir, 'brand.txt'), 'custom-brand');
      await setConfiguredShellDir(customShellDir, { homeDir: tmpHome });

      const runningGlobalShell = await startDevServer({
        targetDir: collectionDir,
        port: 0,
        allowEphemeralPort: true,
        homeDir: tmpHome,
      });

      try {
        assert.equal(runningGlobalShell.shell?.source, 'config');
        const idx = await (await fetch(`${runningGlobalShell.url}/`)).text();
        assert.ok(idx.includes('CUSTOM SHELL'));
        assert.ok(idx.includes('My CSS Demos'));
        const brand = await fetch(`${runningGlobalShell.url}/brand.txt`);
        assert.equal(brand.status, 200);
        assert.equal(await brand.text(), 'custom-brand');
        // Partial shell falls back to built-in scripts.js
        const scripts = await fetch(`${runningGlobalShell.url}/scripts.js`);
        assert.equal(scripts.status, 200);
      } finally {
        await runningGlobalShell.close();
      }

      // 3. Existing index.html in collection root is preserved instead of generating shell index
      await fs.writeFile(path.join(collectionDir, 'index.html'), '<h1>My Handcrafted Root Index</h1>');
      const runningCustomRoot = await startDevServer({
        targetDir: collectionDir,
        port: 0,
        allowEphemeralPort: true,
        homeDir: tmpHome,
      });

      try {
        assert.equal(runningCustomRoot.mode, 'collection');
        const rootIdx = await (await fetch(`${runningCustomRoot.url}/`)).text();
        assert.equal(rootIdx, '<h1>My Handcrafted Root Index</h1>');
        // /demos.json is still dynamically served for the handcrafted index!
        const demosRes = await fetch(`${runningCustomRoot.url}/demos.json`);
        assert.equal(demosRes.status, 200);
      } finally {
        await runningCustomRoot.close();
      }
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
      await fs.rm(tmpHome, { recursive: true, force: true });
    }
  });
});
