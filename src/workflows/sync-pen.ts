import type { CodePenClient } from '../api/client.js';
import type { Pen, PenFile } from '../api/types.js';
import type { ResolvedAuth } from '../config/auth.js';
import { writeProjectConfig, type ProjectLocation } from '../config/project.js';
import { PROJECT_CONFIG_FILENAME } from '../constants.js';
import { CliError } from '../errors.js';
import {
  computeSyncDiff,
  detectLocalChangesFromBaseline,
  hasDiffChanges,
  type SyncDiff,
} from '../sync/diff.js';
import { scanLocalFiles, type LocalFile } from '../sync/fs.js';
import {
  analyzeInfoSync,
  buildPenInfoConfigFields,
  hashPenInfo,
  isCompletePenInfo,
  type InfoDiffItem,
  type InfoSyncAnalysis,
} from '../sync/info.js';
import { fmt, shortId } from '../utils/format.js';
import { defaultOutput, type CommandOutput } from '../utils/output.js';
import { executePull, type ExecutePullResult } from './pull-pen.js';
import { executePush, type PushExecutionResult } from './push-pen.js';

export type PenSyncState =
  | 'up-to-date'
  | 'local-ahead'
  | 'remote-ahead'
  | 'remote-metadata-ahead'
  | 'conflict';

export interface LinkedPenSyncInspection {
  state: PenSyncState;
  pen: Pen;
  remoteFiles: PenFile[];
  localFiles: Map<string, LocalFile>;
  diff: SyncDiff;
  diffCount: number;
  localHead: string | null;
  remoteHead: string | null;
  remoteVersionChanged: boolean;
  hasFileBaseline: boolean;
  localFileBaseline: { added: string[]; modified: string[]; deleted: string[] };
  localFilesDirty: boolean;
  infoAnalysis: InfoSyncAnalysis;
  classicReadOnly: boolean;
}

export interface InspectLinkedPenOptions {
  prefetchedPen?: Pen;
  prefetchedRemoteFiles?: PenFile[];
  prefetchedLocalFiles?: Map<string, LocalFile>;
}

/**
 * Performs a 3-way sync comparison between local files / `.cdpn.json` metadata,
 * the last synced baseline, and the current remote Pen on CodePen.
 */
export async function inspectLinkedPenSyncState(
  client: CodePenClient,
  project: ProjectLocation,
  options: InspectLinkedPenOptions = {},
): Promise<LinkedPenSyncInspection> {
  const pen = options.prefetchedPen ?? (await client.getPen(project.config.pen_id));
  const [remoteFiles, localFiles] = await Promise.all([
    options.prefetchedRemoteFiles
      ? Promise.resolve(options.prefetchedRemoteFiles)
      : client.getPenFiles(project.config.pen_id),
    options.prefetchedLocalFiles
      ? Promise.resolve(options.prefetchedLocalFiles)
      : scanLocalFiles(project.rootDir),
  ]);

  const diff = await computeSyncDiff({
    localFiles,
    remoteFiles,
    baseline: project.config.files,
    downloadFile: (url) => client.downloadFile(url),
  });
  const diffCount = diff.added.length + diff.modified.length + diff.deleted.length;
  const hasFileDiffs = hasDiffChanges(diff);

  const localHead = project.config.last_synced_version_id;
  const remoteHead = pen.saved_version?.id ?? null;
  const remoteVersionChanged = Boolean(remoteHead && localHead && remoteHead !== localHead);

  const hasFileBaseline = project.config.files !== undefined;
  const localFileBaseline = detectLocalChangesFromBaseline(localFiles, project.config.files);
  const localFilesDirty =
    hasFileBaseline &&
    (localFileBaseline.added.length > 0 ||
      localFileBaseline.modified.length > 0 ||
      localFileBaseline.deleted.length > 0);

  const infoAnalysis = analyzeInfoSync(
    project.config.info,
    project.config.last_synced_info_hash,
    pen,
  );
  const hasInfoDiffs = infoAnalysis.changes.length > 0;
  const localInfoDirty = infoAnalysis.localChanged;
  const remoteInfoChanged = infoAnalysis.remoteChanged;

  const fileConflict = remoteVersionChanged && hasFileDiffs && (localFilesDirty || !hasFileBaseline);
  const infoConflict = localInfoDirty && remoteInfoChanged;
  const crossConflict = localInfoDirty && remoteVersionChanged;

  let state: PenSyncState;
  if (!hasFileDiffs && !hasInfoDiffs && !remoteVersionChanged) {
    state = 'up-to-date';
  } else if (fileConflict || infoConflict || crossConflict) {
    state = 'conflict';
  } else if (remoteVersionChanged || (remoteInfoChanged && !localFilesDirty && !localInfoDirty)) {
    state = !hasFileDiffs && !hasInfoDiffs ? 'remote-metadata-ahead' : 'remote-ahead';
  } else if (hasFileDiffs || hasInfoDiffs) {
    state = 'local-ahead';
  } else {
    state = 'up-to-date';
  }

  return {
    state,
    pen,
    remoteFiles,
    localFiles,
    diff,
    diffCount,
    localHead,
    remoteHead,
    remoteVersionChanged,
    hasFileBaseline,
    localFileBaseline,
    localFilesDirty,
    infoAnalysis,
    classicReadOnly: pen.editor === 'Classic',
  };
}

