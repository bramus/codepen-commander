import fs from 'node:fs/promises';
import type { Command } from 'commander';
import { CodePenClient } from '../api/client.js';
import type { ResolvedAuth } from '../config/auth.js';
import {
  PROJECT_CONFIG_FILENAME,
  requireProjectInDir,
  writeUnlinkedProjectInfo,
  type ProjectLocation,
} from '../config/project.js';
import { analyzeInfoSync, extractPenInfo, normalizePartialPenInfo } from '../sync/info.js';
import type { CompletePenInfo, Pen } from '../types.js';
import { fmt } from '../utils/format.js';
import { CliError, printJsonResponse } from '../utils/json.js';
import {
  isInteractive,
  promptConfirm,
  promptSelect,
  type SelectOption,
} from '../utils/prompts.js';
import { getGlobalProfileOption, resolveCommandAuth } from './auth-context.js';

export const CODEPEN_DELETED_ITEMS_URL = 'https://codepen.io/your-work?item_type=DELETED_ITEMS';

export interface DeleteCliOptions {
  yes?: boolean;
  keepInfo?: boolean;
  json?: boolean;
}

export interface DeletePenCommandOptions {
  /** Skip confirmation prompt (required in non-interactive mode). */
  yes?: boolean;
  /** Retain the `info` section in `.cdpn.json` (unlinked) instead of removing `.cdpn.json`. */
  keepInfo?: boolean;
  /** Output structured JSON response instead of human-readable logs. */
  json?: boolean;
  /** Working directory (must contain `.cdpn.json` directly; defaults to `process.cwd()`). */
  cwd?: string;
  /** Explicit `--profile <name>` flag value. */
  explicitProfile?: string;
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

export interface DeletePenResult {
  pen: Pen;
  project: ProjectLocation;
  auth: ResolvedAuth;
  configRemoved: boolean;
  infoRetained: boolean;
  retainedInfo?: CompletePenInfo;
}

/**
 * Deletes the online Pen linked to `.cdpn.json` directly inside `options.cwd`
 * (moves it to CodePen Deleted Items, restorable for 3 days) and removes `.cdpn.json`
 * (or retains only its `info` section when `keepInfo` is true) only after the remote
 * deletion succeeds. Local project files are kept untouched.
 *
 * Returns `null` if the user cancels at the confirmation prompt.
 */
export async function deletePenCommand(
  options: DeletePenCommandOptions = {},
): Promise<DeletePenResult | null> {
  const cwd = options.cwd ?? process.cwd();
  const keepInfo = Boolean(options.keepInfo);
  const interactive = (options.interactive ?? isInteractive()) && !options.json;
  const confirmImpl = options.prompts?.confirm ?? promptConfirm;
  const selectImpl = options.prompts?.select ?? promptSelect;

  // Strictly require `.cdpn.json` directly inside the current folder
  const project = await requireProjectInDir(cwd);

  const auth = await resolveCommandAuth({
    explicitProfile: options.explicitProfile,
    project,
    interactive,
    persistProfileToProject: false,
    env: options.env,
    homeDir: options.homeDir,
    selectProfile: selectImpl,
  });
  const client = new CodePenClient({ apiKey: auth.apiKey, baseUrl: options.baseUrl });

  const pen = await client.getPen(project.config.pen_id);

  if (!options.yes) {
    if (!interactive) {
      throw new CliError(400, 'Refusing to delete Pen in non-interactive mode without --yes.');
    }

    console.log(`\n${fmt.yellow('About to delete online Pen:')}`);
    console.log(`  Title:   ${fmt.bold(pen.title || 'Untitled')} ${fmt.dim(`(${pen.id})`)}`);
    if (auth.profile) {
      console.log(`  Profile: ${fmt.cyan(auth.profile)}`);
    }
    console.log(`  Editor:  ${fmt.cyan(pen.urls.editor)}`);
    if (pen.deployment) {
      console.log(`  Live:    ${fmt.yellow(pen.deployment.url)} ${fmt.dim('(will also be taken down)')}`);
    }
    console.log(
      fmt.dim(
        keepInfo
          ? `\nLocal files will stay untouched; only the "info" section will be kept in ${PROJECT_CONFIG_FILENAME} after deletion succeeds.`
          : `\nLocal files will stay untouched; ${PROJECT_CONFIG_FILENAME} will be removed after deletion succeeds.`,
      ),
    );

    const ok = await confirmImpl(
      keepInfo
        ? `Delete this Pen on CodePen (moves to Deleted Items for 3 days) and keep only "info" in ${PROJECT_CONFIG_FILENAME}?`
        : `Delete this Pen on CodePen (moves to Deleted Items for 3 days) and remove ${PROJECT_CONFIG_FILENAME}?`,
      false,
    );
    if (!ok) {
      console.log('Aborted.');
      return null;
    }
  }

  await client.deletePen(project.config.pen_id);

  // Modify or remove `.cdpn.json` only after remote deletion succeeded
  let retainedInfo: CompletePenInfo | undefined;
  if (keepInfo) {
    const remoteInfo = extractPenInfo(pen);
    const infoAnalysis = analyzeInfoSync(
      project.config.info,
      project.config.last_synced_info_hash,
      pen,
    );
    retainedInfo =
      infoAnalysis.localChanged && project.config.info
        ? { ...remoteInfo, ...normalizePartialPenInfo(project.config.info) }
        : remoteInfo;
    await writeUnlinkedProjectInfo(project.rootDir, retainedInfo);
  } else {
    await fs.unlink(project.configPath);
  }

  if (options.json) {
    if (keepInfo) {
      printJsonResponse(
        200,
        `Deleted ${pen.title || 'Untitled'} (${pen.id}) on CodePen and retained info in ${PROJECT_CONFIG_FILENAME}.`,
        {
          pen_id: pen.id,
          title: pen.title,
          profile: auth.profile,
          editor_url: pen.urls.editor,
          deleted: true,
          config_removed: false,
          info_retained: true,
          info: retainedInfo,
          restore_url: CODEPEN_DELETED_ITEMS_URL,
        },
      );
    } else {
      printJsonResponse(
        200,
        `Deleted ${pen.title || 'Untitled'} (${pen.id}) on CodePen and removed ${PROJECT_CONFIG_FILENAME}.`,
        {
          pen_id: pen.id,
          title: pen.title,
          profile: auth.profile,
          editor_url: pen.urls.editor,
          deleted: true,
          config_removed: true,
          info_retained: false,
          restore_url: CODEPEN_DELETED_ITEMS_URL,
        },
      );
    }
  } else {
    console.log(
      `\n${fmt.green('✓')} Deleted ${fmt.bold(pen.title || 'Untitled')} ${fmt.dim(`(${pen.id})`)} on CodePen ${fmt.dim('(moved to Deleted Items; restorable for 3 days)')}`,
    );
    if (keepInfo) {
      if (auth.profile) {
        console.log(`  Profile:  ${fmt.cyan(auth.profile)}`);
      }
      console.log(
        `  Retained: ${fmt.cyan(`info in ${PROJECT_CONFIG_FILENAME}`)} ${fmt.dim('(unlinked; local files were kept untouched)')}`,
      );
      console.log(`  Restore:  ${fmt.dim(CODEPEN_DELETED_ITEMS_URL)}`);
    } else {
      if (auth.profile) {
        console.log(`  Profile: ${fmt.cyan(auth.profile)}`);
      }
      console.log(`  Removed: ${fmt.cyan(PROJECT_CONFIG_FILENAME)} ${fmt.dim('(local files were kept untouched)')}`);
      console.log(`  Restore: ${fmt.dim(CODEPEN_DELETED_ITEMS_URL)}`);
    }
  }

  return {
    pen,
    project,
    auth,
    configRemoved: !keepInfo,
    infoRetained: keepInfo,
    ...(retainedInfo ? { retainedInfo } : {}),
  };
}

export function registerDeleteCommand(program: Command): void {
  program
    .command('delete')
    .aliases(['del', 'rm'])
    .allowExcessArguments(false)
    .description(
      `Delete the online Pen on CodePen (moves to Deleted Items) and remove ${PROJECT_CONFIG_FILENAME}`,
    )
    .option('--keep-info', `Keep Pen info in ${PROJECT_CONFIG_FILENAME} so it is reused on the next push`)
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--json', 'Output deletion result as JSON')
    .action(async (options: DeleteCliOptions, command: Command) => {
      await deletePenCommand({
        yes: options.yes,
        keepInfo: options.keepInfo,
        json: options.json,
        explicitProfile: getGlobalProfileOption(command),
      });
    });
}
