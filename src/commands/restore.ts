import type { Command } from 'commander';
import { CodePenClient } from '../api/client.js';
import type { Pen, TrashItem } from '../api/types.js';
import type { ResolvedAuth } from '../config/auth.js';
import { findNearestConfig, type ProjectLocation } from '../config/project.js';
import { CODEPEN_DELETED_ITEMS_URL, PROJECT_CONFIG_FILENAME } from '../constants.js';
import { CliError } from '../errors.js';
import { normalizePenReference } from '../utils/codepen-url.js';
import { fmt, formatDate } from '../utils/format.js';
import { printJsonResponse } from '../utils/json.js';
import { defaultOutput, type CommandOutput } from '../utils/output.js';
import { isInteractive, promptSelect, type SelectOption } from '../utils/prompts/index.js';
import { getGlobalProfileOption, resolveCommandAuth } from '../workflows/auth-context.js';
import { findProjectPenInTrash, isRemotePenNotFoundError } from '../workflows/missing-pen.js';

export interface RestoreCliOptions {
  json?: boolean;
}

export interface RunRestoreCommandOptions {
  /** Optional Pen URL or ID to restore (when omitted, uses the linked `.cdpn.json` or interactive Trash picker). */
  penArg?: string;
  /** Output structured JSON response instead of human-readable logs. */
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
    select?: <T extends string>(
      question: string,
      options: SelectOption<T>[],
      defaultIndex?: number,
    ) => Promise<T>;
  };
}

export interface RestoreCommandResult {
  pen: Pen;
  auth: ResolvedAuth;
  project: ProjectLocation | null;
  restored: boolean;
  alreadyActive: boolean;
  trashItem: TrashItem | null;
}

