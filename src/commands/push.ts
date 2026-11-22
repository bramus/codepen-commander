import path from 'node:path';
import type { Command } from 'commander';
import { CodePenClient } from '../api/client.js';
import type { Build, BuildPatch, Pen } from '../api/types.js';
import { findNearestConfig, type ProjectLocation } from '../config/project.js';
import { PROJECT_CONFIG_FILENAME } from '../constants.js';
import { CliError } from '../errors.js';
import type { InfoDiffItem } from '../sync/info.js';
import { assertValidVersionLabel, resolveAccessOrVisibility } from '../utils/cli-options.js';
import { fmt, shortId } from '../utils/format.js';
import { printJsonResponse } from '../utils/json.js';
import { defaultOutput, type CommandOutput } from '../utils/output.js';
import { isInteractive, type SelectOption } from '../utils/prompts/index.js';
import { getGlobalProfileOption, resolveCommandAuth } from '../workflows/auth-context.js';
import { runBatchPush, type BatchExecutionResult } from '../workflows/batch-pens.js';
import {
  offerBatchAllFallback,
  resolveBatchCommandTarget,
} from '../workflows/batch-target.js';
import { createPenFromDirectory } from '../workflows/create-pen.js';
import type { DiscoveredPen } from '../workflows/discover-pens.js';
import { fetchLinkedPenOrHandleMissing } from '../workflows/missing-pen.js';
import { executePush, type PushExecutionResult, type PushOptions } from '../workflows/push-pen.js';

export type { PushExecutionResult, PushOptions };

export interface PushCliOptions {
  label?: string;
  force?: boolean;
  dryRun?: boolean;
  wait?: boolean;
  title?: string;
  access?: string;
  visibility?: string;
  password?: string;
  json?: boolean;
}

