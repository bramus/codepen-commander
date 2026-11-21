import fs from 'node:fs/promises';
import path from 'node:path';
import { PEN_HTML_SUFFIX } from '../../constants.js';
import { readSafeJsonObject, resolveSafeFile } from '../../utils/fs-safe.js';
import { isPlainObject } from '../../utils/strings.js';
import { findPenContext, type PenBlockContext } from './context.js';

const PACKAGE_JSON_FILENAME = 'package.json';
const MAX_HTML_BYTES = 10 * 1024 * 1024;
const ESM_SH_ORIGIN = 'https://esm.sh';
const NPM_PACKAGE_NAME_PATTERN =
  /^(?:@[a-zA-Z0-9~][a-zA-Z0-9._~-]*\/)?[a-zA-Z0-9~][a-zA-Z0-9._~-]*$/;
const SAFE_VERSION_PATTERN = /^[a-zA-Z0-9._^~*+-][a-zA-Z0-9._^~*+<>=| -]*$/;

function buildEsmShImports(dependencies: unknown): Record<string, string> {
  const imports: Record<string, string> = {};
  if (!isPlainObject(dependencies)) return imports;

  for (const [rawName, rawVersion] of Object.entries(dependencies)) {
    if (typeof rawName !== 'string' || typeof rawVersion !== 'string') continue;
    const name = rawName.trim();
    const version = rawVersion.trim();
    if (!name || !version) continue;
    if (!NPM_PACKAGE_NAME_PATTERN.test(name) || name.includes('..')) continue;
    if (!SAFE_VERSION_PATTERN.test(version) || version.includes('..')) continue;

    const encodedVersion = version.replace(/ /g, '%20');
    const baseUrlStr = `${ESM_SH_ORIGIN}/${name}@${encodedVersion}`;
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(baseUrlStr);
    } catch {
      continue;
    }
    if (
      parsedUrl.origin !== ESM_SH_ORIGIN ||
      parsedUrl.search ||
      parsedUrl.hash ||
      parsedUrl.pathname.includes('..')
    ) {
      continue;
    }

    imports[name] = baseUrlStr;
    imports[`${name}/`] = `${baseUrlStr}/`;
  }

  return imports;
}

function serializeImportMap(mapObj: Record<string, unknown>): string {
  // Escape `<` as `\u003c` so serialized JSON can never break out of `<script>`.
  return JSON.stringify(mapObj, null, 2).replace(/</g, '\\u003c');
}

function findTagEnd(html: string, startIndex: number): number {
  let quote: string | null = null;
  for (let i = startIndex; i < html.length; i++) {
    const ch = html[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i;
    }
  }
  return -1;
}

function isTagNameBoundary(ch: string | undefined): boolean {
  return ch === undefined || ch === '>' || ch === '/' || /\s/.test(ch);
}

function getTagAttribute(attrText: string, targetName: string): string | null {
  const attrPattern =
    /([a-zA-Z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  const lowerTarget = targetName.toLowerCase();

  for (const match of attrText.matchAll(attrPattern)) {
    if (match[1]?.toLowerCase() === lowerTarget) {
      return match[2] ?? match[3] ?? match[4] ?? '';
    }
  }
  return null;
}

function findExistingImportMapScript(
  html: string,
): { contentStart: number; contentEnd: number } | null {
  const lower = html.toLowerCase();
  let i = 0;

  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) break;

    if (html.startsWith('<!--', lt)) {
      const endComment = html.indexOf('-->', lt + 4);
      if (endComment === -1) break;
      i = endComment + 3;
      continue;
    }

    if (lower.startsWith('<script', lt) && isTagNameBoundary(html[lt + 7])) {
      const openEnd = findTagEnd(html, lt + 7);
      if (openEnd === -1) break;

      const closeStart = lower.indexOf('</script', openEnd + 1);
      if (closeStart === -1) break;
      const closeEnd = findTagEnd(html, closeStart + 8);
      if (closeEnd === -1) break;

      const attrText = html.slice(lt + 7, openEnd);
      const scriptType = getTagAttribute(attrText, 'type');
      if (scriptType !== null && scriptType.trim().toLowerCase() === 'importmap') {
        return {
          contentStart: openEnd + 1,
          contentEnd: closeStart,
        };
      }

      i = closeEnd + 1;
      continue;
    }

    i = lt + 1;
  }

  return null;
}

