import fs from 'node:fs/promises';
import path from 'node:path';
import type { PenAccess, PenEditor, PenFile } from '../api/types.js';
import { PROJECT_CONFIG_FILENAME } from '../constants.js';
import { CliError } from '../errors.js';
import { parseAccessValue } from '../utils/cli-options.js';
import { isPlainObject } from '../utils/strings.js';

export { PROJECT_CONFIG_FILENAME };

/** Per-file sync baseline stored inside `.cdpn.json`. */
export interface SyncedFileEntry {
  id: string;
  content_hash: string;
  local_sha256: string;
  is_binary: boolean;
}

/** Editable Pen metadata stored under `info` in `.cdpn.json`. */
export interface PenInfo {
  title?: string;
  description?: string;
  tags?: string[];
  access?: PenAccess;
  template?: boolean;
}

/** Fully populated Pen metadata extracted from CodePen API v2. */
export type CompletePenInfo = Required<PenInfo>;

/** Local Pen sync metadata stored in `.cdpn.json` at the Pen folder root. */
export interface CdpnConfig {
  url: string;
  pen_id: string;
  profile?: string;
  last_synced_version_id: string | null;
  last_synced_info_hash?: string;
  editor?: PenEditor;
  info?: PenInfo;
  files?: Record<string, SyncedFileEntry>;
}

/** Unlinked `.cdpn.json` containing only retained or pre-populated Pen metadata (`info`). */
export interface UnlinkedCdpnConfig {
  info: PenInfo;
}

export interface ProjectLocation {
  rootDir: string;
  configPath: string;
  config: CdpnConfig;
}

export interface UnlinkedProjectLocation {
  rootDir: string;
  configPath: string;
  config: UnlinkedCdpnConfig;
}

export type NearestProjectConfig =
  | ({ linked: true } & ProjectLocation)
  | ({ linked: false } & UnlinkedProjectLocation);

export type ParsedProjectConfig =
  | { linked: true; config: CdpnConfig }
  | { linked: false; config: UnlinkedCdpnConfig };

/**
 * Orders defined keys of a (potentially partial) `PenInfo` object consistently for writing `.cdpn.json`.
 */
export function normalizePartialPenInfo(info: PenInfo): PenInfo {
  const ordered: PenInfo = {};
  if (info.title !== undefined) ordered.title = info.title;
  if (info.description !== undefined) ordered.description = info.description;
  if (info.tags !== undefined) ordered.tags = [...info.tags];
  if (info.access !== undefined) ordered.access = info.access;
  if (info.template !== undefined) ordered.template = info.template;
  return ordered;
}

/**
 * Validates and normalizes the optional `info` object parsed from `.cdpn.json`.
 * Returns `undefined` when absent (backwards-compatible with older `.cdpn.json` files).
 */
export function parsePenInfoInput(
  raw: unknown,
  configLabel = PROJECT_CONFIG_FILENAME,
): PenInfo | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }

  if (!isPlainObject(raw)) {
    throw new CliError(400, `Invalid ${configLabel}: "info" must be a JSON object.`);
  }

  if (Object.hasOwn(raw, 'password') && raw.password !== undefined) {
    throw new CliError(
      400,
      `Invalid ${configLabel}: "info.password" is not supported (passwords must not be stored in ${configLabel}).\n` +
        'Use `cdpn privacy protected` or `cdpn info --access Protected --password <password>` instead.',
    );
  }

  const parsed: PenInfo = {};

  if (raw.title !== undefined) {
    if (typeof raw.title !== 'string') {
      throw new CliError(400, `Invalid ${configLabel}: "info.title" must be a string.`);
    }
    parsed.title = raw.title;
  }

  if (raw.description !== undefined) {
    if (typeof raw.description !== 'string') {
      throw new CliError(400, `Invalid ${configLabel}: "info.description" must be a string.`);
    }
    parsed.description = raw.description;
  }

  if (raw.tags !== undefined) {
    if (!Array.isArray(raw.tags) || !raw.tags.every((t) => typeof t === 'string')) {
      throw new CliError(400, `Invalid ${configLabel}: "info.tags" must be an array of strings.`);
    }
    parsed.tags = raw.tags.map((t) => t.trim()).filter(Boolean);
  }

  if (raw.access !== undefined) {
    if (typeof raw.access !== 'string') {
      throw new CliError(
        400,
        `Invalid ${configLabel}: "info.access" must be one of Public, Private, Protected, or Collaborators.`,
      );
    }
    const normalizedAccess = parseAccessValue(raw.access);
    if (!normalizedAccess) {
      throw new CliError(
        400,
        `Invalid ${configLabel}: "info.access" value "${raw.access}" is invalid. Use: Public, Private, Protected, or Collaborators.`,
      );
    }
    parsed.access = normalizedAccess;
  }

  if (raw.template !== undefined) {
    if (typeof raw.template !== 'boolean') {
      throw new CliError(400, `Invalid ${configLabel}: "info.template" must be a boolean.`);
    }
    parsed.template = raw.template;
  }

  return parsed;
}

