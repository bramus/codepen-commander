import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getConfiguredShellDir } from '../config/user-store.js';
import { CliError } from '../errors.js';
import { isWithinRoot, resolveSafeFile } from '../utils/fs-safe.js';
import { escapeHtml } from '../utils/html.js';
import { resolveBuiltinShellDir } from '../utils/package-paths.js';
import { formatFolderTitle, hasControlChars } from '../utils/strings.js';

export { resolveBuiltinShellDir };

export const CORE_SHELL_FILES = ['index.html', 'styles.css', 'scripts.js'] as const;

export const DEFAULT_SITE_SUBTITLE = 'A collection of self-contained web demos.';
export const DEFAULT_SITE_FOOTER = 'Powered by codepen-commander.';
export const CODEPEN_COMMANDER_NPM_URL = 'https://www.npmjs.com/package/codepen-commander';

const MAX_SHELL_WALK_DEPTH = 8;

export interface SiteMetadata {
  title: string;
  subtitle: string;
  footer: string;
}

export interface SiteMetadataOverrides {
  title?: string;
  subtitle?: string;
  footer?: string;
}

export type ShellSource = 'flag' | 'config' | 'builtin';

export interface ResolvedShell {
  source: ShellSource;
  dir: string;
  realpath: string;
  builtinDir: string;
  builtinRealpath: string;
}

export interface ValidatedShellDir {
  dir: string;
  realpath: string;
  files: string[];
}

export function expandHomePath(rawPath: string, homeDir?: string): string {
  const trimmed = rawPath.trim();
  const resolvedHome = homeDir ?? os.homedir();
  if (trimmed === '~') {
    return resolvedHome;
  }
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.join(resolvedHome, trimmed.slice(2));
  }
  return trimmed;
}

/**
 * Lists all non-hidden regular files (relative POSIX paths) inside a shell directory,
 * strictly enforcing directory containment and skipping symlinks.
 */
export async function listShellAssetFiles(shellRealpath: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(currentDir: string, relPrefix: string, depth: number): Promise<void> {
    if (depth > MAX_SHELL_WALK_DEPTH) return;

    let entries;
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

      const fullPath = path.join(currentDir, entry.name);
      if (!isWithinRoot(fullPath, shellRealpath)) continue;

      let lstat;
      try {
        lstat = await fs.lstat(fullPath);
      } catch {
        continue;
      }
      if (lstat.isSymbolicLink()) continue;

      const realPath = await fs.realpath(fullPath);
      if (!isWithinRoot(realPath, shellRealpath)) continue;

      const relPosix = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (lstat.isDirectory()) {
        await walk(realPath, relPosix, depth + 1);
      } else if (lstat.isFile()) {
        files.push(relPosix);
      }
    }
  }

  await walk(shellRealpath, '', 0);
  return files.sort((a, b) => a.localeCompare(b));
}

/**
 * Validates that a custom shell directory exists, is a directory, and contains at least
 * one core shell file (`index.html`, `styles.css`, or `scripts.js`).
 */
export async function validateShellDir(
  rawPath: string,
  options: { cwd?: string; homeDir?: string; sourceLabel?: string } = {},
): Promise<ValidatedShellDir> {
  const trimmed = rawPath.trim();
  if (!trimmed || hasControlChars(trimmed)) {
    throw new CliError(400, 'Shell directory path cannot be empty or contain control characters.');
  }

  const expanded = expandHomePath(trimmed, options.homeDir);
  const baseCwd = path.resolve(options.cwd ?? process.cwd());
  const resolved = path.resolve(baseCwd, expanded);

  let stat;
  try {
    stat = await fs.stat(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      const hint =
        options.sourceLabel === 'config'
          ? ' Update it with `cdpn shell set <dir>` or reset with `cdpn shell reset`.'
          : ' Run `cdpn shell export <dir>` to create one from the built-in shell.';
      throw new CliError(404, `Shell directory not found: ${resolved}.${hint}`);
    }
    throw error;
  }

  if (!stat.isDirectory()) {
    throw new CliError(400, `Shell path is not a directory: ${resolved}`);
  }

  const realpath = await fs.realpath(resolved);
  const files = await listShellAssetFiles(realpath);
  const hasCoreFile = CORE_SHELL_FILES.some((name) => files.includes(name));
  if (!hasCoreFile) {
    throw new CliError(
      400,
      `Shell directory ${resolved} must contain at least one of: ${CORE_SHELL_FILES.join(', ')}.\n` +
        'Run `cdpn shell export <dir>` to copy the built-in shell as a starting point.',
    );
  }

  return { dir: resolved, realpath, files };
}

/**
 * Resolves the active shell directory with precedence:
 * 1. Explicit `--shell <dir>` CLI flag
 * 2. Configured `config.shell` in `~/.cdpn`
 * 3. Built-in packaged `shell/` directory
 */
