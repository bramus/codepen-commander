import type { PenFile, SyncedFileEntry } from '../types.js';
import type { LocalFile } from './fs.js';

export interface DiffItem {
  path: string;
  local?: LocalFile;
  remote?: PenFile;
}

export interface SyncDiff {
  added: DiffItem[];
  modified: DiffItem[];
  deleted: DiffItem[];
  unchanged: DiffItem[];
}

export interface ComputeDiffOptions {
  localFiles: Map<string, LocalFile>;
  remoteFiles: PenFile[];
  baseline?: Record<string, SyncedFileEntry>;
  downloadFile?: (downloadUrl: string) => Promise<Buffer>;
}

function normalizeRemotePath(p: string): string {
  return p.startsWith('/') ? p : `/${p}`;
}

/**
 * Compares local files against the remote Pen's saved head files.
 * - `added`: exists locally, not on remote (push will create)
 * - `modified`: exists on both, content differs (push will overwrite)
 * - `deleted`: exists on remote, missing locally (push will delete)
 * - `unchanged`: identical on local and remote
 */
export async function computeSyncDiff(options: ComputeDiffOptions): Promise<SyncDiff> {
  const { localFiles, remoteFiles, baseline, downloadFile } = options;

  const remoteByPath = new Map<string, PenFile>();
  for (const rf of remoteFiles) {
    remoteByPath.set(normalizeRemotePath(rf.path), rf);
  }

  const added: DiffItem[] = [];
  const modified: DiffItem[] = [];
  const deleted: DiffItem[] = [];
  const unchanged: DiffItem[] = [];

  const sortedLocalPaths = [...localFiles.keys()].sort();
  for (const filePath of sortedLocalPaths) {
    const local = localFiles.get(filePath)!;
    const remote = remoteByPath.get(filePath);

    if (!remote) {
      added.push({ path: filePath, local });
      continue;
    }

    const same = await areFilesIdentical(local, remote, baseline?.[filePath], downloadFile);
    if (same) {
      unchanged.push({ path: filePath, local, remote });
    } else {
      modified.push({ path: filePath, local, remote });
    }
  }

  const sortedRemotePaths = [...remoteByPath.keys()].sort();
  for (const filePath of sortedRemotePaths) {
    if (!localFiles.has(filePath)) {
      const remote = remoteByPath.get(filePath)!;
      deleted.push({ path: filePath, remote });
    }
  }

  return { added, modified, deleted, unchanged };
}

async function areFilesIdentical(
  local: LocalFile,
  remote: PenFile,
  baselineEntry: SyncedFileEntry | undefined,
  downloadFile?: (downloadUrl: string) => Promise<Buffer>,
): Promise<boolean> {
  // Fast, exact comparison for UTF-8 text files
  if (!remote.is_binary && !local.isBinary && remote.content !== null && local.textContent !== null) {
    return local.textContent === remote.content;
  }

  // Binary comparison:
  // 1. Direct SHA-256 match against remote content_hash
  if (local.sha256 === remote.content_hash) {
    return true;
  }

  // 2. Baseline match from .cdpn.json (covers cases where remote uses a non-raw-SHA256 hash)
  if (
    baselineEntry &&
    baselineEntry.content_hash === remote.content_hash &&
    baselineEntry.local_sha256 === local.sha256
  ) {
    return true;
  }

  // 3. Different byte lengths definitely mean modified
  if (local.buffer.length !== remote.bytes) {
    return false;
  }

  // 4. Fallback exact byte comparison via signed download_url when available
  if (remote.download_url && downloadFile) {
    const remoteBytes = await downloadFile(remote.download_url);
    return Buffer.compare(local.buffer, remoteBytes) === 0;
  }

  return false;
}

export function hasDiffChanges(diff: SyncDiff): boolean {
  return diff.added.length > 0 || diff.modified.length > 0 || diff.deleted.length > 0;
}

/**
 * Checks whether local files have been modified/added/deleted relative to the `.cdpn.json` baseline.
 * Used before `cdpn pull` to warn before clobbering uncommitted local edits.
 */
export function detectLocalChangesFromBaseline(
  localFiles: Map<string, LocalFile>,
  baseline: Record<string, SyncedFileEntry> | undefined,
): { added: string[]; modified: string[]; deleted: string[] } {
  if (!baseline) {
    return { added: [...localFiles.keys()].sort(), modified: [], deleted: [] };
  }

  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];

  for (const [filePath, local] of localFiles) {
    const base = baseline[filePath];
    if (!base) {
      added.push(filePath);
    } else if (base.local_sha256 !== local.sha256) {
      modified.push(filePath);
    }
  }

  for (const filePath of Object.keys(baseline)) {
    if (!localFiles.has(filePath)) {
      deleted.push(filePath);
    }
  }

  added.sort();
  modified.sort();
  deleted.sort();

  return { added, modified, deleted };
}
