import path from 'node:path';
import type { Command } from 'commander';
import { CodePenClient } from '../api/client.js';
import type { Build, BuildPatch, Pen } from '../api/types.js';
import { findNearestConfig, type ProjectLocation } from '../config/project.js';
import { MAX_PEN_TAGS, PROJECT_CONFIG_FILENAME } from '../constants.js';
import { CliError } from '../errors.js';
import { scanLocalFiles } from '../sync/fs.js';
import type { InfoDiffItem } from '../sync/info.js';
import {
  assertValidProtectedPassword,
  assertValidVersionLabel,
  normalizeAccess,
  resolveAccessOrVisibility,
} from '../utils/cli-options.js';
import { fmt, shortId } from '../utils/format.js';
import { extractHtmlTitle } from '../utils/html.js';
import { printJsonResponse } from '../utils/json.js';
import { defaultOutput, type CommandOutput } from '../utils/output.js';
import { isInteractive, type SelectOption } from '../utils/prompts/index.js';
import { getGlobalProfileOption, resolveCommandAuth } from '../workflows/auth-context.js';
import { runBatchSync, type BatchExecutionResult } from '../workflows/batch-pens.js';
import {
  offerBatchAllFallback,
  resolveBatchCommandTarget,
} from '../workflows/batch-target.js';
import { createPenFromDirectory } from '../workflows/create-pen.js';
import type { DiscoveredPen } from '../workflows/discover-pens.js';
import { fetchLinkedPenOrHandleMissing } from '../workflows/missing-pen.js';
import { executeSync, type PenSyncState } from '../workflows/sync-pen.js';

export interface SyncCliOptions {
  label?: string;
  force?: boolean;
  dryRun?: boolean;
  wait?: boolean;
  access?: string;
  visibility?: string;
  password?: string;
  json?: boolean;
}

export interface RunSyncCommandOptions extends SyncCliOptions {
  /** Optional target directory path or `"all"` to walk subdirectories in batch mode. */
  target?: string;
  cwd?: string;
  explicitProfile?: string;
  baseUrl?: string;
  interactive?: boolean;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  output?: CommandOutput;
  prompts?: {
    confirm?: (question: string, defaultYes?: boolean) => Promise<boolean>;
    text?: (question: string, defaultValue?: string) => Promise<string>;
    select?: <T extends string>(
      question: string,
      options: SelectOption<T>[],
      defaultIndex?: number,
    ) => Promise<T>;
    secret?: (question: string) => Promise<string>;
  };
}

export interface SyncCommandResult {
  mode: 'single' | 'batch';
  action?: 'created' | 'pushed' | 'pulled' | 'up-to-date';
  state?: PenSyncState | 'unlinked';
  dryRun: boolean;
  pen?: Pen;
  versionId?: string | null;
  build?: Build | null;
  changes?: { added: string[]; modified: string[]; deleted: string[] };
  writtenPaths?: string[];
  deletedPaths?: string[];
  infoChanges?: InfoDiffItem[];
  appliedPatches?: BuildPatch[];
  batch?: BatchExecutionResult;
  aborted?: boolean;
  exitCode?: number;
}

/**
 * Bidirectional sync command:
 * - Inside a Pen folder (or explicit `[target]` directory): creates unlinked Pens,
 *   pushes when local is ahead, pulls when remote is ahead, leaves up-to-date Pens untouched,
 *   and refuses with `409 Conflict` when both sides have diverged.
 * - With `[target]` set to `"all"`: walks subdirectories to discover all Pens (`.cdpn.json`)
 *   and syncs them in batch, printing a summary report.
 */