export async function resolveActiveShell(options: {
  explicitShell?: string;
  cwd?: string;
  homeDir?: string;
} = {}): Promise<ResolvedShell> {
  const builtin = await resolveBuiltinShellDir();

  if (options.explicitShell !== undefined) {
    const validated = await validateShellDir(options.explicitShell, {
      cwd: options.cwd,
      homeDir: options.homeDir,
      sourceLabel: 'flag',
    });
    return {
      source: 'flag',
      dir: validated.dir,
      realpath: validated.realpath,
      builtinDir: builtin.dir,
      builtinRealpath: builtin.realpath,
    };
  }

  const configured = await getConfiguredShellDir({ homeDir: options.homeDir });
  if (configured) {
    const validated = await validateShellDir(configured, {
      cwd: options.homeDir ?? os.homedir(),
      homeDir: options.homeDir,
      sourceLabel: 'config',
    });
    return {
      source: 'config',
      dir: validated.dir,
      realpath: validated.realpath,
      builtinDir: builtin.dir,
      builtinRealpath: builtin.realpath,
    };
  }

  return {
    source: 'builtin',
    dir: builtin.dir,
    realpath: builtin.realpath,
    builtinDir: builtin.dir,
    builtinRealpath: builtin.realpath,
  };
}

/**
 * Resolves a request pathname (e.g. `/`, `/styles.css`, `/favicon.svg`) against
 * the active shell directory, falling back to the built-in shell for missing core files.
 */
export async function resolveShellAssetForRequest(
  rawPathname: string,
  shell: ResolvedShell,
): Promise<{ filePath: string; fromBuiltin: boolean; isIndexHtml: boolean } | null> {
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(rawPathname);
  } catch {
    return null;
  }

  if (decodedPath.includes('\0') || decodedPath.includes('\\')) {
    return null;
  }

  const normalizedPath = decodedPath === '/' ? '/index.html' : decodedPath;
  const segments = normalizedPath.split('/').filter(Boolean);
  if (segments.length === 0) return null;

  for (const segment of segments) {
    if (segment === '.' || segment === '..' || segment.startsWith('.')) {
      return null;
    }
  }

  const relPosix = segments.join('/');
  const isIndexHtml = relPosix === 'index.html';

  const primary = await resolveSafeFile(
    path.resolve(shell.realpath, ...segments),
    shell.realpath,
  );
  if (primary) {
    return {
      filePath: primary.realPath,
      fromBuiltin: shell.source === 'builtin',
      isIndexHtml,
    };
  }

  if (shell.source !== 'builtin' && (CORE_SHELL_FILES as readonly string[]).includes(relPosix)) {
    const fallback = await resolveSafeFile(
      path.resolve(shell.builtinRealpath, ...segments),
      shell.builtinRealpath,
    );
    if (fallback) {
      return {
        filePath: fallback.realPath,
        fromBuiltin: true,
        isIndexHtml,
      };
    }
  }

  return null;
}

function renderFooterHtml(footerText: string): string {
  return escapeHtml(footerText).replaceAll(
    'codepen-commander',
    `<a href="${CODEPEN_COMMANDER_NPM_URL}" target="_blank" rel="noopener noreferrer">codepen-commander</a>`,
  );
}

export function resolveSiteMetadata(
  rootDir: string,
  overrides: SiteMetadataOverrides = {},
): SiteMetadata {
  const folderName = path.basename(path.resolve(rootDir));
  const defaultTitle = formatFolderTitle(folderName) || 'CodePen Demos';

  return {
    title:
      typeof overrides.title === 'string' && overrides.title.trim()
        ? overrides.title.trim()
        : defaultTitle,
    subtitle:
      typeof overrides.subtitle === 'string' ? overrides.subtitle.trim() : DEFAULT_SITE_SUBTITLE,
    footer:
      typeof overrides.footer === 'string' ? overrides.footer.trim() : DEFAULT_SITE_FOOTER,
  };
}

const MISSING_DEMO_WARNING_TEMPLATE_ID = 'missing-demo-warning-template';

export interface RenderShellHtmlOptions {
  /** Include the local-dev "Missing a demo? Run cdpn init" warning template (default: true). */
  includeMissingDemoWarning?: boolean;
}

/**
 * Removes `<template id="...">...</template>` blocks matching `templateId` without regex
 * backtracking, trimming any surrounding indentation/blank line cleanly.
 */
