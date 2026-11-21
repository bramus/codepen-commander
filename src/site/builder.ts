import fs from 'node:fs/promises';
import { existsSync, watch } from 'node:fs';
import path from 'node:path';
import { IGNORE_FILENAME, isIgnoredPath, loadIgnoreMatchers } from '../sync/fs.js';
import { CliError } from '../utils/json.js';
import {
  PEN_HTML_SUFFIX,
  applyPackagesBlock,
  compileClassicPenHtml,
  isWithinRoot,
  readPenBlocks,
  renderUnsupportedBlocksPage,
  type PenBlockContext,
} from './blocks.js';
import {
  classifyDirectoryMode,
  inspectTargetDirectory,
  type DirectoryInspection,
  type DirectoryMode,
} from './detect.js';
import {
  countDemos,
  isBuiltCollectionOutputDir,
  scanDemos,
  serializeManifest,
  type DemoManifest,
} from './manifest.js';
import {
  CORE_SHELL_FILES,
  expandHomePath,
  listShellAssetFiles,
  renderShellIndexHtml,
  resolveActiveShell,
  resolveSiteMetadata,
  type ResolvedShell,
  type SiteMetadataOverrides,
} from './shell.js';

export const DEFAULT_BUILD_DIR = 'build';
const GITIGNORE_FILENAME = '.gitignore';
const CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f]/;

/**
 * Common repository/package files at a collection root that are never part of the
 * deployed static demo site (still copied normally when inside an individual Pen folder).
 */
const COLLECTION_ROOT_EXCLUDED_FILES = new Set([
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'readme.md',
  'agents.md',
  'license',
  'license.md',
  'changelog.md',
  'tsconfig.json',
  'config.json',
  'config.json.example',
]);

export interface ResolvedBuildTarget {
  /** Absolute resolved output directory path. */
  outDir: string;
  /** Canonical path resolved through nearest existing ancestor (for safe containment checks). */
  canonicalOutDir: string;
  /** User-facing display label for prompts/logs. */
  displayPath: string;
  /** True when `outDir` already exists on disk. */
  exists: boolean;
  /** True when `outDir` resolves strictly inside `sourceRealpath`. */
  isInsideSource: boolean;
  /** POSIX relative path inside `sourceRealpath` when `isInsideSource` is true (e.g. `build` or `out/site`). */
  relInsideSource: string | null;
}

export interface UnsupportedDemoReport {
  path: string;
  blocks: string[];
}

export interface BuildProjectOptions {
  sourceDir: string;
  outDir: string;
  explicitShell?: string;
  site?: SiteMetadataOverrides;
  homeDir?: string;
  cwd?: string;
}

export interface BuildProjectResult {
  mode: DirectoryMode;
  sourceDir: string;
  outDir: string;
  demoCount: number;
  manifest: DemoManifest | null;
  shell: ResolvedShell | null;
  unsupportedDemos: UnsupportedDemoReport[];
  inspection: DirectoryInspection;
}

async function resolveCanonicalPathThroughExistingAncestor(targetPath: string): Promise<string> {
  const resolved = path.resolve(targetPath);
  const trailingSegments: string[] = [];
  let probe = resolved;

  for (;;) {
    try {
      const realProbe = await fs.realpath(probe);
      return trailingSegments.length > 0
        ? path.join(realProbe, ...trailingSegments.reverse())
        : realProbe;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        const parent = path.dirname(probe);
        if (parent === probe) {
          return resolved;
        }
        trailingSegments.push(path.basename(probe));
        probe = parent;
        continue;
      }
      throw error;
    }
  }
}

/**
 * Validates and resolves a build target directory relative to `sourceDir` (allowing
 * targets both inside and outside `sourceDir`, while forbidding `.`, ancestor dirs,
 * files, and symlinks).
 */
