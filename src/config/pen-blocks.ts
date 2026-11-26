import fs from 'node:fs/promises';
import path from 'node:path';
import {
  CLASSIC_CONFIG_FILENAME,
  CODEPEN_DIR,
  PEN_CONFIG_FILENAME,
} from '../constants.js';
import { CliError } from '../errors.js';
import { fileExistsRegular, isWithinRoot, readSafeJsonObject } from '../utils/fs-safe.js';
import { hasControlChars, isPlainObject } from '../utils/strings.js';

export { CLASSIC_CONFIG_FILENAME, CODEPEN_DIR, PEN_CONFIG_FILENAME };

export const REQUIRED_PEN_BLOCKS = ['validate-1', 'fingerprint-1'] as const;

export interface InitBlockChoice {
  id: 'validate' | 'fingerprint' | 'packages' | 'classic';
  blockName: string;
  label: string;
  description: string;
  locked: boolean;
  exclusive?: boolean;
}

export const INIT_BLOCK_CHOICES: readonly InitBlockChoice[] = Object.freeze([
  {
    id: 'validate',
    blockName: 'validate-1',
    label: 'validate',
    description: 'HTML/CSS/JS validation · required',
    locked: true,
  },
  {
    id: 'fingerprint',
    blockName: 'fingerprint-1',
    label: 'fingerprint',
    description: 'asset fingerprinting · required',
    locked: true,
  },
  {
    id: 'packages',
    blockName: 'packages-1',
    label: 'packages',
    description: 'npm packages via package.json importmap',
    locked: false,
  },
  {
    id: 'classic',
    blockName: 'classic-1',
    label: 'classic',
    description: 'CodePen Classic mode (.pen.html + classic.config.json)',
    locked: false,
    exclusive: true,
  },
]);

const KNOWN_BLOCK_MAP = new Map<string, string>(
  INIT_BLOCK_CHOICES.map((c) => [c.id, c.blockName]),
);

const EXPLICIT_BLOCK_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,60}-\d+$/;
const SHORT_BLOCK_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,60}$/;

export function normalizeBlockType(rawName: string): string {
  return String(rawName).trim().toLowerCase().replace(/-\d+$/, '');
}

/**
 * Normalizes a single user-supplied block identifier (e.g. `"packages"`, `"classic"`,
 * `"packages-1"`, `"markdown-it-14"`) into a CodePen 2.0 block name.
 */
export function normalizeBlockIdentifier(raw: string): string {
  const cleaned = raw.trim().toLowerCase();
  if (!cleaned || hasControlChars(cleaned)) {
    throw new CliError(400, `Invalid block name "${raw}".`);
  }
  const known = KNOWN_BLOCK_MAP.get(cleaned);
  if (known) return known;

  if (EXPLICIT_BLOCK_NAME_PATTERN.test(cleaned)) {
    return cleaned;
  }
  if (SHORT_BLOCK_NAME_PATTERN.test(cleaned)) {
    return `${cleaned}-1`;
  }

  throw new CliError(
    400,
    `Invalid block name "${raw}". Use lowercase letters, numbers, and hyphens (e.g. packages, classic).`,
  );
}

/**
 * Normalizes a list of block identifiers, deduplicating, sorting alphabetically,
 * and always guaranteeing `validate-1` and `fingerprint-1` are included.
 */
export function normalizePenBlocksList(rawBlocks: readonly string[]): string[] {
  const byType = new Map<string, string>();
  for (const required of REQUIRED_PEN_BLOCKS) {
    byType.set(normalizeBlockType(required), required);
  }
  for (const raw of rawBlocks) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.toLowerCase() === 'none') continue;
    const normalized = normalizeBlockIdentifier(trimmed);
    const blockType = normalizeBlockType(normalized);
    if (blockType === 'validate') {
      byType.set('validate', 'validate-1');
    } else if (blockType === 'fingerprint') {
      byType.set('fingerprint', 'fingerprint-1');
    } else {
      byType.set(blockType, normalized);
    }
  }
  return [...byType.values()].sort((a, b) => a.localeCompare(b));
}

