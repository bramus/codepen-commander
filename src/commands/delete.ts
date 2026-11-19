import fs from 'node:fs/promises';
import type { Command } from 'commander';
import { CodePenClient } from '../api/client.js';
import type { ResolvedAuth } from '../config/auth.js';
import {
  PROJECT_CONFIG_FILENAME,
  requireProjectInDir,
  type ProjectLocation,
} from '../config/project.js';
import type { Pen } from '../types.js';
import { fmt } from '../utils/format.js';
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
}

export interface DeletePenCommandOptions {
  /** Skip confirmation prompt (required in non-interactive mode). */
  yes?: boolean;
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
}

/**
 * Deletes the online Pen linked to `.cdpn.json` directly inside `options.cwd`
 * (moves it to CodePen Deleted Items, restorable for 3 days) and removes `.cdpn.json`
 * only after the remote deletion succeeds. Local project files are kept untouched.
 *
 * Returns `null` if the user cancels at the confirmation prompt.
 */
export async function deletePenCommand(
  options: DeletePenCommandOptions = {},
): Promise<DeletePenResult | null> {
  const cwd = options.cwd ?? process.cwd();
  const interactive = options.interactive ?? isInteractive();
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
      throw new Error('Refusing to delete Pen in non-interactive mode without --yes.');
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
        `\nLocal files will stay untouched; ${PROJECT_CONFIG_FILENAME} will be removed after deletion succeeds.`,
      ),
    );

    const ok = await confirmImpl(
      `Delete this Pen on CodePen (moves to Deleted Items for 3 days) and remove ${PROJECT_CONFIG_FILENAME}?`,
      false,
    );
    if (!ok) {
      console.log('Aborted.');
      return null;
    }
  }

  await client.deletePen(project.config.pen_id);

  // Remove `.cdpn.json` only after remote deletion succeeded
  await fs.unlink(project.configPath);

  console.log(
    `\n${fmt.green('✓')} Deleted ${fmt.bold(pen.title || 'Untitled')} ${fmt.dim(`(${pen.id})`)} on CodePen ${fmt.dim('(moved to Deleted Items; restorable for 3 days)')}`,
  );
  if (auth.profile) {
    console.log(`  Profile: ${fmt.cyan(auth.profile)}`);
  }
  console.log(`  Removed: ${fmt.cyan(PROJECT_CONFIG_FILENAME)} ${fmt.dim('(local files were kept untouched)')}`);
  console.log(`  Restore: ${fmt.dim(CODEPEN_DELETED_ITEMS_URL)}`);

  return {
    pen,
    project,
    auth,
    configRemoved: true,
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
    .option('-y, --yes', 'Skip confirmation prompt')
    .action(async (options: DeleteCliOptions, command: Command) => {
      await deletePenCommand({
        yes: options.yes,
        explicitProfile: getGlobalProfileOption(command),
      });
    });
}
