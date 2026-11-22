import fs from 'node:fs/promises';
import path from 'node:path';
import type { Command } from 'commander';
import { CodePenClient } from '../api/client.js';
import type { Pen, TrashItem } from '../api/types.js';
import type { ResolvedAuth } from '../config/auth.js';
import {
  findProject,
  hasProjectConfigInDir,
  normalizePartialPenInfo,
  requireProjectInDir,
  writeUnlinkedProjectInfo,
  type CompletePenInfo,
  type PenInfo,
  type ProjectLocation,
} from '../config/project.js';
import {
  CODEPEN_DELETED_ITEMS_URL,
  CODEPEN_DIR,
  PROJECT_CONFIG_FILENAME,
} from '../constants.js';
import { CliError } from '../errors.js';
import { analyzeInfoSync, extractPenInfo } from '../sync/info.js';
import { fmt, formatDate } from '../utils/format.js';
import { printJsonResponse } from '../utils/json.js';
import { defaultOutput, type CommandOutput } from '../utils/output.js';
import {
  isInteractive,
  promptConfirm,
  promptSelect,
  type SelectOption,
} from '../utils/prompts/index.js';
import { getGlobalProfileOption, resolveCommandAuth } from '../workflows/auth-context.js';
import { runBatchDelete, type BatchExecutionResult } from '../workflows/batch-pens.js';
import { discoverPenDirectories } from '../workflows/discover-pens.js';
import {
  findProjectPenInTrash,
  isRemotePenNotFoundError,
  removeCodepenDirSafe,
  unlinkLinkedProject,
} from '../workflows/missing-pen.js';

export { CODEPEN_DELETED_ITEMS_URL };

export interface DeleteCliOptions {
  yes?: boolean;
  dryRun?: boolean;
  cleanup?: boolean;
  fullCleanup?: boolean;
  json?: boolean;
}