/**
 * Parses a comma-separated `--blocks` CLI flag into normalized CodePen 2.0 block names,
 * always including `validate-1` and `fingerprint-1`.
 */
export function parseBlocksOption(raw: string): string[] {
  const parts = raw
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  return normalizePenBlocksList(parts);
}

const REQUIRED_BLOCK_TYPES = new Set(REQUIRED_PEN_BLOCKS.map((b) => normalizeBlockType(b)));

/**
 * Validates that the `classic` block is not combined with any other non-required block.
 * Throws a `400 CliError` when `classic` appears alongside other optional blocks.
 */
export function assertNoClassicBlockConflict(rawBlocks: readonly string[]): void {
  const normalized = normalizePenBlocksList(rawBlocks);
  let hasClassic = false;
  const otherOptional: string[] = [];

  for (const block of normalized) {
    const blockType = normalizeBlockType(block);
    if (REQUIRED_BLOCK_TYPES.has(blockType)) continue;
    if (blockType === 'classic') {
      hasClassic = true;
    } else {
      otherOptional.push(blockType);
    }
  }

  if (hasClassic && otherOptional.length > 0) {
    throw new CliError(
      400,
      `Cannot combine the "classic" block with other optional blocks (${otherOptional.join(', ')}).`,
    );
  }
}

/**
 * Builds a `.codepen/pen.config.json` object for the given block names, optionally
 * merging onto an existing `pen.config.json` object. Pass `pruneUnselected: true`
 * to keep `createdAt`/`version` from existing entries while only emitting `rawBlocks`.
 */
export function buildPenConfigObject(
  rawBlocks: readonly string[],
  options: {
    existing?: Record<string, unknown> | null;
    nowIso?: string;
    pruneUnselected?: boolean;
  } = {},
): { blocks: Record<string, { createdAt: string; disabled: boolean; name: string; version: string }> } {
  const blockNames = normalizePenBlocksList(rawBlocks);
  const nowIso = options.nowIso ?? new Date().toISOString();
  const existingBlocks =
    options.existing && isPlainObject(options.existing.blocks) ? options.existing.blocks : {};

  type BlockEntry = { createdAt: string; disabled: boolean; name: string; version: string };
  const existingByKey: Record<string, BlockEntry> = {};

  if (options.existing) {
    for (const [key, entry] of Object.entries(existingBlocks)) {
      if (!isPlainObject(entry)) continue;
      const name = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : key;
      const createdAt =
        typeof entry.createdAt === 'string' && entry.createdAt.trim() ? entry.createdAt.trim() : nowIso;
      const version =
        typeof entry.version === 'string' && entry.version.trim() ? entry.version.trim() : 'latest';
      existingByKey[key] = {
        createdAt,
        disabled: Boolean(entry.disabled),
        name,
        version,
      };
    }
  }

  const blocks: Record<string, BlockEntry> = options.pruneUnselected ? {} : { ...existingByKey };

  for (const name of blockNames) {
    const prev = existingByKey[name];
    blocks[name] = {
      createdAt: prev?.createdAt ?? nowIso,
      disabled: false,
      name,
      version: prev?.version ?? 'latest',
    };
  }

  const sortedBlocks: typeof blocks = {};
  for (const key of Object.keys(blocks).sort((a, b) => a.localeCompare(b))) {
    sortedBlocks[key] = blocks[key]!;
  }

  return { blocks: sortedBlocks };
}

export interface StarterClassicConfig {
  head: string;
  htmlClasses: string;
  scripts: string[];
  styles: string[];
}

