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
import { isInteractive, promptConfirm } from '../utils/prompts/index.js';
import { runBatchUnlink, type BatchExecutionResult } from '../workflows/batch-pens.js';
import { discoverPenDirectories } from '../workflows/discover-pens.js';
import { unlinkLinkedProject } from '../workflows/missing-pen.js';

export interface UnlinkCliOptions {
  yes?: boolean;
  dryRun?: boolean;
  json?: boolean;
}

export interface RunUnlinkCommandOptions {
  /** Skip confirmation prompt (required in non-interactive mode). */
  yes?: boolean;
  /** Preview what would be unlinked without modifying local files. */
  dryRun?: boolean;
  /** Output structured JSON response instead of human-readable logs. */
  json?: boolean;
  /** Working directory (must contain a linked `.cdpn.json` directly, or child Pen folders for batch mode; defaults to `process.cwd()`). */
  cwd?: string;
  /** Injectable interactivity flag (for testing). */
  interactive?: boolean;
  /** Injectable output sink (defaults to stdout/stderr). */
  output?: CommandOutput;
  /** Injectable prompts (for testing). */
  prompts?: {
    confirm?: (question: string, defaultYes?: boolean) => Promise<boolean>;
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
 * Locally unlinks the current folder from its remote CodePen Pen by clearing all
 * remote link fields (`url`, `pen_id`, `profile`, `last_synced_version_id`,
 * `last_synced_info_hash`, `editor`, `files`) from `.cdpn.json` while keeping
 * `info`, `.codepen/`, and all local source files untouched.
 *
 * When invoked outside any Pen folder (with no `.cdpn.json` in `cwd` or any parent),
 * walks subdirectories to discover all Pens and unlinks them in batch after an upfront
 * two-step confirmation (unless `--yes` or `--dry-run` is passed).
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

  // Outside a Pen directory: check parent safety, then offer tree-walk batch mode if child Pens exist
  if (!(await hasProjectConfigInDir(cwd))) {
    const parentDir = path.dirname(cwd);
    const hasParentProject = parentDir !== cwd && Boolean(await findProject(parentDir));
    if (!hasParentProject) {
      const discovered = await discoverPenDirectories(cwd);
      if (discovered.length > 0) {
        const batch = await runBatchUnlink({
          rootDir: cwd,
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
          rootDir: cwd,
          batch,
          ...(batch.exitCode !== undefined ? { exitCode: batch.exitCode } : {}),
        };
      }
    }
  }

  // Strictly require a linked `.cdpn.json` directly inside the current folder
  const project = await requireProjectInDir(cwd);
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
    .allowExcessArguments(false)
    .description(
      `Unlink this local folder from its online Pen (or walk subdirectories when run outside a Pen folder; keeps online Pens, ${CODEPEN_DIR}/, and Pen info)`,
    )
    .option('--dry-run', 'Preview what would be unlinked without modifying local files')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--json', 'Output unlink result as JSON')
    .action(async (options: UnlinkCliOptions) => {
      const result = await runUnlinkCommand({
        yes: options.yes,
        dryRun: options.dryRun,
        json: options.json,
      });
      if (result?.exitCode !== undefined) {
        process.exitCode = result.exitCode;
      }
    });
}
