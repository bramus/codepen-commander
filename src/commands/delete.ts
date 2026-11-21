import fs from 'node:fs/promises';
import path from 'node:path';
import type { Command } from 'commander';
import { CodePenClient } from '../api/client.js';
import type { ResolvedAuth } from '../config/auth.js';
import {
  PROJECT_CONFIG_FILENAME,
  requireProjectInDir,
  writeUnlinkedProjectInfo,
  type ProjectLocation,
} from '../config/project.js';
import { CODEPEN_DIR, isWithinRoot } from '../site/blocks.js';
import { analyzeInfoSync, extractPenInfo, normalizePartialPenInfo } from '../sync/info.js';
import type { CompletePenInfo, Pen, PenInfo, TrashItem } from '../types.js';
import { fmt, formatDate } from '../utils/format.js';
import { CliError, printJsonResponse } from '../utils/json.js';
import {
  isInteractive,
  promptConfirm,
  promptSelect,
  type SelectOption,
} from '../utils/prompts.js';
import { getGlobalProfileOption, resolveCommandAuth } from './auth-context.js';
import {
  CODEPEN_DELETED_ITEMS_URL,
  findProjectPenInTrash,
  isRemotePenNotFoundError,
  unlinkLinkedProject,
} from './missing-pen.js';

export { CODEPEN_DELETED_ITEMS_URL };

export interface DeleteCliOptions {
  yes?: boolean;
  keepConfig?: boolean;
  keepInfo?: boolean;
  json?: boolean;
}

export interface DeletePenCommandOptions {
  /** Skip confirmation prompt (required in non-interactive mode). */
  yes?: boolean;
  /** Retain `.codepen/` and only the `info` section in `.cdpn.json` (unlinked) instead of removing them. */
  keepConfig?: boolean;
  /** Backwards-compatible alias for `keepConfig`. */
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
  pen: Pen | null;
  project: ProjectLocation;
  auth: ResolvedAuth;
  configRemoved: boolean;
  codepenDirRemoved: boolean;
  infoRetained: boolean;
  retainedInfo?: PenInfo | CompletePenInfo;
  alreadyDeletedRemotely?: boolean;
  purgedFromTrash?: boolean;
  recoveredFromTrash?: boolean;
  trashItem?: TrashItem | null;
}

/**
 * Safely removes `<rootDir>/.codepen/` if it is a regular directory strictly within `rootDir`.
 * Never follows symlinks. Returns `true` if `.codepen/` existed and was removed.
 */
async function removeCodepenDirSafe(rootDir: string): Promise<boolean> {
  const resolvedRoot = await fs.realpath(rootDir);
  const codepenDir = path.join(resolvedRoot, CODEPEN_DIR);
  let stat;
  try {
    stat = await fs.lstat(codepenDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }

  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    return false;
  }

  const realCodepenDir = await fs.realpath(codepenDir);
  if (!isWithinRoot(realCodepenDir, resolvedRoot) || realCodepenDir === resolvedRoot) {
    return false;
  }

  await fs.rm(realCodepenDir, { recursive: true, force: true });
  return true;
}

/**
 * Deletes the online Pen linked to `.cdpn.json` directly inside `options.cwd`
 * (moves it to CodePen Deleted Items, restorable for 3 days) and removes `.cdpn.json`
 * and `.codepen/` (or retains `.codepen/` and only the `info` section in `.cdpn.json`
 * when `keepConfig` / `keepInfo` is true) only after the remote deletion succeeds.
 * If the Pen was already deleted on CodePen, checks Trash and cleanly offers permanent
 * purge, local cleanup, or recovery instead of failing with 404. Local project source
 * files are kept untouched.
 *
 * Returns `null` if the user cancels at a confirmation prompt.
 */