export function createUnlinkedProjectError(rootDir: string): CliError {
  return new CliError(
    404,
    `${PROJECT_CONFIG_FILENAME} in ${rootDir} only contains Pen info and is not linked to an online Pen yet.\n` +
      'Run `cdpn push` to push this folder as a new Pen on CodePen.',
  );
}

/**
 * Walks upward from `startDir` looking for the nearest `.cdpn.json` (linked or unlinked info-only).
 * Stops at the first `.cdpn.json` encountered so nested unlinked folders never leak to a parent Pen.
 */
export async function findNearestConfig(
  startDir: string = process.cwd(),
): Promise<NearestProjectConfig | null> {
  let current = path.resolve(startDir);

  for (;;) {
    const configPath = path.join(current, PROJECT_CONFIG_FILENAME);
    try {
      const stat = await fs.lstat(configPath);
      if (stat.isFile()) {
        const parsed = await readProjectConfigFile(current);
        if (parsed.linked) {
          return { linked: true, rootDir: current, configPath, config: parsed.config };
        }
        return { linked: false, rootDir: current, configPath, config: parsed.config };
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

/**
 * Walks upward from `startDir` looking for a linked `.cdpn.json` (similar to how git locates `.git`).
 * Returns `null` if no `.cdpn.json` is found or if the nearest `.cdpn.json` is unlinked (info-only).
 */
export async function findProject(startDir: string = process.cwd()): Promise<ProjectLocation | null> {
  const nearest = await findNearestConfig(startDir);
  if (!nearest || !nearest.linked) {
    return null;
  }
  return {
    rootDir: nearest.rootDir,
    configPath: nearest.configPath,
    config: nearest.config,
  };
}

export async function requireProject(startDir: string = process.cwd()): Promise<ProjectLocation> {
  const nearest = await findNearestConfig(startDir);
  if (!nearest) {
    throw new CliError(
      404,
      `No ${PROJECT_CONFIG_FILENAME} found in this directory or any parent directory.\nRun \`cdpn clone <url>\` to clone a Pen or \`cdpn new\` to create one.`,
    );
  }
  if (!nearest.linked) {
    throw createUnlinkedProjectError(nearest.rootDir);
  }
  return {
    rootDir: nearest.rootDir,
    configPath: nearest.configPath,
    config: nearest.config,
  };
}

/**
 * Requires a linked `.cdpn.json` to exist directly inside `dir` (does NOT walk upward to parent directories).
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
      throw new CliError(
        404,
        `No ${PROJECT_CONFIG_FILENAME} found in ${resolvedDir}.\n` +
          `This command only works directly inside a folder containing ${PROJECT_CONFIG_FILENAME} (found one in parent folder: ${parentProject.rootDir}).`,
      );
    }
  }

  throw new CliError(
    404,
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

/**
 * Reads and validates `.cdpn.json` from `rootDir`, supporting both linked Pen configs
 * and unlinked info-only configs (e.g. retained via `cdpn delete --cleanup` or `cdpn init`).
 */
export async function readProjectConfigFile(rootDir: string): Promise<ParsedProjectConfig> {
  const resolvedDir = path.resolve(rootDir);
  const configPath = path.join(resolvedDir, PROJECT_CONFIG_FILENAME);
  const raw = await fs.readFile(configPath, 'utf8');

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CliError(400, `Invalid JSON in ${configPath}`);
  }

  if (!isPlainObject(parsed)) {
    throw new CliError(400, `Invalid ${PROJECT_CONFIG_FILENAME}: expected a JSON object.`);
  }

  // Unlinked info-only `.cdpn.json`: no pen_id or url, only `info`
  if (parsed.pen_id === undefined && parsed.url === undefined && parsed.info !== undefined) {
    if (parsed.info === null) {
      throw new CliError(400, `Invalid ${PROJECT_CONFIG_FILENAME}: "info" must be a JSON object.`);
    }
    const info = parsePenInfoInput(parsed.info, PROJECT_CONFIG_FILENAME)!;
    return {
      linked: false,
      config: { info },
    };
  }

  if (typeof parsed.pen_id !== 'string' || !parsed.pen_id.trim()) {
    throw new CliError(400, `Invalid ${PROJECT_CONFIG_FILENAME}: missing required "pen_id" string.`);
  }
  if (typeof parsed.url !== 'string' || !parsed.url.trim()) {
    throw new CliError(400, `Invalid ${PROJECT_CONFIG_FILENAME}: missing required "url" string.`);
  }

  const profile =
    typeof parsed.profile === 'string' && parsed.profile.trim()
      ? parsed.profile.trim()
      : undefined;

  const lastSynced =
    parsed.last_synced_version_id === null || typeof parsed.last_synced_version_id === 'string'
      ? parsed.last_synced_version_id
      : null;

  const lastSyncedInfoHash =
    typeof parsed.last_synced_info_hash === 'string' && parsed.last_synced_info_hash.trim()
      ? parsed.last_synced_info_hash.trim()
      : undefined;

  const editor =
    parsed.editor === 'V2' || parsed.editor === 'Classic' ? parsed.editor : undefined;

  const info = parsePenInfoInput(parsed.info, PROJECT_CONFIG_FILENAME);

  let files: Record<string, SyncedFileEntry> | undefined;
  if (isPlainObject(parsed.files)) {
    files = {};
    for (const [filePath, entry] of Object.entries(parsed.files)) {
      if (isPlainObject(entry)) {
        if (
          typeof entry.id === 'string' &&
          typeof entry.content_hash === 'string' &&
          typeof entry.local_sha256 === 'string'
        ) {
          files[filePath] = {
            id: entry.id,
            content_hash: entry.content_hash,
            local_sha256: entry.local_sha256,
            is_binary: Boolean(entry.is_binary),
          };
        }
      }
    }
  }

  return {
    linked: true,
    config: {
      url: parsed.url.trim(),
      pen_id: parsed.pen_id.trim(),
      ...(profile ? { profile } : {}),
      last_synced_version_id: lastSynced,
      ...(lastSyncedInfoHash ? { last_synced_info_hash: lastSyncedInfoHash } : {}),
      ...(editor ? { editor } : {}),
      ...(info !== undefined ? { info } : {}),
      ...(files ? { files } : {}),
    },
  };
}

export async function readProjectConfig(rootDir: string): Promise<CdpnConfig> {
  const parsed = await readProjectConfigFile(rootDir);
  if (!parsed.linked) {
    throw createUnlinkedProjectError(path.resolve(rootDir));
  }
  return parsed.config;
}

export async function writeProjectConfig(rootDir: string, config: CdpnConfig): Promise<string> {
  const configPath = path.join(path.resolve(rootDir), PROJECT_CONFIG_FILENAME);
  const trimmedProfile = config.profile?.trim();
  const trimmedInfoHash = config.last_synced_info_hash?.trim();
  const normalizedInfo = config.info !== undefined ? normalizePartialPenInfo(config.info) : undefined;
  const ordered: CdpnConfig = {
    url: config.url,
    pen_id: config.pen_id,
    ...(trimmedProfile ? { profile: trimmedProfile } : {}),
    last_synced_version_id: config.last_synced_version_id,
    ...(trimmedInfoHash ? { last_synced_info_hash: trimmedInfoHash } : {}),
    ...(config.editor ? { editor: config.editor } : {}),
    ...(normalizedInfo !== undefined ? { info: normalizedInfo } : {}),
    ...(config.files ? { files: sortRecordKeys(config.files) } : {}),
  };
  await fs.writeFile(configPath, `${JSON.stringify(ordered, null, 2)}\n`, 'utf8');
  return configPath;
}

/**
 * Writes an unlinked `.cdpn.json` containing only the normalized `info` section.
 */
export async function writeUnlinkedProjectInfo(rootDir: string, info: PenInfo): Promise<string> {
  const configPath = path.join(path.resolve(rootDir), PROJECT_CONFIG_FILENAME);
  const normalizedInfo = normalizePartialPenInfo(info);
  const payload: UnlinkedCdpnConfig = { info: normalizedInfo };
  await fs.writeFile(configPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
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