export async function resolveBuildTargetDir(
  rawTarget: string,
  sourceRealpath: string,
  options: { homeDir?: string } = {},
): Promise<{ ok: true; target: ResolvedBuildTarget } | { ok: false; error: string }> {
  const trimmed = rawTarget.trim();
  if (!trimmed) {
    return { ok: false, error: 'Output directory cannot be empty.' };
  }
  if (CONTROL_CHAR_PATTERN.test(trimmed)) {
    return { ok: false, error: 'Output directory cannot contain control characters.' };
  }

  const expanded = expandHomePath(trimmed, options.homeDir);
  const resolvedOut = path.resolve(sourceRealpath, expanded);

  let exists = false;
  try {
    const lstat = await fs.lstat(resolvedOut);
    if (lstat.isSymbolicLink()) {
      return {
        ok: false,
        error: `"${trimmed}" is a symbolic link. Please choose a regular directory.`,
      };
    }
    if (!lstat.isDirectory()) {
      return {
        ok: false,
        error: `"${trimmed}" already exists and is not a directory.`,
      };
    }
    exists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  // Also ensure no existing ancestor path component is a regular file or symlink loop
  let canonicalOutDir: string;
  try {
    canonicalOutDir = await resolveCanonicalPathThroughExistingAncestor(resolvedOut);
  } catch (error) {
    return { ok: false, error: `Cannot resolve "${trimmed}": ${(error as Error).message}` };
  }

  // Guard against wiping the source directory itself or any ancestor directory (e.g. `.`, `..`, `/`, `~`)
  if (canonicalOutDir === sourceRealpath) {
    return {
      ok: false,
      error: 'Output directory cannot be the same as the source directory.',
    };
  }
  if (sourceRealpath.startsWith(canonicalOutDir + path.sep)) {
    return {
      ok: false,
      error: 'Output directory cannot be a parent/ancestor of the source directory.',
    };
  }

  const isInsideSource = canonicalOutDir.startsWith(sourceRealpath + path.sep);
  let relInsideSource: string | null = null;
  if (isInsideSource) {
    const rel = path.relative(sourceRealpath, canonicalOutDir);
    const segments = rel.split(path.sep).filter(Boolean);
    if (segments.some((s) => s.startsWith('.'))) {
      return {
        ok: false,
        error: 'Output directory inside the project cannot use hidden folder segments.',
      };
    }
    relInsideSource = segments.join('/');
  }

  return {
    ok: true,
    target: {
      outDir: resolvedOut,
      canonicalOutDir,
      displayPath: trimmed,
      exists,
      isInsideSource,
      relInsideSource,
    },
  };
}

/**
 * Ensures `relInsideSource` (e.g. `build`) is ignored by `<penDir>/.cdpnignore`,
 * appending cleanly without duplicating existing rules or clobbering existing entries.
 */
export async function ensureIgnoredInCdpnIgnore(
  penDir: string,
  relInsideSource: string,
): Promise<{ updated: boolean; created: boolean; alreadyIgnored: boolean; entry: string }> {
  const normalizedRel = relInsideSource.replace(/^\/+/, '').replace(/\/+$/, '');
  const entry = `${normalizedRel}/`;
  const ignorePath = path.join(path.resolve(penDir), IGNORE_FILENAME);

  const matchers = await loadIgnoreMatchers(penDir);
  if (
    isIgnoredPath(`/${normalizedRel}`, matchers) &&
    isIgnoredPath(`/${normalizedRel}/index.html`, matchers)
  ) {
    return { updated: false, created: false, alreadyIgnored: true, entry };
  }

  let existing: string | null = null;
  try {
    existing = await fs.readFile(ignorePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  if (existing === null) {
    await fs.writeFile(ignorePath, `${entry}\n`, 'utf8');
    return { updated: true, created: true, alreadyIgnored: false, entry };
  }

  const separator = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
  await fs.writeFile(ignorePath, `${existing}${separator}${entry}\n`, 'utf8');
  return { updated: true, created: false, alreadyIgnored: false, entry };
}

export async function inspectGitIgnoreStatus(
  dir: string,
  relInsideSource: string,
): Promise<{ exists: boolean; alreadyIgnored: boolean; entry: string; filePath: string }> {
  const normalizedRel = relInsideSource.replace(/^\/+/, '').replace(/\/+$/, '');
  const entry = `${normalizedRel}/`;
  const filePath = path.join(path.resolve(dir), GITIGNORE_FILENAME);

  let raw: string | null = null;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  if (raw === null) {
    return { exists: false, alreadyIgnored: false, entry, filePath };
  }

  const targetCandidates = new Set([
    normalizedRel,
    `/${normalizedRel}`,
    `${normalizedRel}/`,
    `/${normalizedRel}/`,
    `${normalizedRel}/*`,
    `/${normalizedRel}/*`,
  ]);
  const topSegment = normalizedRel.split('/')[0];
  if (topSegment && topSegment !== normalizedRel) {
    targetCandidates.add(topSegment);
    targetCandidates.add(`/${topSegment}`);
    targetCandidates.add(`${topSegment}/`);
    targetCandidates.add(`/${topSegment}/`);
  }

  const alreadyIgnored = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((line) => line && !line.startsWith('#') && targetCandidates.has(line));

  return { exists: true, alreadyIgnored, entry, filePath };
}

/**
 * Creates a `.gitignore` or appends `relInsideSource/` to an existing `.gitignore`.
 */
export async function updateGitIgnore(
  dir: string,
  relInsideSource: string,
): Promise<{ updated: boolean; created: boolean; entry: string; filePath: string }> {
  const status = await inspectGitIgnoreStatus(dir, relInsideSource);
  if (status.alreadyIgnored) {
    return { updated: false, created: false, entry: status.entry, filePath: status.filePath };
  }

  if (!status.exists) {
    const content = ['# OS', '.DS_Store', 'Thumbs.db', '', '# Build output', status.entry, ''].join(
      '\n',
    );
    await fs.writeFile(status.filePath, content, 'utf8');
    return { updated: true, created: true, entry: status.entry, filePath: status.filePath };
  }

  const existing = await fs.readFile(status.filePath, 'utf8');
  const separator = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
  await fs.writeFile(status.filePath, `${existing}${separator}${status.entry}\n`, 'utf8');
  return { updated: true, created: false, entry: status.entry, filePath: status.filePath };
}

function collectManifestDirSets(
  manifest: DemoManifest,
  rootRealpath: string,
): { demoDirs: Set<string>; groupDirs: Set<string> } {
  const demoDirs = new Set<string>();
  const groupDirs = new Set<string>();

  const registerDemo = (relPathWithSlash: string) => {
    const segments = relPathWithSlash.replace(/\/+$/, '').split('/').filter(Boolean);
    if (segments.length === 0) return;
    const demoAbs = path.resolve(rootRealpath, ...segments);
    demoDirs.add(demoAbs);
    for (let i = 1; i < segments.length; i++) {
      groupDirs.add(path.resolve(rootRealpath, ...segments.slice(0, i)));
    }
  };

  const walkGroups = (groups: DemoManifest['groups']) => {
    for (const group of groups) {
      for (const demo of group.demos) {
        registerDemo(demo.path);
      }
      if (group.groups.length > 0) {
        walkGroups(group.groups);
      }
    }
  };

  for (const demo of manifest.standalone) {
    registerDemo(demo.path);
  }
  walkGroups(manifest.groups);

  return { demoDirs, groupDirs };
}

async function copyDirectoryTree(options: {
  currentSrcDir: string;
  currentDestDir: string;
  rootRealpath: string;
  excludedRealpaths: ReadonlySet<string>;
  isCollectionRootLevel: boolean;
  mode: DirectoryMode;
  insideDemo: boolean;
  allowedDemoDirs: ReadonlySet<string> | null;
  allowedGroupDirs: ReadonlySet<string> | null;
  inheritedPenContext: PenBlockContext | null;
  activeIgnoreRoot: string | null;
  activeIgnoreMatchers: RegExp[];
  unsupportedDemos: UnsupportedDemoReport[];
}): Promise<void> {
  const {
    currentSrcDir,
    currentDestDir,
    rootRealpath,
    excludedRealpaths,
    isCollectionRootLevel,
    mode,
    insideDemo,
    allowedDemoDirs,
    allowedGroupDirs,
    inheritedPenContext,
    unsupportedDemos,
  } = options;

  const localPenContext = await readPenBlocks(currentSrcDir, rootRealpath);
  const penContext = localPenContext ?? inheritedPenContext;

  if (localPenContext && localPenContext.unsupportedBlocks.length > 0) {
    const relFromRoot = path.relative(rootRealpath, currentSrcDir);
    const relSegments = relFromRoot ? relFromRoot.split(path.sep).filter(Boolean) : [];
    const demoRelPath =
      relSegments.length > 0 ? `${relSegments.join('/')}/` : `${path.basename(currentSrcDir)}/`;

    unsupportedDemos.push({
      path: demoRelPath,
      blocks: localPenContext.unsupportedBlocks,
    });

    const homeHref =
      mode === 'collection' && relSegments.length > 0 ? '../'.repeat(relSegments.length) : null;
    const { html } = await renderUnsupportedBlocksPage({
      penContext: localPenContext,
      rootRealpath,
      demoRelPath,
      homeHref,
    });
    await fs.writeFile(path.join(currentDestDir, 'index.html'), html, 'utf8');
    return;
  }

  // Load local `.cdpnignore` when entering the root or a Pen folder
  let activeIgnoreRoot = options.activeIgnoreRoot;
  let activeIgnoreMatchers = options.activeIgnoreMatchers;
  const localMatchers = await loadIgnoreMatchers(currentSrcDir);
  if (localMatchers.length > 0) {
    activeIgnoreRoot = currentSrcDir;
    activeIgnoreMatchers = localMatchers;
  }

  const entries = await fs.readdir(currentSrcDir, { withFileTypes: true });
  const existingNamesLower = new Set(entries.map((entry) => entry.name.toLowerCase()));

  for (const entry of entries) {
    // Skip dotfiles/dotdirs (.cdpn.json, .cdpnignore, .codepen, .git, .DS_Store, .env, etc.) and node_modules
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

    // In collection mode at root level, skip stale demos.json and unrelated repo/package metadata files
    if (isCollectionRootLevel) {
      const lower = entry.name.toLowerCase();
      if (lower === 'demos.json' || COLLECTION_ROOT_EXCLUDED_FILES.has(lower)) {
        continue;
      }
    }

    const srcPath = path.join(currentSrcDir, entry.name);
    const destPath = path.join(currentDestDir, entry.name);

    let lstat;
    try {
      lstat = await fs.lstat(srcPath);
    } catch {
      continue;
    }

    if (lstat.isSymbolicLink()) continue;

    const realSrcPath = await fs.realpath(srcPath);
    if (!isWithinRoot(realSrcPath, rootRealpath)) continue;
    if (excludedRealpaths.has(realSrcPath)) continue;

    if (activeIgnoreRoot && activeIgnoreMatchers.length > 0) {
      const relFromIgnore = path.relative(activeIgnoreRoot, realSrcPath);
      if (relFromIgnore && !relFromIgnore.startsWith('..')) {
        const penPosix = `/${relFromIgnore.split(path.sep).join('/')}`;
        if (isIgnoredPath(penPosix, activeIgnoreMatchers)) {
          continue;
        }
      }
    }

    if (lstat.isDirectory()) {
      let nextInsideDemo = insideDemo;
      if (mode === 'collection' && !insideDemo) {
        if (await isBuiltCollectionOutputDir(realSrcPath, rootRealpath)) {
          continue;
        }
        const isAllowedDemo = Boolean(allowedDemoDirs?.has(realSrcPath));
        const isAllowedGroup = Boolean(allowedGroupDirs?.has(realSrcPath));
        if (!isAllowedDemo && !isAllowedGroup) {
          continue;
        }
        if (isAllowedDemo) {
          nextInsideDemo = true;
        }
      }
      await fs.mkdir(destPath, { recursive: true });
      await copyDirectoryTree({
        currentSrcDir: realSrcPath,
        currentDestDir: destPath,
        rootRealpath,
        excludedRealpaths,
        isCollectionRootLevel: false,
        mode,
        insideDemo: nextInsideDemo,
        allowedDemoDirs,
        allowedGroupDirs,
        inheritedPenContext: penContext,
        activeIgnoreRoot,
        activeIgnoreMatchers,
        unsupportedDemos,
      });
    } else if (lstat.isFile()) {
      // In collection mode, skip stray files sitting inside group folders outside any `.cdpn.json` demo
      if (mode === 'collection' && !isCollectionRootLevel && !insideDemo) {
        continue;
      }

      const lowerName = entry.name.toLowerCase();

      if (penContext?.hasClassic && lowerName.endsWith(PEN_HTML_SUFFIX)) {
        const outName = `${entry.name.slice(0, -PEN_HTML_SUFFIX.length)}.html`;
        if (!existingNamesLower.has(outName.toLowerCase())) {
          const compiledHtml = await compileClassicPenHtml({
            penHtmlPath: realSrcPath,
            penContext,
            rootRealpath,
          });
          if (compiledHtml !== null) {
            await fs.writeFile(path.join(currentDestDir, outName), compiledHtml, 'utf8');
          }
        }
        continue;
      }

      if (
        penContext?.hasPackages &&
        lowerName.endsWith('.html') &&
        !lowerName.endsWith(PEN_HTML_SUFFIX)
      ) {
        const rawHtml = await fs.readFile(realSrcPath, 'utf8');
        const transformedHtml = await applyPackagesBlock({
          html: rawHtml,
          penContext,
          rootRealpath,
        });
        await fs.writeFile(destPath, transformedHtml, 'utf8');
        continue;
      }

      await fs.copyFile(realSrcPath, destPath);
    }
  }
}

/**
 * Builds a single Pen (`.cdpn.json`) or collection directory into `outDir`.
 */
export async function buildProject(options: BuildProjectOptions): Promise<BuildProjectResult> {
  const baseCwd = path.resolve(options.cwd ?? process.cwd());
  const resolvedSource = path.resolve(baseCwd, options.sourceDir);

  let sourceStat;
  try {
    sourceStat = await fs.stat(resolvedSource);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new CliError(404, `Source directory not found: ${resolvedSource}`);
    }
    throw error;
  }
  if (!sourceStat.isDirectory()) {
    throw new CliError(400, `Source path is not a directory: ${resolvedSource}`);
  }

  const inspection = await inspectTargetDirectory(resolvedSource);
  const targetValidation = await resolveBuildTargetDir(options.outDir, inspection.rootRealpath, {
    homeDir: options.homeDir,
  });
  if (!targetValidation.ok) {
    throw new CliError(400, targetValidation.error);
  }

  const { outDir, canonicalOutDir } = targetValidation.target;
  const excludedRealpaths = new Set<string>([canonicalOutDir]);
  const mode = classifyDirectoryMode(inspection);

  let preScannedManifest: DemoManifest | null = null;
  let allowedDemoDirs: Set<string> | null = null;
  let allowedGroupDirs: Set<string> | null = null;
  if (mode === 'collection') {
    preScannedManifest = await scanDemos(inspection.rootRealpath, {
      excludeDirs: excludedRealpaths,
    });
    const sets = collectManifestDirSets(preScannedManifest, inspection.rootRealpath);
    allowedDemoDirs = sets.demoDirs;
    allowedGroupDirs = sets.groupDirs;
  }

  // In single-Pen mode, fail loudly when unsupported CodePen blocks are active
  if (mode === 'pen' && inspection.penBlocks && inspection.penBlocks.unsupportedBlocks.length > 0) {
    const list = inspection.penBlocks.unsupportedBlocks.join(', ');
    throw new CliError(
      422,
      `Cannot build this Pen locally because it uses unsupported CodePen block(s): ${list}.`,
      { unsupported_blocks: inspection.penBlocks.unsupportedBlocks },
    );
  }

  let activeShell: ResolvedShell | null = null;
  if (mode === 'collection') {
    activeShell = await resolveActiveShell({
      explicitShell: options.explicitShell,
      cwd: baseCwd,
      homeDir: options.homeDir,
    });
  } else if (options.explicitShell !== undefined) {
    await resolveActiveShell({
      explicitShell: options.explicitShell,
      cwd: baseCwd,
      homeDir: options.homeDir,
    });
  }

  // Wipe and recreate target output directory
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });

  const realOutDir = await fs.realpath(outDir);
  excludedRealpaths.add(realOutDir);

  const unsupportedDemos: UnsupportedDemoReport[] = [];

  await copyDirectoryTree({
    currentSrcDir: inspection.rootRealpath,
    currentDestDir: realOutDir,
    rootRealpath: inspection.rootRealpath,
    excludedRealpaths,
    isCollectionRootLevel: mode === 'collection',
    mode,
    insideDemo: mode === 'pen',
    allowedDemoDirs,
    allowedGroupDirs,
    inheritedPenContext: null,
    activeIgnoreRoot: null,
    activeIgnoreMatchers: [],
    unsupportedDemos,
  });

  let finalManifest: DemoManifest | null = null;
  let demoCount = mode === 'collection' ? 0 : 1;

  if (mode === 'collection' && activeShell) {
    const siteMeta = resolveSiteMetadata(inspection.rootRealpath, options.site);

    // Layer custom/active shell assets wherever the source directory did not override them
    const primaryFiles = await listShellAssetFiles(activeShell.realpath);
    for (const relPosix of primaryFiles) {
      const destPath = path.join(realOutDir, ...relPosix.split('/'));
      if (!isWithinRoot(destPath, realOutDir)) continue;
      if (existsSync(destPath)) continue;

      const srcPath = path.join(activeShell.realpath, ...relPosix.split('/'));
      await fs.mkdir(path.dirname(destPath), { recursive: true });
      if (relPosix === 'index.html') {
        const templateHtml = await fs.readFile(srcPath, 'utf8');
        await fs.writeFile(
          destPath,
          renderShellIndexHtml(templateHtml, siteMeta, { includeMissingDemoWarning: false }),
          'utf8',
        );
      } else {
        await fs.copyFile(srcPath, destPath);
      }
    }

    // Fall back to built-in shell for any missing core files (supports partial custom shells)
    if (activeShell.source !== 'builtin') {
      for (const filename of CORE_SHELL_FILES) {
        const destPath = path.join(realOutDir, filename);
        if (existsSync(destPath)) continue;
        const builtinPath = path.join(activeShell.builtinRealpath, filename);
        if (!existsSync(builtinPath)) continue;
        if (filename === 'index.html') {
          const templateHtml = await fs.readFile(builtinPath, 'utf8');
          await fs.writeFile(
            destPath,
            renderShellIndexHtml(templateHtml, siteMeta, { includeMissingDemoWarning: false }),
            'utf8',
          );
        } else {
          await fs.copyFile(builtinPath, destPath);
        }
      }
    }

    // Generate fresh demos.json in outDir
    finalManifest = preScannedManifest ?? (await scanDemos(inspection.rootRealpath, { excludeDirs: excludedRealpaths }));
    demoCount = countDemos(finalManifest);
    await fs.writeFile(path.join(realOutDir, 'demos.json'), serializeManifest(finalManifest), 'utf8');
  }

  return {
    mode,
    sourceDir: inspection.rootRealpath,
    outDir: realOutDir,
    demoCount,
    manifest: finalManifest,
    shell: activeShell,
    unsupportedDemos,
    inspection,
  };
}

