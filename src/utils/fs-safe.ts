import fs from 'node:fs/promises';
import path from 'node:path';
import { isPlainObject } from './strings.js';

const DEFAULT_MAX_JSON_BYTES = 256 * 1024;
const utf8Decoder = new TextDecoder('utf-8');

export function isWithinRoot(candidatePath: string, rootPath: string): boolean {
  return candidatePath === rootPath || candidatePath.startsWith(rootPath + path.sep);
}

/**
 * Safely verifies that `candidatePath` is a regular (non-symlink) file whose resolved
 * and canonical paths both stay strictly inside `rootDir` / `rootRealpath`.
 */
export async function resolveSafeFile(
  candidatePath: string,
  rootRealpath: string,
  rootDir: string = rootRealpath,
): Promise<{ realPath: string; size: number } | null> {
  const resolved = path.resolve(candidatePath);
  if (!isWithinRoot(resolved, rootDir)) return null;

  let lstat;
  try {
    lstat = await fs.lstat(resolved);
  } catch {
    return null;
  }
  if (lstat.isSymbolicLink() || !lstat.isFile()) return null;

  try {
    const realPath = await fs.realpath(resolved);
    if (!isWithinRoot(realPath, rootRealpath)) return null;
    return { realPath, size: lstat.size };
  } catch {
    return null;
  }
}

/**
 * Safely verifies that `candidatePath` is a regular (non-symlink) directory whose resolved
 * and canonical paths both stay strictly inside `rootDir` / `rootRealpath`.
 */
export async function resolveSafeDir(
  candidatePath: string,
  rootRealpath: string,
  rootDir: string = rootRealpath,
): Promise<string | null> {
  const resolved = path.resolve(candidatePath);
  if (!isWithinRoot(resolved, rootDir)) return null;

  let lstat;
  try {
    lstat = await fs.lstat(resolved);
  } catch {
    return null;
  }
  if (lstat.isSymbolicLink() || !lstat.isDirectory()) return null;

  try {
    const realPath = await fs.realpath(resolved);
    if (!isWithinRoot(realPath, rootRealpath)) return null;
    return realPath;
  } catch {
    return null;
  }
}

export async function readSafeJsonObject(
  filePath: string,
  rootRealpath: string,
  maxBytes = DEFAULT_MAX_JSON_BYTES,
): Promise<Record<string, unknown> | null> {
  const file = await resolveSafeFile(filePath, rootRealpath);
  if (!file || file.size > maxBytes) return null;

  try {
    const raw = await fs.readFile(file.realPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function readPartialUtf8(filePath: string, maxBytes: number): Promise<string> {
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return utf8Decoder.decode(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

export async function fileExistsRegular(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(filePath);
    return !stat.isSymbolicLink() && stat.isFile();
  } catch {
    return false;
  }
}
