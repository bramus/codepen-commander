import fs from 'node:fs/promises';
import path from 'node:path';
import type { CodePenClient } from '../api/client.js';
import { CodePenApiError, isCodePenApiError } from '../api/errors.js';
import type { Pen, TrashItem } from '../api/types.js';
import type { ResolvedAuth } from '../config/auth.js';
import {
  normalizePartialPenInfo,
  writeUnlinkedProjectInfo,
  type PenInfo,
  type ProjectLocation,
} from '../config/project.js';
import { CODEPEN_DELETED_ITEMS_URL, CODEPEN_DIR, PROJECT_CONFIG_FILENAME } from '../constants.js';
import { CliError } from '../errors.js';
import { extractPenIdFromUrl } from '../utils/codepen-url.js';
import { fmt, formatDate } from '../utils/format.js';
import { isWithinRoot } from '../utils/fs-safe.js';
import { defaultOutput, type CommandOutput } from '../utils/output.js';
import {
  promptConfirm,
  promptSelect,
  type SelectOption,
} from '../utils/prompts/index.js';

export { CODEPEN_DELETED_ITEMS_URL };

export interface MissingPenPrompts {
  select?: <T extends string>(
    question: string,
    options: SelectOption<T>[],
    defaultIndex?: number,
  ) => Promise<T>;
  confirm?: (question: string, defaultYes?: boolean) => Promise<boolean>;
}

export interface HandleMissingRemotePenOptions {
  client: CodePenClient;
  project: ProjectLocation;
  auth?: Pick<ResolvedAuth, 'profile'> | null;
  /** Command name shown in tips and menu descriptions (e.g. `status`, `pull`, `push`). */
  commandName: string;
  interactive: boolean;
  json?: boolean;
  output?: CommandOutput;
  prompts?: MissingPenPrompts;
}

export type MissingPenResolution =
  | { action: 'recovered'; pen: Pen; trashItem: TrashItem }
  | { action: 'purged'; trashItem: TrashItem; unlinkedInfo: PenInfo }
  | { action: 'unlinked'; trashItem: TrashItem | null; unlinkedInfo: PenInfo }
  | { action: 'canceled'; trashItem: TrashItem | null };

export type FetchLinkedPenResult =
  | { found: true; pen: Pen; recoveredFromTrash: boolean }
  | { found: false; resolution: Exclude<MissingPenResolution, { action: 'recovered' }> };

export function isRemotePenNotFoundError(error: unknown): error is CodePenApiError {
  return isCodePenApiError(error) && error.status === 404;
}

/**
 * Clears all online-link fields (`url`, `pen_id`, `profile`, `last_synced_version_id`,
 * `last_synced_info_hash`, `editor`, `files`) from `.cdpn.json`, leaving an unlinked
 * info-only `.cdpn.json` so the demo stays recognized locally and can be re-pushed as a new Pen.
 */
export async function unlinkLinkedProject(
  project: ProjectLocation,
  fallbackTitle?: string,
): Promise<{ configPath: string; info: PenInfo }> {
  const info: PenInfo = normalizePartialPenInfo(project.config.info ?? {});
  if (!info.title && fallbackTitle?.trim()) {
    info.title = fallbackTitle.trim();
  }
  const configPath = await writeUnlinkedProjectInfo(project.rootDir, info);
  return { configPath, info };
}

/**
 * Safely removes `<rootDir>/.codepen/` if it is a regular directory strictly within `rootDir`.
 * Never follows symlinks. Returns `true` if `.codepen/` existed and was removed.
 */
