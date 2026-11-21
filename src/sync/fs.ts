import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  IGNORE_FILENAME,
  MAX_FILE_BYTES,
  PROJECT_CONFIG_FILENAME,
} from '../constants.js';
import { CliError } from '../errors.js';
import { isWithinRoot } from '../utils/fs-safe.js';
import { hasControlChars } from '../utils/strings.js';

export { IGNORE_FILENAME };

const BUILTIN_IGNORED_SEGMENTS = new Set([
  PROJECT_CONFIG_FILENAME,
  IGNORE_FILENAME,
  '.git',
  '.svn',
  '.hg',
  'node_modules',
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
]);

export interface LocalFile {
  /** Normalized Pen path with leading `/`, e.g. `/src/app.js`. */
  path: string;
  absolutePath: string;
  buffer: Buffer;
  isBinary: boolean;
  sha256: string;
  textContent: string | null;
}

export function sha256Hex(content: Buffer | string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Determines whether a Buffer should be treated as binary.
 * Checks for NUL bytes and validates strict UTF-8 decoding.
 */
export function isBinaryBuffer(buffer: Buffer): boolean {
  if (buffer.length === 0) return false;

  const sampleLength = Math.min(buffer.length, 8192);
  for (let i = 0; i < sampleLength; i++) {
    if (buffer[i] === 0) return true;
  }

  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return false;
  } catch {
    return true;
  }
}

/**
 * Validates and normalizes a CodePen file path into a safe leading-slash POSIX path (e.g. `/src/app.js`).
 * Rejects path traversal segments, backslashes, NUL bytes, Windows drive letters, and reserved CLI files.
 */
export function normalizePenPath(rawPath: string): string {
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    throw new CliError(400, 'File path cannot be empty.');
  }
  if (hasControlChars(rawPath)) {
    throw new CliError(400, `Invalid control character in file path: ${JSON.stringify(rawPath)}`);
  }
  if (rawPath.includes('\\')) {
    throw new CliError(400, `Backslashes are not allowed in Pen file paths: ${rawPath}`);
  }
  if (/^[A-Za-z]:/.test(rawPath)) {
    throw new CliError(400, `Drive-letter paths are not allowed: ${rawPath}`);
  }

  const trimmed = rawPath.replace(/^\/+/, '');
  if (!trimmed) {
    throw new CliError(400, `Invalid empty Pen file path: ${rawPath}`);
  }

  const segments = trimmed.split('/');
  for (const seg of segments) {
    if (!seg || seg === '.' || seg === '..') {
      throw new CliError(400, `Unsafe path segment in Pen file path: ${rawPath}`);
    }
  }

  const normalized = `/${segments.join('/')}`;
  if (segments[0] === PROJECT_CONFIG_FILENAME || segments[0] === '.git') {
    throw new CliError(400, `Refusing to touch reserved path: ${normalized}`);
  }

  return normalized;
}

/**
 * Safely resolves a CodePen file path inside `rootDir` and enforces strict directory boundary containment.
 */