export function buildStarterClassicConfigFromPaths(filePaths: readonly string[]): StarterClassicConfig {
  const pathSet = new Set(filePaths.map((p) => (p.startsWith('/') ? p : `/${p}`)));
  return {
    head: '<meta name="viewport" content="width=device-width" />',
    htmlClasses: '',
    scripts: pathSet.has('/script.js') ? ['/script.js'] : [],
    styles: pathSet.has('/style.css') ? ['/style.css'] : [],
  };
}

/**
 * Generates a starter `.codepen/classic.config.json` payload, auto-linking `/style.css`
 * and `/script.js` when those files exist in `penDir`.
 */
export async function buildStarterClassicConfig(penDir: string): Promise<StarterClassicConfig> {
  const resolved = path.resolve(penDir);
  const [hasStyleCss, hasScriptJs] = await Promise.all([
    fileExistsRegular(path.join(resolved, 'style.css')),
    fileExistsRegular(path.join(resolved, 'script.js')),
  ]);

  return {
    head: '<meta name="viewport" content="width=device-width" />',
    htmlClasses: '',
    scripts: hasScriptJs ? ['/script.js'] : [],
    styles: hasStyleCss ? ['/style.css'] : [],
  };
}

/**
 * Removes blocks whose normalized type matches any entry in `blockTypesToRemove` from an existing
 * `pen.config.json` object, while preserving remaining blocks and guaranteeing required blocks.
 */
export function removeBlocksFromPenConfig(
  existing: Record<string, unknown> | null | undefined,
  blockTypesToRemove: readonly string[],
  options: { nowIso?: string } = {},
): { blocks: Record<string, { createdAt: string; disabled: boolean; name: string; version: string }> } {
  const removeSet = new Set(blockTypesToRemove.map((b) => normalizeBlockType(b)));
  const nowIso = options.nowIso ?? new Date().toISOString();
  const existingBlocks = existing && isPlainObject(existing.blocks) ? existing.blocks : {};

  type BlockEntry = { createdAt: string; disabled: boolean; name: string; version: string };
  const remaining: Record<string, BlockEntry> = {};

  for (const [key, entry] of Object.entries(existingBlocks)) {
    if (!isPlainObject(entry)) continue;
    const name = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : key;
    if (removeSet.has(normalizeBlockType(name)) || removeSet.has(normalizeBlockType(key))) {
      continue;
    }
    const createdAt =
      typeof entry.createdAt === 'string' && entry.createdAt.trim() ? entry.createdAt.trim() : nowIso;
    const version =
      typeof entry.version === 'string' && entry.version.trim() ? entry.version.trim() : 'latest';
    remaining[key] = {
      createdAt,
      disabled: Boolean(entry.disabled),
      name,
      version,
    };
  }

  for (const required of REQUIRED_PEN_BLOCKS) {
    const prev = remaining[required];
    remaining[required] = {
      createdAt: prev?.createdAt ?? nowIso,
      disabled: false,
      name: required,
      version: prev?.version ?? 'latest',
    };
  }

  const sortedBlocks: Record<string, BlockEntry> = {};
  for (const key of Object.keys(remaining).sort((a, b) => a.localeCompare(b))) {
    sortedBlocks[key] = remaining[key]!;
  }

  return { blocks: sortedBlocks };
}

/**
 * Checks whether `<dirRealpath>/package.json` exists as a regular, root-contained JSON file
 * containing at least one non-empty entry in `dependencies`.
 */
export async function hasPackageJsonDependencies(dirRealpath: string): Promise<boolean> {
  const pkgJson = await readSafeJsonObject(path.join(dirRealpath, 'package.json'), dirRealpath);
  if (!pkgJson || !isPlainObject(pkgJson.dependencies)) {
    return false;
  }
  return Object.entries(pkgJson.dependencies).some(
    ([name, version]) =>
      typeof name === 'string' &&
      name.trim().length > 0 &&
      typeof version === 'string' &&
      version.trim().length > 0,
  );
}

