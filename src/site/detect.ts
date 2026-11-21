import fs from 'node:fs/promises';
import path from 'node:path';
import { PROJECT_CONFIG_FILENAME, readProjectConfigFile } from '../config/project.js';
import { CODEPEN_DIR, PEN_CONFIG_FILENAME, isWithinRoot, readPenBlocks, type PenBlockContext } from './blocks.js';

export type DirectoryMode = 'pen' | 'collection';

export type CdpnJsonState = 'linked-v2' | 'linked-classic' | 'unlinked' | 'invalid' | 'none';

export interface DirectoryInspection {
  rootDir: string;
  rootRealpath: string;
  hasCdpnJson: boolean;
  cdpnState: CdpnJsonState;
  penTitle: string | null;
  hasCodepenDir: boolean;
  hasPenConfig: boolean;
  hasIndexHtml: boolean;
  hasClassicPenHtml: boolean;
  penBlocks: PenBlockContext | null;
}

async function statRegularFile(filePath: string, rootRealpath: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) return false;
    const real = await fs.realpath(filePath);
    return isWithinRoot(real, rootRealpath);
  } catch {
    return false;
  }
}

async function statRegularDir(dirPath: string, rootRealpath: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(dirPath);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
    const real = await fs.realpath(dirPath);
    return isWithinRoot(real, rootRealpath);
  } catch {
    return false;
  }
}

/**
 * Inspects a directory directly (does not walk upward) to classify whether it is a
 * CodePen Pen folder (`.cdpn.json`) or a multi-Pen collection directory.
 */
export async function inspectTargetDirectory(targetDir: string): Promise<DirectoryInspection> {
  const resolved = path.resolve(targetDir);
  const rootRealpath = await fs.realpath(resolved);

  const [hasCdpnJson, hasCodepenDir, hasPenConfig, hasIndexHtml, hasClassicPenHtml] =
    await Promise.all([
      statRegularFile(path.join(rootRealpath, PROJECT_CONFIG_FILENAME), rootRealpath),
      statRegularDir(path.join(rootRealpath, CODEPEN_DIR), rootRealpath),
      statRegularFile(path.join(rootRealpath, CODEPEN_DIR, PEN_CONFIG_FILENAME), rootRealpath),
      statRegularFile(path.join(rootRealpath, 'index.html'), rootRealpath),
      statRegularFile(path.join(rootRealpath, 'index.pen.html'), rootRealpath),
    ]);

  let cdpnState: CdpnJsonState = 'none';
  let penTitle: string | null = null;
  if (hasCdpnJson) {
    try {
      const parsed = await readProjectConfigFile(rootRealpath);
      if (parsed.linked) {
        cdpnState = parsed.config.editor === 'Classic' ? 'linked-classic' : 'linked-v2';
        penTitle = parsed.config.info?.title?.trim() || null;
      } else {
        cdpnState = 'unlinked';
        penTitle = parsed.config.info?.title?.trim() || null;
      }
    } catch {
      cdpnState = 'invalid';
    }
  }

  const penBlocks = hasPenConfig ? await readPenBlocks(rootRealpath, rootRealpath) : null;

  return {
    rootDir: resolved,
    rootRealpath,
    hasCdpnJson,
    cdpnState,
    penTitle,
    hasCodepenDir,
    hasPenConfig,
    hasIndexHtml,
    hasClassicPenHtml,
    penBlocks,
  };
}

/**
 * Resolves the effective operating mode for `serve` and `build`:
 * - `'pen'`: directory directly contains a `.cdpn.json` file
 * - `'collection'`: directory does not contain `.cdpn.json` (serves/builds `.cdpn.json` subdirectories)
 */
export function classifyDirectoryMode(inspection: DirectoryInspection): DirectoryMode {
  return inspection.hasCdpnJson ? 'pen' : 'collection';
}