export function resolveSafeLocalPath(rootDir: string, penPath: string): string {
  const normalizedPenPath = normalizePenPath(penPath);
  const resolvedRoot = path.resolve(rootDir);
  const relative = normalizedPenPath.slice(1).split('/').join(path.sep);
  const resolvedTarget = path.resolve(resolvedRoot, relative);

  if (!isWithinRoot(resolvedTarget, resolvedRoot)) {
    throw new CliError(400, `Path escapes project root boundary: ${penPath}`);
  }

  return resolvedTarget;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compileIgnorePattern(pattern: string): RegExp | null {
  const trimmed = pattern.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;

  const normalized = trimmed.replace(/^\/+/, '').replace(/\/+$/, '');
  if (!normalized) return null;

  const hasSlash = normalized.includes('/');
  const regexBody = normalized
    .split('**')
    .map((part) => part.split('*').map(escapeRegex).join('[^/]*'))
    .join('.*');

  if (hasSlash) {
    return new RegExp(`^/${regexBody}(?:/.*)?$`);
  }
  return new RegExp(`(?:^|/)${regexBody}(?:/.*)?$`);
}

export async function loadIgnoreMatchers(rootDir: string): Promise<RegExp[]> {
  const ignorePath = path.join(path.resolve(rootDir), IGNORE_FILENAME);
  try {
    const raw = await fs.readFile(ignorePath, 'utf8');
    const matchers: RegExp[] = [];
    for (const line of raw.split(/\r?\n/)) {
      const compiled = compileIgnorePattern(line);
      if (compiled) matchers.push(compiled);
    }
    return matchers;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

export function isIgnoredPath(penPath: string, customMatchers: RegExp[]): boolean {
  const segments = penPath.replace(/^\/+/, '').split('/');
  for (const seg of segments) {
    if (BUILTIN_IGNORED_SEGMENTS.has(seg)) {
      return true;
    }
  }
  return customMatchers.some((regex) => regex.test(penPath));
}

/**
 * Recursively scans a local Pen directory and returns all non-ignored regular files.
 * Symlinks are intentionally skipped to prevent reading files outside the Pen directory.
 */
export async function scanLocalFiles(rootDir: string): Promise<Map<string, LocalFile>> {
  const resolvedRoot = path.resolve(rootDir);
  const customMatchers = await loadIgnoreMatchers(resolvedRoot);
  const results = new Map<string, LocalFile>();

  async function walk(currentDir: string, relativePrefix: string): Promise<void> {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (BUILTIN_IGNORED_SEGMENTS.has(entry.name)) {
        continue;
      }

      const penPath = relativePrefix ? `${relativePrefix}/${entry.name}` : `/${entry.name}`;
      if (isIgnoredPath(penPath, customMatchers)) {
        continue;
      }

      const fullPath = path.join(currentDir, entry.name);
      if (!isWithinRoot(fullPath, resolvedRoot)) {
        continue;
      }

      const stat = await fs.lstat(fullPath);
      if (stat.isSymbolicLink()) {
        // Skip symlinks so files outside the Pen folder are never leaked/uploaded
        continue;
      }

      if (stat.isDirectory()) {
        await walk(fullPath, penPath);
      } else if (stat.isFile()) {
        if (stat.size > MAX_FILE_BYTES) {
          throw new CliError(
            400,
            `Local file ${penPath} is ${Math.round(stat.size / (1024 * 1024))} MB, exceeding CodePen's 30 MB per-file limit.`,
          );
        }
        const buffer = await fs.readFile(fullPath);
        const binary = isBinaryBuffer(buffer);
        results.set(penPath, {
          path: penPath,
          absolutePath: fullPath,
          buffer,
          isBinary: binary,
          sha256: sha256Hex(buffer),
          textContent: binary ? null : buffer.toString('utf8'),
        });
      }
    }
  }

  await walk(resolvedRoot, '');
  return results;
}

async function assertNoSymlinksInRelativePath(rootDir: string, penPath: string): Promise<void> {
  const resolvedRoot = path.resolve(rootDir);
  const segments = normalizePenPath(penPath).slice(1).split('/');
  let current = resolvedRoot;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) {
        throw new CliError(400, `Refusing to write through symlink at ${penPath}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw error;
    }
  }
}

export async function writeLocalFile(
  rootDir: string,
  penPath: string,
  content: Buffer | string,
): Promise<string> {
  const targetPath = resolveSafeLocalPath(rootDir, penPath);
  await assertNoSymlinksInRelativePath(rootDir, penPath);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, content);
  return targetPath;
}

export async function deleteLocalFile(rootDir: string, penPath: string): Promise<void> {
  const targetPath = resolveSafeLocalPath(rootDir, penPath);
  await assertNoSymlinksInRelativePath(rootDir, penPath);
  try {
    await fs.unlink(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  await pruneEmptyDirs(rootDir, path.dirname(targetPath));
}

export async function pruneEmptyDirs(rootDir: string, startDir: string): Promise<void> {
  const resolvedRoot = path.resolve(rootDir);
  let current = path.resolve(startDir);

  while (current !== resolvedRoot && isWithinRoot(current, resolvedRoot)) {
    try {
      const entries = await fs.readdir(current);
      if (entries.length > 0) {
        return;
      }
      await fs.rmdir(current);
      current = path.dirname(current);
    } catch {
      return;
    }
  }
}

export async function isDirectoryNonEmpty(dirPath: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(dirPath);
    return entries.length > 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}