function emitRestoreSuccess(
  params: {
    pen: Pen;
    auth: ResolvedAuth;
    project: ProjectLocation | null;
    restored: boolean;
    alreadyActive: boolean;
    trashItem: TrashItem | null;
    json: boolean;
    output: CommandOutput;
  },
): RestoreCommandResult {
  const { pen, auth, project, restored, alreadyActive, trashItem, json, output } = params;
  const title = pen.title || trashItem?.title || 'Untitled';

  if (json) {
    const message = alreadyActive
      ? `Pen ${title} (${pen.id}) is already active on CodePen (not in Deleted Items).`
      : `Restored ${title} (${pen.id}) from CodePen Trash.`;
    printJsonResponse(
      200,
      message,
      {
        pen,
        pen_id: pen.id,
        title,
        profile: auth.profile,
        editor_url: pen.urls.editor,
        restored,
        already_active: alreadyActive,
        linked_project: project !== null,
        ...(trashItem ? { trash_item: trashItem } : {}),
      },
      output,
    );
  } else if (alreadyActive) {
    output.log(
      `${fmt.green('✓')} Pen ${fmt.bold(title)} ${fmt.dim(`(${pen.id})`)} is already active on CodePen ${fmt.dim('(not in Deleted Items)')}.`,
    );
    if (auth.profile) {
      output.log(`  Profile: ${fmt.cyan(auth.profile)}`);
    }
    output.log(`  Editor:  ${fmt.cyan(pen.urls.editor)}`);
  } else {
    output.log(
      `\n${fmt.boldGreen('✓')} Restored ${fmt.bold(title)} ${fmt.dim(`(${pen.id})`)} from CodePen Trash!`,
    );
    if (auth.profile) {
      output.log(`  Profile: ${fmt.cyan(auth.profile)}`);
    }
    output.log(`  Editor:  ${fmt.cyan(pen.urls.editor)}`);
    if (project) {
      output.log(
        `  ${fmt.dim(`${PROJECT_CONFIG_FILENAME} is still linked — run \`cdpn status\` to inspect or \`cdpn push\` / \`cdpn pull\` to sync.`)}`,
      );
    } else {
      output.log(`  ${fmt.dim(`Tip: Run \`cdpn clone ${pen.urls.editor}\` to clone it locally.`)}`);
    }
  }

  return {
    pen,
    auth,
    project,
    restored,
    alreadyActive,
    trashItem,
  };
}

/**
 * Restores a deleted Pen from CodePen Deleted Items (Trash) via `POST /v2/pens/{id}/restore`.
 *
 * Resolution order:
 * 1. Explicit `[pen]` URL or ID argument (`cdpn restore <id|url>`).
 * 2. Linked `.cdpn.json` in the current or parent directory (`cdpn restore`).
 * 3. Interactive Trash picker (`GET /v2/trash`) when invoked outside any Pen folder.
 *
 * Returns `null` when invoked interactively outside a Pen folder and Trash has no deleted Pens.
 */
export async function runRestoreCommand(
  options: RunRestoreCommandOptions = {},
): Promise<RestoreCommandResult | null> {
  const output = options.output ?? defaultOutput;
  const cwd = options.cwd ?? process.cwd();
  const jsonMode = Boolean(options.json);
  const interactive = !jsonMode && (options.interactive ?? isInteractive());
  const selectImpl = options.prompts?.select ?? promptSelect;

  const trimmedPenArg = options.penArg?.trim();

  // Case 1: Explicit Pen ID or URL provided
  if (trimmedPenArg) {
    const ref = normalizePenReference(trimmedPenArg);
    const auth = await resolveCommandAuth({
      explicitProfile: options.explicitProfile,
      urlHint: ref.originalUrl,
      autoSelectUrlMatch: true,
      interactive,
      promptMessage: 'Which CodePen profile owns this Pen?',
      output,
      env: options.env,
      homeDir: options.homeDir,
      selectProfile: selectImpl,
    });
    const client = new CodePenClient({ apiKey: auth.apiKey, baseUrl: options.baseUrl });

    // Check if Pen is already active (not in Trash)
    try {
      const activePen = await client.getPen(ref.apiIdentifier);
      return emitRestoreSuccess({
        pen: activePen,
        auth,
        project: null,
        restored: false,
        alreadyActive: true,
        trashItem: null,
        json: jsonMode,
        output,
      });
    } catch (error) {
      if (!isRemotePenNotFoundError(error)) {
        throw error;
      }
    }

    const trashItem = await client.findTrashedPen(ref.apiIdentifier);
    if (!trashItem) {
      const profileHint = auth.profile ? ` (active profile: ${auth.profile})` : '';
      throw new CliError(
        404,
        `Pen "${trimmedPenArg}" was not found in CodePen’s Deleted Items (Trash)${profileHint}.\n` +
          `It may have already expired or been permanently deleted, or belongs to a different account/profile.\n` +
          `Check ${CODEPEN_DELETED_ITEMS_URL} or re-run with --profile <name>.`,
        {
          pen_id: ref.apiIdentifier,
          profile: auth.profile,
          in_trash: false,
        },
      );
    }

    const restoredPen = await client.restorePen(trashItem.item_id);
    return emitRestoreSuccess({
      pen: restoredPen,
      auth,
      project: null,
      restored: true,
      alreadyActive: false,
      trashItem,
      json: jsonMode,
      output,
    });
  }

  // Case 2: Look for `.cdpn.json` in current or parent directory
  const nearest = await findNearestConfig(cwd);
  if (nearest && !nearest.linked) {
    throw new CliError(
      404,
      `${PROJECT_CONFIG_FILENAME} in ${nearest.rootDir} only contains Pen info and is not linked to an online Pen.\n` +
        'Pass a Pen URL or ID (`cdpn restore <url-or-id>`) to restore a specific deleted Pen, or run `cdpn push` to publish this folder as a new Pen.',
    );
  }

  if (nearest && nearest.linked) {
    const project: ProjectLocation = {
      rootDir: nearest.rootDir,
      configPath: nearest.configPath,
      config: nearest.config,
    };
    const auth = await resolveCommandAuth({
      explicitProfile: options.explicitProfile,
      project,
      interactive,
      persistProfileToProject: false,
      output,
      env: options.env,
      homeDir: options.homeDir,
      selectProfile: selectImpl,
    });
    const client = new CodePenClient({ apiKey: auth.apiKey, baseUrl: options.baseUrl });

    try {
      const activePen = await client.getPen(project.config.pen_id);
      return emitRestoreSuccess({
        pen: activePen,
        auth,
        project,
        restored: false,
        alreadyActive: true,
        trashItem: null,
        json: jsonMode,
        output,
      });
    } catch (error) {
      if (!isRemotePenNotFoundError(error)) {
        throw error;
      }
    }

    const trashItem = await findProjectPenInTrash(client, project);
    if (!trashItem) {
      const displayTitle = project.config.info?.title || 'Untitled';
      const profileHint = auth.profile ? ` (active profile: ${auth.profile})` : '';
      throw new CliError(
        404,
        `Pen "${displayTitle}" (${project.config.pen_id}) was not found in CodePen’s Deleted Items (Trash)${profileHint}.\n` +
          'It may have been permanently deleted or expired after 3 days, or belongs to a different account/profile.\n' +
          `Run \`cdpn unlink\` to clear the remote link in ${PROJECT_CONFIG_FILENAME} (keeping local files and Pen info), or re-run with --profile <name>.`,
        {
          pen_id: project.config.pen_id,
          url: project.config.url,
          profile: auth.profile,
          in_trash: false,
        },
      );
    }

    const restoredPen = await client.restorePen(trashItem.item_id);
    return emitRestoreSuccess({
      pen: restoredPen,
      auth,
      project,
      restored: true,
      alreadyActive: false,
      trashItem,
      json: jsonMode,
      output,
    });
  }

  // Case 3: No `.cdpn.json` and no explicit `[pen]` argument
  if (!interactive) {
    throw new CliError(
      400,
      `No ${PROJECT_CONFIG_FILENAME} found in this directory or any parent directory.\n` +
        'Pass a Pen URL or ID (`cdpn restore <url-or-id>`) or run `cdpn restore` interactively to pick a Pen from CodePen Trash.',
    );
  }

  const auth = await resolveCommandAuth({
    explicitProfile: options.explicitProfile,
    interactive,
    promptMessage: 'Which CodePen profile would you like to inspect Trash for?',
    output,
    env: options.env,
    homeDir: options.homeDir,
    selectProfile: selectImpl,
  });
  const client = new CodePenClient({ apiKey: auth.apiKey, baseUrl: options.baseUrl });

  const trashPage = await client.listTrash({ per_page: 50, sort: 'updated', direction: 'desc' });
  const trashedPens = trashPage.items.filter((item) => item.type === 'Pen');

  if (trashedPens.length === 0) {
    output.log(fmt.dim('No deleted Pens found in CodePen Trash.'));
    return null;
  }

  const selectedItemId = await selectImpl(
    'Select a deleted Pen to restore from CodePen Trash:',
    trashedPens.map((item) => ({
      value: item.item_id,
      label: `${item.title || 'Untitled'} (${item.item_id})`,
      description: `deleted ${formatDate(item.deleted_at)} · expires ${formatDate(item.expires_at)}`,
    })),
    0,
  );

  const chosen = trashedPens.find((item) => item.item_id === selectedItemId) ?? null;
  const restoredPen = await client.restorePen(selectedItemId);

  return emitRestoreSuccess({
    pen: restoredPen,
    auth,
    project: null,
    restored: true,
    alreadyActive: false,
    trashItem: chosen,
    json: jsonMode,
    output,
  });
}

export function registerRestoreCommand(program: Command): void {
  program
    .command('restore [pen]')
    .description('Restore a deleted Pen from CodePen Deleted Items (Trash)')
    .option('--json', 'Output restore result as JSON')
    .action(async (penArg: string | undefined, options: RestoreCliOptions, command: Command) => {
      await runRestoreCommand({
        penArg,
        json: options.json,
        explicitProfile: getGlobalProfileOption(command),
      });
    });
}
