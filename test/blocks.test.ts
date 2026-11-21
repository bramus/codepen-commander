import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  applyPackagesBlock,
  compileClassicPenHtml,
  readPenBlocks,
  renderUnsupportedBlocksPage,
  resolveServedHtmlWithBlocks,
  resolveVirtualClassicHtml,
  UNSUPPORTED_BLOCK_PAGE_CSP,
} from '../src/site/blocks.js';

describe('CodePen Blocks engine (classic, packages, unsupported)', () => {
  it('detects supported and unsupported active blocks while ignoring disabled blocks', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-blocks-detect-'));
    try {
      const realTmp = await fs.realpath(tmpDir);
      await fs.mkdir(path.join(realTmp, '.codepen'), { recursive: true });
      await fs.writeFile(
        path.join(realTmp, '.codepen', 'pen.config.json'),
        JSON.stringify({
          blocks: {
            'validate-1': { name: 'validate-1', disabled: false },
            'fingerprint-1': { name: 'fingerprint-1', disabled: false },
            'classic-1': { name: 'classic-1', disabled: false },
            'packages-1': { name: 'packages-1', disabled: false },
            'sass-1': { name: 'sass-1', disabled: true },
            'markdown-1': { name: 'markdown-1', disabled: false },
          },
        }),
      );

      const ctx = await readPenBlocks(realTmp, realTmp);
      assert.ok(ctx);
      assert.equal(ctx.hasClassic, true);
      assert.equal(ctx.hasPackages, true);
      assert.deepEqual(ctx.unsupportedBlocks, ['markdown-1']);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('compiles classic .pen.html with classic.config.json, rewrites asset paths, detects ESM, and rejects unsafe schemes', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-blocks-classic-'));
    try {
      const realTmp = await fs.realpath(tmpDir);
      await fs.mkdir(path.join(realTmp, '.codepen'), { recursive: true });
      await fs.writeFile(
        path.join(realTmp, '.codepen', 'pen.config.json'),
        JSON.stringify({
          blocks: {
            'classic-1': { name: 'classic-1', disabled: false },
            'packages-1': { name: 'packages-1', disabled: false },
          },
        }),
      );
      await fs.writeFile(
        path.join(realTmp, '.codepen', 'classic.config.json'),
        JSON.stringify({
          head: '<meta name="viewport" content="width=device-width">',
          htmlClasses: ['demo-root', 'theme-dark'],
          styles: ['/style.css', 'https://cdn.example.com/lib.css', 'javascript:alert(1)'],
          scripts: ['/script.js', 'data:text/javascript,alert(1)'],
        }),
      );
      await fs.writeFile(
        path.join(realTmp, '.cdpn.json'),
        JSON.stringify({ info: { title: 'Classic <Demo> & More' } }),
      );
      await fs.writeFile(
        path.join(realTmp, 'package.json'),
        JSON.stringify({ dependencies: { 'canvas-confetti': '^1.9.3' } }),
      );
      await fs.writeFile(path.join(realTmp, 'index.pen.html'), '<h1>Hello Classic</h1>\n');
      await fs.writeFile(path.join(realTmp, 'style.css'), 'body { color: red; }\n');
      await fs.writeFile(
        path.join(realTmp, 'script.js'),
        "import confetti from 'canvas-confetti';\nconfetti();\n",
      );

      const html = await resolveVirtualClassicHtml({
        dirRealpath: realTmp,
        requestedFilename: 'index.html',
        rootRealpath: realTmp,
      });
      assert.ok(html);
      assert.ok(html.includes('<html lang="en" class="demo-root theme-dark">'));
      assert.ok(html.includes('<title>Classic &lt;Demo&gt; &amp; More</title>'));
      assert.ok(html.includes('<link rel="stylesheet" href="./style.css">'));
      assert.ok(html.includes('<link rel="stylesheet" href="https://cdn.example.com/lib.css">'));
      assert.ok(html.includes('<script type="module" src="./script.js"></script>'));
      assert.ok(html.includes('<script type="importmap">'));
      assert.ok(html.includes('"canvas-confetti": "https://esm.sh/canvas-confetti@^1.9.3"'));
      assert.equal(html.includes('javascript:alert'), false);
      assert.equal(html.includes('data:text/javascript'), false);

      // Direct compileClassicPenHtml also works
      const ctx = await readPenBlocks(realTmp, realTmp);
      assert.ok(ctx);
      const compiled = await compileClassicPenHtml({
        penHtmlPath: path.join(realTmp, 'index.pen.html'),
        penContext: ctx,
        rootRealpath: realTmp,
      });
      assert.equal(compiled, html);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('merges packages importmap into existing importmap while preserving user overrides and escaping <', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-blocks-packages-'));
    try {
      const realTmp = await fs.realpath(tmpDir);
      await fs.mkdir(path.join(realTmp, '.codepen'), { recursive: true });
      await fs.writeFile(
        path.join(realTmp, '.codepen', 'pen.config.json'),
        JSON.stringify({
          blocks: { 'packages-1': { name: 'packages-1', disabled: false } },
        }),
      );
      await fs.writeFile(
        path.join(realTmp, 'package.json'),
        JSON.stringify({
          dependencies: {
            lit: '3.2.0',
            'bad/../../pkg': '1.0.0',
          },
        }),
      );
      await fs.writeFile(
        path.join(realTmp, 'index.html'),
        `<!DOCTYPE html>
<html>
<head>
  <script type="importmap">
  {
    "imports": {
      "custom": "/local.js",
      "lit": "https://example.com/custom-lit.js"
    }
  }
  </script>
</head>
<body></body>
</html>`,
      );

      const res = await resolveServedHtmlWithBlocks({
        filePath: path.join(realTmp, 'index.html'),
        rootRealpath: realTmp,
      });
      assert.equal(res.transformed, true);
      if (res.transformed) {
        assert.ok(res.html.includes('"custom": "/local.js"'));
        // User override takes precedence over generated esm.sh mapping
        assert.ok(res.html.includes('"lit": "https://example.com/custom-lit.js"'));
        assert.ok(res.html.includes('"lit/": "https://esm.sh/lit@3.2.0/"'));
        assert.equal(res.html.includes('bad/..'), false);
      }

      // Escapes `<` in serialized importmap JSON so </script> breakout is impossible
      const ctx = await readPenBlocks(realTmp, realTmp);
      const withClosing = await applyPackagesBlock({
        html: '<head><script type="importmap">{"imports":{"x":"\\u003c/script><img src=x>"}}</script></head>',
        penContext: ctx,
        rootRealpath: realTmp,
      });
      assert.equal(withClosing.includes('</script><img'), false);
      assert.ok(withClosing.includes('\\u003c/script>'));
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('renders unsupported blocks page with strict SHA-256 CSP and sanitized CodePen URL', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-blocks-unsupported-'));
    try {
      const realTmp = await fs.realpath(tmpDir);
      await fs.writeFile(
        path.join(realTmp, '.cdpn.json'),
        JSON.stringify({ url: 'https://codepen.io/bramus/pen/abcde' }),
      );

      const page = await renderUnsupportedBlocksPage({
        penContext: {
          penDir: realTmp,
          hasClassic: false,
          hasPackages: false,
          unsupportedBlocks: ['markdown-1', 'sass-1'],
        },
        rootRealpath: realTmp,
        demoRelPath: 'my-demo/',
        homeHref: '../',
      });

      assert.equal(page.csp, UNSUPPORTED_BLOCK_PAGE_CSP);
      assert.ok(page.csp.includes("script-src 'none'"));
      assert.ok(page.html.includes('grid-template-columns: minmax(0, 1fr);'));
      assert.ok(page.html.includes('main {\n    inline-size: min(100%, 38rem);'));
      assert.ok(page.html.includes('Unsupported CodePen Blocks'));
      assert.ok(page.html.includes('markdown-1'));
      assert.ok(page.html.includes('sass-1'));
      assert.ok(page.html.includes('Back to Homepage'));
      assert.ok(page.html.includes('https://codepen.io/bramus/pen/abcde'));

      // Non-CodePen URL in .cdpn.json must be stripped
      await fs.writeFile(
        path.join(realTmp, '.cdpn.json'),
        JSON.stringify({ url: 'https://evil.example.com/phish' }),
      );
      const safePage = await renderUnsupportedBlocksPage({
        penContext: {
          penDir: realTmp,
          hasClassic: false,
          hasPackages: false,
          unsupportedBlocks: ['markdown-1'],
        },
        rootRealpath: realTmp,
        homeHref: null,
      });
      assert.equal(safePage.html.includes('evil.example.com'), false);
      assert.equal(safePage.html.includes('Back to Homepage'), false);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