export async function runSyncCommand(
  options: RunSyncCommandOptions = {},
): Promise<SyncCommandResult> {
  const output = options.output ?? defaultOutput;
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const jsonMode = Boolean(options.json);
  const dryRun = Boolean(options.dryRun);
  const interactive = !jsonMode && (options.interactive ?? isInteractive());

  assertValidVersionLabel(options.label);
  const resolvedAccess = resolveAccessOrVisibility(options.access, options.visibility);

  const executeBatch = async (
    rootDir: string,
    discovered: DiscoveredPen[],
  ): Promise<SyncCommandResult> => {
    const batch = await runBatchSync({
      rootDir,
      discovered,
      label: options.label,
      force: options.force,
      dryRun,
      wait: options.wait,
      access: resolvedAccess,
      password: options.password,
      json: jsonMode,
      interactive,
      explicitProfile: options.explicitProfile,
      baseUrl: options.baseUrl,
      env: options.env,
      homeDir: options.homeDir,
      output,
      prompts: options.prompts,
    });

    return {
      mode: 'batch',
      dryRun,
      batch,
      ...(batch.exitCode !== undefined ? { exitCode: batch.exitCode } : {}),
    };
  };

  const resolvedTarget = await resolveBatchCommandTarget({
    commandName: 'sync',
    cwd,
    target: options.target,
    interactive,
    output,
    prompts: options.prompts,
  });

  if (resolvedTarget.mode === 'batch') {
    return executeBatch(resolvedTarget.rootDir, resolvedTarget.discovered);
  }

  const nearest = await findNearestConfig(resolvedTarget.targetDir);

  if (!nearest) {
    const fallback = await offerBatchAllFallback({
      commandName: 'sync',
      targetDir: resolvedTarget.targetDir,
      fromExplicitDir: resolvedTarget.fromExplicitDir,
      displayDir: resolvedTarget.displayDir,
      dryRun,
      interactive,
      output,
      prompts: options.prompts,
    });
    if (fallback.action === 'batch') {
      return executeBatch(resolvedTarget.targetDir, fallback.discovered);
    }
    if (fallback.action === 'canceled') {
      return { mode: 'single', dryRun, aborted: true };
    }

    throw new CliError(
      404,
      `No ${PROJECT_CONFIG_FILENAME} found in this directory or any parent directory.\n` +
        'Run `cdpn clone <url>` to clone a Pen, `cdpn init` to initialize this folder, or `cdpn new` to create one.',
    );
  }

  // Single-Pen unlinked info-only `.cdpn.json` -> create new Pen (or preview in --dry-run)
  if (!nearest.linked) {
    const targetDir = nearest.rootDir;
    const folderDisplay = path.relative(cwd, targetDir) || '.';
    const retainedInfo = nearest.config.info;

    if (dryRun) {
      const effectiveAccess = resolvedAccess ?? normalizeAccess(retainedInfo.access) ?? 'Public';
      if (retainedInfo.tags && retainedInfo.tags.length > MAX_PEN_TAGS) {
        throw new CliError(
          400,
          `CodePen allows at most ${MAX_PEN_TAGS} tags per Pen (found ${retainedInfo.tags.length} in ${PROJECT_CONFIG_FILENAME}).`,
        );
      }
      assertValidProtectedPassword(effectiveAccess, options.password, false);

      const scanned = await scanLocalFiles(targetDir);
      if (scanned.size === 0) {
        throw new CliError(
          400,
          `No syncable files found in ${targetDir} (only an unlinked ${PROJECT_CONFIG_FILENAME} is present).`,
        );
      }

      const indexFile = scanned.get('/index.html');
      if (!indexFile && !options.force) {
        throw new CliError(
          400,
          `No index.html found in ${targetDir}. Pass --force to push this folder without an index.html.`,
        );
      }

      const htmlTitle =
        indexFile && !indexFile.isBinary && indexFile.textContent
          ? extractHtmlTitle(indexFile.textContent)
          : null;
      const title = retainedInfo.title?.trim() || htmlTitle || path.basename(targetDir) || 'Untitled';

      if (jsonMode) {
        printJsonResponse(
          200,
          `Dry run complete — would create new ${effectiveAccess} Pen "${title}" (${scanned.size} file(s)).`,
          {
            batch: false,
            action: 'created',
            state: 'unlinked',
            dry_run: true,
            title,
            access: effectiveAccess,
            folder: folderDisplay,
            root_dir: targetDir,
            file_count: scanned.size,
          },
          output,
        );
      } else {
        output.log(
          `${fmt.green('+ [WOULD CREATE]')} New ${effectiveAccess} Pen ${fmt.bold(title)} from ${scanned.size} file(s) in ${fmt.cyan(folderDisplay)}.`,
        );
        output.log(`\n${fmt.cyan('ℹ')} Dry run complete — no changes were saved to CodePen.`);
      }

      return {
        mode: 'single',
        action: 'created',
        state: 'unlinked',
        dryRun: true,
      };
    }

    if (!jsonMode) {
      output.log(
        fmt.dim(
          `Found unlinked ${PROJECT_CONFIG_FILENAME} with saved Pen info — creating a new CodePen 2.0 Pen.`,
        ),
      );
    }

    const created = await createPenFromDirectory({
      targetDir,
      folderDisplay,
      explicitProfile: options.explicitProfile,
      access: resolvedAccess,
      password: options.password,
      force: options.force,
      wait: options.wait,
      silent: jsonMode,
      output,
      baseUrl: options.baseUrl,
      interactive,
      env: options.env,
      homeDir: options.homeDir,
      prompts: options.prompts,
    });

    if (!created) {
      return { mode: 'single', dryRun: false, aborted: true };
    }

    const buildFailed = created.build?.status === 'Failed';
    if (jsonMode) {
      printJsonResponse(
        buildFailed ? 422 : 201,
        buildFailed
          ? `Created Pen ${created.pen.title || 'Untitled'} (${created.pen.id}), but the initial build failed.`
          : `Created Pen ${created.pen.title || 'Untitled'} (${created.pen.id}).`,
        {
          batch: false,
          action: 'created',
          state: 'unlinked',
          dry_run: false,
          pen: created.pen,
          profile: created.auth.profile,
          folder: folderDisplay,
          root_dir: created.project.rootDir,
          config_path: created.project.configPath,
          version_id: created.versionId,
          build: created.build,
        },
        output,
      );
    }

    return {
      mode: 'single',
      action: 'created',
      state: 'unlinked',
      dryRun: false,
      pen: created.pen,
      versionId: created.versionId,
      build: created.build,
      ...(created.exitCode !== undefined ? { exitCode: created.exitCode } : {}),
    };
  }

  // Single-Pen linked `.cdpn.json`
  const project: ProjectLocation = {
    rootDir: nearest.rootDir,
    configPath: nearest.configPath,
    config: nearest.config,
  };

  const auth = await resolveCommandAuth({
    explicitProfile: options.explicitProfile,
    project,
    interactive,
    persistProfileToProject: !jsonMode,
    output,
    env: options.env,
    homeDir: options.homeDir,
    selectProfile: options.prompts?.select,
  });
  const client = new CodePenClient({ apiKey: auth.apiKey, baseUrl: options.baseUrl });

  const penLookup = await fetchLinkedPenOrHandleMissing({
    client,
    project,
    auth,
    commandName: 'sync',
    interactive,
    json: jsonMode,
    output,
    prompts: options.prompts,
  });
  if (!penLookup.found) {
    return { mode: 'single', dryRun, aborted: true };
  }

  const syncRes = await executeSync(client, project, auth, {
    label: options.label,
    dryRun,
    wait: options.wait,
    silent: jsonMode,
    json: jsonMode,
    output,
    prefetchedPen: penLookup.pen,
  });

  if (jsonMode) {
    if (syncRes.action === 'up-to-date') {
      printJsonResponse(
        200,
        'Everything is up to date — nothing to sync.',
        {
          batch: false,
          action: 'up-to-date',
          state: syncRes.state,
          dry_run: dryRun,
          pen: syncRes.pen,
          profile: auth.profile,
          version_id: syncRes.inspection.remoteHead,
        },
        output,
      );
    } else if (syncRes.action === 'pushed' && syncRes.pushResult) {
      const pr = syncRes.pushResult;
      const hasFileChanges =
        pr.changes.added.length > 0 ||
        pr.changes.modified.length > 0 ||
        pr.changes.deleted.length > 0;
      const buildFailed = hasFileChanges && pr.build?.status === 'Failed';
      const statusCode = buildFailed ? 422 : 200;
      const message = dryRun
        ? buildFailed
          ? 'Dry run completed, but the build failed.'
          : 'Dry run complete — would push local changes to CodePen.'
        : buildFailed
          ? `Files were saved as version ${shortId(pr.versionId)}, but the build failed.`
          : `Synced by pushing local changes (version ${shortId(pr.versionId)}).`;

      printJsonResponse(
        statusCode,
        message,
        {
          batch: false,
          action: 'pushed',
          state: syncRes.state,
          dry_run: dryRun,
          pen: pr.pen,
          profile: auth.profile,
          version_id: pr.versionId,
          build: pr.build,
          changes: pr.changes,
          info_changes: pr.infoChanges,
          applied_patches: pr.appliedPatches,
        },
        output,
      );
    } else if (syncRes.action === 'pulled' && syncRes.pullResult) {
      const lr = syncRes.pullResult;
      printJsonResponse(
        200,
        dryRun
          ? `Dry run complete — would pull remote changes for ${lr.pen.title || 'Untitled'}.`
          : `Synced by pulling remote changes for ${lr.pen.title || 'Untitled'}.`,
        {
          batch: false,
          action: 'pulled',
          state: syncRes.state,
          dry_run: dryRun,
          pen: lr.pen,
          profile: auth.profile,
          version_id: lr.pen.saved_version?.id ?? null,
          written_paths: lr.writtenPaths,
          deleted_paths: lr.deletedPaths,
          info_changes: lr.infoChanges,
        },
        output,
      );
    }
  }

  return {
    mode: 'single',
    action: syncRes.action,
    state: syncRes.state,
    dryRun,
    pen: syncRes.pen,
    versionId:
      syncRes.pushResult?.versionId ??
      syncRes.pullResult?.pen.saved_version?.id ??
      syncRes.inspection.remoteHead,
    build: syncRes.pushResult?.build,
    changes: syncRes.pushResult?.changes,
    writtenPaths: syncRes.pullResult?.writtenPaths,
    deletedPaths: syncRes.pullResult?.deletedPaths,
    infoChanges: syncRes.pushResult?.infoChanges ?? syncRes.pullResult?.infoChanges,
    appliedPatches: syncRes.pushResult?.appliedPatches,
    ...(syncRes.exitCode !== undefined ? { exitCode: syncRes.exitCode } : {}),
  };
}

