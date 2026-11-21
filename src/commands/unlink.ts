import type { Command } from 'commander';
import {
  PROJECT_CONFIG_FILENAME,
  requireProjectInDir,
} from '../config/project.js';
import { CODEPEN_DIR } from '../site/blocks.js';
import type { PenInfo } from '../types.js';
import { fmt } from '../utils/format.js';
import { CliError, printJsonResponse } from '../utils/json.js';
import { isInteractive, promptConfirm } from '../utils/prompts.js';
import { unlinkLinkedProject } from './missing-pen.js';

export interface UnlinkCliOptions {
  yes?: boolean;
  json?: boolean;
}

export interface UnlinkPenCommandOptions {
  /** Skip confirmation prompt (required in non-interactive mode). */
  yes?: boolean;
  /** Output structured JSON response instead of human-readable logs. */
  json?: boolean;
  /** Working directory (must contain a linked `.cdpn.json` directly; defaults to `process.cwd()`). */
  cwd?: string;
  /** Injectable interactivity flag (for testing). */
  interactive?: boolean;
  /** Injectable prompts (for testing). */
  prompts?: {
    confirm?: (question: string, defaultYes?: boolean) => Promise<boolean>;
  };
}

export interface UnlinkPenResult {
  unlinked: boolean;
  previousPenId: string;
  previousUrl: string;
  previousProfile: string | null;
  rootDir: string;
  configPath: string;
  retainedInfo: PenInfo;
}

/**
 * Locally unlinks the current folder from its remote CodePen Pen by clearing all
 * remote link fields (`url`, `pen_id`, `profile`, `last_synced_version_id`,
 * `last_synced_info_hash`, `editor`, `files`) from `.cdpn.json` while keeping
 * `info`, `.codepen/`, and all local source files untouched.
 *
 * Does NOT modify or delete the online Pen on CodePen.
 * Returns `null` if the user cancels at the confirmation prompt.
 */
export async function unlinkPenCommand(
  options: UnlinkPenCommandOptions = {},
): Promise<UnlinkPenResult | null> {
  const cwd = options.cwd ?? process.cwd();
  const interactive = (options.interactive ?? isInteractive()) && !options.json;
  const confirmImpl = options.prompts?.confirm ?? promptConfirm;

  // Strictly require a linked `.cdpn.json` directly inside the current folder
  const project = await requireProjectInDir(cwd);
  const displayTitle = project.config.info?.title?.trim() || 'Untitled';
  const previousPenId = project.config.pen_id;
  const previousUrl = project.config.url;
  const previousProfile = project.config.profile ?? null;

  if (!options.yes) {
    if (!interactive) {
      throw new CliError(400, 'Refusing to unlink Pen in non-interactive mode without --yes.');
    }

    console.log(`\n${fmt.yellow('About to unlink local folder from CodePen Pen:')}`);
    console.log(`  Title:   ${fmt.bold(displayTitle)} ${fmt.dim(`(${previousPenId})`)}`);
    if (previousProfile) {
      console.log(`  Profile: ${fmt.cyan(previousProfile)}`);
    }
    console.log(`  Editor:  ${fmt.cyan(previousUrl)}`);
    console.log(
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
      console.log('Aborted.');
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
    );
  } else {
    console.log(
      `\n${fmt.boldGreen('✓')} Unlinked local folder from ${fmt.bold(displayTitle)} ${fmt.dim(`(${previousPenId})`)}`,
    );
    console.log(
      `  ${fmt.dim('Updated:')} ${fmt.cyan(PROJECT_CONFIG_FILENAME)} ${fmt.dim(`(cleared remote link; kept ${CODEPEN_DIR}/ and Pen info)`)}`,
    );
    console.log(
      `  ${fmt.dim('Online:')}  ${fmt.cyan(previousUrl)} ${fmt.dim('(left untouched on CodePen)')}`,
    );
    console.log(
      `  ${fmt.dim('Tip:')}     Run \`cdpn push\` anytime to publish this folder as a new Pen.`,
    );
  }

  return {
    unlinked: true,
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
      `Unlink this local folder from its online Pen (keeps the online Pen, ${CODEPEN_DIR}/, and Pen info in ${PROJECT_CONFIG_FILENAME})`,
    )
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--json', 'Output unlink result as JSON')
    .action(async (options: UnlinkCliOptions) => {
      await unlinkPenCommand({
        yes: options.yes,
        json: options.json,
      });
    });
}