function stripTemplateById(html: string, templateId: string): string {
  const lower = html.toLowerCase();
  const targetId = templateId.toLowerCase();
  const idDouble = `id="${targetId}"`;
  const idSingle = `id='${targetId}'`;
  const idUnquoted = `id=${targetId}`;

  let result = '';
  let cursor = 0;

  while (cursor < html.length) {
    const openIdx = lower.indexOf('<template', cursor);
    if (openIdx === -1) {
      result += html.slice(cursor);
      break;
    }

    const afterTagName = lower[openIdx + '<template'.length];
    if (
      afterTagName !== undefined &&
      afterTagName !== '>' &&
      afterTagName !== '/' &&
      !/\s/.test(afterTagName)
    ) {
      result += html.slice(cursor, openIdx + '<template'.length);
      cursor = openIdx + '<template'.length;
      continue;
    }

    const openEndIdx = lower.indexOf('>', openIdx);
    if (openEndIdx === -1) {
      result += html.slice(cursor);
      break;
    }

    const openTagLower = lower.slice(openIdx, openEndIdx + 1);
    const hasUnquotedId = (() => {
      let idx = openTagLower.indexOf(idUnquoted);
      while (idx !== -1) {
        const before = openTagLower[idx - 1];
        const after = openTagLower[idx + idUnquoted.length];
        if (
          before !== undefined &&
          /\s/.test(before) &&
          (after === undefined || after === '>' || after === '/' || /\s/.test(after))
        ) {
          return true;
        }
        idx = openTagLower.indexOf(idUnquoted, idx + idUnquoted.length);
      }
      return false;
    })();

    const matchesId =
      openTagLower.includes(idDouble) || openTagLower.includes(idSingle) || hasUnquotedId;

    if (!matchesId) {
      result += html.slice(cursor, openEndIdx + 1);
      cursor = openEndIdx + 1;
      continue;
    }

    let depth = 1;
    let searchPos = openEndIdx + 1;
    let closeEndIdx = -1;

    while (depth > 0 && searchPos < lower.length) {
      const nextOpen = lower.indexOf('<template', searchPos);
      const nextClose = lower.indexOf('</template', searchPos);
      if (nextClose === -1) {
        break;
      }
      if (nextOpen !== -1 && nextOpen < nextClose) {
        const ch = lower[nextOpen + '<template'.length];
        if (ch === '>' || ch === '/' || (ch !== undefined && /\s/.test(ch))) {
          depth++;
        }
        searchPos = nextOpen + '<template'.length;
      } else {
        const closeTagEnd = lower.indexOf('>', nextClose);
        if (closeTagEnd === -1) {
          break;
        }
        depth--;
        if (depth === 0) {
          closeEndIdx = closeTagEnd + 1;
        }
        searchPos = closeTagEnd + 1;
      }
    }

    if (closeEndIdx === -1) {
      result += html.slice(cursor);
      break;
    }

    let trimStart = openIdx;
    while (trimStart > cursor && (html[trimStart - 1] === ' ' || html[trimStart - 1] === '\t')) {
      trimStart--;
    }

    let trimEnd = closeEndIdx;
    while (trimEnd < html.length && (html[trimEnd] === ' ' || html[trimEnd] === '\t')) {
      trimEnd++;
    }
    if (html[trimEnd] === '\r' && html[trimEnd + 1] === '\n') {
      trimEnd += 2;
    } else if (html[trimEnd] === '\n') {
      trimEnd += 1;
    }

    if (trimStart >= cursor + 2 && html[trimStart - 1] === '\n' && html[trimStart - 2] === '\n') {
      trimStart -= 1;
    } else if (
      trimStart >= cursor + 4 &&
      html[trimStart - 1] === '\n' &&
      html[trimStart - 2] === '\r' &&
      html[trimStart - 3] === '\n' &&
      html[trimStart - 4] === '\r'
    ) {
      trimStart -= 2;
    }

    result += html.slice(cursor, trimStart);
    cursor = trimEnd;
  }

  return result;
}

export function renderShellIndexHtml(
  templateHtml: string,
  site: SiteMetadata,
  options: RenderShellHtmlOptions = {},
): string {
  const rendered = templateHtml
    .replaceAll('{{SITE_TITLE}}', escapeHtml(site.title))
    .replaceAll('{{SITE_SUBTITLE}}', escapeHtml(site.subtitle))
    .replaceAll('{{SITE_FOOTER}}', renderFooterHtml(site.footer));

  if (options.includeMissingDemoWarning === false) {
    return stripTemplateById(rendered, MISSING_DEMO_WARNING_TEMPLATE_ID);
  }
  return rendered;
}

/**
 * Copies the built-in shell files (`index.html`, `styles.css`, `scripts.js`) into `targetDir`.
 */
export async function exportBuiltinShell(targetDir: string): Promise<{
  targetDir: string;
  copiedFiles: string[];
}> {
  const builtin = await resolveBuiltinShellDir();
  const resolvedTarget = path.resolve(targetDir);

  if (
    resolvedTarget === builtin.realpath ||
    isWithinRoot(resolvedTarget, builtin.realpath)
  ) {
    throw new CliError(400, 'Refusing to export shell inside the codepen-commander package directory.');
  }

  await fs.mkdir(resolvedTarget, { recursive: true });
  const files = await listShellAssetFiles(builtin.realpath);
  const copiedFiles: string[] = [];

  for (const relPosix of files) {
    const srcPath = path.join(builtin.realpath, ...relPosix.split('/'));
    const destPath = path.join(resolvedTarget, ...relPosix.split('/'));
    if (!isWithinRoot(destPath, resolvedTarget)) continue;

    await fs.mkdir(path.dirname(destPath), { recursive: true });
    await fs.copyFile(srcPath, destPath);
    copiedFiles.push(relPosix);
  }

  return { targetDir: resolvedTarget, copiedFiles };
}