export function registerSyncCommand(program: Command): void {
  program
    .command('sync')
    .argument('[target]', 'Directory path to sync, or "all" to sync all Pens in subdirectories')
    .allowExcessArguments(false)
    .description(
      'Bidirectionally sync a Pen with CodePen (or pass "all" to walk subdirectories)',
    )
    .option('-m, --label <label>', 'Label for the saved version when pushing (max 80 chars)')
    .option(
      '-f, --force',
      'Skip missing index.html prompt when creating a Pen from an unlinked folder',
    )
    .option('--dry-run', 'Preview sync actions without saving changes or modifying local files')
    .option('--no-wait', 'Return as soon as files are saved when pushing without waiting for the build')
    .option('--access <level>', 'Privacy for a new Pen: Public, Private, Protected, or Collaborators')
    .option('--visibility <level>', 'Alias for --access')
    .option('--password <password>', 'Password for a new Protected Pen (min 8 chars)')
    .option('--json', 'Output sync result as JSON')
    .action(async (target: string | undefined, options: SyncCliOptions, command: Command) => {
      const result = await runSyncCommand({
        ...options,
        target,
        explicitProfile: getGlobalProfileOption(command),
      });
      if (result.exitCode !== undefined) {
        process.exitCode = result.exitCode;
      }
    });
}
