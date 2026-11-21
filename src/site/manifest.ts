import fs from 'node:fs/promises';
import { watch } from 'node:fs';
import path from 'node:path';
import { PROJECT_CONFIG_FILENAME } from '../config/project.js';
import { isIgnoredPath, loadIgnoreMatchers } from '../sync/fs.js';
import { extractHtmlTitle, extractMetaDescription } from '../utils/html.js';
import {
  CODEPEN_DIR,
  isWithinRoot,
  readClassicHeadMetadata,
  readPenBlocks,
  sanitizeCodePenUrl,
} from './blocks.js';

const MAX_SCAN_DEPTH = 4;
const MAX_HTML_HEAD_BYTES = 16 * 1024;
const MAX_CDPN_JSON_BYTES = 64 * 1024;
const MAX_DEMO_TAGS = 10;

const ACRONYMS = new Map<string, string>([
  ['ai', 'AI'],
  ['api', 'API'],
  ['apis', 'APIs'],
  ['aria', 'ARIA'],
  ['cls', 'CLS'],
  ['css', 'CSS'],
  ['cwv', 'CWV'],
  ['dom', 'DOM'],
  ['html', 'HTML'],
  ['http', 'HTTP'],
  ['inp', 'INP'],
  ['js', 'JS'],
  ['json', 'JSON'],
  ['lcp', 'LCP'],
  ['mcp', 'MCP'],
  ['pwa', 'PWA'],
  ['svg', 'SVG'],
  ['ui', 'UI'],
  ['url', 'URL'],
  ['ux', 'UX'],
  ['wasm', 'WASM'],
  ['webgl', 'WebGL'],
  ['webgpu', 'WebGPU'],
  ['webmcp', 'WebMCP'],
]);

const MINOR_WORDS = new Set([
  'a',
  'an',
  'and',
  'as',
  'at',
  'by',
  'for',
  'from',
  'in',
  'of',
  'on',
  'or',
  'the',
  'to',
  'with',
]);

const utf8Decoder = new TextDecoder('utf-8');

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

export interface ScanDemosOptions {
  /** Absolute realpaths of directories to skip (e.g. active build output directory). */
  excludeDirs?: ReadonlySet<string>;
}

function compareNatural(a: string, b: string): number {
  return a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });
}

export function formatFolderTitle(folderName: string): string {
  const words = folderName.split(/[-_]+/).filter(Boolean);
  return words
    .map((word, index) => {
      const lower = word.toLowerCase();
      const acronym = ACRONYMS.get(lower);
      if (acronym) {
        return acronym;
      }
      if (index > 0 && index < words.length - 1 && MINOR_WORDS.has(lower)) {
        return lower;
      }
      return (word[0]?.toUpperCase() ?? '') + word.slice(1);
    })
    .join(' ');
}

