import type { CodePenClient } from '../api/client.js';
import type { Pen, PenFile } from '../api/types.js';
import type { ResolvedAuth } from '../config/auth.js';
import {
  buildSyncedFileMap,
  writeProjectConfig,
  type ProjectLocation,
} from '../config/project.js';
import { PROJECT_CONFIG_FILENAME } from '../constants.js';
import { CliError } from '../errors.js';
import { computeSyncDiff, detectLocalChangesFromBaseline } from '../sync/diff.js';
import { scanLocalFiles, type LocalFile } from '../sync/fs.js';
import {
  analyzeInfoSync,
  buildPenInfoConfigFields,
  formatInfoValue,
  hasAnyPenInfoFields,
  isLocalInfoDirty,
  type InfoDiffItem,
} from '../sync/info.js';
import { syncRemoteFilesToDisk } from '../sync/materialize.js';
import { fmt, shortId } from '../utils/format.js';
import { defaultOutput, type CommandOutput } from '../utils/output.js';
import { promptConfirm } from '../utils/prompts/index.js';
import { fetchLinkedPenOrHandleMissing, type MissingPenPrompts } from './missing-pen.js';

export interface ExecutePullOptions {
  /** Overwrite local changes without prompting. */
  force?: boolean;
  /** Preview remote changes without writing or deleting local files. */
  dryRun?: boolean;
  /** Suppress human-readable console output (used by --json and batch callers). */
  silent?: boolean;
  /** Whether interactive prompts are allowed (dirty-check confirmation & missing-pen menu). */
  interactive?: boolean;
  /** Whether caller is emitting JSON (passed through to missing-pen handling). */
  json?: boolean;
  /** Injectable output sink. */
  output?: CommandOutput;
  /** Injectable prompt callbacks. */
  prompts?: MissingPenPrompts;
  /** Optional already-fetched remote Pen (avoids duplicate GET /v2/pens/{id}). */
  prefetchedPen?: Pen;
  /** Optional already-fetched remote files (avoids duplicate GET /v2/pens/{id}/files). */
  prefetchedRemoteFiles?: PenFile[];
  /** Optional already-scanned local files. */
  prefetchedLocalFiles?: Map<string, LocalFile>;
  /** Whether to handle 404 missing Pens via `fetchLinkedPenOrHandleMissing` (default: true). */
  handleMissingPen?: boolean;
  /** Whether to persist `auth.profile` back into `.cdpn.json` if missing (default: true). */
  persistProfile?: boolean;
}

export interface ExecutePullResult {
  pen: Pen;
  writtenPaths: string[];
  deletedPaths: string[];
  infoChanges: InfoDiffItem[];
  hadInfoBefore: boolean;
  hasLocalChanges: boolean;
  dryRun: boolean;
  auth: ResolvedAuth;
  project: ProjectLocation;
}

/**
 * Executes a pull of remote files and Pen metadata from CodePen into an existing linked
 * Pen directory, with full support for dirty-state guards and `--dry-run` preview.
 * Returns `null` if the user cancels interactively (either on dirty files or missing Pen).
 */
