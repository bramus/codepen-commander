import path from 'node:path';
import type { Command } from 'commander';
import { CodePenClient } from '../api/client.js';
import type { Pen } from '../api/types.js';
import type { ResolvedAuth } from '../config/auth.js';
import {
  createUnlinkedProjectError,
  findNearestConfig,
  type ProjectLocation,
} from '../config/project.js';
import { PROJECT_CONFIG_FILENAME } from '../constants.js';
import { CliError } from '../errors.js';
import { printJsonResponse } from '../utils/json.js';
import { defaultOutput, type CommandOutput } from '../utils/output.js';
import { isInteractive, promptSelect, type SelectOption } from '../utils/prompts/index.js';
import { getGlobalProfileOption, resolveCommandAuth } from '../workflows/auth-context.js';
import { runBatchPull, type BatchExecutionResult } from '../workflows/batch-pens.js';
import {
  offerBatchAllFallback,
  resolveBatchCommandTarget,
} from '../workflows/batch-target.js';
import type { DiscoveredPen } from '../workflows/discover-pens.js';
import { executePull } from '../workflows/pull-pen.js';

export interface PullCliOptions {
  force?: boolean;
  dryRun?: boolean;
  json?: boolean;
}

export interface RunPullCommandOptions {
  /** Optional target directory path or `"all"` to walk subdirectories in batch mode. */
  target?: string;
  /** Overwrite local changes without prompting. */
  force?: boolean;
  /** Preview remote changes without modifying local files. */
  dryRun?: boolean;
  /** Output pull result as JSON. */
  json?: boolean;
  /** Working directory (defaults to `process.cwd()`). */
  cwd?: string;
  /** Explicit `--profile <name>` flag value. */
  explicitProfile?: string;
  /** Injectable output sink (defaults to stdout/stderr). */
  output?: CommandOutput;
  /** Injectable API base URL (for testing). */
  baseUrl?: string;
  /** Injectable interactivity flag (for testing). */
  interactive?: boolean;
  /** Injectable env map (for testing). */
  env?: NodeJS.ProcessEnv;
  /** Injectable home dir (for testing). */
  homeDir?: string;
  /** Injectable prompts (for testing). */
  prompts?: {
    confirm?: (question: string, defaultYes?: boolean) => Promise<boolean>;
    select?: <T extends string>(
      question: string,
      options: SelectOption<T>[],
      defaultIndex?: number,
    ) => Promise<T>;
  };
}

export interface PullCommandResult {
  pen?: Pen;
  writtenPaths: string[];
  deletedPaths: string[];
  auth?: ResolvedAuth;
  project?: ProjectLocation;
  dryRun?: boolean;
  batch?: BatchExecutionResult;
  exitCode?: number;
}

/**
 * Pulls the latest remote files and Pen metadata from CodePen into an existing cloned folder
 * containing `.cdpn.json` (in `cwd` or an explicit directory `[target]`), or walks subdirectories
 * in batch mode when `[target]` is `"all"`.
 * Returns `null` if the user cancels interactively.
 */
export async function runPullCommand(
  options: RunPullCommandOptions = {},
): Promise<PullCommandResult | null> {
  const output = options.output ?? defaultOutput;
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const jsonMode = Boolean(options.json);
  const dryRun = Boolean(options.dryRun);
  const interactive = (options.interactive ?? isInteractive()) && !jsonMode;
  const force = Boolean(options.force);
  const selectImpl = options.prompts?.select ?? promptSelect;

  const executeBatch = async (
    rootDir: string,
    discovered: DiscoveredPen[],
  ): Promise<PullCommandResult> => {
    const batch = await runBatchPull({
      rootDir,
      discovered,
      force,
      dryRun,
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
      writtenPaths: [],
      deletedPaths: [],
      dryRun,
      batch,
      ...(batch.exitCode !== undefined ? { exitCode: batch.exitCode } : {}),
    };
  };

  const resolvedTarget = await resolveBatchCommandTarget({
    commandName: 'pull',
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
      commandName: 'pull',
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
      return null;
    }

    throw new CliError(
      404,
      `No ${PROJECT_CONFIG_FILENAME} found in this directory or any parent directory.\nRun \`cdpn clone <url>\` to clone a Pen or \`cdpn new\` to create one.`,
    );
  }

  if (!nearest.linked) {
    throw createUnlinkedProjectError(nearest.rootDir);
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
    persistProfileToProject: !jsonMode && !dryRun,
    output,
    env: options.env,
    homeDir: options.homeDir,
    selectProfile: selectImpl,
  });
  const client = new CodePenClient({ apiKey: auth.apiKey, baseUrl: options.baseUrl });

  const pulled = await executePull(client, project, auth, {
    force,
    dryRun,
    silent: jsonMode,
    interactive,
    json: jsonMode,
    output,
    prompts: options.prompts,
  });

  if (!pulled) {
    return null;
  }

  if (jsonMode) {
    const profileToReport = pulled.project.config.profile ?? auth.profile ?? null;
    printJsonResponse(
      200,
      dryRun
        ? `Dry run complete — previewed remote changes for ${pulled.pen.title || 'Untitled'}.`
        : `Synced ${pulled.pen.title || 'Untitled'}.`,
      {
        pen: pulled.pen,
        profile: profileToReport,
        root_dir: pulled.project.rootDir,
        config_path: pulled.project.configPath,
        version_id: pulled.pen.saved_version?.id ?? null,
        dry_run: dryRun,
        ...(dryRun ? { has_local_changes: pulled.hasLocalChanges } : {}),
        written_paths: pulled.writtenPaths,
        deleted_paths: pulled.deletedPaths,
        ...(dryRun ? { info_changes: pulled.infoChanges } : {}),
      },
      output,
    );
  }

  return {
    pen: pulled.pen,
    writtenPaths: pulled.writtenPaths,
    deletedPaths: pulled.deletedPaths,
    auth,
    project: pulled.project,
    dryRun,
  };
}

export function registerPullCommand(program: Command): void {
  program
    .command('pull')
    .argument('[target]', 'Directory path to pull, or "all" to pull all Pens in subdirectories')
    .allowExcessArguments(false)
    .description(
      'Pull latest changes from CodePen into a cloned folder (or pass "all" to walk subdirectories)',
    )
    .option('-f, --force', 'Overwrite local changes without prompting')
    .option('--dry-run', 'Preview remote changes without modifying local files')
    .option('--json', 'Output pull result as JSON')
    .action(async (target: string | undefined, options: PullCliOptions, command: Command) => {
      const result = await runPullCommand({
        target,
        force: options.force,
        dryRun: options.dryRun,
        json: options.json,
        explicitProfile: getGlobalProfileOption(command),
      });
      if (result?.exitCode !== undefined) {
        process.exitCode = result.exitCode;
      }
    });
}