export interface RunPushCommandOptions extends PushCliOptions {
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

export interface RunPushCommandResult {
  pushed: boolean;
  created: boolean;
  dryRun: boolean;
  pen?: Pen;
  versionId?: string | null;
  build?: Build | null;
  changes?: { added: string[]; modified: string[]; deleted: string[] };
  infoChanges?: InfoDiffItem[];
  appliedPatches?: BuildPatch[];
  batch?: BatchExecutionResult;
  aborted?: boolean;
  exitCode?: number;
}

export async function runPushCommand(
  options: RunPushCommandOptions = {},
): Promise<RunPushCommandResult> {
  const output = options.output ?? defaultOutput;
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const jsonMode = Boolean(options.json);
  const interactive = !jsonMode && (options.interactive ?? isInteractive());

  assertValidVersionLabel(options.label);
  const resolvedAccess = resolveAccessOrVisibility(options.access, options.visibility);

  const executeBatch = async (
    rootDir: string,
    discovered: DiscoveredPen[],
  ): Promise<RunPushCommandResult> => {
    if (options.title?.trim()) {
      throw new CliError(
        400,
        '--title cannot be used when pushing multiple Pens in a directory tree.',
      );
    }

    const batch = await runBatchPush({
      rootDir,
      discovered,
      label: options.label,
      force: options.force,
      dryRun: options.dryRun,
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
      pushed: !batch.dryRun && (batch.counts.pushed > 0 || batch.counts.created > 0),
      created: !batch.dryRun && batch.counts.created > 0,
      dryRun: batch.dryRun,
      batch,
      ...(batch.exitCode !== undefined ? { exitCode: batch.exitCode } : {}),
    };
  };

  const resolvedTarget = await resolveBatchCommandTarget({
    commandName: 'push',
    cwd,
    target: options.target,
    interactive,
    output,
    prompts: options.prompts,
  });

  if (resolvedTarget.mode === 'batch') {
    return executeBatch(resolvedTarget.rootDir, resolvedTarget.discovered);
  }

  const targetCwd = resolvedTarget.targetDir;
  const nearest = await findNearestConfig(targetCwd);

  if (!nearest) {
    const fallback = await offerBatchAllFallback({
      commandName: 'push',
      targetDir: targetCwd,
      fromExplicitDir: resolvedTarget.fromExplicitDir,
      displayDir: resolvedTarget.displayDir,
      dryRun: options.dryRun,
      interactive,
      output,
      prompts: options.prompts,
    });
    if (fallback.action === 'batch') {
      return executeBatch(targetCwd, fallback.discovered);
    }
    if (fallback.action === 'canceled') {
      return { pushed: false, created: false, dryRun: Boolean(options.dryRun), aborted: true };
    }
  }

  // First-time push: no linked .cdpn.json found -> push local folder as a brand-new CodePen 2.0 Pen
  if (!nearest || !nearest.linked) {
    if (options.dryRun) {
      throw new CliError(
        400,
        nearest
          ? `${PROJECT_CONFIG_FILENAME} in ${nearest.rootDir} is not linked to an online Pen yet. --dry-run is only supported for an existing synced Pen.`
          : `No ${PROJECT_CONFIG_FILENAME} found. --dry-run is only supported for an existing synced Pen.`,
      );
    }

    const targetDir = nearest ? nearest.rootDir : targetCwd;
    const folderDisplay = path.relative(cwd, targetDir) || '.';

    if (!jsonMode) {
      output.log(
        fmt.dim(
          nearest
            ? `Found unlinked ${PROJECT_CONFIG_FILENAME} with saved Pen info — pushing this local folder as a new CodePen 2.0 Pen.`
            : `No ${PROJECT_CONFIG_FILENAME} found — pushing this local folder as a new CodePen 2.0 Pen.`,
        ),
      );
    }

    const created = await createPenFromDirectory({
      targetDir,
      folderDisplay,
      explicitProfile: options.explicitProfile,
      title: options.title,
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
      return { pushed: false, created: false, dryRun: false, aborted: true };
    }

    const buildFailed = created.build?.status === 'Failed';
    if (jsonMode) {
      printJsonResponse(
        buildFailed ? 422 : 201,
        buildFailed
          ? `Created Pen ${created.pen.title || 'Untitled'} (${created.pen.id}), but the initial build failed.`
          : `Created Pen ${created.pen.title || 'Untitled'} (${created.pen.id}).`,
        {
          pushed: true,
          created: true,
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
      pushed: true,
      created: true,
      dryRun: false,
      pen: created.pen,
      versionId: created.versionId,
      build: created.build,
      ...(created.exitCode !== undefined ? { exitCode: created.exitCode } : {}),
    };
  }

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
    commandName: 'push',
    interactive,
    json: jsonMode,
    output,
    prompts: options.prompts,
  });
  if (!penLookup.found) {
    return { pushed: false, created: false, dryRun: Boolean(options.dryRun), aborted: true };
  }

  const result = await executePush(client, project, {
    label: options.label,
    force: options.force,
    dryRun: options.dryRun,
    wait: options.wait,
    title: options.title,
    access: resolvedAccess,
    password: options.password,
    json: jsonMode,
    prefetchedPen: penLookup.pen,
    silent: jsonMode,
    output,
  });

  const hasFileChanges =
    result.changes.added.length > 0 ||
    result.changes.modified.length > 0 ||
    result.changes.deleted.length > 0;
  const buildFailed = hasFileChanges && result.build?.status === 'Failed';

  if (jsonMode) {
    const payload = {
      pushed: result.pushed,
      created: false,
      dry_run: result.dryRun,
      pen: result.pen,
      profile: auth.profile,
      version_id: result.versionId,
      build: result.build,
      changes: result.changes,
      info_changes: result.infoChanges,
      applied_patches: result.appliedPatches,
    };

    if (result.dryRun) {
      printJsonResponse(
        buildFailed ? 422 : 200,
        buildFailed
          ? 'Dry run completed, but the build failed.'
          : 'Dry run complete — no changes were saved to CodePen.',
        payload,
        output,
      );
    } else if (!result.pushed) {
      printJsonResponse(
        200,
        result.remoteInfoChanged
          ? `No local changes to push. Remote Pen info has changed on CodePen — run \`cdpn pull\` to update ${PROJECT_CONFIG_FILENAME}, or \`cdpn push --force\` to overwrite.`
          : 'Everything is up to date — nothing to push.',
        payload,
        output,
      );
    } else if (buildFailed) {
      printJsonResponse(
        422,
        `Files were saved as version ${shortId(result.versionId)}, but the build failed.`,
        payload,
        output,
      );
    } else if (!hasFileChanges && result.infoChanges.length > 0) {
      printJsonResponse(
        200,
        `Updated Pen info (${result.infoChanges.map((c) => c.field).join(', ')}).`,
        payload,
        output,
      );
    } else {
      printJsonResponse(
        200,
        `Pushed successfully (version ${shortId(result.versionId)}).`,
        payload,
        output,
      );
    }
  }

  return {
    pushed: result.pushed,
    created: false,
    dryRun: result.dryRun,
    pen: result.pen,
    versionId: result.versionId,
    build: result.build,
    changes: result.changes,
    infoChanges: result.infoChanges,
    appliedPatches: result.appliedPatches,
    ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
  };
}

export function registerPushCommand(program: Command): void {
  program
    .command('push')
    .argument('[target]', 'Directory path to push, or "all" to push all Pens in subdirectories')
    .allowExcessArguments(false)
    .description(
      'Push local file and Pen info changes to CodePen (pass "all" to walk subdirectories, or push an unlinked folder as a new Pen)',
    )
    .option('-m, --label <label>', 'Label for the saved version (max 80 chars)')
    .option(
      '-f, --force',
      'Overwrite remote head if moved (or skip missing index.html prompt on first push)',
    )
    .option('--dry-run', 'Preview changes without saving them to CodePen')
    .option('--no-wait', 'Return as soon as files are saved without waiting for the build')
    .option(
      '-t, --title <title>',
      'Title for the new Pen when pushing an unlinked folder for the first time',
    )
    .option('--access <level>', 'Privacy for a new Pen: Public, Private, Protected, or Collaborators')
    .option('--visibility <level>', 'Alias for --access')
    .option('--password <password>', 'Password for a new Protected Pen (min 8 chars)')
    .option('--json', 'Output push result as JSON')
    .action(async (target: string | undefined, options: PushCliOptions, command: Command) => {
      const result = await runPushCommand({
        ...options,
        target,
        explicitProfile: getGlobalProfileOption(command),
      });
      if (result.exitCode !== undefined) {
        process.exitCode = result.exitCode;
      }
    });
}
