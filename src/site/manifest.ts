import fs from 'node:fs/promises';
import path from 'node:path';
import type { PenAccess } from '../api/types.js';
import { CODEPEN_DIR, PROJECT_CONFIG_FILENAME } from '../constants.js';
import { isIgnoredPath, loadIgnoreMatchers } from '../sync/fs.js';
import {
  matchesAccessFilter,
  parseAccessValue,
  type AccessFilter,
} from '../utils/cli-options.js';
import { sanitizeCodePenUrl } from '../utils/codepen-url.js';
import { readPartialUtf8, resolveSafeDir, resolveSafeFile } from '../utils/fs-safe.js';
import { extractHtmlTitle, extractMetaDescription } from '../utils/html.js';
import {
  compareNatural,
  formatFolderTitle,
  isPlainObject,
  normalizePlainText,
} from '../utils/strings.js';
import { createDebouncedWatcher } from '../utils/watcher.js';
import { readClassicHeadMetadata, readPenBlocks } from './blocks/index.js';

export { formatFolderTitle };

const MAX_SCAN_DEPTH = 4;
const MAX_HTML_HEAD_BYTES = 16 * 1024;
const MAX_CDPN_JSON_BYTES = 64 * 1024;
const MAX_DEMO_TAGS = 10;

export interface DemoEntry {
  title: string;
  description: string | null;
  tags: string[];
  path: string;
  href: string;
  codepenUrl: string | null;
}

export interface DemoGroup {
  id: string;
  title: string;
  demos: DemoEntry[];
  groups: DemoGroup[];
}

export interface DemoManifest {
  groups: DemoGroup[];
  standalone: DemoEntry[];
}

export interface ExcludedDemoReport {
  path: string;
  access: PenAccess | null;
}

export interface ScanDemosResult {
  manifest: DemoManifest;
  excludedDemos: ExcludedDemoReport[];
}

export interface ScanDemosOptions {
  /** Absolute realpaths of directories to skip (e.g. active build output directory). */
  excludeDirs?: ReadonlySet<string>;
  /** Optional Pen access filter; when omitted, all Pens are included (used by `cdpn serve`). */
  accessFilter?: AccessFilter;
}

type DemoReadResult =
  | { kind: 'none' }
  | { kind: 'excluded'; demo: ExcludedDemoReport }
  | { kind: 'included'; entry: DemoEntry };

function extractCdpnTags(rawTags: unknown): string[] {
  if (!Array.isArray(rawTags)) return [];
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const rawTag of rawTags) {
    if (typeof rawTag !== 'string') continue;
    const normalized = normalizePlainText(rawTag, 48);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(normalized);
    if (tags.length >= MAX_DEMO_TAGS) break;
  }
  return tags;
}

/**
 * Detects whether a directory looks like a previously built collection output
 * (contains `demos.json` + `index.html`, with neither `.cdpn.json` nor `.codepen/`).
 */
export async function isBuiltCollectionOutputDir(
  dirRealpath: string,
  rootRealpath: string,
): Promise<boolean> {
  const [hasDemosJson, hasIndexHtml, hasCdpnJson, hasCodepenDir] = await Promise.all([
    resolveSafeFile(path.join(dirRealpath, 'demos.json'), rootRealpath, dirRealpath),
    resolveSafeFile(path.join(dirRealpath, 'index.html'), rootRealpath, dirRealpath),
    resolveSafeFile(path.join(dirRealpath, PROJECT_CONFIG_FILENAME), rootRealpath, dirRealpath),
    resolveSafeDir(path.join(dirRealpath, CODEPEN_DIR), rootRealpath, dirRealpath),
  ]);
  return Boolean(hasDemosJson && hasIndexHtml && !hasCdpnJson && !hasCodepenDir);
}

