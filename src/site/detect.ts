import fs from 'node:fs/promises';
import path from 'node:path';
import { readProjectConfigFile } from '../config/project.js';
import { CODEPEN_DIR, PEN_CONFIG_FILENAME, PROJECT_CONFIG_FILENAME } from '../constants.js';
import { resolveSafeDir, resolveSafeFile } from '../utils/fs-safe.js';
import { readPenBlocks, type PenBlockContext } from './blocks/index.js';

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

/**
 * Inspects a directory directly (does not walk upward) to classify whether it is a
 * CodePen Pen folder (`.cdpn.json`) or a multi-Pen collection directory.
 */
export async function inspectTargetDirectory(targetDir: string): Promise<DirectoryInspection> {
  const resolved = path.resolve(targetDir);
  const rootRealpath = await fs.realpath(resolved);

  const [cdpnJson, codepenDir, penConfig, indexHtml, classicPenHtml] = await Promise.all([
    resolveSafeFile(path.join(rootRealpath, PROJECT_CONFIG_FILENAME), rootRealpath),
    resolveSafeDir(path.join(rootRealpath, CODEPEN_DIR), rootRealpath),
    resolveSafeFile(path.join(rootRealpath, CODEPEN_DIR, PEN_CONFIG_FILENAME), rootRealpath),
    resolveSafeFile(path.join(rootRealpath, 'index.html'), rootRealpath),
    resolveSafeFile(path.join(rootRealpath, 'index.pen.html'), rootRealpath),
  ]);

  const hasCdpnJson = Boolean(cdpnJson);
  const hasCodepenDir = Boolean(codepenDir);
  const hasPenConfig = Boolean(penConfig);
  const hasIndexHtml = Boolean(indexHtml);
  const hasClassicPenHtml = Boolean(classicPenHtml);

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
