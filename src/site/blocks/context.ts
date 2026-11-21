import path from 'node:path';
import { normalizeBlockType } from '../../config/pen-blocks.js';
import { CODEPEN_DIR, PEN_CONFIG_FILENAME } from '../../constants.js';
import { isWithinRoot, readSafeJsonObject } from '../../utils/fs-safe.js';
import { compareNatural, isPlainObject } from '../../utils/strings.js';

const MAX_WALK_DEPTH = 16;
const SUPPORTED_BLOCK_TYPES = new Set(['validate', 'fingerprint', 'classic', 'packages']);

export interface PenBlockContext {
  penDir: string;
  hasClassic: boolean;
  hasPackages: boolean;
  unsupportedBlocks: string[];
}

/**
 * Inspects `<penDir>/.codepen/pen.config.json` and detects enabled supported blocks
 * (`classic`, `packages`; `validate` and `fingerprint` are default no-ops) as well as
 * any active unsupported blocks.
 */
export async function readPenBlocks(
  penDir: string,
  rootRealpath: string,
): Promise<PenBlockContext | null> {
  const configPath = path.join(penDir, CODEPEN_DIR, PEN_CONFIG_FILENAME);
  const parsed = await readSafeJsonObject(configPath, rootRealpath);
  if (!parsed || !isPlainObject(parsed.blocks)) return null;

  const activeBlocks = new Set<string>();
  const unsupportedMap = new Map<string, string>();

  for (const [key, block] of Object.entries(parsed.blocks)) {
    if (!isPlainObject(block)) continue;
    if (block.disabled === true) continue;

    const rawName =
      typeof block.name === 'string' && block.name.trim() ? block.name.trim() : key;
    const cleanedName = String(rawName).replace(/[\x00-\x1f\x7f]+/g, '').trim().slice(0, 128);
    const blockType = normalizeBlockType(cleanedName);
    if (!blockType) continue;

    activeBlocks.add(blockType);
    if (!SUPPORTED_BLOCK_TYPES.has(blockType) && !unsupportedMap.has(blockType)) {
      unsupportedMap.set(blockType, cleanedName);
    }
  }

  const unsupportedBlocks = [...unsupportedMap.values()].sort(compareNatural);

  return {
    penDir,
    hasClassic: activeBlocks.has('classic'),
    hasPackages: activeBlocks.has('packages'),
    unsupportedBlocks,
  };
}

/**
 * Walks upward from `targetDir` to `rootRealpath` (inclusive) to find the nearest
 * enclosing Pen directory containing `.codepen/pen.config.json`.
 */
export async function findPenContext(
  targetDir: string,
  rootRealpath: string,
): Promise<PenBlockContext | null> {
  let currentDir = path.resolve(targetDir);
  if (!isWithinRoot(currentDir, rootRealpath)) return null;

  for (let depth = 0; depth <= MAX_WALK_DEPTH; depth++) {
    const blocks = await readPenBlocks(currentDir, rootRealpath);
    if (blocks) return blocks;

    if (currentDir === rootRealpath) break;
    const parent = path.dirname(currentDir);
    if (parent === currentDir || !isWithinRoot(parent, rootRealpath)) break;
    currentDir = parent;
  }

  return null;
}