/**
 * Formats a concise one-line summary of file and info changes (e.g. `2 file(s), info: title, tags`).
 */
export function formatSyncChangeSummary(
  diffCount: number,
  infoChanges: InfoDiffItem[],
  fallback = 'metadata behind',
): string {
  const parts: string[] = [];
  if (diffCount > 0) {
    parts.push(`${diffCount} file(s)`);
  }
  if (infoChanges.length > 0) {
    parts.push(`info: ${infoChanges.map((c) => c.field).join(', ')}`);
  }
  return parts.length > 0 ? parts.join(', ') : fallback;
}

/**
 * Formats file diff lines (`+`, `~`, `-`) for push or pull direction display.
 */
export function formatFileDiffLines(
  diff: SyncDiff,
  direction: 'push' | 'pull',
  indent = '    ',
): string[] {
  const lines: string[] = [];
  if (direction === 'push') {
    for (const item of diff.added) lines.push(`${indent}${fmt.green('+')} ${item.path}`);
    for (const item of diff.modified) lines.push(`${indent}${fmt.yellow('~')} ${item.path}`);
    for (const item of diff.deleted) lines.push(`${indent}${fmt.red('-')} ${item.path}`);
  } else {
    for (const item of diff.deleted) lines.push(`${indent}${fmt.green('+')} ${item.path}`);
    for (const item of diff.modified) lines.push(`${indent}${fmt.yellow('~')} ${item.path}`);
    for (const item of diff.added) lines.push(`${indent}${fmt.red('-')} ${item.path}`);
  }
  return lines;
}

export interface ExecuteSyncOptions {
  label?: string;
  dryRun?: boolean;
  wait?: boolean;
  silent?: boolean;
  json?: boolean;
  output?: CommandOutput;
  prefetchedPen?: Pen;
}

export interface ExecuteSyncResult {
  action: 'up-to-date' | 'pushed' | 'pulled';
  state: PenSyncState;
  dryRun: boolean;
  pen: Pen;
  inspection: LinkedPenSyncInspection;
  pushResult?: PushExecutionResult;
  pullResult?: ExecutePullResult;
  exitCode?: number;
}

/**
 * Synchronizes a single linked Pen in whichever direction is ahead (local -> push, remote -> pull),
 * leaving up-to-date Pens untouched and failing safely with `409 Conflict` if both sides diverged.
 */