function normalizePlainText(value: unknown, maxLength: number): string | null {
  const cleaned = String(value).replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength - 1)}…` : cleaned;
}

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

async function readPartialUtf8(filePath: string, maxBytes: number): Promise<string> {
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return utf8Decoder.decode(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

async function resolveSafeRealFile(
  candidatePath: string,
  rootDir: string,
  rootRealpath: string,
): Promise<{ realPath: string; size: number } | null> {
  if (!isWithinRoot(candidatePath, rootDir)) return null;
  let lstat;
  try {
    lstat = await fs.lstat(candidatePath);
  } catch {
    return null;
  }
  if (lstat.isSymbolicLink() || !lstat.isFile()) return null;

  try {
    const realPath = await fs.realpath(candidatePath);
    if (!isWithinRoot(realPath, rootRealpath)) return null;
    return { realPath, size: lstat.size };
  } catch {
    return null;
  }
}

async function resolveSafeRealDir(
  candidatePath: string,
  rootDir: string,
  rootRealpath: string,
): Promise<string | null> {
  if (!isWithinRoot(candidatePath, rootDir)) return null;
  let lstat;
  try {
    lstat = await fs.lstat(candidatePath);
  } catch {
    return null;
  }
  if (lstat.isSymbolicLink() || !lstat.isDirectory()) return null;

  try {
    const realPath = await fs.realpath(candidatePath);
    if (!isWithinRoot(realPath, rootRealpath)) return null;
    return realPath;
  } catch {
    return null;
  }
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
    resolveSafeRealFile(path.join(dirRealpath, 'demos.json'), dirRealpath, rootRealpath),
    resolveSafeRealFile(path.join(dirRealpath, 'index.html'), dirRealpath, rootRealpath),
    resolveSafeRealFile(path.join(dirRealpath, PROJECT_CONFIG_FILENAME), dirRealpath, rootRealpath),
    resolveSafeRealDir(path.join(dirRealpath, CODEPEN_DIR), dirRealpath, rootRealpath),
  ]);
  return Boolean(hasDemosJson && hasIndexHtml && !hasCdpnJson && !hasCodepenDir);
}

async function readDemoEntry(
  segments: string[],
  demoRealpath: string,
  rootDir: string,
  rootRealpath: string,
): Promise<DemoEntry | null> {
  const demoDir = path.resolve(rootDir, ...segments);
  const cdpnFile = await resolveSafeRealFile(
    path.join(demoDir, PROJECT_CONFIG_FILENAME),
    rootDir,
    rootRealpath,
  );
  const codepenDir = await resolveSafeRealDir(
    path.join(demoDir, CODEPEN_DIR),
    rootDir,
    rootRealpath,
  );
  const indexFile = await resolveSafeRealFile(
    path.join(demoDir, 'index.html'),
    rootDir,
    rootRealpath,
  );

  let classicIndexFile: { realPath: string; size: number } | null = null;
  let hasUnsupportedBlocks = false;
  if (!indexFile && codepenDir) {
    const penBlocks = await readPenBlocks(demoRealpath, rootRealpath);
    if (penBlocks && penBlocks.unsupportedBlocks.length > 0) {
      hasUnsupportedBlocks = true;
    } else if (penBlocks?.hasClassic) {
      classicIndexFile = await resolveSafeRealFile(
        path.join(demoDir, 'index.pen.html'),
        rootDir,
        rootRealpath,
      );
    }
  }

  if (!cdpnFile && !codepenDir && !indexFile && !classicIndexFile && !hasUnsupportedBlocks) {
    return null;
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

  let codepenUrl: string | null = null;
  let cdpnTitle: string | null = null;
  let cdpnDescription: string | null = null;
  let tags: string[] = [];
  if (cdpnFile && cdpnFile.size <= MAX_CDPN_JSON_BYTES) {
    try {
      const rawJson = await fs.readFile(cdpnFile.realPath, 'utf8');
      const parsed = JSON.parse(rawJson) as Record<string, unknown>;
      codepenUrl = sanitizeCodePenUrl(parsed?.url);
      const info =
        parsed?.info && typeof parsed.info === 'object' && !Array.isArray(parsed.info)
          ? (parsed.info as Record<string, unknown>)
          : null;
      if (typeof info?.title === 'string') {
        cdpnTitle = normalizePlainText(info.title, 160);
      }
      if (typeof info?.description === 'string') {
        cdpnDescription = normalizePlainText(info.description, 320);
      }
      tags = extractCdpnTags(info?.tags);
    } catch {
      codepenUrl = null;
      tags = [];
    }
  }

  const lastSegment = segments.at(-1) ?? 'demo';

  return {
    title: cdpnTitle ?? htmlTitle ?? formatFolderTitle(lastSegment),
    description: cdpnDescription ?? htmlDescription,
    tags,
    path: `${segments.join('/')}/`,
    href: `./${segments.map(encodeURIComponent).join('/')}/`,
    codepenUrl,
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
    const childRealDir = await resolveSafeRealDir(childCandidate, rootDir, rootRealpath);
    if (!childRealDir || visitedRealpaths.has(childRealDir)) continue;
    if (excludeDirs.has(childRealDir)) continue;

    visitedRealpaths.add(childRealDir);

    // Skip previously built collection output folders (e.g. `./build/` or `./dist/` containing `demos.json` + `index.html`)
    if (await isBuiltCollectionOutputDir(childRealDir, rootRealpath)) {
      continue;
    }

    const demoEntry = await readDemoEntry(childSegments, childRealDir, rootDir, rootRealpath);
    if (demoEntry) {
      demos.push(demoEntry);
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
 * Recursively scans `rootDir` subdirectories for Pens/demos (folders containing `.cdpn.json`,
 * `.codepen/`, or `index.html`).
 */
export async function scanDemos(
  rootDir: string,
  options: ScanDemosOptions = {},
): Promise<DemoManifest> {
  const resolvedRoot = path.resolve(rootDir);
  const rootRealpath = await fs.realpath(resolvedRoot);
  const excludeDirs = options.excludeDirs ?? new Set<string>();
  const ignoreMatchers = await loadIgnoreMatchers(rootRealpath);

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
  );
  return {
    groups: root.groups,
    standalone: root.demos,
  };
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

function shouldIgnoreWatchEvent(rawFilename: string | Buffer | null): boolean {
  if (typeof rawFilename !== 'string' || !rawFilename) return false;
  const normalized = rawFilename.split(path.sep).join('/');
  const segments = normalized.split('/');
  const base = segments.at(-1);
  if (base === '.DS_Store') return true;
  if (segments.includes('node_modules') || segments.includes('.git')) return true;
  return false;
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

  let timer: ReturnType<typeof setTimeout> | null = null;
  let isScanning = false;
  let pendingScan = false;
  let closed = false;

  async function runScan(): Promise<void> {
    if (closed) return;
    if (isScanning) {
      pendingScan = true;
      return;
    }
    isScanning = true;
    try {
      const nextManifest = await scanDemos(rootDir, { excludeDirs });
      const nextSerialized = serializeManifest(nextManifest);
      if (nextSerialized !== currentSerialized) {
        currentManifest = nextManifest;
        currentSerialized = nextSerialized;
        onUpdate?.({ demoCount: countDemos(nextManifest), manifest: nextManifest });
      }
    } catch (error) {
      onError?.(error instanceof Error ? error : new Error(String(error)));
    } finally {
      isScanning = false;
      if (pendingScan && !closed) {
        pendingScan = false;
        scheduleScan();
      }
    }
  }

  function scheduleScan(): void {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void runScan();
    }, debounceMs);
  }

  let watcher: ReturnType<typeof watch> | null = null;
  try {
    watcher = watch(rootDir, { recursive: true }, (_eventType, filename) => {
      if (shouldIgnoreWatchEvent(filename)) return;
      scheduleScan();
    });
    watcher.on('error', (error) => {
      onError?.(error instanceof Error ? error : new Error(String(error)));
    });
  } catch (error) {
    // Graceful fallback on platforms where recursive fs.watch is unavailable
    onError?.(error instanceof Error ? error : new Error(String(error)));
  }

  return {
    getManifest: () => currentManifest,
    getSerialized: () => currentSerialized,
    close() {
      closed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      watcher?.close();
    },
  };
}