export interface RunDeleteCommandOptions {
  /** Skip confirmation prompt (required in non-interactive mode). */
  yes?: boolean;
  /** Preview what would be deleted without modifying CodePen or local files. */
  dryRun?: boolean;
  /** Remove `.codepen/` and strip `.cdpn.json` down to unlinked `info`-only after deleting the online Pen. */
  cleanup?: boolean;
  /** Remove both `.codepen/` and `.cdpn.json` after deleting the online Pen (local source files stay untouched). */
  fullCleanup?: boolean;
  /** Output structured JSON response instead of human-readable logs. */
  json?: boolean;
  /** Working directory (must contain `.cdpn.json` directly, or child Pen folders for batch mode; defaults to `process.cwd()`). */
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

export interface DeleteCommandResult {
  pen: Pen | null;
  project?: ProjectLocation;
  auth?: ResolvedAuth;
  configRemoved: boolean;
  codepenDirRemoved: boolean;
  configKeptLinked: boolean;
  infoRetained: boolean;
  dryRun?: boolean;
  retainedInfo?: PenInfo | CompletePenInfo;
  alreadyDeletedRemotely?: boolean;
  purgedFromTrash?: boolean;
  recoveredFromTrash?: boolean;
  trashItem?: TrashItem | null;
  batch?: BatchExecutionResult;
  exitCode?: number;
}

type LocalAction = 'keep-linked' | 'unlink-info' | 'cleanup' | 'full-cleanup';

/**
 * Deletes the online Pen linked to `.cdpn.json` directly inside `options.cwd`
 * (moves it to CodePen Deleted Items, restorable for 3 days).
 *
 * When invoked outside any Pen folder (with no `.cdpn.json` in `cwd` or any parent),
 * walks subdirectories to discover all Pens and deletes them in batch after an upfront
 * two-step confirmation (unless `--yes` or `--dry-run` is passed).
 *
 * Local file behavior:
 * - Default: keeps `.cdpn.json` (still linked) and `.codepen/` untouched so that
 *   a successive `cdpn status` detects the Pen in Trash and `cdpn restore` can restore it.
 * - `--cleanup`: removes `.codepen/` and strips `.cdpn.json` down to unlinked `info`-only.
 * - `--full-cleanup`: removes both `.codepen/` and `.cdpn.json`.
 *
 * Local project source files are always kept untouched.
 * Returns `null` if the user cancels at a confirmation prompt.
 */
export async function runDeleteCommand(
  options: RunDeleteCommandOptions = {},
): Promise<DeleteCommandResult | null> {
  const output = options.output ?? defaultOutput;
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const dryRun = Boolean(options.dryRun);
  const cleanup = Boolean(options.cleanup);
  const fullCleanup = Boolean(options.fullCleanup);
  const interactive = (options.interactive ?? isInteractive()) && !options.json;
  const confirmImpl = options.prompts?.confirm ?? promptConfirm;
  const selectImpl = options.prompts?.select ?? promptSelect;

  if (cleanup && fullCleanup) {
    throw new CliError(400, 'Cannot combine --cleanup and --full-cleanup.');
  }

  // Outside a Pen directory: preserve parent-dir refusal, otherwise enter batch tree-walk mode if child Pens exist
  if (!(await hasProjectConfigInDir(cwd))) {
    const parentDir = path.dirname(cwd);
    const hasParentProject = parentDir !== cwd && Boolean(await findProject(parentDir));
    if (!hasParentProject) {
      const discovered = await discoverPenDirectories(cwd);
      if (discovered.length > 0) {
        const batch = await runBatchDelete({
          rootDir: cwd,
          discovered,
          yes: options.yes,
          dryRun,
          cleanup,
          fullCleanup,
          json: options.json,
          interactive,
          explicitProfile: options.explicitProfile,
          baseUrl: options.baseUrl,
          env: options.env,
          homeDir: options.homeDir,
          output,
          prompts: options.prompts,
        });
        if (!batch) {
          return null;
        }
        return {
          pen: null,
          configRemoved: false,
          codepenDirRemoved: false,
          configKeptLinked: false,
          infoRetained: false,
          dryRun,
          batch,
          ...(batch.exitCode !== undefined ? { exitCode: batch.exitCode } : {}),
        };
      }
    }
  }

  // Strictly require `.cdpn.json` directly inside the current folder
  const project = await requireProjectInDir(cwd);

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
    let localAction: LocalAction = fullCleanup
      ? 'full-cleanup'
      : cleanup
        ? 'cleanup'
        : trashItem
          ? 'keep-linked'
          : 'unlink-info';

    if (dryRun) {
      const localNote =
        localAction === 'full-cleanup'
          ? `would remove ${PROJECT_CONFIG_FILENAME} and ${CODEPEN_DIR}/`
          : localAction === 'cleanup'
            ? `would remove ${CODEPEN_DIR}/ and retain info in ${PROJECT_CONFIG_FILENAME}`
            : localAction === 'unlink-info'
              ? `would clear remote link in ${PROJECT_CONFIG_FILENAME} (keeping ${CODEPEN_DIR}/ and info)`
              : `would keep ${PROJECT_CONFIG_FILENAME} and ${CODEPEN_DIR}/ untouched`;
      const statusText = trashItem
        ? 'already in CodePen Deleted Items'
        : 'no longer exists on CodePen';

      if (options.json) {
        printJsonResponse(
          200,
          `Dry run complete — Pen ${displayTitle} (${project.config.pen_id}) ${statusText}; ${localNote}.`,
          {
            pen_id: project.config.pen_id,
            title: displayTitle,
            profile: auth.profile,
            editor_url: project.config.url,
            deleted: false,
            dry_run: true,
            already_deleted_remotely: true,
            in_trash: Boolean(trashItem),
            ...(trashItem ? { trash_item: trashItem, restore_url: CODEPEN_DELETED_ITEMS_URL } : {}),
            planned_local_action: localAction,
          },
          output,
        );
      } else {
        output.log(
          `\n${fmt.yellow('× [WOULD DELETE]')} ${fmt.bold(displayTitle)} ${fmt.dim(`(${project.config.pen_id})`)} — ${statusText} (${localNote})`,
        );
        output.log(`\n${fmt.cyan('ℹ')} Dry run complete — no changes were made.`);
      }

      return {
        pen: null,
        project,
        auth,
        configRemoved: false,
        codepenDirRemoved: false,
        configKeptLinked: false,
        infoRetained: false,
        dryRun: true,
        alreadyDeletedRemotely: true,
        purgedFromTrash: false,
        recoveredFromTrash: false,
        trashItem,
      };
    }

    if (!options.yes) {
      if (!interactive) {
        throw new CliError(400, 'Refusing to delete Pen in non-interactive mode without --yes.');
      }

      if (trashItem) {
        output.log('');
        output.log(
          `${fmt.boldYellow('!')} Pen ${fmt.bold(displayTitle)} ${fmt.dim(`(${project.config.pen_id})`)} is already in CodePen’s ${fmt.bold('Deleted Items (Trash)')}.`,
        );
        output.log(
          `  ${fmt.dim('Deleted:')} ${formatDate(trashItem.deleted_at)}  ${fmt.dim('·')}  ${fmt.dim('Expires:')} ${fmt.yellow(formatDate(trashItem.expires_at))}`,
        );
        output.log(`  ${fmt.dim('URL:')}     ${fmt.cyan(project.config.url)}`);
        output.log('');

        type TrashChoice = 'purge' | 'unlink' | 'cleanup' | 'full-cleanup' | 'recover' | 'cancel';
        const menuOptions: SelectOption<TrashChoice>[] = [
          {
            value: 'purge',
            label: 'Delete the Pen permanently from Trash',
            description: fullCleanup
              ? `purge from CodePen Trash and remove ${PROJECT_CONFIG_FILENAME} and ${CODEPEN_DIR}/`
              : cleanup
                ? `purge from CodePen Trash, remove ${CODEPEN_DIR}/, and keep only "info" in ${PROJECT_CONFIG_FILENAME}`
                : `purge from CodePen Trash and unlink ${PROJECT_CONFIG_FILENAME} (keeps ${CODEPEN_DIR}/ and "info")`,
          },
        ];

        if (!cleanup && !fullCleanup) {
          menuOptions.push(
            {
              value: 'unlink',
              label: `Unlink local ${PROJECT_CONFIG_FILENAME} (keep ${CODEPEN_DIR}/ & "info")`,
              description: `leave Pen in Trash until expiry and clear remote link in ${PROJECT_CONFIG_FILENAME}`,
            },
            {
              value: 'cleanup',
              label: `Remove ${CODEPEN_DIR}/ and keep only "info" in ${PROJECT_CONFIG_FILENAME}`,
              description: `leave Pen in Trash until expiry, remove ${CODEPEN_DIR}/, and unlink ${PROJECT_CONFIG_FILENAME}`,
            },
            {
              value: 'full-cleanup',
              label: `Remove local ${PROJECT_CONFIG_FILENAME} & ${CODEPEN_DIR}/`,
              description: `leave Pen in Trash until expiry and remove ${PROJECT_CONFIG_FILENAME} and ${CODEPEN_DIR}/`,
            },
          );
        } else if (cleanup) {
          menuOptions.push({
            value: 'cleanup',
            label: `Only remove ${CODEPEN_DIR}/ and keep "info" in ${PROJECT_CONFIG_FILENAME}`,
            description: `leave Pen in Trash until expiry, remove ${CODEPEN_DIR}/, and unlink ${PROJECT_CONFIG_FILENAME}`,
          });
        } else {
          menuOptions.push({
            value: 'full-cleanup',
            label: `Only remove local ${PROJECT_CONFIG_FILENAME} & ${CODEPEN_DIR}/`,
            description: `leave Pen in Trash until expiry and remove ${PROJECT_CONFIG_FILENAME} and ${CODEPEN_DIR}/`,
          });
        }

        menuOptions.push(
          {
            value: 'recover',
            label: 'Restore the Pen from Trash instead',
            description: `restore it on CodePen and keep ${PROJECT_CONFIG_FILENAME} linked`,
          },
          {
            value: 'cancel',
            label: 'Cancel (do nothing)',
            description: `leave Trash and ${PROJECT_CONFIG_FILENAME} untouched`,
          },
        );

        const choice = await selectImpl<TrashChoice>('What would you like to do?', menuOptions, 0);

        if (choice === 'cancel') {
          output.log('Aborted.');
          return null;
        }

        if (choice === 'recover') {
          const restoredPen = await client.restorePen(trashItem.item_id);
          output.log(
            `\n${fmt.boldGreen('✓')} Restored ${fmt.bold(restoredPen.title || displayTitle)} ${fmt.dim(`(${restoredPen.id})`)} from CodePen Trash ${fmt.dim(`(kept ${PROJECT_CONFIG_FILENAME} linked)`)}.`,
          );
          return {
            pen: restoredPen,
            project,
            auth,
            configRemoved: false,
            codepenDirRemoved: false,
            configKeptLinked: true,
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
            output.log('Aborted.');
            return null;
          }
          await client.purgeTrashedPen(trashItem.item_id);
          purgedFromTrash = true;
          localAction = fullCleanup ? 'full-cleanup' : cleanup ? 'cleanup' : 'unlink-info';
        } else if (choice === 'full-cleanup') {
          localAction = 'full-cleanup';
        } else if (choice === 'cleanup') {
          localAction = 'cleanup';
        } else if (choice === 'unlink') {
          localAction = 'unlink-info';
        }
      } else {
        output.log('');
        output.log(
          `${fmt.boldYellow('!')} Pen ${fmt.bold(displayTitle)} ${fmt.dim(`(${project.config.pen_id})`)} no longer exists on CodePen (already deleted).`,
        );
        output.log(`  ${fmt.dim('URL:')} ${fmt.cyan(project.config.url)}`);
        output.log('');

        const ok = await confirmImpl(
          fullCleanup
            ? `Remove local ${PROJECT_CONFIG_FILENAME} and ${CODEPEN_DIR}/ (local source files stay untouched)?`
            : cleanup
              ? `Remove ${CODEPEN_DIR}/ and keep only "info" in ${PROJECT_CONFIG_FILENAME} (local source files stay untouched)?`
              : `Clear the remote link in ${PROJECT_CONFIG_FILENAME} (keeping ${CODEPEN_DIR}/, "info", and local files)?`,
          true,
        );
        if (!ok) {
          output.log('Aborted.');
          return null;
        }
        localAction = fullCleanup ? 'full-cleanup' : cleanup ? 'cleanup' : 'unlink-info';
      }
    }

    let retainedInfo: PenInfo | undefined;
    let codepenDirRemoved = false;
    if (localAction === 'full-cleanup') {
      await fs.unlink(project.configPath);
      codepenDirRemoved = await removeCodepenDirSafe(project.rootDir);
    } else if (localAction === 'cleanup') {
      const unlinked = await unlinkLinkedProject(project, trashItem?.title);
      retainedInfo = unlinked.info;
      codepenDirRemoved = await removeCodepenDirSafe(project.rootDir);
    } else if (localAction === 'unlink-info') {
      const unlinked = await unlinkLinkedProject(project, trashItem?.title);
      retainedInfo = unlinked.info;
    }

    const configRemoved = localAction === 'full-cleanup';
    const infoRetained = localAction === 'cleanup' || localAction === 'unlink-info';
    const configKeptLinked = localAction === 'keep-linked';
    const removedSummary = codepenDirRemoved
      ? `${PROJECT_CONFIG_FILENAME} and ${CODEPEN_DIR}/`
      : PROJECT_CONFIG_FILENAME;

    if (options.json) {
      let msg: string;
      if (trashItem) {
        if (configRemoved) {
          msg = `Pen ${displayTitle} (${project.config.pen_id}) was already in CodePen Deleted Items; removed ${removedSummary}.`;
        } else if (localAction === 'cleanup') {
          msg = codepenDirRemoved
            ? `Pen ${displayTitle} (${project.config.pen_id}) was already in CodePen Deleted Items; removed ${CODEPEN_DIR}/ and retained info in ${PROJECT_CONFIG_FILENAME}.`
            : `Pen ${displayTitle} (${project.config.pen_id}) was already in CodePen Deleted Items; retained info in ${PROJECT_CONFIG_FILENAME}.`;
        } else if (localAction === 'unlink-info') {
          msg = `Pen ${displayTitle} (${project.config.pen_id}) was already in CodePen Deleted Items; retained info in ${PROJECT_CONFIG_FILENAME} and ${CODEPEN_DIR}/.`;
        } else {
          msg = `Pen ${displayTitle} (${project.config.pen_id}) is already in CodePen Deleted Items (kept ${PROJECT_CONFIG_FILENAME} and ${CODEPEN_DIR}/).`;
        }
      } else if (configRemoved) {
        msg = `Pen ${displayTitle} (${project.config.pen_id}) no longer exists on CodePen; removed ${removedSummary}.`;
      } else if (localAction === 'cleanup') {
        msg = codepenDirRemoved
          ? `Pen ${displayTitle} (${project.config.pen_id}) no longer exists on CodePen; removed ${CODEPEN_DIR}/ and retained info in ${PROJECT_CONFIG_FILENAME}.`
          : `Pen ${displayTitle} (${project.config.pen_id}) no longer exists on CodePen; retained info in ${PROJECT_CONFIG_FILENAME}.`;
      } else {
        msg = `Pen ${displayTitle} (${project.config.pen_id}) no longer exists on CodePen; retained info in ${PROJECT_CONFIG_FILENAME} and ${CODEPEN_DIR}/.`;
      }

      printJsonResponse(
        200,
        msg,
        {
          pen_id: project.config.pen_id,
          title: displayTitle,
          profile: auth.profile,
          editor_url: project.config.url,
          deleted: true,
          already_deleted_remotely: true,
          in_trash: Boolean(trashItem),
          purged_from_trash: purgedFromTrash,
          ...(trashItem ? { trash_item: trashItem, restore_url: CODEPEN_DELETED_ITEMS_URL } : {}),
          config_removed: configRemoved,
          codepen_dir_removed: codepenDirRemoved,
          config_kept_linked: configKeptLinked,
          info_retained: infoRetained,
          ...(infoRetained ? { info: retainedInfo } : {}),
        },
        output,
      );
    } else {
      if (purgedFromTrash) {
        output.log(
          `\n${fmt.boldGreen('✓')} Permanently deleted ${fmt.bold(displayTitle)} ${fmt.dim(`(${project.config.pen_id})`)} from CodePen Trash.`,
        );
      } else if (trashItem) {
        output.log(
          `\n${fmt.boldGreen('✓')} Pen ${fmt.bold(displayTitle)} ${fmt.dim(`(${project.config.pen_id})`)} is already in CodePen Deleted Items.`,
        );
      } else {
        output.log(
          `\n${fmt.boldGreen('✓')} Pen ${fmt.bold(displayTitle)} ${fmt.dim(`(${project.config.pen_id})`)} no longer exists on CodePen.`,
        );
      }
      if (auth.profile) {
        output.log(`  Profile:  ${fmt.cyan(auth.profile)}`);
      }
      if (configRemoved) {
        output.log(
          `  Removed:  ${fmt.cyan(removedSummary)} ${fmt.dim('(local files were kept untouched)')}`,
        );
      } else if (localAction === 'cleanup') {
        if (codepenDirRemoved) {
          output.log(`  Removed:  ${fmt.cyan(`${CODEPEN_DIR}/`)}`);
        }
        output.log(
          `  Retained: ${fmt.cyan(`info in ${PROJECT_CONFIG_FILENAME}`)} ${fmt.dim('(unlinked; local files were kept untouched)')}`,
        );
      } else if (localAction === 'unlink-info') {
        output.log(
          `  Retained: ${fmt.cyan(`${CODEPEN_DIR}/ and info in ${PROJECT_CONFIG_FILENAME}`)} ${fmt.dim('(unlinked; local files were kept untouched)')}`,
        );
      } else {
        output.log(
          `  Local:    ${fmt.cyan(`${PROJECT_CONFIG_FILENAME} and ${CODEPEN_DIR}/ kept untouched`)}`,
        );
      }
      if (trashItem && !purgedFromTrash) {
        output.log(
          `  Restore:  Run \`cdpn restore\` ${fmt.dim(`(or ${CODEPEN_DELETED_ITEMS_URL})`)}`,
        );
      }
    }

    return {
      pen: null,
      project,
      auth,
      configRemoved,
      codepenDirRemoved,
      configKeptLinked,
      infoRetained,
      ...(retainedInfo ? { retainedInfo } : {}),
      alreadyDeletedRemotely: true,
      purgedFromTrash,
      recoveredFromTrash: false,
      trashItem,
    };
  }

