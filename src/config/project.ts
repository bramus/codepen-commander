import fs from 'node:fs/promises';
import path from 'node:path';
import type { CdpnConfig, Pen, PenFile, SyncedFileEntry } from '../types.js';

export const PROJECT_CONFIG_FILENAME = '.cdpn.json';

export interface ProjectLocation {
  rootDir: string;
  configPath: string;
  config: CdpnConfig;
}

/**
 * Walks upward from `startDir` looking for `.cdpn.json` (similar to how git locates `.git`).
 */
export async function findProject(startDir: string = process.cwd()): Promise<ProjectLocation | null> {
  let current = path.resolve(startDir);

  for (;;) {
    const configPath = path.join(current, PROJECT_CONFIG_FILENAME);
    try {
      const stat = await fs.lstat(configPath);
      if (stat.isFile()) {
        const config = await readProjectConfig(current);
        return { rootDir: current, configPath, config };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export async function requireProject(startDir: string = process.cwd()): Promise<ProjectLocation> {
  const project = await findProject(startDir);
  if (!project) {
    throw new Error(
      `No ${PROJECT_CONFIG_FILENAME} found in this directory or any parent directory.\nRun \`cdpn clone <url>\` to clone a Pen or \`cdpn new\` to create one.`,
    );
  }
  return project;
}

/**
 * Requires `.cdpn.json` to exist directly inside `dir` (does NOT walk upward to parent directories).
 */
export async function requireProjectInDir(dir: string = process.cwd()): Promise<ProjectLocation> {
  const resolvedDir = path.resolve(dir);
  if (await hasProjectConfigInDir(resolvedDir)) {
    const config = await readProjectConfig(resolvedDir);
    return {
      rootDir: resolvedDir,
      configPath: path.join(resolvedDir, PROJECT_CONFIG_FILENAME),
      config,
    };
  }

  const parentDir = path.dirname(resolvedDir);
  if (parentDir !== resolvedDir) {
    const parentProject = await findProject(parentDir);
    if (parentProject) {
      throw new Error(
        `No ${PROJECT_CONFIG_FILENAME} found in ${resolvedDir}.\n` +
          `This command only works directly inside a folder containing ${PROJECT_CONFIG_FILENAME} (found one in parent folder: ${parentProject.rootDir}).`,
      );
    }
  }

  throw new Error(
    `No ${PROJECT_CONFIG_FILENAME} found in ${resolvedDir}.\n` +
      `This command only works in a folder with a ${PROJECT_CONFIG_FILENAME} file in it.`,
  );
}

export async function hasProjectConfigInDir(dir: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(path.join(path.resolve(dir), PROJECT_CONFIG_FILENAME));
    return stat.isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

export async function readProjectConfig(rootDir: string): Promise<CdpnConfig> {
  const configPath = path.join(path.resolve(rootDir), PROJECT_CONFIG_FILENAME);
  const raw = await fs.readFile(configPath, 'utf8');

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in ${configPath}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid ${PROJECT_CONFIG_FILENAME}: expected a JSON object.`);
  }

  const record = parsed as Record<string, unknown>;
  if (typeof record.pen_id !== 'string' || !record.pen_id.trim()) {
    throw new Error(`Invalid ${PROJECT_CONFIG_FILENAME}: missing required "pen_id" string.`);
  }
  if (typeof record.url !== 'string' || !record.url.trim()) {
    throw new Error(`Invalid ${PROJECT_CONFIG_FILENAME}: missing required "url" string.`);
  }

  const profile =
    typeof record.profile === 'string' && record.profile.trim()
      ? record.profile.trim()
      : undefined;

  const lastSynced =
    record.last_synced_version_id === null || typeof record.last_synced_version_id === 'string'
      ? record.last_synced_version_id
      : null;

  const editor =
    record.editor === 'V2' || record.editor === 'Classic' ? record.editor : undefined;

  let files: Record<string, SyncedFileEntry> | undefined;
  if (record.files && typeof record.files === 'object' && !Array.isArray(record.files)) {
    files = {};
    for (const [filePath, entry] of Object.entries(record.files as Record<string, unknown>)) {
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        const e = entry as Record<string, unknown>;
        if (
          typeof e.id === 'string' &&
          typeof e.content_hash === 'string' &&
          typeof e.local_sha256 === 'string'
        ) {
          files[filePath] = {
            id: e.id,
            content_hash: e.content_hash,
            local_sha256: e.local_sha256,
            is_binary: Boolean(e.is_binary),
          };
        }
      }
    }
  }

  return {
    url: record.url.trim(),
    pen_id: record.pen_id.trim(),
    ...(profile ? { profile } : {}),
    last_synced_version_id: lastSynced,
    ...(editor ? { editor } : {}),
    ...(files ? { files } : {}),
  };
}

export async function writeProjectConfig(rootDir: string, config: CdpnConfig): Promise<string> {
  const configPath = path.join(path.resolve(rootDir), PROJECT_CONFIG_FILENAME);
  const trimmedProfile = config.profile?.trim();
  const ordered: CdpnConfig = {
    url: config.url,
    pen_id: config.pen_id,
    ...(trimmedProfile ? { profile: trimmedProfile } : {}),
    last_synced_version_id: config.last_synced_version_id,
    ...(config.editor ? { editor: config.editor } : {}),
    ...(config.files ? { files: sortRecordKeys(config.files) } : {}),
  };
  await fs.writeFile(configPath, `${JSON.stringify(ordered, null, 2)}\n`, 'utf8');
  return configPath;
}

function sortRecordKeys<T>(record: Record<string, T>): Record<string, T> {
  const sorted: Record<string, T> = {};
  for (const key of Object.keys(record).sort()) {
    const val = record[key];
    if (val !== undefined) {
      sorted[key] = val;
    }
  }
  return sorted;
}

/**
 * Builds the baseline file manifest stored in `.cdpn.json` after a pull or push.
 */
export function buildSyncedFileMap(
  remoteFiles: PenFile[],
  localSha256ByPath: Map<string, string>,
): Record<string, SyncedFileEntry> {
  const map: Record<string, SyncedFileEntry> = {};
  for (const file of remoteFiles) {
    const normalizedPath = file.path.startsWith('/') ? file.path : `/${file.path}`;
    const localHash = localSha256ByPath.get(normalizedPath) ?? file.content_hash;
    map[normalizedPath] = {
      id: file.id,
      content_hash: file.content_hash,
      local_sha256: localHash,
      is_binary: file.is_binary,
    };
  }
  return sortRecordKeys(map);
}

/**
 * Validates and normalizes a Pen identifier or CodePen URL passed by the user.
 * CodePen API v2 accepts cpids, hashids, and CodePen URLs (editor, pen, preview).
 */
export function normalizePenReference(rawInput: string): { apiIdentifier: string; originalUrl?: string } {
  const trimmed = rawInput.trim();
  if (!trimmed) {
    throw new Error('Pen URL or ID cannot be empty.');
  }

  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new Error(`Invalid URL: ${trimmed}`);
    }
    const host = parsed.hostname.toLowerCase();
    const isCodePenHost =
      host === 'codepen.io' ||
      host.endsWith('.codepen.io') ||
      host.endsWith('.codepen.dev') ||
      host.endsWith('.codepen.app');
    if (!isCodePenHost) {
      throw new Error(`Expected a CodePen URL (codepen.io / codepen.dev / codepen.app), got: ${host}`);
    }
    return { apiIdentifier: trimmed, originalUrl: trimmed };
  }

  // Raw cpid (UUID) or hashid
  if (!/^[A-Za-z0-9_-]{3,64}$/.test(trimmed)) {
    throw new Error(`Invalid Pen ID: "${trimmed}". Provide a Pen URL, cpid, or hashid.`);
  }

  return { apiIdentifier: trimmed };
}

/**
 * Converts a Pen title into a safe directory-name slug, or returns null for empty / "Untitled".
 */
export function slugifyTitle(rawTitle: string | undefined | null): string | null {
  const title = (rawTitle ?? '').trim();
  if (!title || title.toLowerCase() === 'untitled') {
    return null;
  }
  const slug = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  if (!slug || slug === '.' || slug === '..') {
    return null;
  }
  return slug;
}

/**
 * Produces a safe default local folder name for a Pen based on its title or ID.
 */
export function suggestFolderName(pen: Pick<Pen, 'id' | 'title'>): string {
  return slugifyTitle(pen.title) ?? pen.id.replace(/[^A-Za-z0-9_-]/g, '-');
}

const RESERVED_CODEPEN_SEGMENTS = new Set([
  'pen',
  'editor',
  'full',
  'details',
  'debug',
  'live',
  'embed',
  'settings',
  'trending',
  'following',
  'your-work',
  'collections',
  'project',
  'projects',
  'api',
]);

/**
 * Extracts the CodePen username or team slug from a `codepen.io` URL, if present.
 * Supports CodePen 2.0 editor URLs (`https://codepen.io/editor/bramus/pen/<cpid>`),
 * Classic personal URLs (`https://codepen.io/bramus/pen/<slug>`), and team URLs
 * (`https://codepen.io/team/username/pen/...`, `https://codepen.io/editor/team/username/pen/...`).
 */
export function extractCodePenOwnerFromUrl(rawUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return null;
  }

  const host = parsed.hostname.toLowerCase();
  if (host !== 'codepen.io' && host !== 'www.codepen.io') {
    return null;
  }

  const segments = parsed.pathname.split('/').filter(Boolean);
  let idx = 0;

  // CodePen 2.0 editor URLs place `/editor/` before the username/team slug
  if (segments[idx]?.toLowerCase() === 'editor') {
    idx++;
  }

  // Team URLs may include a `/team/` prefix before the team slug
  if (segments[idx]?.toLowerCase() === 'team') {
    idx++;
  }

  // Require at least `<owner>/<view-or-resource>` remaining (e.g. `bramus/pen/<id>`)
  if (segments.length - idx < 2) {
    return null;
  }

  const candidate = segments[idx]?.trim();
  if (!candidate || RESERVED_CODEPEN_SEGMENTS.has(candidate.toLowerCase())) {
    return null;
  }

  if (/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(candidate)) {
    return candidate;
  }
  return null;
}