export function watchBuild(options: {
  buildOptions: BuildProjectOptions;
  canonicalOutDir: string;
  debounceMs?: number;
  onRebuild?: (result: BuildProjectResult) => void;
  onError?: (error: Error) => void;
}): { close: () => void } {
  const { buildOptions, canonicalOutDir, debounceMs = 200, onRebuild, onError } = options;
  const resolvedSource = path.resolve(buildOptions.cwd ?? process.cwd(), buildOptions.sourceDir);

  let timer: ReturnType<typeof setTimeout> | null = null;
  let isBuilding = false;
  let pendingRebuild = false;
  let closed = false;

  async function runBuild(): Promise<void> {
    if (closed) return;
    if (isBuilding) {
      pendingRebuild = true;
      return;
    }
    isBuilding = true;
    try {
      const result = await buildProject(buildOptions);
      onRebuild?.(result);
    } catch (error) {
      onError?.(error instanceof Error ? error : new Error(String(error)));
    } finally {
      isBuilding = false;
      if (pendingRebuild && !closed) {
        pendingRebuild = false;
        scheduleBuild();
      }
    }
  }

  function scheduleBuild(): void {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void runBuild();
    }, debounceMs);
  }

  const watcher = watch(resolvedSource, { recursive: true }, (_eventType, filename) => {
    if (typeof filename === 'string' && filename) {
      const candidate = path.resolve(resolvedSource, filename);
      if (isWithinRoot(candidate, canonicalOutDir)) return;
      const normalized = filename.split(path.sep).join('/');
      const segments = normalized.split('/');
      if (segments.at(-1) === '.DS_Store') return;
      if (segments.includes('node_modules') || segments.includes('.git')) return;
    }
    scheduleBuild();
  });

  watcher.on('error', (error) => {
    onError?.(error instanceof Error ? error : new Error(String(error)));
  });

  return {
    close() {
      closed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      watcher.close();
    },
  };
}