  const localAction: LocalAction = fullCleanup
    ? 'full-cleanup'
    : cleanup
      ? 'cleanup'
      : 'keep-linked';

  if (dryRun) {
    const localNote =
      localAction === 'full-cleanup'
        ? `would remove ${PROJECT_CONFIG_FILENAME} and ${CODEPEN_DIR}/`
        : localAction === 'cleanup'
          ? `would remove ${CODEPEN_DIR}/ and retain info in ${PROJECT_CONFIG_FILENAME}`
          : `would keep ${PROJECT_CONFIG_FILENAME} and ${CODEPEN_DIR}/ untouched`;

    if (options.json) {
      printJsonResponse(
        200,
        `Dry run complete — would delete ${pen.title || 'Untitled'} (${pen.id}) on CodePen (${localNote}).`,
        {
          pen_id: pen.id,
          title: pen.title,
          profile: auth.profile,
          editor_url: pen.urls.editor,
          deleted: false,
          dry_run: true,
          would_delete: true,
          planned_local_action: localAction,
        },
        output,
      );
    } else {
      output.log(
        `\n${fmt.yellow('× [WOULD DELETE]')} ${fmt.bold(pen.title || 'Untitled')} ${fmt.dim(`(${pen.id})`)}`,
      );
      if (auth.profile) {
        output.log(`  Profile: ${fmt.cyan(auth.profile)}`);
      }
      output.log(`  Editor:  ${fmt.cyan(pen.urls.editor)}`);
      if (pen.deployment) {
        output.log(
          `  Live:    ${fmt.yellow(pen.deployment.url)} ${fmt.dim('(would also be taken down)')}`,
        );
      }
      output.log(`  Local:   ${fmt.dim(localNote)}`);
      output.log(`\n${fmt.cyan('ℹ')} Dry run complete — no changes were made.`);
    }

    return {
      pen,
      project,
      auth,
      configRemoved: false,
      codepenDirRemoved: false,
      configKeptLinked: false,
      infoRetained: false,
      dryRun: true,
    };
  }