export async function executeSync(
  client: CodePenClient,
  project: ProjectLocation,
  auth: ResolvedAuth,
  options: ExecuteSyncOptions = {},
): Promise<ExecuteSyncResult> {
  const output = options.output ?? defaultOutput;
  const silent = Boolean(options.silent);
  const dryRun = Boolean(options.dryRun);

  const inspection = await inspectLinkedPenSyncState(client, project, {
    prefetchedPen: options.prefetchedPen,
  });

  if (inspection.state === 'up-to-date') {
    if (!dryRun && inspection.infoAnalysis.changes.length === 0) {
      const remoteHash = hashPenInfo(inspection.infoAnalysis.remoteInfo);
      const needsInfoUpgrade =
        !inspection.infoAnalysis.tracked ||
        !isCompletePenInfo(project.config.info) ||
        project.config.last_synced_info_hash !== remoteHash;
      if (needsInfoUpgrade) {
        const nextConfig = {
          ...project.config,
          ...buildPenInfoConfigFields(inspection.pen),
        };
        await writeProjectConfig(project.rootDir, nextConfig);
        project.config = nextConfig;
      }
    }

    if (!silent) {
      output.log(`${fmt.green('✓')} Everything is up to date — nothing to sync.`);
    }

    return {
      action: 'up-to-date',
      state: 'up-to-date',
      dryRun,
      pen: inspection.pen,
      inspection,
    };
  }

  if (inspection.state === 'conflict') {
    const infoFields = inspection.infoAnalysis.changes.map((c) => c.field);
    const details: string[] = [];
    if (inspection.remoteVersionChanged) {
      details.push(
        `Synced version ${shortId(inspection.localHead)} differs from remote head ${shortId(inspection.remoteHead)}`,
      );
    }
    if (inspection.diffCount > 0) {
      details.push(`${inspection.diffCount} file difference(s)`);
    }
    if (infoFields.length > 0) {
      details.push(`Pen info differences (${infoFields.join(', ')})`);
    }

    throw new CliError(
      409,
      `Sync conflict detected for ${inspection.pen.title || 'Untitled'} (${inspection.pen.id}): both local and remote have changed` +
        (details.length > 0 ? ` (${details.join('; ')})` : '') +
        '.\nRun `cdpn status` to inspect differences, then `cdpn push --force` to keep local or `cdpn pull --force` to keep remote.',
      {
        pen_id: inspection.pen.id,
        url: inspection.pen.urls.editor,
        local_head: inspection.localHead,
        remote_head: inspection.remoteHead,
        local_file_changes: inspection.localFileBaseline,
        diff: {
          added: inspection.diff.added.map((i) => i.path),
          modified: inspection.diff.modified.map((i) => i.path),
          deleted: inspection.diff.deleted.map((i) => i.path),
        },
        info_changes: inspection.infoAnalysis.changes,
      },
    );
  }

  if (inspection.state === 'local-ahead') {
    const pushResult = await executePush(client, project, {
      label: options.label,
      dryRun,
      wait: options.wait,
      json: options.json,
      silent,
      output,
      prefetchedPen: inspection.pen,
    });
    return {
      action: 'pushed',
      state: 'local-ahead',
      dryRun,
      pen: pushResult.pen,
      inspection,
      pushResult,
      ...(pushResult.exitCode !== undefined ? { exitCode: pushResult.exitCode } : {}),
    };
  }

  // remote-ahead or remote-metadata-ahead -> pull
  const pullResult = await executePull(client, project, auth, {
    force: inspection.state === 'remote-metadata-ahead',
    dryRun,
    silent,
    interactive: false,
    json: options.json,
    output,
    prefetchedPen: inspection.pen,
    prefetchedRemoteFiles: inspection.remoteFiles,
    prefetchedLocalFiles: inspection.localFiles,
    handleMissingPen: false,
  });

  if (!pullResult) {
    throw new CliError(500, 'Pull aborted unexpectedly during sync.');
  }

  return {
    action: 'pulled',
    state: inspection.state,
    dryRun,
    pen: pullResult.pen,
    inspection,
    pullResult,
  };
}
