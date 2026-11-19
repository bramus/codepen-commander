import fs from 'node:fs/promises';
import path from 'node:path';
import type { CodePenClient } from '../api/client.js';
import { isCodePenApiError } from '../api/errors.js';
import { normalizePenReference } from '../config/project.js';
import { IGNORE_FILENAME, normalizePenPath, scanLocalFiles } from '../sync/fs.js';
import type { BinaryUploadPart, Pen, PenFileRequest } from '../types.js';
import { escapeHtml } from '../utils/html.js';

export type ScaffoldPreset = 'starter' | 'html-css' | 'html-css-js' | 'blank';

export const VALID_SCAFFOLD_PRESETS: readonly ScaffoldPreset[] = [
  'starter',
  'html-css',
  'html-css-js',
  'blank',
];

const STYLESHEET_EXTENSIONS = new Set(['.css', '.scss', '.sass', '.less']);
const SCRIPT_EXTENSIONS = new Set(['.js', '.mjs', '.ts', '.jsx', '.tsx']);
const HTML_EXTENSIONS = new Set(['.html', '.htm']);

export function normalizeScaffoldPreset(raw: string): ScaffoldPreset {
  const lower = raw.trim().toLowerCase();
  if (
    lower === 'starter' ||
    lower === 'html-css' ||
    lower === 'html-css-js' ||
    lower === 'blank'
  ) {
    return lower;
  }
  throw new Error(
    `Invalid scaffold preset "${raw}". Use: ${VALID_SCAFFOLD_PRESETS.join(', ')}.`,
  );
}

export function getPresetFilePaths(preset: Exclude<ScaffoldPreset, 'starter'>): string[] {
  switch (preset) {
    case 'blank':
      return ['/index.html'];
    case 'html-css':
      return ['/index.html', '/style.css'];
    case 'html-css-js':
      return ['/index.html', '/style.css', '/script.js'];
  }
}

/**
 * Validates and normalizes a comma-separated list of custom starter file paths.
 */
export function parseCustomFileList(raw: string): string[] {
  const parts = raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  if (parts.length === 0) {
    throw new Error('Specify at least one starter file path (e.g. index.html,style.css).');
  }

  const seenLower = new Set<string>();
  const normalized: string[] = [];

  for (const part of parts) {
    const cleanPath = normalizePenPath(part);
    const firstSegment = cleanPath.slice(1).split('/')[0];
    if (firstSegment === IGNORE_FILENAME) {
      throw new Error(`Refusing to scaffold reserved CLI file: ${cleanPath}`);
    }
    const key = cleanPath.toLowerCase();
    if (!seenLower.has(key)) {
      seenLower.add(key);
      normalized.push(cleanPath);
    }
  }

  return normalized;
}

