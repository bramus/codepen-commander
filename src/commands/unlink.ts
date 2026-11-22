import path from 'node:path';
import type { Command } from 'commander';
import {
  findProject,
  hasProjectConfigInDir,
  requireProjectInDir,
  type PenInfo,
} from '../config/project.js';
import { CODEPEN_DIR, PROJECT_CONFIG_FILENAME } from '../constants.js';
import { CliError } from '../errors.js';
import { fmt } from '../utils/format.js';
import { printJsonResponse } from '../utils/json.js';
import { defaultOutput, type CommandOutput } from '../utils/output.js';
import { isInteractive, promptConfirm, type SelectOption } from '../utils/prompts/index.js';
import { runBatchUnlink, type BatchExecutionResult } from '../workflows/batch-pens.js';
import {
  offerBatchAllFallback,
  resolveBatchCommandTarget,
} from '../workflows/batch-target.js';
import type { DiscoveredPen } from '../workflows/discover-pens.js';
import { unlinkLinkedProject } from '../workflows/missing-pen.js';

export interface UnlinkCliOptions {
  yes?: boolean;
  dryRun?: boolean;
  json?: boolean;
}

export interface RunUnlinkCommandOptions {
  /** Optional target directory path or `"all"` to walk subdirectories in batch mode. */
  target?: string;
  /** Skip confirmation prompt (required in non-interactive mode). */
  yes?: boolean;
  /** Preview what would be unlinked without modifying local files. */
  dryRun?: boolean;
  /** Output structured JSON response instead of human-readable logs. */
  json?: boolean;
  /** Working directory (defaults to `process.cwd()`). */
  cwd?: string;
  /** Injectable interactivity flag (for testing). */
  interactive?: boolean;
  /** Injectable output sink (defaults to stdout/stderr). */
  output?: CommandOutput;
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

export interface UnlinkCommandResult {
  unlinked: boolean;
  dryRun?: boolean;
  previousPenId?: string;
  previousUrl?: string;
  previousProfile?: string | null;
  rootDir: string;
  configPath?: string;
  retainedInfo?: PenInfo;
  batch?: BatchExecutionResult;
  exitCode?: number;
}

/**
 * Locally unlinks the current folder (or explicit directory `[target]`) from its remote CodePen Pen
 * by clearing all remote link fields from `.cdpn.json` while keeping `info`, `.codepen/`, and all
 * local source files untouched.
 *
 * Pass `[target]` = `"all"` to walk subdirectories and unlink all discovered Pens in batch after
 * an upfront two-step confirmation (unless `--yes` or `--dry-run` is passed).
 *
 * Does NOT modify or delete online Pens on CodePen.
 * Returns `null` if the user cancels at a confirmation prompt.
 */
export async function runUnlinkCommand(
  options: RunUnlinkCommandOptions = {},
): Promise<UnlinkCommandResult | null> {
  const output = options.output ?? defaultOutput;
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const dryRun = Boolean(options.dryRun);
  const interactive = (options.interactive ?? isInteractive()) && !options.json;
  const confirmImpl = options.prompts?.confirm ?? promptConfirm;

  const executeBatch = async (
    rootDir: string,
    discovered: DiscoveredPen[],
  ): Promise<UnlinkCommandResult | null> => {
    const batch = await runBatchUnlink({
      rootDir,
      discovered,
      yes: options.yes,
      dryRun,
      json: options.json,
      interactive,
      output,
      prompts: options.prompts,
    });
    if (!batch) {
      return null;
    }
    return {
      unlinked: !dryRun && batch.counts.unlinked > 0,
      dryRun,
      rootDir,
      batch,
      ...(batch.exitCode !== undefined ? { exitCode: batch.exitCode } : {}),
    };
  };

  const resolvedTarget = await resolveBatchCommandTarget({
    commandName: 'unlink',
    cwd,
    target: options.target,
    interactive,
    output,
    prompts: options.prompts,
  });

  if (resolvedTarget.mode === 'batch') {
    return executeBatch(resolvedTarget.rootDir, resolvedTarget.discovered);
  }

  const targetDir = resolvedTarget.targetDir;

  // Outside a Pen directory: preserve parent safety, then offer `cdpn unlink all` if child Pens exist
  if (!(await hasProjectConfigInDir(targetDir))) {
    const parentDir = path.dirname(targetDir);
    const hasParentProject = parentDir !== targetDir && Boolean(await findProject(parentDir));
    if (!hasParentProject) {
      const fallback = await offerBatchAllFallback({
        commandName: 'unlink',
        targetDir,
        fromExplicitDir: resolvedTarget.fromExplicitDir,
        displayDir: resolvedTarget.displayDir,
        dryRun,
        interactive,
        output,
        prompts: options.prompts,
      });
      if (fallback.action === 'batch') {
        return executeBatch(targetDir, fallback.discovered);
      }
      if (fallback.action === 'canceled') {
        return null;
      }
    }
  }

  // Strictly require a linked `.cdpn.json` directly inside the target folder
  const project = await requireProjectInDir(targetDir);
  const displayTitle = project.config.info?.title?.trim() || 'Untitled';
  const previousPenId = project.config.pen_id;
  const previousUrl = project.config.url;
  const previousProfile = project.config.profile ?? null;

  if (dryRun) {
    const previewInfo: PenInfo = project.config.info ?? {};
    if (options.json) {
      printJsonResponse(
        200,
        `Dry run complete — would unlink local folder from ${displayTitle} (${previousPenId}); online Pen left untouched.`,
        {
          unlinked: false,
          dry_run: true,
          would_unlink: true,
          previous_pen_id: previousPenId,
          previous_url: previousUrl,
          previous_profile: previousProfile,
          root_dir: project.rootDir,
          config_path: project.configPath,
          info: previewInfo,
        },
        output,
      );
    } else {
      output.log(
        `\n${fmt.yellow('× [WOULD UNLINK]')} ${fmt.bold(displayTitle)} ${fmt.dim(`(${previousPenId})`)}`,
      );
      output.log(
        `  ${fmt.dim('Config:')} ${fmt.cyan(PROJECT_CONFIG_FILENAME)} ${fmt.dim(`(would clear remote link; keep ${CODEPEN_DIR}/ and Pen info)`)}`,
      );
      output.log(
        `  ${fmt.dim('Online:')} ${fmt.cyan(previousUrl)} ${fmt.dim('(would remain untouched on CodePen)')}`,
      );
      output.log(`\n${fmt.cyan('ℹ')} Dry run complete — no local files were modified.`);
    }

    return {
      unlinked: false,
      dryRun: true,
      previousPenId,
      previousUrl,
      previousProfile,
      rootDir: project.rootDir,
      configPath: project.configPath,
      retainedInfo: previewInfo,
    };
  }

  if (!options.yes) {
    if (!interactive) {
      throw new CliError(400, 'Refusing to unlink Pen in non-interactive mode without --yes.');
    }

    output.log(`\n${fmt.yellow('About to unlink local folder from CodePen Pen:')}`);
    output.log(`  Title:   ${fmt.bold(displayTitle)} ${fmt.dim(`(${previousPenId})`)}`);
    if (previousProfile) {
      output.log(`  Profile: ${fmt.cyan(previousProfile)}`);
    }
    output.log(`  Editor:  ${fmt.cyan(previousUrl)}`);
    output.log(
      fmt.dim(
        `\nThe online Pen on CodePen, ${CODEPEN_DIR}/, and all local source files will stay untouched.\n` +
          `Only the remote link fields in ${PROJECT_CONFIG_FILENAME} will be cleared (keeping "info").`,
      ),
    );

    const ok = await confirmImpl(
      `Unlink this local folder from the online Pen (keeps ${CODEPEN_DIR}/ and "info" in ${PROJECT_CONFIG_FILENAME})?`,
      false,
    );
    if (!ok) {
      output.log('Aborted.');
      return null;
    }
  }

  const { configPath, info: retainedInfo } = await unlinkLinkedProject(project);

  if (options.json) {
    printJsonResponse(
      200,
      `Unlinked local folder from ${displayTitle} (${previousPenId}); online Pen left untouched.`,
      {
        unlinked: true,
        previous_pen_id: previousPenId,
        previous_url: previousUrl,
        previous_profile: previousProfile,
        root_dir: project.rootDir,
        config_path: configPath,
        info: retainedInfo,
      },
      output,
    );
  } else {
    output.log(
      `\n${fmt.boldGreen('✓')} Unlinked local folder from ${fmt.bold(displayTitle)} ${fmt.dim(`(${previousPenId})`)}`,
    );
    output.log(
      `  ${fmt.dim('Updated:')} ${fmt.cyan(PROJECT_CONFIG_FILENAME)} ${fmt.dim(`(cleared remote link; kept ${CODEPEN_DIR}/ and Pen info)`)}`,
    );
    output.log(
      `  ${fmt.dim('Online:')}  ${fmt.cyan(previousUrl)} ${fmt.dim('(left untouched on CodePen)')}`,
    );
    output.log(
      `  ${fmt.dim('Tip:')}     Run \`cdpn push\` anytime to publish this folder as a new Pen.`,
    );
  }

  return {
    unlinked: true,
    dryRun: false,
    previousPenId,
    previousUrl,
    previousProfile,
    rootDir: project.rootDir,
    configPath,
    retainedInfo,
  };
}

export function registerUnlinkCommand(program: Command): void {
  program
    .command('unlink')
    .argument(
      '[target]',
      'Directory path to unlink, or "all" to unlink all Pens in subdirectories',
    )
    .allowExcessArguments(false)
    .description(
      `Unlink a local folder from its online Pen (pass "all" to walk subdirectories; keeps online Pens, ${CODEPEN_DIR}/, and Pen info)`,
    )
    .option('--dry-run', 'Preview what would be unlinked without modifying local files')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--json', 'Output unlink result as JSON')
    .action(async (target: string | undefined, options: UnlinkCliOptions) => {
      const result = await runUnlinkCommand({
        target,
        yes: options.yes,
        dryRun: options.dryRun,
        json: options.json,
      });
      if (result?.exitCode !== undefined) {
        process.exitCode = result.exitCode;
      }
    });
}
