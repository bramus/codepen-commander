import { createHash } from 'node:crypto';
import path from 'node:path';
import { PROJECT_CONFIG_FILENAME } from '../../constants.js';
import { sanitizeCodePenUrl } from '../../utils/codepen-url.js';
import { readSafeJsonObject } from '../../utils/fs-safe.js';
import { escapeHtml } from '../../utils/html.js';
import { findPenContext, type PenBlockContext } from './context.js';

export interface UnsupportedBlocksPageResult {
  html: string;
  csp: string;
}

const UNSUPPORTED_BLOCK_PAGE_STYLE = `
@layer reset, base, components;

:root {
  color-scheme: light dark;

  --surface-page: light-dark(oklch(98.5% 0.004 250), oklch(15% 0.012 260));
  --surface-card: light-dark(oklch(100% 0 0), oklch(20% 0.014 260));
  --surface-code: light-dark(oklch(94.5% 0.008 255), oklch(25% 0.016 260));

  --text-primary: light-dark(oklch(20% 0.015 260), oklch(94% 0.008 250));
  --text-muted: light-dark(oklch(46% 0.016 260), oklch(72% 0.014 255));
  --text-subtle: light-dark(oklch(56% 0.014 260), oklch(62% 0.014 255));

  --border-subtle: light-dark(oklch(88% 0.01 255), oklch(30% 0.018 260));

  --accent: light-dark(oklch(48% 0.2 260), oklch(75% 0.15 250));
  --accent-fg: light-dark(oklch(99% 0 0), oklch(15% 0.015 260));

  --radius-card: 0.875rem;
  --radius-code: 0.375rem;
  accent-color: var(--accent);
}

@layer reset {
  html,
  body,
  main,
  article,
  header,
  footer,
  div,
  ul,
  li {
    box-sizing: border-box;
  }

  body,
  h1,
  p,
  ul {
    margin: 0;
  }
}

@layer base {
  body {
    min-block-size: 100dvb;
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    place-items: center;
    padding: clamp(1.5rem, 5vw, 3rem) clamp(1.25rem, 4vw, 2rem);
    background-color: var(--surface-page);
    color: var(--text-primary);
    font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    line-height: 1.55;
  }

  main {
    inline-size: min(100%, 38rem);
  }

  h1 {
    font-size: clamp(1.4rem, 3vw, 1.75rem);
    line-height: 1.25;
    letter-spacing: -0.02em;
    text-wrap: balance;
  }

  p {
    text-wrap: pretty;
  }

  a:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 3px;
    border-radius: 0.25rem;
  }

  code {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.875em;
    padding-block: 0.125em;
    padding-inline: 0.4em;
    border-radius: var(--radius-code);
    background-color: var(--surface-code);
  }
}

@layer components {
  .error-card {
    inline-size: 100%;
    display: grid;
    gap: 1.15rem;
    padding: clamp(1.5rem, 4vw, 2.25rem);
    background-color: var(--surface-card);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-card);
    corner-shape: squircle;
  }

  .error-header {
    display: grid;
    gap: 0.45rem;
    justify-items: start;
    min-inline-size: 0;
  }

  .demo-path {
    padding: 0;
    background: none;
    color: var(--text-subtle);
    font-size: 0.8rem;
    max-inline-size: 100%;
    overflow-wrap: anywhere;
  }

  .error-body {
    display: grid;
    gap: 1.25rem;
    min-inline-size: 0;
    color: var(--text-muted);
    font-size: 0.95rem;
  }

  .block-list {
    display: flex;
    flex-wrap: wrap;
    gap: 0.45rem;
    list-style: none;
    padding: 0;
  }

  .block-list code {
    color: var(--text-primary);
    font-weight: 500;
  }

  .error-illustration {
    display: block;
    inline-size: 7rem;
    block-size: 7rem;
    margin-block: 0.5rem;
    margin-inline: auto;
    color: light-dark(#000, var(--text-primary));
  }

  .error-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.65rem;
    padding-block-start: 1rem;
    border-block-start: 1px solid color-mix(in oklch, var(--border-subtle) 70%, transparent);
  }

  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.45em;
    padding-block: 0.55em;
    padding-inline: 0.95em;
    border-radius: var(--radius-code);
    border: 1px solid transparent;
    font-size: 0.875rem;
    font-weight: 500;
    line-height: 1.3;
    text-decoration: none;
    white-space: nowrap;
    transition: background-color 150ms ease, border-color 150ms ease, color 150ms ease;
  }

  .btn-primary {
    background-color: var(--accent);
    color: var(--accent-fg);

    &:hover {
      background-color: color-mix(in oklch, var(--accent) 88%, var(--text-primary));
    }
  }

  .btn-secondary {
    border-color: var(--border-subtle);
    background-color: var(--surface-page);
    color: var(--text-primary);

    &:hover {
      border-color: color-mix(in oklch, var(--accent) 60%, var(--border-subtle));
      color: var(--accent);
    }
  }

  .btn-codepen {
    margin-inline-start: auto;
  }

  .btn-icon {
    flex-shrink: 0;
    inline-size: 0.95rem;
    block-size: 0.95rem;
  }

  @media (prefers-reduced-motion: reduce) {
    .btn {
      transition: none;
    }
  }
}
`;