  if (!options.yes) {
    if (!interactive) {
      throw new CliError(400, 'Refusing to delete Pen in non-interactive mode without --yes.');
    }

    output.log(`\n${fmt.yellow('About to delete online Pen:')}`);
    output.log(`  Title:   ${fmt.bold(pen.title || 'Untitled')} ${fmt.dim(`(${pen.id})`)}`);
    if (auth.profile) {
      output.log(`  Profile: ${fmt.cyan(auth.profile)}`);
    }
    output.log(`  Editor:  ${fmt.cyan(pen.urls.editor)}`);
    if (pen.deployment) {
      output.log(
        `  Live:    ${fmt.yellow(pen.deployment.url)} ${fmt.dim('(will also be taken down)')}`,
      );
    }
    output.log(
      fmt.dim(
        localAction === 'full-cleanup'
          ? `\nLocal source files will stay untouched; ${PROJECT_CONFIG_FILENAME} and ${CODEPEN_DIR}/ will be removed after deletion succeeds.`
          : localAction === 'cleanup'
            ? `\nLocal source files will stay untouched; ${CODEPEN_DIR}/ will be removed and only the "info" section will be kept in ${PROJECT_CONFIG_FILENAME} (unlinked) after deletion succeeds.`
            : `\nLocal source files, ${PROJECT_CONFIG_FILENAME}, and ${CODEPEN_DIR}/ will stay untouched so you can restore the Pen with \`cdpn restore\` or inspect it with \`cdpn status\`.`,
      ),
    );

    const ok = await confirmImpl(
      localAction === 'full-cleanup'
        ? `Delete this Pen on CodePen (moves to Deleted Items for 3 days) and remove ${PROJECT_CONFIG_FILENAME} and ${CODEPEN_DIR}/?`
        : localAction === 'cleanup'
          ? `Delete this Pen on CodePen (moves to Deleted Items for 3 days), remove ${CODEPEN_DIR}/, and keep only "info" in ${PROJECT_CONFIG_FILENAME}?`
          : 'Delete this Pen on CodePen (moves to Deleted Items for 3 days)?',
      false,
    );
    if (!ok) {
      output.log('Aborted.');
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

  // Only mutate/remove local config files after remote deletion succeeds (or Pen was already gone)
  let retainedInfo: CompletePenInfo | undefined;
  let codepenDirRemoved = false;
  if (localAction === 'full-cleanup') {
    await fs.unlink(project.configPath);
    codepenDirRemoved = await removeCodepenDirSafe(project.rootDir);
  } else if (localAction === 'cleanup') {
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
    codepenDirRemoved = await removeCodepenDirSafe(project.rootDir);
  }

  const configRemoved = localAction === 'full-cleanup';
  const infoRetained = localAction === 'cleanup';
  const configKeptLinked = localAction === 'keep-linked';
  const removedSummary = codepenDirRemoved
    ? `${PROJECT_CONFIG_FILENAME} and ${CODEPEN_DIR}/`
    : PROJECT_CONFIG_FILENAME;

  if (options.json) {
    const message = configRemoved
      ? `Deleted ${pen.title || 'Untitled'} (${pen.id}) on CodePen and removed ${removedSummary}.`
      : infoRetained
        ? codepenDirRemoved
          ? `Deleted ${pen.title || 'Untitled'} (${pen.id}) on CodePen, removed ${CODEPEN_DIR}/, and retained info in ${PROJECT_CONFIG_FILENAME}.`
          : `Deleted ${pen.title || 'Untitled'} (${pen.id}) on CodePen and retained info in ${PROJECT_CONFIG_FILENAME}.`
        : `Deleted ${pen.title || 'Untitled'} (${pen.id}) on CodePen (kept ${PROJECT_CONFIG_FILENAME} and ${CODEPEN_DIR}/).`;

    printJsonResponse(
      200,
      message,
      {
        pen_id: pen.id,
        title: pen.title,
        profile: auth.profile,
        editor_url: pen.urls.editor,
        deleted: true,
        ...(alreadyDeletedRemotely ? { already_deleted_remotely: true } : {}),
        config_removed: configRemoved,
        codepen_dir_removed: codepenDirRemoved,
        config_kept_linked: configKeptLinked,
        info_retained: infoRetained,
        ...(infoRetained ? { info: retainedInfo } : {}),
        restore_url: CODEPEN_DELETED_ITEMS_URL,
      },
      output,
    );
  } else {
    output.log(
      `\n${fmt.green('✓')} Deleted ${fmt.bold(pen.title || 'Untitled')} ${fmt.dim(`(${pen.id})`)} on CodePen ${fmt.dim('(moved to Deleted Items; restorable for 3 days)')}`,
    );
    if (auth.profile) {
      output.log(`  Profile:  ${fmt.cyan(auth.profile)}`);
    }
    if (configRemoved) {
      output.log(
        `  Removed:  ${fmt.cyan(removedSummary)} ${fmt.dim('(local files were kept untouched)')}`,
      );
      output.log(`  Restore:  ${fmt.dim(CODEPEN_DELETED_ITEMS_URL)}`);
    } else if (infoRetained) {
      if (codepenDirRemoved) {
        output.log(`  Removed:  ${fmt.cyan(`${CODEPEN_DIR}/`)}`);
      }
      output.log(
        `  Retained: ${fmt.cyan(`info in ${PROJECT_CONFIG_FILENAME}`)} ${fmt.dim('(unlinked; local files were kept untouched)')}`,
      );
      output.log(`  Restore:  ${fmt.dim(CODEPEN_DELETED_ITEMS_URL)}`);
    } else {
      output.log(
        `  Local:    ${fmt.cyan(`${PROJECT_CONFIG_FILENAME} and ${CODEPEN_DIR}/ kept untouched`)}`,
      );
      output.log(
        `  Restore:  Run \`cdpn restore\` ${fmt.dim(`(or ${CODEPEN_DELETED_ITEMS_URL})`)}`,
      );
      output.log(
        `  ${fmt.dim(`Tip: Run \`cdpn unlink\` to unlink, \`cdpn delete --cleanup\` to remove ${CODEPEN_DIR}/ while keeping info, or \`cdpn delete --full-cleanup\` to remove both ${PROJECT_CONFIG_FILENAME} and ${CODEPEN_DIR}/.`)}`,
      );
    }
  }

  return {
    pen,
    project,
    auth,
    configRemoved,
    codepenDirRemoved,
    configKeptLinked,
    infoRetained,
    dryRun: false,
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
      `Delete the online Pen on CodePen (or walk subdirectories when run outside a Pen folder; keeps ${PROJECT_CONFIG_FILENAME} and ${CODEPEN_DIR}/ unless --cleanup or --full-cleanup is passed)`,
    )
    .option(
      '--cleanup',
      `Remove ${CODEPEN_DIR}/ and keep only the unlinked "info" section in ${PROJECT_CONFIG_FILENAME} (local source files stay untouched)`,
    )
    .option(
      '--full-cleanup',
      `Remove both ${CODEPEN_DIR}/ and ${PROJECT_CONFIG_FILENAME} (local source files stay untouched)`,
    )
    .option('--dry-run', 'Preview what would be deleted without modifying CodePen or local files')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--json', 'Output deletion result as JSON')
    .action(async (options: DeleteCliOptions, command: Command) => {
      const result = await runDeleteCommand({
        yes: options.yes,
        dryRun: options.dryRun,
        cleanup: options.cleanup,
        fullCleanup: options.fullCleanup,
        json: options.json,
        explicitProfile: getGlobalProfileOption(command),
      });
      if (result?.exitCode !== undefined) {
        process.exitCode = result.exitCode;
      }
    });
}
