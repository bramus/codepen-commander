import fs from 'node:fs/promises';
import path from 'node:path';
import {
  CLASSIC_CONFIG_FILENAME,
  CODEPEN_DIR,
  PEN_HTML_SUFFIX,
  PROJECT_CONFIG_FILENAME,
} from '../../constants.js';
import {
  isWithinRoot,
  readPartialUtf8,
  readSafeJsonObject,
  resolveSafeFile,
} from '../../utils/fs-safe.js';
import { escapeHtml } from '../../utils/html.js';
import { hasControlChars, isPlainObject } from '../../utils/strings.js';
import { findPenContext, type PenBlockContext } from './context.js';
import { applyPackagesBlock } from './packages.js';

const MAX_HTML_BYTES = 10 * 1024 * 1024;
const MAX_SCRIPT_SNIFF_BYTES = 64 * 1024;
const URL_SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const ALLOWED_SCRIPT_TYPES = new Set(['module', 'text/javascript']);

/**
 * Reads the optional `head` HTML string from `<penDir>/.codepen/classic.config.json`.
 */
export async function readClassicHeadMetadata(
  penDir: string,
  rootRealpath: string,
): Promise<string | null> {
  const classicConfigPath = path.join(penDir, CODEPEN_DIR, CLASSIC_CONFIG_FILENAME);
  const classicConfig = await readSafeJsonObject(classicConfigPath, rootRealpath);
  if (!classicConfig || typeof classicConfig.head !== 'string') return null;
  const trimmed = classicConfig.head.trim();
  return trimmed || null;
}

