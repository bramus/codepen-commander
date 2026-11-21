import fs from 'node:fs/promises';
import path from 'node:path';
import { IGNORE_FILENAME } from '../constants.js';
import { isIgnoredPath, loadIgnoreMatchers } from '../sync/fs.js';

const GITIGNORE_FILENAME = '.gitignore';

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