async function readDemoEntry(
  segments: string[],
  demoRealpath: string,
  rootDir: string,
  rootRealpath: string,
  accessFilter?: AccessFilter,
): Promise<DemoReadResult> {
  const demoDir = path.resolve(rootDir, ...segments);
  const cdpnFile = await resolveSafeFile(
    path.join(demoDir, PROJECT_CONFIG_FILENAME),
    rootRealpath,
    rootDir,
  );
  if (!cdpnFile) {
    return { kind: 'none' };
  }

  let codepenUrl: string | null = null;
  let cdpnTitle: string | null = null;
  let cdpnDescription: string | null = null;
  let cdpnAccess: PenAccess | null = null;
  let tags: string[] = [];
  if (cdpnFile.size <= MAX_CDPN_JSON_BYTES) {
    try {
      const rawJson = await fs.readFile(cdpnFile.realPath, 'utf8');
      const parsed: unknown = JSON.parse(rawJson);
      if (isPlainObject(parsed)) {
        codepenUrl = sanitizeCodePenUrl(parsed.url);
        const info = isPlainObject(parsed.info) ? parsed.info : null;
        if (typeof info?.title === 'string') {
          cdpnTitle = normalizePlainText(info.title, 160);
        }
        if (typeof info?.description === 'string') {
          cdpnDescription = normalizePlainText(info.description, 320);
        }
        if (typeof info?.access === 'string') {
          cdpnAccess = parseAccessValue(info.access);
        }
        tags = extractCdpnTags(info?.tags);
      }
    } catch {
      codepenUrl = null;
      cdpnAccess = null;
      tags = [];
    }
  }

  const demoPath = `${segments.join('/')}/`;
  if (accessFilter && !matchesAccessFilter(cdpnAccess, accessFilter)) {
    return {
      kind: 'excluded',
      demo: {
        path: demoPath,
        access: cdpnAccess,
      },
    };
  }

  const codepenDir = await resolveSafeDir(path.join(demoDir, CODEPEN_DIR), rootRealpath, rootDir);
  const indexFile = await resolveSafeFile(path.join(demoDir, 'index.html'), rootRealpath, rootDir);

  let classicIndexFile: { realPath: string; size: number } | null = null;
  if (!indexFile && codepenDir) {
    const penBlocks = await readPenBlocks(demoRealpath, rootRealpath);
    if (penBlocks?.hasClassic) {
      classicIndexFile = await resolveSafeFile(
        path.join(demoDir, 'index.pen.html'),
        rootRealpath,
        rootDir,
      );
    }
  }

  let htmlTitle: string | null = null;
  let htmlDescription: string | null = null;
  if (indexFile) {
    try {
      const headHtml = await readPartialUtf8(indexFile.realPath, MAX_HTML_HEAD_BYTES);
      const rawTitle = extractHtmlTitle(headHtml);
      htmlTitle = rawTitle ? normalizePlainText(rawTitle, 160) : null;
      htmlDescription = extractMetaDescription(headHtml, 320);
    } catch {
      // Fall back to .cdpn.json or folder name when HTML metadata cannot be read
    }
  } else if (classicIndexFile) {
    try {
      const classicHead = await readClassicHeadMetadata(demoRealpath, rootRealpath);
      if (classicHead) {
        const rawTitle = extractHtmlTitle(classicHead);
        htmlTitle = rawTitle ? normalizePlainText(rawTitle, 160) : null;
        htmlDescription = extractMetaDescription(classicHead, 320);
      }
    } catch {
      // Fall back to .cdpn.json or folder name when classic config metadata cannot be read
    }
  }

  const lastSegment = segments.at(-1) ?? 'demo';

  return {
    kind: 'included',
    entry: {
      title: cdpnTitle ?? htmlTitle ?? formatFolderTitle(lastSegment),
      description: cdpnDescription ?? htmlDescription,
      tags,
      path: demoPath,
      href: `./${segments.map(encodeURIComponent).join('/')}/`,
      codepenUrl,
    },
  };
}

async function scanGroupNode(
  dirRealpath: string,
  segments: string[],
  depth: number,
  visitedRealpaths: Set<string>,
  rootDir: string,
  rootRealpath: string,
  excludeDirs: ReadonlySet<string>,
  ignoreMatchers: RegExp[],
  accessFilter: AccessFilter | undefined,
  excludedDemos: ExcludedDemoReport[],
): Promise<{ demos: DemoEntry[]; groups: DemoGroup[] }> {
  if (depth > MAX_SCAN_DEPTH) return { demos: [], groups: [] };

  let entries;
  try {
    entries = await fs.readdir(dirRealpath, { withFileTypes: true });
  } catch {
    return { demos: [], groups: [] };
  }

  const demos: DemoEntry[] = [];
  const groups: DemoGroup[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

    const childSegments = [...segments, entry.name];
    const relPosix = `/${childSegments.join('/')}`;
    if (ignoreMatchers.length > 0 && isIgnoredPath(relPosix, ignoreMatchers)) continue;

    const childCandidate = path.resolve(rootDir, ...childSegments);
    const childRealDir = await resolveSafeDir(childCandidate, rootRealpath, rootDir);
    if (!childRealDir || visitedRealpaths.has(childRealDir)) continue;
    if (excludeDirs.has(childRealDir)) continue;

    visitedRealpaths.add(childRealDir);

    // Skip previously built collection output folders (e.g. `./build/` or `./dist/` containing `demos.json` + `index.html`)
    if (await isBuiltCollectionOutputDir(childRealDir, rootRealpath)) {
      continue;
    }

    const demoResult = await readDemoEntry(
      childSegments,
      childRealDir,
      rootDir,
      rootRealpath,
      accessFilter,
    );
    if (demoResult.kind === 'included') {
      demos.push(demoResult.entry);
      continue;
    }
    if (demoResult.kind === 'excluded') {
      // Never recurse into an excluded Pen folder (Pen folders are always leaves).
      excludedDemos.push(demoResult.demo);
      continue;
    }

    const subNode = await scanGroupNode(
      childRealDir,
      childSegments,
      depth + 1,
      visitedRealpaths,
      rootDir,
      rootRealpath,
      excludeDirs,
      ignoreMatchers,
      accessFilter,
      excludedDemos,
    );
    if (subNode.demos.length > 0 || subNode.groups.length > 0) {
      groups.push({
        id: childSegments.join('/'),
        title: formatFolderTitle(entry.name),
        demos: subNode.demos,
        groups: subNode.groups,
      });
    }
  }

  return {
    demos: [...demos].sort((a, b) => compareNatural(a.path, b.path)),
    groups: [...groups].sort((a, b) => compareNatural(a.id, b.id)),
  };
}

