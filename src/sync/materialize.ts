import fs from 'node:fs/promises';
import path from 'node:path';
import type { CodePenClient } from '../api/client.js';
import type { BuildPatch, PenFile } from '../types.js';
import {
  deleteLocalFile,
  normalizePenPath,
  sha256Hex,
  writeLocalFile,
} from './fs.js';

export interface MaterializeResult {
  writtenPaths: string[];
  deletedPaths: string[];
  localSha256ByPath: Map<string, string>;
}

export async function syncRemoteFilesToDisk(options: {
  client: CodePenClient;
  rootDir: string;
  remoteFiles: PenFile[];
  existingLocalPaths?: Iterable<string>;
  pruneRemoved?: boolean;
}): Promise<MaterializeResult> {
  const { client, rootDir, remoteFiles, existingLocalPaths, pruneRemoved = false } = options;

  const resolvedRoot = path.resolve(rootDir);
  await fs.mkdir(resolvedRoot, { recursive: true });

  const writtenPaths: string[] = [];
  const deletedPaths: string[] = [];
  const localSha256ByPath = new Map<string, string>();
  const remotePathSet = new Set<string>();

  for (const file of remoteFiles) {
    const normalizedPath = normalizePenPath(file.path);
    remotePathSet.add(normalizedPath);

    let buffer: Buffer;
    if (!file.is_binary && file.content !== null) {
      buffer = Buffer.from(file.content, 'utf8');
    } else if (file.download_url) {
      buffer = await client.downloadFile(file.download_url);
    } else {
      throw new Error(
        `Remote file ${normalizedPath} has neither text content nor a download_url.`,
      );
    }

    await writeLocalFile(resolvedRoot, normalizedPath, buffer);
    localSha256ByPath.set(normalizedPath, sha256Hex(buffer));
    writtenPaths.push(normalizedPath);
  }

  if (pruneRemoved && existingLocalPaths) {
    for (const localPath of existingLocalPaths) {
      if (!remotePathSet.has(localPath)) {
        await deleteLocalFile(resolvedRoot, localPath);
        deletedPaths.push(localPath);
      }
    }
  }

  writtenPaths.sort();
  deletedPaths.sort();

  return { writtenPaths, deletedPaths, localSha256ByPath };
}

/**
 * Applies compiler patches returned from a CodePen build back onto the local folder
 * so the working copy stays strictly in sync with the converged remote head.
 */
export async function applyCompilerPatchesToDisk(options: {
  client: CodePenClient;
  rootDir: string;
  patches: BuildPatch[];
  convergedFiles?: PenFile[];
}): Promise<string[]> {
  const { client, rootDir, patches, convergedFiles } = options;
  const touched: string[] = [];
  const convergedByPath = new Map<string, PenFile>();

  if (convergedFiles) {
    for (const f of convergedFiles) {
      convergedByPath.set(normalizePenPath(f.path), f);
    }
  }

  for (const patch of patches) {
    const normalizedPath = normalizePenPath(patch.path);
    if (patch.type === 'delete') {
      await deleteLocalFile(rootDir, normalizedPath);
      touched.push(normalizedPath);
      continue;
    }

    const converged = convergedByPath.get(normalizedPath);
    if (converged) {
      if (!converged.is_binary && converged.content !== null) {
        await writeLocalFile(rootDir, normalizedPath, converged.content);
        touched.push(normalizedPath);
        continue;
      }
      if (converged.download_url) {
        const bytes = await client.downloadFile(converged.download_url);
        await writeLocalFile(rootDir, normalizedPath, bytes);
        touched.push(normalizedPath);
        continue;
      }
    }

    if (patch.content !== null) {
      await writeLocalFile(rootDir, normalizedPath, patch.content);
      touched.push(normalizedPath);
    }
  }

  return touched;
}