/**
 * Ensures `<rootRealpath>/.codepen` exists as a regular directory strictly inside `rootRealpath`
 * (refusing symlinks or escapes).
 */
export async function ensureCodepenDirSafe(rootRealpath: string): Promise<string> {
  const codepenDir = path.join(rootRealpath, CODEPEN_DIR);
  try {
    const stat = await fs.lstat(codepenDir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new CliError(
        400,
        `${CODEPEN_DIR} must be a regular directory (symlinks are not allowed).`,
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      await fs.mkdir(codepenDir, { recursive: true });
    } else {
      throw error;
    }
  }

  const realCodepenDir = await fs.realpath(codepenDir);
  if (!isWithinRoot(realCodepenDir, rootRealpath)) {
    throw new CliError(400, `${CODEPEN_DIR} resolves outside the target directory.`);
  }
  return realCodepenDir;
}

/**
 * Safely reads `<rootRealpath>/.codepen/pen.config.json` as a plain JSON object if it exists.
 * Rejects symlinked or non-regular `.codepen/pen.config.json`.
 */
export async function readExistingPenConfigSafe(
  rootRealpath: string,
): Promise<Record<string, unknown> | null> {
  const penConfigPath = path.join(rootRealpath, CODEPEN_DIR, PEN_CONFIG_FILENAME);
  try {
    const stat = await fs.lstat(penConfigPath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new CliError(400, `${CODEPEN_DIR}/${PEN_CONFIG_FILENAME} must be a regular file.`);
    }
    const realPath = await fs.realpath(penConfigPath);
    if (!isWithinRoot(realPath, rootRealpath)) {
      throw new CliError(400, `${CODEPEN_DIR}/${PEN_CONFIG_FILENAME} resolves outside the target directory.`);
    }
    const raw = await fs.readFile(realPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    if (error instanceof CliError) {
      throw error;
    }
    return null;
  }
}

/**
 * Safely writes `<rootRealpath>/.codepen/pen.config.json`, ensuring `.codepen/` is a regular
 * root-contained directory and `pen.config.json` is not a symlink.
 */
export async function writePenConfigSafe(
  rootRealpath: string,
  payload: { blocks: Record<string, { createdAt: string; disabled: boolean; name: string; version: string }> },
): Promise<string> {
  const realCodepenDir = await ensureCodepenDirSafe(rootRealpath);
  const penConfigPath = path.join(realCodepenDir, PEN_CONFIG_FILENAME);
  if (!isWithinRoot(penConfigPath, rootRealpath)) {
    throw new CliError(400, `${CODEPEN_DIR}/${PEN_CONFIG_FILENAME} resolves outside the target directory.`);
  }
  try {
    const stat = await fs.lstat(penConfigPath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new CliError(400, `${CODEPEN_DIR}/${PEN_CONFIG_FILENAME} must be a regular file.`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  await fs.writeFile(penConfigPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return penConfigPath;
}

/**
 * Creates a starter `<rootRealpath>/.codepen/classic.config.json` if it does not already exist.
 * Returns `true` when created, `false` when already present.
 */
export async function ensureStarterClassicConfigSafe(rootRealpath: string): Promise<boolean> {
  const realCodepenDir = await ensureCodepenDirSafe(rootRealpath);
  const classicConfigPath = path.join(realCodepenDir, CLASSIC_CONFIG_FILENAME);
  if (!isWithinRoot(classicConfigPath, rootRealpath)) {
    throw new CliError(400, `${CODEPEN_DIR}/${CLASSIC_CONFIG_FILENAME} resolves outside the target directory.`);
  }
  try {
    const stat = await fs.lstat(classicConfigPath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new CliError(400, `${CODEPEN_DIR}/${CLASSIC_CONFIG_FILENAME} must be a regular file.`);
    }
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  const starter = await buildStarterClassicConfig(rootRealpath);
  await fs.writeFile(classicConfigPath, `${JSON.stringify(starter, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
  return true;
}