function findImportMapInsertionPoint(html: string): { index: number; leadingNewline: boolean } {
  const lower = html.toLowerCase();
  let i = 0;
  let firstScriptStart = -1;
  let afterHtmlOrDoctype = -1;

  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) break;

    if (html.startsWith('<!--', lt)) {
      const endComment = html.indexOf('-->', lt + 4);
      if (endComment === -1) break;
      i = endComment + 3;
      continue;
    }

    if (lower.startsWith('<head', lt) && isTagNameBoundary(html[lt + 5])) {
      const openEnd = findTagEnd(html, lt + 5);
      if (openEnd !== -1) {
        return { index: openEnd + 1, leadingNewline: true };
      }
      break;
    }

    if (
      firstScriptStart === -1 &&
      lower.startsWith('<script', lt) &&
      isTagNameBoundary(html[lt + 7])
    ) {
      firstScriptStart = lt;
    }

    if (lower.startsWith('<!doctype', lt) && isTagNameBoundary(html[lt + 9])) {
      const openEnd = findTagEnd(html, lt + 9);
      if (openEnd !== -1) {
        afterHtmlOrDoctype = openEnd + 1;
        i = openEnd + 1;
        continue;
      }
    }

    if (lower.startsWith('<html', lt) && isTagNameBoundary(html[lt + 5])) {
      const openEnd = findTagEnd(html, lt + 5);
      if (openEnd !== -1) {
        afterHtmlOrDoctype = openEnd + 1;
        i = openEnd + 1;
        continue;
      }
    }

    i = lt + 1;
  }

  if (firstScriptStart !== -1) {
    return { index: firstScriptStart, leadingNewline: false };
  }
  if (afterHtmlOrDoctype !== -1) {
    return { index: afterHtmlOrDoctype, leadingNewline: true };
  }
  return { index: 0, leadingNewline: false };
}

/**
 * Applies the CodePen `packages` block to an HTML document by reading `package.json`
 * dependencies from the Pen root and injecting (or merging into an existing)
 * `<script type="importmap">` targeting `https://esm.sh/`.
 */
export async function applyPackagesBlock(options: {
  html: string;
  penContext: PenBlockContext | null;
  rootRealpath: string;
}): Promise<string> {
  const { html, penContext, rootRealpath } = options;
  if (!penContext?.hasPackages) return html;

  const pkgJsonPath = path.join(penContext.penDir, PACKAGE_JSON_FILENAME);
  const pkgJson = await readSafeJsonObject(pkgJsonPath, rootRealpath);
  if (!pkgJson || !isPlainObject(pkgJson.dependencies)) return html;

  const generatedImports = buildEsmShImports(pkgJson.dependencies);
  if (Object.keys(generatedImports).length === 0) return html;

  const existingScript = findExistingImportMapScript(html);
  if (existingScript) {
    const rawExisting = html.slice(existingScript.contentStart, existingScript.contentEnd).trim();
    try {
      const parsedExisting: unknown = rawExisting ? JSON.parse(rawExisting) : {};
      if (!isPlainObject(parsedExisting)) return html;

      const userImports = isPlainObject(parsedExisting.imports) ? parsedExisting.imports : {};
      const merged = {
        ...parsedExisting,
        imports: {
          ...generatedImports,
          ...userImports,
        },
      };

      return (
        html.slice(0, existingScript.contentStart) +
        `\n${serializeImportMap(merged)}\n` +
        html.slice(existingScript.contentEnd)
      );
    } catch {
      return html;
    }
  }

  const { index, leadingNewline } = findImportMapInsertionPoint(html);
  const prefix = leadingNewline ? '\n' : '';
  const importMapTag = `${prefix}<script type="importmap">\n${serializeImportMap({ imports: generatedImports })}\n</script>\n`;

  return html.slice(0, index) + importMapTag + html.slice(index);
}

/**
 * Applies active HTML blocks (currently `packages`) to an existing `.html` file on disk.
 * Returns `{ transformed: true, html }` when a transform ran, or `{ transformed: false }`.
 */
export async function resolveServedHtmlWithBlocks(options: {
  filePath: string;
  rootRealpath: string;
}): Promise<{ transformed: true; html: string } | { transformed: false }> {
  const { filePath, rootRealpath } = options;
  const lowerPath = filePath.toLowerCase();
  if (!lowerPath.endsWith('.html') || lowerPath.endsWith(PEN_HTML_SUFFIX)) {
    return { transformed: false };
  }

  const penContext = await findPenContext(path.dirname(filePath), rootRealpath);
  if (!penContext?.hasPackages) {
    return { transformed: false };
  }

  const safeFile = await resolveSafeFile(filePath, rootRealpath);
  if (!safeFile || safeFile.size > MAX_HTML_BYTES) {
    return { transformed: false };
  }

  const rawHtml = await fs.readFile(safeFile.realPath, 'utf8');
  const html = await applyPackagesBlock({ html: rawHtml, penContext, rootRealpath });
  if (html === rawHtml) {
    return { transformed: false };
  }
  return { transformed: true, html };
}