function buildHtmlDocument(
  htmlPath: string,
  title: string,
  stylesheets: string[],
  scripts: string[],
): string {
  const htmlDir = path.posix.dirname(htmlPath);
  const headLines: string[] = [
    '  <meta charset="UTF-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1.0">',
    `  <title>${escapeHtml(title.trim() || 'Untitled')}</title>`,
  ];

  for (const cssPath of stylesheets) {
    const rel = path.posix.relative(htmlDir, cssPath);
    headLines.push(`  <link rel="stylesheet" href="${escapeHtml(rel)}">`);
  }

  for (const scriptPath of scripts) {
    const rel = path.posix.relative(htmlDir, scriptPath);
    headLines.push(`  <script type="module" src="${escapeHtml(rel)}"></script>`);
  }

  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    ...headLines,
    '</head>',
    '<body>',
    '  ',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/**
 * Generates clean starter file contents for a list of Pen paths, linking included
 * stylesheets and scripts inside HTML files and safely escaping the `<title>`.
 */
export function buildStarterFiles(filePaths: string[], title: string): PenFileRequest[] {
  const normalizedPaths: string[] = [];
  const seenLower = new Set<string>();

  for (const rawPath of filePaths) {
    const cleanPath = normalizePenPath(rawPath);
    const firstSegment = cleanPath.slice(1).split('/')[0];
    if (firstSegment === IGNORE_FILENAME) {
      throw new Error(`Refusing to scaffold reserved CLI file: ${cleanPath}`);
    }
    const key = cleanPath.toLowerCase();
    if (!seenLower.has(key)) {
      seenLower.add(key);
      normalizedPaths.push(cleanPath);
    }
  }

  if (normalizedPaths.length === 0) {
    throw new Error('At least one starter file path is required.');
  }

  const stylesheets = normalizedPaths.filter((p) =>
    STYLESHEET_EXTENSIONS.has(path.posix.extname(p).toLowerCase()),
  );
  const scripts = normalizedPaths.filter((p) =>
    SCRIPT_EXTENSIONS.has(path.posix.extname(p).toLowerCase()),
  );

  return normalizedPaths.map((filePath) => {
    const ext = path.posix.extname(filePath).toLowerCase();
    if (HTML_EXTENSIONS.has(ext)) {
      return {
        path: filePath,
        content: buildHtmlDocument(filePath, title, stylesheets, scripts),
      };
    }
    if (ext === '.json') {
      return {
        path: filePath,
        content: '{}\n',
      };
    }
    return {
      path: filePath,
      content: '',
    };
  });
}

/**
 * Lists the authenticated account's CodePen Templates (`template=true`), newest updated first.
 */
export async function listAccountTemplates(
  client: CodePenClient,
  maxItems = 50,
): Promise<Pen[]> {
  const templates: Pen[] = [];
  let page = await client.listPens({
    template: true,
    sort: 'updated',
    direction: 'desc',
    per_page: Math.min(maxItems, 100),
  });
  templates.push(...page.items);

  while (templates.length < maxItems && page.links.next) {
    page = await client.listPensPageByUrl(page.links.next);
    templates.push(...page.items);
  }

  return templates.slice(0, maxItems);
}

/**
 * Resolves a CodePen Template reference passed via `--template <id|url|title>`.
 */
export async function resolveTemplatePen(
  client: CodePenClient,
  rawQuery: string,
  cachedTemplates?: Pen[],
): Promise<Pen> {
  const query = rawQuery.trim();
  if (!query) {
    throw new Error('--template requires a CodePen template ID, URL, or title.');
  }

  if (/^https?:\/\//i.test(query)) {
    const ref = normalizePenReference(query);
    return client.getPen(ref.apiIdentifier);
  }

  const templates = cachedTemplates ?? (await listAccountTemplates(client));

  const byId = templates.find((t) => t.id === query);
  if (byId) {
    return byId;
  }

  const lower = query.toLowerCase();
  const byTitle = templates.filter((t) => (t.title || '').trim().toLowerCase() === lower);
  if (byTitle.length === 1) {
    return byTitle[0]!;
  }
  if (byTitle.length > 1) {
    const choices = byTitle.map((t) => `  - ${t.title} (${t.id})`).join('\n');
    throw new Error(
      `Multiple CodePen templates match "${query}":\n${choices}\nPass the template ID or URL to pick one.`,
    );
  }

  // Fallback: if the value looks like a Pen ID (cpid or hashid), try fetching directly
  if (/^[A-Za-z0-9_-]{3,64}$/.test(query)) {
    try {
      return await client.getPen(query);
    } catch (error) {
      if (!isCodePenApiError(error) || error.status !== 404) {
        throw error;
      }
    }
  }

  if (templates.length === 0) {
    throw new Error(
      `No CodePen template found matching "${query}" (and your account has no Pens marked as templates yet).\n` +
        'Mark any Pen as a template on CodePen or run `cdpn info --template true` in a synced Pen folder.',
    );
  }

  const available = templates
    .slice(0, 10)
    .map((t) => `  - ${t.title || 'Untitled'} (${t.id})`)
    .join('\n');
  throw new Error(
    `No CodePen template found matching "${query}".\nAvailable templates on this account:\n${available}`,
  );
}

/**
 * Downloads all text and binary files from one of your CodePen Pens (e.g. a Template Pen)
 * so they can be used to create a brand-new independent CodePen 2.0 Pen.
 */
export async function fetchPenFilesAsUploadPayload(
  client: CodePenClient,
  penId: string,
): Promise<{ textFiles: PenFileRequest[]; binaryFiles: BinaryUploadPart[] }> {
  const remoteFiles = await client.getPenFiles(penId);
  const textFiles: PenFileRequest[] = [];
  const binaryFiles: BinaryUploadPart[] = [];

  for (const file of remoteFiles) {
    const normalizedPath = normalizePenPath(file.path);
    if (file.is_binary) {
      if (file.bytes === 0) {
        textFiles.push({ path: normalizedPath, content: '' });
      } else if (file.download_url) {
        const buffer = await client.downloadFile(file.download_url);
        binaryFiles.push({ path: normalizedPath, content: buffer });
      } else {
        throw new Error(
          `Cannot copy binary file ${normalizedPath} from Pen ${penId}: no download_url returned by CodePen.`,
        );
      }
    } else {
      textFiles.push({
        path: normalizedPath,
        content: file.content ?? '',
      });
    }
  }

  return { textFiles, binaryFiles };
}

/**
 * Checks whether a `--from` source string points to an existing local directory.
 */
export async function resolveExistingLocalDirectory(
  candidate: string,
  cwd: string = process.cwd(),
): Promise<string | null> {
  const trimmed = candidate.trim();
  if (!trimmed || /^https?:\/\//i.test(trimmed)) {
    return null;
  }

  const resolved = path.resolve(cwd, trimmed);
  try {
    const stat = await fs.stat(resolved);
    return stat.isDirectory() ? resolved : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

/**
 * Reads all syncable files from a local scaffold directory (ignoring `.cdpn.json`, `.git`,
 * `node_modules`, `.cdpnignore`, and symlinks).
 */
export async function readLocalScaffoldFolder(
  dirPath: string,
): Promise<{ textFiles: PenFileRequest[]; binaryFiles: BinaryUploadPart[] }> {
  const scanned = await scanLocalFiles(dirPath);
  if (scanned.size === 0) {
    throw new Error(`Local scaffold folder ${dirPath} contains no syncable files.`);
  }

  const textFiles: PenFileRequest[] = [];
  const binaryFiles: BinaryUploadPart[] = [];

  for (const [filePath, lf] of scanned) {
    if (lf.isBinary && lf.buffer.length > 0) {
      binaryFiles.push({ path: filePath, content: lf.buffer });
    } else {
      textFiles.push({ path: filePath, content: lf.textContent ?? '' });
    }
  }

  return { textFiles, binaryFiles };
}