/**
 * Recursively scans `rootDir` subdirectories for Pens/demos (folders containing `.cdpn.json`),
 * returning both the filtered manifest and any Pens excluded by `options.accessFilter`.
 */
export async function scanDemosDetailed(
  rootDir: string,
  options: ScanDemosOptions = {},
): Promise<ScanDemosResult> {
  const resolvedRoot = path.resolve(rootDir);
  const rootRealpath = await fs.realpath(resolvedRoot);
  const excludeDirs = options.excludeDirs ?? new Set<string>();
  const ignoreMatchers = await loadIgnoreMatchers(rootRealpath);
  const excludedDemos: ExcludedDemoReport[] = [];

  const visitedRealpaths = new Set<string>([rootRealpath]);
  const root = await scanGroupNode(
    rootRealpath,
    [],
    0,
    visitedRealpaths,
    resolvedRoot,
    rootRealpath,
    excludeDirs,
    ignoreMatchers,
    options.accessFilter,
    excludedDemos,
  );
  return {
    manifest: {
      groups: root.groups,
      standalone: root.demos,
    },
    excludedDemos: [...excludedDemos].sort((a, b) => compareNatural(a.path, b.path)),
  };
}

/**
 * Recursively scans `rootDir` subdirectories for Pens/demos (folders containing `.cdpn.json`).
 */
export async function scanDemos(
  rootDir: string,
  options: ScanDemosOptions = {},
): Promise<DemoManifest> {
  const { manifest } = await scanDemosDetailed(rootDir, options);
  return manifest;
}

function countGroupDemos(groups: DemoGroup[]): number {
  return groups.reduce(
    (total, group) => total + group.demos.length + countGroupDemos(group.groups ?? []),
    0,
  );
}

export function countDemos(manifest: DemoManifest): number {
  return (manifest.standalone?.length ?? 0) + countGroupDemos(manifest.groups ?? []);
}

export function serializeManifest(manifest: DemoManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export interface InMemoryManifestWatcher {
  getManifest: () => DemoManifest;
  getSerialized: () => string;
  close: () => void;
}

/**
 * Scans `rootDir` once and watches it to keep the demo manifest updated purely in memory
 * (without writing any files to disk).
 */
export async function createInMemoryManifestWatcher(options: {
  rootDir: string;
  excludeDirs?: ReadonlySet<string>;
  debounceMs?: number;
  onUpdate?: (result: { demoCount: number; manifest: DemoManifest }) => void;
  onError?: (error: Error) => void;
}): Promise<InMemoryManifestWatcher> {
  const { rootDir, excludeDirs, debounceMs = 150, onUpdate, onError } = options;
  let currentManifest = await scanDemos(rootDir, { excludeDirs });
  let currentSerialized = serializeManifest(currentManifest);

  const handle = createDebouncedWatcher({
    rootDir,
    debounceMs,
    onChange: async () => {
      const nextManifest = await scanDemos(rootDir, { excludeDirs });
      const nextSerialized = serializeManifest(nextManifest);
      if (nextSerialized !== currentSerialized) {
        currentManifest = nextManifest;
        currentSerialized = nextSerialized;
        onUpdate?.({ demoCount: countDemos(nextManifest), manifest: nextManifest });
      }
    },
    onError,
  });

  return {
    getManifest: () => currentManifest,
    getSerialized: () => currentSerialized,
    close: () => handle.close(),
  };
}