export async function executePull(
  client: CodePenClient,
  project: ProjectLocation,
  auth: ResolvedAuth,
  options: ExecutePullOptions = {},
): Promise<ExecutePullResult | null> {
  const output = options.output ?? defaultOutput;
  const silent = Boolean(options.silent);
  const dryRun = Boolean(options.dryRun);
  const force = Boolean(options.force);
  const interactive = Boolean(options.interactive) && !silent;
  const confirmImpl = options.prompts?.confirm ?? promptConfirm;
  const { rootDir, config } = project;

  if (!silent) {
    output.log(
      dryRun
        ? `Checking remote changes for ${fmt.cyan(config.pen_id)} (dry run)…`
        : `Pulling latest changes for ${fmt.cyan(config.pen_id)}…`,
    );
  }

  const localFiles = options.prefetchedLocalFiles ?? (await scanLocalFiles(rootDir));
  const localDirty = detectLocalChangesFromBaseline(localFiles, config.files);
  const dirtyCount =
    localDirty.added.length + localDirty.modified.length + localDirty.deleted.length;
  const localInfoDirty = isLocalInfoDirty(config.info, config.last_synced_info_hash);
  const hasLocalChanges = dirtyCount > 0 || localInfoDirty;

  if (hasLocalChanges && !force && !dryRun) {
    if (!silent) {
      output.log(
        fmt.yellow('\nWarning: You have uncommitted local changes that will be overwritten:'),
      );
      for (const p of localDirty.added) {
        output.log(`  ${fmt.green('+')} ${p} ${fmt.dim('(will be removed)')}`);
      }
      for (const p of localDirty.modified) {
        output.log(`  ${fmt.yellow('~')} ${p} ${fmt.dim('(will be overwritten)')}`);
      }
      for (const p of localDirty.deleted) {
        output.log(`  ${fmt.red('-')} ${p} ${fmt.dim('(will be restored)')}`);
      }
      if (localInfoDirty) {
        output.log(
          `  ${fmt.yellow('~')} ${PROJECT_CONFIG_FILENAME} (info) ${fmt.dim('(will be overwritten)')}`,
        );
      }
    }

    if (!interactive) {
      throw new CliError(
        409,
        'Local changes detected. Commit/push them first, or re-run with --force.',
        {
          dirty_files: localDirty,
          ...(localInfoDirty ? { dirty_info: true } : {}),
        },
      );
    }

    const ok = await confirmImpl('\nOverwrite local changes with remote version?', false);
    if (!ok) {
      output.log('Aborted.');
      return null;
    }
  }

  let pen = options.prefetchedPen;
  if (!pen) {
    if (options.handleMissingPen !== false) {
      const penLookup = await fetchLinkedPenOrHandleMissing({
        client,
        project,
        auth,
        commandName: 'pull',
        interactive,
        json: options.json,
        output,
        prompts: options.prompts,
      });
      if (!penLookup.found) {
        return null;
      }
      pen = penLookup.pen;
    } else {
      pen = await client.getPen(config.pen_id);
    }
  }

  const remoteFiles = options.prefetchedRemoteFiles ?? (await client.getPenFiles(config.pen_id));
  const hadInfoBefore = hasAnyPenInfoFields(config.info);
  const infoAnalysis = analyzeInfoSync(config.info, config.last_synced_info_hash, pen);

  if (dryRun) {
    const diff = await computeSyncDiff({
      localFiles,
      remoteFiles,
      baseline: config.files,
      downloadFile: (url) => client.downloadFile(url),
    });

    // From pull's perspective:
    // - diff.deleted = exists on remote, missing locally -> would add/write locally
    // - diff.modified = differs -> would overwrite locally
    // - diff.added = exists locally only -> would remove locally
    const addedLocally = diff.deleted.map((item) => item.path).sort();
    const updatedLocally = diff.modified.map((item) => item.path).sort();
    const removedLocally = diff.added.map((item) => item.path).sort();
    const wouldWritePaths = [...addedLocally, ...updatedLocally].sort();
    const remoteHead = pen.saved_version?.id ?? null;
    const versionChanged = Boolean(
      remoteHead && config.last_synced_version_id && remoteHead !== config.last_synced_version_id,
    );
    const hasAnyPullEffect =
      wouldWritePaths.length > 0 ||
      removedLocally.length > 0 ||
      infoAnalysis.changes.length > 0 ||
      !hadInfoBefore ||
      versionChanged;

    if (!silent) {
      if (hasLocalChanges && !force) {
        output.log(
          fmt.yellow(
            '\nNote: Uncommitted local changes exist (running without --dry-run will prompt or require --force).',
          ),
        );
      }
      if (!hasAnyPullEffect) {
        output.log(`\n${fmt.green('✓')} Everything is up to date — nothing to pull.`);
      } else {
        output.log(
          `\nDry-run pulling ${fmt.bold(pen.title || 'Untitled')} ${fmt.dim(`(${pen.id})`)}:`,
        );
        for (const p of addedLocally) output.log(`  ${fmt.green('+')} ${p}`);
        for (const p of updatedLocally) output.log(`  ${fmt.yellow('~')} ${p}`);
        for (const p of removedLocally) output.log(`  ${fmt.red('-')} ${p}`);
        for (const change of infoAnalysis.changes) {
          output.log(
            `  ${fmt.yellow('~')} info.${change.field}: ${formatInfoValue(change.field, change.local)} → ${formatInfoValue(change.field, change.remote)}`,
          );
        }
        if (!hadInfoBefore && infoAnalysis.changes.length === 0) {
          output.log(`  ${fmt.cyan('~')} ${PROJECT_CONFIG_FILENAME} (add Pen info)`);
        }
        if (versionChanged && wouldWritePaths.length === 0 && removedLocally.length === 0) {
          output.log(
            `  ${fmt.cyan('~')} version: ${shortId(config.last_synced_version_id)} → ${shortId(remoteHead)}`,
          );
        }
      }
      output.log(`\n${fmt.cyan('ℹ')} Dry run complete — no local files were modified.`);
    }

    return {
      pen,
      writtenPaths: wouldWritePaths,
      deletedPaths: removedLocally,
      infoChanges: infoAnalysis.changes,
      hadInfoBefore,
      hasLocalChanges,
      dryRun: true,
      auth,
      project,
    };
  }

  const result = await syncRemoteFilesToDisk({
    client,
    rootDir,
    remoteFiles,
    existingLocalPaths: localFiles.keys(),
    pruneRemoved: true,
  });

  const syncedFiles = buildSyncedFileMap(remoteFiles, result.localSha256ByPath);
  const profileToPersist =
    options.persistProfile === false
      ? config.profile
      : (config.profile ?? auth.profile ?? undefined);
  const nextConfig = {
    url: config.url || pen.urls.editor,
    pen_id: pen.id,
    ...(profileToPersist ? { profile: profileToPersist } : {}),
    last_synced_version_id: pen.saved_version?.id ?? null,
    editor: pen.editor,
    ...buildPenInfoConfigFields(pen),
    files: syncedFiles,
  };
  const configPath = await writeProjectConfig(rootDir, nextConfig);

  if (!silent) {
    output.log(
      `\n${fmt.green('✓')} Synced ${fmt.bold(pen.title || 'Untitled')} ${fmt.dim(`(${pen.id})`)}`,
    );
    if (auth.profile) {
      output.log(`  Profile: ${fmt.cyan(auth.profile)}`);
    }
    output.log(
      `  Updated: ${result.writtenPaths.length} file(s)` +
        (result.deletedPaths.length > 0
          ? `, removed ${result.deletedPaths.length} deleted file(s)`
          : ''),
    );
    if (!hadInfoBefore) {
      output.log(`  Info:    ${fmt.dim(`added to ${PROJECT_CONFIG_FILENAME}`)}`);
    } else if (infoAnalysis.changes.length > 0) {
      output.log(
        `  Info:    ${fmt.dim(`updated ${infoAnalysis.changes.map((c) => c.field).join(', ')} in ${PROJECT_CONFIG_FILENAME}`)}`,
      );
    }
    if (pen.saved_version) {
      output.log(`  Version: ${fmt.dim(shortId(pen.saved_version.id))}`);
    }
  }

  return {
    pen,
    writtenPaths: result.writtenPaths,
    deletedPaths: result.deletedPaths,
    infoChanges: infoAnalysis.changes,
    hadInfoBefore,
    hasLocalChanges,
    dryRun: false,
    auth,
    project: {
      rootDir,
      configPath,
      config: nextConfig,
    },
  };
}