const UNSUPPORTED_BLOCK_PAGE_STYLE_HASH = createHash('sha256')
  .update(UNSUPPORTED_BLOCK_PAGE_STYLE, 'utf8')
  .digest('base64');

export const UNSUPPORTED_BLOCK_PAGE_CSP =
  `default-src 'none'; style-src 'sha256-${UNSUPPORTED_BLOCK_PAGE_STYLE_HASH}'; img-src 'none'; script-src 'none'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'`;

const UNSUPPORTED_BLOCK_EMOJI_SVG = `<svg class="error-illustration" viewBox="0 0 120 120" fill="none" stroke="currentColor" stroke-width="6.5" stroke-linecap="butt" stroke-linejoin="miter" aria-hidden="true">
            <circle cx="60" cy="60" r="52" />
            <line x1="33.5" y1="37.5" x2="50.5" y2="54.5" />
            <line x1="50.5" y1="37.5" x2="33.5" y2="54.5" />
            <line x1="69.5" y1="37.5" x2="86.5" y2="54.5" />
            <line x1="86.5" y1="37.5" x2="69.5" y2="54.5" />
            <line x1="32" y1="72" x2="88" y2="72" />
            <path d="M 58 72 V 83 A 11 11 0 0 0 80 83 V 72" />
            <line x1="69" y1="72" x2="69" y2="84" />
          </svg>`;

/**
 * Renders a self-contained HTML error page explaining which CodePen block(s) in
 * `.codepen/pen.config.json` are not supported, with links back to the homepage
 * and/or to open the demo on CodePen.
 */