export async function removeCodepenDirSafe(rootDir: string): Promise<boolean> {
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
 * Checks CodePen's Trash (`GET /v2/trash`) for the Pen referenced by `project`.
 * Gracefully returns `null` if not found or if the trash endpoint is unavailable.
 */
export async function findProjectPenInTrash(
  client: CodePenClient,
  project: ProjectLocation,
): Promise<TrashItem | null> {
  const ids = [project.config.pen_id];
  const urlPenId = extractPenIdFromUrl(project.config.url);
  if (urlPenId && !ids.includes(urlPenId)) {
    ids.push(urlPenId);
  }
  try {
    return await client.findTrashedPen(ids);
  } catch {
    return null;
  }
}

/**
 * Handles a `404 NOT_FOUND` error for a locally linked Pen across `cdpn` commands:
 *
 * - First checks CodePen's Deleted Items (`GET /v2/trash`).
 * - If found in Trash interactively, offers a choice menu:
 *   1. Recover the Pen from Trash (`POST /v2/pens/{id}/restore`) and continue
 *   2. Delete the Pen permanently (`DELETE /v2/trash/pens/{id}`) and unlink `.cdpn.json`
 *   3. Unlink the local copy from the Pen (clear remote link fields in `.cdpn.json`)
 *   4. Do nothing (exit)
 * - If not found in Trash interactively, informs the user the Pen no longer exists on CodePen
 *   and offers to unlink `.cdpn.json`.
 * - In non-interactive or `--json` mode, throws a structured `CliError(404)` with helpful guidance.
 */
export async function handleMissingRemotePen(
  options: HandleMissingRemotePenOptions,
): Promise<MissingPenResolution> {
  const { client, project, auth, commandName, interactive } = options;
  const output = options.output ?? defaultOutput;
  const selectImpl = options.prompts?.select ?? promptSelect;
  const confirmImpl = options.prompts?.confirm ?? promptConfirm;

  const trashItem = await findProjectPenInTrash(client, project);
  const displayTitle = trashItem?.title || project.config.info?.title || 'Untitled';
  const activeProfile = auth?.profile ?? project.config.profile ?? null;

  if (trashItem) {
    if (!interactive) {
      throw new CliError(
        404,
        `Pen "${displayTitle}" (${project.config.pen_id}) is currently in CodePen’s Deleted Items (Trash; expires ${formatDate(trashItem.expires_at)}).\n` +
          `Run \`cdpn restore\` to restore it on CodePen, run \`cdpn ${commandName}\` interactively to manage it, or restore it at ${CODEPEN_DELETED_ITEMS_URL}.`,
        {
          pen_id: project.config.pen_id,
          url: project.config.url,
          profile: activeProfile,
          in_trash: true,
          trash_item: trashItem,
          restore_url: CODEPEN_DELETED_ITEMS_URL,
        },
      );
    }

    output.log('');
    output.log(
      `${fmt.boldYellow('!')} Pen ${fmt.bold(displayTitle)} ${fmt.dim(`(${project.config.pen_id})`)} was deleted on CodePen and is currently in ${fmt.bold('Deleted Items (Trash)')}.`,
    );
    output.log(
      `  ${fmt.dim('Deleted:')} ${formatDate(trashItem.deleted_at)}  ${fmt.dim('·')}  ${fmt.dim('Expires:')} ${fmt.yellow(formatDate(trashItem.expires_at))}`,
    );
    output.log(`  ${fmt.dim('URL:')}     ${fmt.cyan(project.config.url)}`);
    output.log('');

    const choice = await selectImpl<'recover' | 'purge' | 'unlink' | 'cancel'>(
      'What would you like to do?',
      [
        {
          value: 'recover',
          label: 'Restore the Pen from Trash',
          description: `restore it on CodePen and continue \`cdpn ${commandName}\``,
        },
        {
          value: 'purge',
          label: 'Delete the Pen permanently',
          description: `purge from CodePen Trash and unlink ${PROJECT_CONFIG_FILENAME}`,
        },
        {
          value: 'unlink',
          label: 'Unlink local copy from this Pen',
          description: `clear remote link in ${PROJECT_CONFIG_FILENAME} so you can re-push as a new Pen`,
        },
        {
          value: 'cancel',
          label: 'Do nothing (exit)',
          description: `leave Trash and ${PROJECT_CONFIG_FILENAME} untouched`,
        },
      ],
      0,
    );

    if (choice === 'recover') {
      const pen = await client.restorePen(trashItem.item_id);
      output.log(
        `\n${fmt.boldGreen('✓')} Restored ${fmt.bold(pen.title || displayTitle)} ${fmt.dim(`(${pen.id})`)} from CodePen Trash.\n`,
      );
      return { action: 'recovered', pen, trashItem };
    }

    if (choice === 'purge') {
      const confirmed = await confirmImpl(
        `Permanently delete "${displayTitle}" (${trashItem.item_id}) from CodePen Trash? This cannot be undone.`,
        false,
      );
      if (!confirmed) {
        output.log(fmt.dim('Aborted.'));
        return { action: 'canceled', trashItem };
      }

      await client.purgeTrashedPen(trashItem.item_id);
      const { info: unlinkedInfo } = await unlinkLinkedProject(project, trashItem.title);
      output.log(
        `\n${fmt.boldGreen('✓')} Permanently deleted ${fmt.bold(displayTitle)} ${fmt.dim(`(${trashItem.item_id})`)} from CodePen Trash.`,
      );
      output.log(
        `  ${fmt.dim('Unlinked:')} ${fmt.cyan(PROJECT_CONFIG_FILENAME)} ${fmt.dim('(cleared remote link; Pen info & local files kept untouched)')}`,
      );
      output.log(
        `  ${fmt.dim('Tip:')}      Run \`cdpn push\` anytime to publish this folder as a new Pen on CodePen.`,
      );
      return { action: 'purged', trashItem, unlinkedInfo };
    }

    if (choice === 'unlink') {
      const { info: unlinkedInfo } = await unlinkLinkedProject(project, trashItem.title);
      output.log(
        `\n${fmt.boldGreen('✓')} Unlinked local folder from Pen ${fmt.dim(`(${project.config.pen_id})`)}.`,
      );
      output.log(
        `  ${fmt.dim('Updated:')} ${fmt.cyan(PROJECT_CONFIG_FILENAME)} ${fmt.dim('(cleared remote link; Pen info & local files kept untouched)')}`,
      );
      output.log(
        `  ${fmt.dim('Note:')}    The deleted Pen remains in CodePen Trash until ${formatDate(trashItem.expires_at)} (${CODEPEN_DELETED_ITEMS_URL}).`,
      );
      output.log(
        `  ${fmt.dim('Tip:')}     Run \`cdpn push\` anytime to publish this folder as a new Pen on CodePen.`,
      );
      return { action: 'unlinked', trashItem, unlinkedInfo };
    }

    output.log(fmt.dim('No changes made.'));
    return { action: 'canceled', trashItem };
  }

  // Not found on CodePen and not in Trash
  if (!interactive) {
    const profileHint = activeProfile ? ` (active profile: ${activeProfile})` : '';
    throw new CliError(
      404,
      `Pen "${displayTitle}" (${project.config.pen_id}) no longer exists on CodePen.\n` +
        `It may have been permanently deleted, or belongs to a different account/profile${profileHint}.\n` +
        `Run \`cdpn ${commandName}\` interactively to unlink ${PROJECT_CONFIG_FILENAME}, \`cdpn unlink --yes\` to clear the remote link, or pass --profile <name> if another profile owns it.`,
      {
        pen_id: project.config.pen_id,
        url: project.config.url,
        profile: activeProfile,
        in_trash: false,
      },
    );
  }

  output.log('');
  output.log(
    `${fmt.boldYellow('!')} Pen ${fmt.bold(displayTitle)} ${fmt.dim(`(${project.config.pen_id})`)} no longer exists on CodePen (and is not in Deleted Items).`,
  );
  output.log(
    fmt.dim('  It may have been permanently deleted on CodePen, or belongs to a different account/profile.'),
  );
  output.log(`  ${fmt.dim('URL:')}     ${fmt.cyan(project.config.url)}`);
  if (activeProfile) {
    output.log(`  ${fmt.dim('Profile:')} ${fmt.cyan(activeProfile)}`);
  }
  output.log('');

  const shouldUnlink = await confirmImpl(
    `Unlink this local folder from the missing Pen (clears remote link in ${PROJECT_CONFIG_FILENAME}, keeps Pen info & local files)?`,
    true,
  );
  if (!shouldUnlink) {
    output.log(
      fmt.dim(
        `Kept ${PROJECT_CONFIG_FILENAME} unchanged. Tip: if another profile owns this Pen, re-run with --profile <name>.`,
      ),
    );
    return { action: 'canceled', trashItem: null };
  }

  const { info: unlinkedInfo } = await unlinkLinkedProject(project);
  output.log(
    `\n${fmt.boldGreen('✓')} Unlinked local folder from missing Pen ${fmt.dim(`(${project.config.pen_id})`)}.`,
  );
  output.log(
    `  ${fmt.dim('Updated:')} ${fmt.cyan(PROJECT_CONFIG_FILENAME)} ${fmt.dim('(cleared remote link; Pen info & local files kept untouched)')}`,
  );
  output.log(
    `  ${fmt.dim('Tip:')}     Run \`cdpn push\` anytime to publish this folder as a new Pen on CodePen.`,
  );
  return { action: 'unlinked', trashItem: null, unlinkedInfo };
}

/**
 * Fetches the remote Pen for a linked `.cdpn.json` project, automatically invoking
 * `handleMissingRemotePen` if CodePen returns `404 NOT_FOUND`.
 */
export async function fetchLinkedPenOrHandleMissing(
  options: HandleMissingRemotePenOptions,
): Promise<FetchLinkedPenResult> {
  try {
    const pen = await options.client.getPen(options.project.config.pen_id);
    return { found: true, pen, recoveredFromTrash: false };
  } catch (error) {
    if (!isRemotePenNotFoundError(error)) {
      throw error;
    }
    const resolution = await handleMissingRemotePen(options);
    if (resolution.action === 'recovered') {
      return { found: true, pen: resolution.pen, recoveredFromTrash: true };
    }
    return { found: false, resolution };
  }
}
