import fs from 'node:fs/promises';
import path from 'node:path';
import { readProjectConfigFile, type ParsedProjectConfig } from '../config/project.js';
import { PROJECT_CONFIG_FILENAME } from '../constants.js';
import { isBuiltCollectionOutputDir } from '../site/manifest.js';
import { isIgnoredPath, loadIgnoreMatchers } from '../sync/fs.js';
import { resolveSafeDir, resolveSafeFile } from '../utils/fs-safe.js';
import { compareNatural } from '../utils/strings.js';

const DEFAULT_MAX_DISCOVERY_DEPTH = 6;

export interface DiscoveredPen {
  /** POSIX-normalized path relative to the discovery root (e.g. `demo-a`, `css/grid-demo`). */
  relPath: string;
  /** Canonical directory path of the Pen folder. */
  rootDir: string;
  /** Path to `.cdpn.json` inside `rootDir`. */
  configPath: string;
  /** Parsed `.cdpn.json` contents when valid. */
  parsed?: ParsedProjectConfig;
  /** Error message when `.cdpn.json` could not be parsed or validated. */
  parseError?: string;
}

export interface DiscoverPensOptions {
  /** Maximum subdirectory depth to traverse beneath `rootDir` (default: 6). */
  maxDepth?: number;
}

async function scanDirectoryTree(
  dirRealpath: string,
  segments: string[],
  depth: number,
  maxDepth: number,
  visitedRealpaths: Set<string>,
  rootDir: string,
  rootRealpath: string,
  ignoreMatchers: RegExp[],
  results: DiscoveredPen[],
): Promise<void> {
  if (depth > maxDepth) return;

  let entries;
  try {
    entries = await fs.readdir(dirRealpath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') {
      continue;
    }

    const childSegments = [...segments, entry.name];
    const relPosix = `/${childSegments.join('/')}`;
    if (ignoreMatchers.length > 0 && isIgnoredPath(relPosix, ignoreMatchers)) {
      continue;
    }

    const childCandidate = path.resolve(rootDir, ...childSegments);
    const childRealDir = await resolveSafeDir(childCandidate, rootRealpath, rootDir);
    if (!childRealDir || visitedRealpaths.has(childRealDir)) {
      continue;
    }
    visitedRealpaths.add(childRealDir);

    if (await isBuiltCollectionOutputDir(childRealDir, rootRealpath)) {
      continue;
    }

    const configCandidate = path.join(childRealDir, PROJECT_CONFIG_FILENAME);
    const configFile = await resolveSafeFile(configCandidate, rootRealpath, rootRealpath);
    if (configFile) {
      const relPath = childSegments.join('/');
      try {
        const parsed = await readProjectConfigFile(childRealDir);
        results.push({
          relPath,
          rootDir: childRealDir,
          configPath: configFile.realPath,
          parsed,
        });
      } catch (error) {
        results.push({
          relPath,
          rootDir: childRealDir,
          configPath: configFile.realPath,
          parseError: error instanceof Error ? error.message : String(error),
        });
      }
      // Treat a Pen folder as a leaf — never descend inside it.
      continue;
    }

    await scanDirectoryTree(
      childRealDir,
      childSegments,
      depth + 1,
      maxDepth,
      visitedRealpaths,
      rootDir,
      rootRealpath,
      ignoreMatchers,
      results,
    );
  }
}

/**
 * Recursively walks subdirectories beneath `rootDir` to discover all folders containing
 * a `.cdpn.json` file (both linked Pens and unlinked info-only Pens).
 *
 * Security & traversal guarantees:
 * - Enforces `isWithinRoot` and `fs.realpath()` containment; never follows symlinks.
 * - Skips hidden directories (`.git`, `.codepen`, etc.), `node_modules`, `.cdpnignore`d paths,
 *   and previously built static collection outputs.
 * - Treats each discovered Pen directory as a leaf (does not descend inside a Pen).
 * - Returns Pens sorted deterministically by relative path.
 */
export async function discoverPenDirectories(
  rootDir: string,
  options: DiscoverPensOptions = {},
): Promise<DiscoveredPen[]> {
  const resolvedRoot = path.resolve(rootDir);
  let rootRealpath: string;
  try {
    rootRealpath = await fs.realpath(resolvedRoot);
  } catch {
    return [];
  }

  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DISCOVERY_DEPTH;
  const ignoreMatchers = await loadIgnoreMatchers(rootRealpath);
  const visitedRealpaths = new Set<string>([rootRealpath]);
  const results: DiscoveredPen[] = [];

  await scanDirectoryTree(
    rootRealpath,
    [],
    0,
    maxDepth,
    visitedRealpaths,
    resolvedRoot,
    rootRealpath,
    ignoreMatchers,
    results,
  );

  return results.sort((a, b) => compareNatural(a.relPath, b.relPath));
}