export async function renderUnsupportedBlocksPage(options: {
  penContext: PenBlockContext;
  rootRealpath: string;
  demoRelPath?: string | null;
  homeHref?: string | null;
}): Promise<UnsupportedBlocksPageResult> {
  const { penContext, rootRealpath, demoRelPath = null, homeHref = null } = options;
  const cdpnConfig =
    (await readSafeJsonObject(
      path.join(penContext.penDir, PROJECT_CONFIG_FILENAME),
      rootRealpath,
    )) ?? {};

  const codepenUrl = sanitizeCodePenUrl(cdpnConfig.url);

  const blocks = penContext.unsupportedBlocks;
  const isPlural = blocks.length > 1;
  const headingText = isPlural ? 'Unsupported CodePen Blocks' : 'Unsupported CodePen Block';
  const displayPath = demoRelPath ?? `${path.basename(penContext.penDir)}/`;

  const blockItemsHtml = blocks
    .map((name) => `<li><code>${escapeHtml(name)}</code></li>`)
    .join('');

  const explanationHtml = isPlural
    ? `<p>This demo uses blocks configured in <code>.codepen/pen.config.json</code> that are not supported locally by <code>codepen-commander</code>:</p>
          <ul class="block-list" aria-label="Unsupported blocks">${blockItemsHtml}</ul>`
    : `<p>This demo uses the <code>${escapeHtml(blocks[0] ?? '')}</code> block in <code>.codepen/pen.config.json</code>, which is not supported locally by <code>codepen-commander</code>.</p>`;

  const actions: string[] = [];
  if (homeHref) {
    const homeBtnClass = codepenUrl ? 'btn btn-secondary' : 'btn btn-primary';
    actions.push(
      `<a class="${homeBtnClass}" href="${escapeHtml(homeHref)}">
          <svg class="btn-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M10.5 3.5 6 8l4.5 4.5" />
          </svg>
          <span>Back to Homepage</span>
        </a>`,
    );
  }
  if (codepenUrl) {
    actions.push(
      `<a class="btn btn-primary btn-codepen" href="${escapeHtml(codepenUrl)}" target="_blank" rel="noopener noreferrer">
          <svg class="btn-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polygon points="8,1.5 14.5,5.5 8,9.5 1.5,5.5" />
            <polygon points="8,6.5 14.5,10.5 8,14.5 1.5,10.5" />
            <line x1="1.5" y1="5.5" x2="1.5" y2="10.5" />
            <line x1="14.5" y1="5.5" x2="14.5" y2="10.5" />
            <line x1="8" y1="1.5" x2="8" y2="6.5" />
            <line x1="8" y1="9.5" x2="8" y2="14.5" />
          </svg>
          <span>Open on CodePen</span>
        </a>`,
    );
  }

  const actionsHtml =
    actions.length > 0
      ? `\n      <footer class="error-actions">\n        ${actions.join('\n        ')}\n      </footer>`
      : '';

  const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light dark">
    <title>${escapeHtml(headingText)}</title>
    <style>${UNSUPPORTED_BLOCK_PAGE_STYLE}</style>
  </head>
  <body>
    <main>
      <article class="error-card">
        <header class="error-header">
          <code class="demo-path">${escapeHtml(displayPath)}</code>
          <h1>${escapeHtml(headingText)}</h1>
        </header>
        <div class="error-body">
          ${explanationHtml}
          ${UNSUPPORTED_BLOCK_EMOJI_SVG}
        </div>${actionsHtml}
      </article>
    </main>
  </body>
</html>
`;

  return { html, csp: UNSUPPORTED_BLOCK_PAGE_CSP };
}

/**
 * Checks whether `dirRealpath` belongs to a Pen with unsupported active blocks and,
 * if so, returns `{ html, csp }` for the error page.
 */
export async function resolveUnsupportedBlocksPage(options: {
  dirRealpath: string;
  rootRealpath: string;
  isRootServe?: boolean;
}): Promise<UnsupportedBlocksPageResult | null> {
  const { dirRealpath, rootRealpath, isRootServe = true } = options;
  const penContext = await findPenContext(dirRealpath, rootRealpath);
  if (!penContext || penContext.unsupportedBlocks.length === 0) {
    return null;
  }

  const relDir = path.relative(rootRealpath, dirRealpath);
  const dirSegments = relDir ? relDir.split(path.sep).filter(Boolean) : [];
  const homeHref = isRootServe && dirSegments.length > 0 ? '../'.repeat(dirSegments.length) : null;

  const relPen = path.relative(rootRealpath, penContext.penDir);
  const penSegments = relPen ? relPen.split(path.sep).filter(Boolean) : [];
  const demoRelPath =
    penSegments.length > 0 ? `${penSegments.join('/')}/` : `${path.basename(penContext.penDir)}/`;

  return renderUnsupportedBlocksPage({
    penContext,
    rootRealpath,
    demoRelPath,
    homeHref,
  });
}