function resolveClassicAssetUrl(
  rawUrl: unknown,
  htmlRelDirPosix: string,
): { href: string; localPenRelPosix: string | null } | null {
  if (typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  if (!trimmed || hasControlChars(trimmed)) return null;

  // Allow external HTTP(S) and protocol-relative URLs untouched
  if (
    trimmed.startsWith('https://') ||
    trimmed.startsWith('http://') ||
    trimmed.startsWith('//')
  ) {
    return { href: trimmed, localPenRelPosix: null };
  }

  // Reject any other explicit URL scheme (e.g. javascript:, data:, vbscript:, file:)
  if (URL_SCHEME_PATTERN.test(trimmed)) {
    return null;
  }

  const splitMatch = /^([^?#]*)(.*)$/.exec(trimmed);
  const rawPath = splitMatch?.[1] ?? trimmed;
  const suffix = splitMatch?.[2] ?? '';

  // Pen-root-relative path (e.g. "/style.css", "/script.js"): rewrite relative to the HTML file
  // so the demo works both at "/<group>/<demo>/" and when served directly as "/".
  if (rawPath.startsWith('/')) {
    const stripped = rawPath.replace(/^\/+/, '');
    if (!stripped) return null;
    const normalizedTarget = path.posix.normalize(stripped);
    if (
      !normalizedTarget ||
      normalizedTarget === '.' ||
      normalizedTarget === '..' ||
      normalizedTarget.startsWith('../')
    ) {
      return null;
    }

    let relativeHref = path.posix.relative(htmlRelDirPosix, normalizedTarget);
    if (!relativeHref) return null;
    if (!relativeHref.startsWith('./') && !relativeHref.startsWith('../')) {
      relativeHref = `./${relativeHref}`;
    }
    return { href: `${relativeHref}${suffix}`, localPenRelPosix: normalizedTarget };
  }

  // Already a relative path (e.g. "./style.css", "script.js")
  const normalizedTarget = path.posix.normalize(
    htmlRelDirPosix ? path.posix.join(htmlRelDirPosix, rawPath) : rawPath,
  );
  const localPenRelPosix =
    normalizedTarget &&
    normalizedTarget !== '.' &&
    normalizedTarget !== '..' &&
    !normalizedTarget.startsWith('../')
      ? normalizedTarget
      : null;

  return { href: trimmed, localPenRelPosix };
}

function looksLikeEsModule(source: string): boolean {
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trimStart();
    if (
      line.startsWith('import ') ||
      line.startsWith('import{') ||
      line.startsWith('import*') ||
      line.startsWith("import'") ||
      line.startsWith('import"') ||
      line.startsWith('export ') ||
      line.startsWith('export{') ||
      line.startsWith('export*')
    ) {
      return true;
    }
  }
  return false;
}

async function localScriptUsesEsm(
  localPenRelPosix: string | null,
  penDir: string,
  rootRealpath: string,
): Promise<boolean> {
  if (!localPenRelPosix) return false;
  const segments = localPenRelPosix.split('/').filter(Boolean);
  if (segments.length === 0) return false;
  for (const seg of segments) {
    if (seg === '.' || seg === '..' || seg.startsWith('.')) return false;
  }

  const candidatePath = path.resolve(penDir, ...segments);
  if (!isWithinRoot(candidatePath, penDir)) return false;

  const file = await resolveSafeFile(candidatePath, rootRealpath);
  if (!file) return false;

  try {
    const snippet = await readPartialUtf8(file.realPath, MAX_SCRIPT_SNIFF_BYTES);
    return looksLikeEsModule(snippet);
  } catch {
    return false;
  }
}

function normalizeHtmlClasses(rawClasses: unknown): string {
  if (typeof rawClasses === 'string') {
    return rawClasses.trim();
  }
  if (Array.isArray(rawClasses)) {
    return rawClasses
      .filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
      .map((item) => item.trim())
      .join(' ');
  }
  return '';
}

/**
 * Compiles a `.pen.html` body fragment into a complete HTML document using
 * `.codepen/classic.config.json` and `.cdpn.json` title metadata. If the Pen also
 * enables the `packages` block, the importmap transform is applied afterward.
 */
export async function compileClassicPenHtml(options: {
  penHtmlPath: string;
  penContext: PenBlockContext;
  rootRealpath: string;
}): Promise<string | null> {
  const { penHtmlPath, penContext, rootRealpath } = options;
  const penHtmlFile = await resolveSafeFile(penHtmlPath, rootRealpath);
  if (!penHtmlFile || penHtmlFile.size > MAX_HTML_BYTES) return null;

  let bodyHtml: string;
  try {
    bodyHtml = await fs.readFile(penHtmlFile.realPath, 'utf8');
  } catch {
    return null;
  }

  const classicConfig =
    (await readSafeJsonObject(
      path.join(penContext.penDir, CODEPEN_DIR, CLASSIC_CONFIG_FILENAME),
      rootRealpath,
    )) ?? {};
  const cdpnConfig =
    (await readSafeJsonObject(
      path.join(penContext.penDir, PROJECT_CONFIG_FILENAME),
      rootRealpath,
    )) ?? {};

  const infoObj = isPlainObject(cdpnConfig.info) ? cdpnConfig.info : null;
  const title =
    typeof infoObj?.title === 'string' && infoObj.title.trim()
      ? infoObj.title.trim()
      : path.basename(penContext.penDir) || 'Pen';

  const htmlClasses = normalizeHtmlClasses(classicConfig.htmlClasses);
  // TODO(security): `classicConfig.head` and `bodyHtml` are raw HTML authored by the
  // demo developer inside the local Pen folder (same trust boundary as `index.html`), so
  // they are intentionally embedded unescaped while `title`, `htmlClasses`, and asset URLs
  // are validated and HTML-escaped.
  const headHtml = typeof classicConfig.head === 'string' ? classicConfig.head.trim() : '';

  const relFromPen = path.relative(penContext.penDir, path.dirname(penHtmlFile.realPath));
  const htmlRelDirPosix = relFromPen ? relFromPen.split(path.sep).join('/') : '';

  const styleTags: string[] = [];
  if (Array.isArray(classicConfig.styles)) {
    for (const entry of classicConfig.styles) {
      const rawHref =
        typeof entry === 'string'
          ? entry
          : isPlainObject(entry)
            ? (entry.href ?? entry.url ?? entry.src)
            : null;
      const resolved = resolveClassicAssetUrl(rawHref, htmlRelDirPosix);
      if (!resolved) continue;
      styleTags.push(`<link rel="stylesheet" href="${escapeHtml(resolved.href)}">`);
    }
  }

  const scriptTags: string[] = [];
  if (Array.isArray(classicConfig.scripts)) {
    for (const entry of classicConfig.scripts) {
      const rawSrc =
        typeof entry === 'string'
          ? entry
          : isPlainObject(entry)
            ? (entry.src ?? entry.url)
            : null;
      const explicitType =
        isPlainObject(entry) && typeof entry.type === 'string'
          ? entry.type.trim().toLowerCase()
          : null;

      const resolved = resolveClassicAssetUrl(rawSrc, htmlRelDirPosix);
      if (!resolved) continue;

      let scriptType =
        explicitType && ALLOWED_SCRIPT_TYPES.has(explicitType) ? explicitType : null;
      const pathWithoutQuery = (resolved.href.split(/[?#]/, 1)[0] ?? '').toLowerCase();
      if (!scriptType && pathWithoutQuery.endsWith('.mjs')) {
        scriptType = 'module';
      }
      if (!scriptType && penContext.hasPackages && resolved.localPenRelPosix) {
        if (await localScriptUsesEsm(resolved.localPenRelPosix, penContext.penDir, rootRealpath)) {
          scriptType = 'module';
        }
      }

      const typeAttr = scriptType ? ` type="${escapeHtml(scriptType)}"` : '';
      scriptTags.push(`<script${typeAttr} src="${escapeHtml(resolved.href)}"></script>`);
    }
  }

  const htmlOpenTag = htmlClasses
    ? `<html lang="en" class="${escapeHtml(htmlClasses)}">`
    : '<html lang="en">';

  const headLines = [
    '    <meta charset="UTF-8">',
    `    <title>${escapeHtml(title)}</title>`,
  ];
  if (headHtml) {
    headLines.push(`    ${headHtml}`);
  }
  for (const tag of styleTags) {
    headLines.push(`    ${tag}`);
  }

  const trimmedBody = bodyHtml.replace(/\r?\n$/, '');
  const bodyLines: string[] = [];
  if (trimmedBody) {
    bodyLines.push(`    ${trimmedBody}`);
  }
  for (const tag of scriptTags) {
    bodyLines.push(`    ${tag}`);
  }

  let html = [
    '<!DOCTYPE html>',
    htmlOpenTag,
    '',
    '  <head>',
    ...headLines,
    '  </head>',
    '',
    '  <body>',
    ...bodyLines,
    '  </body>',
    '',
    '</html>',
    '',
  ].join('\n');

  if (penContext.hasPackages) {
    html = await applyPackagesBlock({ html, penContext, rootRealpath });
  }

  return html;
}

/**
 * When a requested `.html` file does not exist on disk, checks if the enclosing Pen
 * enables the `classic` block and has a matching `.pen.html` source file. Returns the
 * compiled HTML string or `null`.
 */
export async function resolveVirtualClassicHtml(options: {
  dirRealpath: string;
  requestedFilename: string;
  rootRealpath: string;
}): Promise<string | null> {
  const { dirRealpath, requestedFilename, rootRealpath } = options;
  if (
    typeof requestedFilename !== 'string' ||
    !requestedFilename ||
    requestedFilename.includes('\0') ||
    requestedFilename.includes('\\') ||
    requestedFilename.includes('/') ||
    requestedFilename !== path.basename(requestedFilename) ||
    requestedFilename.startsWith('.')
  ) {
    return null;
  }
  const lowerName = requestedFilename.toLowerCase();
  if (!lowerName.endsWith('.html') || lowerName.endsWith(PEN_HTML_SUFFIX)) {
    return null;
  }

  const penContext = await findPenContext(dirRealpath, rootRealpath);
  if (!penContext?.hasClassic) return null;

  const penHtmlFilename = `${requestedFilename.slice(0, -'.html'.length)}${PEN_HTML_SUFFIX}`;
  const penHtmlCandidate = path.join(dirRealpath, penHtmlFilename);

  return compileClassicPenHtml({
    penHtmlPath: penHtmlCandidate,
    penContext,
    rootRealpath,
  });
}