export async function deletePenCommand(
  options: DeletePenCommandOptions = {},
): Promise<DeletePenResult | null> {
  const cwd = options.cwd ?? process.cwd();
  const keepConfig = Boolean(options.keepConfig || options.keepInfo);
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

  let pen: Pen | null = null;
  try {
    pen = await client.getPen(project.config.pen_id);
  } catch (error) {
    if (!isRemotePenNotFoundError(error)) {
      throw error;
    }
  }

  // Remote Pen is already gone (in Trash or permanently deleted)
  if (!pen) {
    const trashItem = await findProjectPenInTrash(client, project);
    const displayTitle = trashItem?.title || project.config.info?.title || 'Untitled';
    let purgedFromTrash = false;

    if (!options.yes) {
      if (!interactive) {
        throw new CliError(400, 'Refusing to delete Pen in non-interactive mode without --yes.');
      }

      if (trashItem) {
        console.log('');
        console.log(
          `${fmt.boldYellow('!')} Pen ${fmt.bold(displayTitle)} ${fmt.dim(`(${project.config.pen_id})`)} is already in CodePen’s ${fmt.bold('Deleted Items (Trash)')}.`,
        );
        console.log(
          `  ${fmt.dim('Deleted:')} ${formatDate(trashItem.deleted_at)}  ${fmt.dim('·')}  ${fmt.dim('Expires:')} ${fmt.yellow(formatDate(trashItem.expires_at))}`,
        );
        console.log(`  ${fmt.dim('URL:')}     ${fmt.cyan(project.config.url)}`);
        console.log('');

        const choice = await selectImpl<'purge' | 'cleanup' | 'recover' | 'cancel'>(
          'What would you like to do?',
          [
            {
              value: 'purge',
              label: 'Delete the Pen permanently from Trash',
              description: keepConfig
                ? `purge from CodePen Trash and keep ${CODEPEN_DIR}/ + only "info" in ${PROJECT_CONFIG_FILENAME}`
                : `purge from CodePen Trash and remove ${PROJECT_CONFIG_FILENAME} and ${CODEPEN_DIR}/`,
            },
            {
              value: 'cleanup',
              label: `Only clean up local ${PROJECT_CONFIG_FILENAME}${keepConfig ? '' : ` & ${CODEPEN_DIR}/`}`,
              description: keepConfig
                ? `leave Pen in Trash until expiry and keep ${CODEPEN_DIR}/ + only "info" in ${PROJECT_CONFIG_FILENAME}`
                : `leave Pen in Trash until expiry and remove ${PROJECT_CONFIG_FILENAME} and ${CODEPEN_DIR}/`,
            },
            {
              value: 'recover',
              label: 'Recover the Pen from Trash instead',
              description: `restore it on CodePen and keep ${PROJECT_CONFIG_FILENAME} linked`,
            },
            {
              value: 'cancel',
              label: 'Cancel (do nothing)',
              description: `leave Trash and ${PROJECT_CONFIG_FILENAME} untouched`,
            },
          ],
          0,
        );

        if (choice === 'cancel') {
          console.log('Aborted.');
          return null;
        }

        if (choice === 'recover') {
          const restoredPen = await client.restorePen(trashItem.item_id);
          console.log(
            `\n${fmt.boldGreen('✓')} Restored ${fmt.bold(restoredPen.title || displayTitle)} ${fmt.dim(`(${restoredPen.id})`)} from CodePen Trash ${fmt.dim(`(kept ${PROJECT_CONFIG_FILENAME} linked)`)}.`,
          );
          return {
            pen: restoredPen,
            project,
            auth,
            configRemoved: false,
            codepenDirRemoved: false,
            infoRetained: false,
            alreadyDeletedRemotely: false,
            purgedFromTrash: false,
            recoveredFromTrash: true,
            trashItem,
          };
        }

        if (choice === 'purge') {
          const confirmed = await confirmImpl(
            `Permanently delete "${displayTitle}" (${trashItem.item_id}) from CodePen Trash? This cannot be undone.`,
            false,
          );
          if (!confirmed) {
            console.log('Aborted.');
            return null;
          }
          await client.purgeTrashedPen(trashItem.item_id);
          purgedFromTrash = true;
        }
      } else {
        console.log('');
        console.log(
          `${fmt.boldYellow('!')} Pen ${fmt.bold(displayTitle)} ${fmt.dim(`(${project.config.pen_id})`)} no longer exists on CodePen (already deleted).`,
        );
        console.log(`  ${fmt.dim('URL:')} ${fmt.cyan(project.config.url)}`);
        console.log('');

        const ok = await confirmImpl(
          keepConfig
            ? `Clear the remote link in ${PROJECT_CONFIG_FILENAME} (keeping ${CODEPEN_DIR}/, "info", and local files)?`
            : `Remove local ${PROJECT_CONFIG_FILENAME} and ${CODEPEN_DIR}/ (local source files stay untouched)?`,
          true,
        );
        if (!ok) {
          console.log('Aborted.');
          return null;
        }
      }
    }

    let retainedInfo: PenInfo | undefined;
    let codepenDirRemoved = false;
    if (keepConfig) {
      const unlinked = await unlinkLinkedProject(project, trashItem?.title);
      retainedInfo = unlinked.info;
    } else {
      await fs.unlink(project.configPath);
      codepenDirRemoved = await removeCodepenDirSafe(project.rootDir);
    }

    const removedSummary = codepenDirRemoved
      ? `${PROJECT_CONFIG_FILENAME} and ${CODEPEN_DIR}/`
      : PROJECT_CONFIG_FILENAME;

    if (options.json) {
      const msg = trashItem
        ? keepConfig
          ? `Pen ${displayTitle} (${project.config.pen_id}) was already in CodePen Deleted Items; retained info in ${PROJECT_CONFIG_FILENAME} and ${CODEPEN_DIR}/.`
          : `Pen ${displayTitle} (${project.config.pen_id}) was already in CodePen Deleted Items; removed ${removedSummary}.`
        : keepConfig
          ? `Pen ${displayTitle} (${project.config.pen_id}) no longer exists on CodePen; retained info in ${PROJECT_CONFIG_FILENAME} and ${CODEPEN_DIR}/.`
          : `Pen ${displayTitle} (${project.config.pen_id}) no longer exists on CodePen; removed ${removedSummary}.`;

      printJsonResponse(200, msg, {
        pen_id: project.config.pen_id,
        title: displayTitle,
        profile: auth.profile,
        editor_url: project.config.url,
        deleted: true,
        already_deleted_remotely: true,
        in_trash: Boolean(trashItem),
        purged_from_trash: purgedFromTrash,
        ...(trashItem ? { trash_item: trashItem, restore_url: CODEPEN_DELETED_ITEMS_URL } : {}),
        config_removed: !keepConfig,
        codepen_dir_removed: codepenDirRemoved,
        info_retained: keepConfig,
        ...(keepConfig ? { info: retainedInfo } : {}),
      });
    } else {
      if (purgedFromTrash) {
        console.log(
          `\n${fmt.boldGreen('✓')} Permanently deleted ${fmt.bold(displayTitle)} ${fmt.dim(`(${project.config.pen_id})`)} from CodePen Trash.`,
        );
      } else if (trashItem) {
        console.log(
          `\n${fmt.boldGreen('✓')} Pen ${fmt.bold(displayTitle)} ${fmt.dim(`(${project.config.pen_id})`)} was already in CodePen Deleted Items.`,
        );
      } else {
        console.log(
          `\n${fmt.boldGreen('✓')} Pen ${fmt.bold(displayTitle)} ${fmt.dim(`(${project.config.pen_id})`)} no longer exists on CodePen.`,
        );
      }
      if (auth.profile) {
        console.log(`  Profile:  ${fmt.cyan(auth.profile)}`);
      }
      if (keepConfig) {
        console.log(
          `  Retained: ${fmt.cyan(`${CODEPEN_DIR}/ and info in ${PROJECT_CONFIG_FILENAME}`)} ${fmt.dim('(unlinked; local files were kept untouched)')}`,
        );
      } else {
        console.log(
          `  Removed:  ${fmt.cyan(removedSummary)} ${fmt.dim('(local files were kept untouched)')}`,
        );
      }
      if (trashItem && !purgedFromTrash) {
        console.log(`  Restore:  ${fmt.dim(CODEPEN_DELETED_ITEMS_URL)}`);
      }
    }

    return {
      pen: null,
      project,
      auth,
      configRemoved: !keepConfig,
      codepenDirRemoved,
      infoRetained: keepConfig,
      ...(retainedInfo ? { retainedInfo } : {}),
      alreadyDeletedRemotely: true,
      purgedFromTrash,
      recoveredFromTrash: false,
      trashItem,
    };
  }

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
        keepConfig
          ? `\nLocal files and ${CODEPEN_DIR}/ will stay untouched; only the "info" section will be kept in ${PROJECT_CONFIG_FILENAME} after deletion succeeds.`
          : `\nLocal source files will stay untouched; ${PROJECT_CONFIG_FILENAME} and ${CODEPEN_DIR}/ will be removed after deletion succeeds.`,
      ),
    );

    const ok = await confirmImpl(
      keepConfig
        ? `Delete this Pen on CodePen (moves to Deleted Items for 3 days) and keep only "info" in ${PROJECT_CONFIG_FILENAME} (and ${CODEPEN_DIR}/)?`
        : `Delete this Pen on CodePen (moves to Deleted Items for 3 days) and remove ${PROJECT_CONFIG_FILENAME} and ${CODEPEN_DIR}/?`,
      false,
    );
    if (!ok) {
      console.log('Aborted.');
      return null;
    }
  }

  let alreadyDeletedRemotely = false;
  try {
    await client.deletePen(project.config.pen_id);
  } catch (error) {
    if (isRemotePenNotFoundError(error)) {
      alreadyDeletedRemotely = true;
    } else {
      throw error;
    }
  }

  // Modify or remove `.cdpn.json` (and `.codepen/`) only after remote deletion succeeded (or Pen was already gone)
  let retainedInfo: CompletePenInfo | undefined;
  let codepenDirRemoved = false;
  if (keepConfig) {
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
    codepenDirRemoved = await removeCodepenDirSafe(project.rootDir);
  }

  const removedSummary = codepenDirRemoved
    ? `${PROJECT_CONFIG_FILENAME} and ${CODEPEN_DIR}/`
    : PROJECT_CONFIG_FILENAME;

  if (options.json) {
    if (keepConfig) {
      printJsonResponse(
        200,
        `Deleted ${pen.title || 'Untitled'} (${pen.id}) on CodePen and retained info in ${PROJECT_CONFIG_FILENAME} and ${CODEPEN_DIR}/.`,
        {
          pen_id: pen.id,
          title: pen.title,
          profile: auth.profile,
          editor_url: pen.urls.editor,
          deleted: true,
          ...(alreadyDeletedRemotely ? { already_deleted_remotely: true } : {}),
          config_removed: false,
          codepen_dir_removed: false,
          info_retained: true,
          info: retainedInfo,
          restore_url: CODEPEN_DELETED_ITEMS_URL,
        },
      );
    } else {
      printJsonResponse(
        200,
        `Deleted ${pen.title || 'Untitled'} (${pen.id}) on CodePen and removed ${removedSummary}.`,
        {
          pen_id: pen.id,
          title: pen.title,
          profile: auth.profile,
          editor_url: pen.urls.editor,
          deleted: true,
          ...(alreadyDeletedRemotely ? { already_deleted_remotely: true } : {}),
          config_removed: true,
          codepen_dir_removed: codepenDirRemoved,
          info_retained: false,
          restore_url: CODEPEN_DELETED_ITEMS_URL,
        },
      );
    }
  } else {
    console.log(
      `\n${fmt.green('✓')} Deleted ${fmt.bold(pen.title || 'Untitled')} ${fmt.dim(`(${pen.id})`)} on CodePen ${fmt.dim('(moved to Deleted Items; restorable for 3 days)')}`,
    );
    if (keepConfig) {
      if (auth.profile) {
        console.log(`  Profile:  ${fmt.cyan(auth.profile)}`);
      }
      console.log(
        `  Retained: ${fmt.cyan(`${CODEPEN_DIR}/ and info in ${PROJECT_CONFIG_FILENAME}`)} ${fmt.dim('(unlinked; local files were kept untouched)')}`,
      );
      console.log(`  Restore:  ${fmt.dim(CODEPEN_DELETED_ITEMS_URL)}`);
    } else {
      if (auth.profile) {
        console.log(`  Profile: ${fmt.cyan(auth.profile)}`);
      }
      console.log(`  Removed: ${fmt.cyan(removedSummary)} ${fmt.dim('(local files were kept untouched)')}`);
      console.log(`  Restore: ${fmt.dim(CODEPEN_DELETED_ITEMS_URL)}`);
    }
  }

  return {
    pen,
    project,
    auth,
    configRemoved: !keepConfig,
    codepenDirRemoved,
    infoRetained: keepConfig,
    ...(retainedInfo ? { retainedInfo } : {}),
    ...(alreadyDeletedRemotely ? { alreadyDeletedRemotely: true } : {}),
  };
}

export function registerDeleteCommand(program: Command): void {
  program
    .command('delete')
    .aliases(['del', 'rm'])
    .allowExcessArguments(false)
    .description(
      `Delete the online Pen on CodePen (moves to Deleted Items) and remove ${PROJECT_CONFIG_FILENAME} and ${CODEPEN_DIR}/`,
    )
    .option(
      '--keep-config',
      `Keep ${CODEPEN_DIR}/ and Pen info in ${PROJECT_CONFIG_FILENAME} (unlinked) so the demo stays ready for the next push`,
    )
    .option(
      '--keep-info',
      `Alias for --keep-config (keep ${CODEPEN_DIR}/ and Pen info in ${PROJECT_CONFIG_FILENAME})`,
    )
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--json', 'Output deletion result as JSON')
    .action(async (options: DeleteCliOptions, command: Command) => {
      await deletePenCommand({
        yes: options.yes,
        keepConfig: options.keepConfig,
        keepInfo: options.keepInfo,
        json: options.json,
        explicitProfile: getGlobalProfileOption(command),
      });
    });
}
