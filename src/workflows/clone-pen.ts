import fs from 'node:fs/promises';
import path from 'node:path';
import { CodePenClient } from '../api/client.js';
import { CodePenApiError } from '../api/errors.js';
import type { Pen } from '../api/types.js';
import { findMatchingProfile, type ResolvedAuth } from '../config/auth.js';
import {
  buildSyncedFileMap,
  hasProjectConfigInDir,
  writeProjectConfig,
  type ProjectLocation,
} from '../config/project.js';
import { PROJECT_CONFIG_FILENAME } from '../constants.js';
import { CliError } from '../errors.js';
import { isDirectoryNonEmpty } from '../sync/fs.js';
import { buildPenInfoConfigFields } from '../sync/info.js';
import { syncRemoteFilesToDisk } from '../sync/materialize.js';
import {
  extractCodePenOwnerFromUrl,
  normalizePenReference,
  suggestFolderName,
} from '../utils/codepen-url.js';
import { fmt, shortId } from '../utils/format.js';
import { printJsonResponse } from '../utils/json.js';
import { defaultOutput, type CommandOutput } from '../utils/output.js';
import {
  isInteractive,
  promptConfirm,
  promptSecret,
  promptSelect,
  promptText,
  type SelectOption,
} from '../utils/prompts/index.js';
import { resolveCommandAuth } from './auth-context.js';
import { handleClassicPenClone, resolveCurrentUsername } from './classic-convert.js';
import {
  findUnmatchedStoredOwner,
  handlePenNotFoundOnFetch,
  handleUnownedPenAccess,
} from './unowned-pen.js';

export interface ForkUnownedPenCallbackResult {
  pen: Pen;
  sourcePen: Pen | null;
  writtenPaths: string[];
  auth: ResolvedAuth;
  project: ProjectLocation;
  exitCode?: number;
}

export interface ClonePenOptions {
  /** Mandatory CodePen Pen URL or ID to clone. */
  urlArg: string;
  /** Optional target local folder (prompted interactively or suggested from Pen title when omitted). */
  folderArg?: string;
  /** Overwrite files if the target directory already exists and is not empty. */
  force?: boolean;
  /** Output clone result as JSON. */
  json?: boolean;
  /** Working directory for resolving relative paths (defaults to `process.cwd()`). */
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
  /** Injectable browser launcher (for testing). */
  openBrowser?: (url: string) => Promise<boolean>;
  /** Whether to offer opening another user's Pen in the browser (defaults to true in interactive mode). */
  allowBrowserFallback?: boolean;
  /** Optional hook wired by `commands/clone.ts` to fork an unowned Pen interactively without creating a workflow cycle. */
  forkUnowned?: (params: {
    urlArg: string;
    folderArg?: string;
    cwd: string;
    resolvedAuth: ResolvedAuth;
    sourcePen: Pen;
    allowOverwrite: boolean;
    output: CommandOutput;
    baseUrl?: string;
    interactive: boolean;
    env?: NodeJS.ProcessEnv;
    homeDir?: string;
    openBrowser?: (url: string) => Promise<boolean>;
    prompts: {
      text: (question: string, defaultValue?: string) => Promise<string>;
      confirm: (question: string, defaultYes?: boolean) => Promise<boolean>;
      select: <T extends string>(
        question: string,
        options: SelectOption<T>[],
        defaultIndex?: number,
      ) => Promise<T>;
      secret: (question: string) => Promise<string>;
    };
  }) => Promise<ForkUnownedPenCallbackResult | null>;
  /** Injectable prompts (for testing). */
  prompts?: {
    text?: (question: string, defaultValue?: string) => Promise<string>;
    confirm?: (question: string, defaultYes?: boolean) => Promise<boolean>;
    secret?: (question: string) => Promise<string>;
    select?: <T extends string>(
      question: string,
      options: SelectOption<T>[],
      defaultIndex?: number,
    ) => Promise<T>;
  };
}

export interface ClonePenResult {
  pen: Pen;
  /** Original Pen when the user accepted the offer to fork an unowned Pen instead. */
  sourcePen?: Pen;
  /** Absolute path to the local directory where files were written. */
  rootDir: string;
  writtenPaths: string[];
  auth: ResolvedAuth;
  /** True when the user chose to fork instead of creating an unlinked local clone. */
  forked: boolean;
  /** True when `.cdpn.json` was written (linked to a CodePen 2.0 Pen owned by the current user). */
  linked: boolean;
  /** Populated when `linked` is true; `null` for unlinked local copies (another user's Pen or unconverted Classic Pen). */
  project: ProjectLocation | null;
  exitCode?: number;
}

async function ensureCloneTargetReady(
  targetDir: string,
  folderDisplay: string,
  options: {
    force: boolean;
    interactive: boolean;
    output: CommandOutput;
    confirmImpl: (question: string, defaultYes?: boolean) => Promise<boolean>;
  },
): Promise<boolean> {
  try {
    const stat = await fs.lstat(targetDir);
    if (!stat.isDirectory()) {
      throw new CliError(409, `Target path ${targetDir} already exists and is not a directory.`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return true;
    }
    throw error;
  }

  const [hasExistingConfig, nonEmpty] = await Promise.all([
    hasProjectConfigInDir(targetDir),
    isDirectoryNonEmpty(targetDir),
  ]);

  if ((nonEmpty || hasExistingConfig) && !options.force) {
    if (!options.interactive) {
      throw new CliError(
        409,
        `Target directory ${targetDir} is not empty. Pass --force to overwrite.`,
      );
    }
    const ok = await options.confirmImpl(
      `Directory ${fmt.bold(folderDisplay)} already exists and is not empty. Continue and overwrite matching files?`,
      false,
    );
    if (!ok) {
      options.output.log('Aborted.');
      return false;
    }
  }

  return true;
}

/**
 * Clones an existing CodePen Pen into a local folder.
 *
 * When the Pen's owner does not match the current authenticated account, offers to fork it
 * instead (interactively, via the optional `forkUnowned` hook). If not forked, downloads files
 * locally without writing `.cdpn.json` so the local folder is not linked to an online Pen owned
 * by another user.
 *
 * When the Pen is a Classic (v1) Pen (read-only through CodePen API v2), interactively offers
 * a choice to open it in the browser to convert to CodePen 2.0 first (waiting to re-fetch or
 * accept the new 2.0 URL for a linked clone) or to clone it locally without writing `.cdpn.json`.
 *
 * Returns `null` if the user cancels interactively.
 */
export async function clonePenWorkflow(
  options: ClonePenOptions,
): Promise<ClonePenResult | null> {
  const output = options.output ?? defaultOutput;
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const jsonMode = Boolean(options.json);
  const interactive = (options.interactive ?? isInteractive()) && !jsonMode;
  const force = Boolean(options.force);
  const textImpl = options.prompts?.text ?? promptText;
  const confirmImpl = options.prompts?.confirm ?? promptConfirm;
  const secretImpl = options.prompts?.secret ?? promptSecret;
  const selectImpl = options.prompts?.select ?? promptSelect;

  const { apiIdentifier, originalUrl } = normalizePenReference(options.urlArg);

  // If target folder was passed explicitly, validate before hitting the network
  let targetFolderDisplay = options.folderArg?.trim() || '';
  let targetDir: string | null = null;
  if (targetFolderDisplay) {
    targetDir = path.resolve(cwd, targetFolderDisplay);
    const ready = await ensureCloneTargetReady(targetDir, targetFolderDisplay, {
      force,
      interactive,
      output,
      confirmImpl,
    });
    if (!ready) {
      return null;
    }
  }

  const unmatched = await findUnmatchedStoredOwner({
    originalUrl,
    explicitProfile: options.explicitProfile,
    env: options.env,
    homeDir: options.homeDir,
  });
  if (unmatched && originalUrl) {
    const pastedUrl = await handleUnownedPenAccess({
      action: 'clone',
      penUrl: originalUrl,
      urlOwner: unmatched.urlOwner,
      availableProfiles: unmatched.availableProfiles,
      interactive,
      allowBrowserFallback: options.allowBrowserFallback,
      output,
      confirmImpl,
      textImpl,
      openBrowserImpl: options.openBrowser,
    });
    if (!pastedUrl) {
      return null;
    }
    return clonePenWorkflow({
      ...options,
      urlArg: pastedUrl,
      explicitProfile: undefined,
      allowBrowserFallback: false,
    });
  }

  let auth = await resolveCommandAuth({
    explicitProfile: options.explicitProfile,
    urlHint: originalUrl ?? options.urlArg,
    autoSelectUrlMatch: true,
    promptMessage: 'Which CodePen profile should be used for this Pen?',
    interactive,
    output,
    env: options.env,
    homeDir: options.homeDir,
    selectProfile: selectImpl,
  });
  let client = new CodePenClient({ apiKey: auth.apiKey, baseUrl: options.baseUrl });

  if (
    !jsonMode &&
    !options.explicitProfile &&
    auth.source === 'file' &&
    auth.profile &&
    auth.availableProfiles.length > 1 &&
    findMatchingProfile(auth.availableProfiles, originalUrl ?? options.urlArg) === auth.profile
  ) {
    output.log(fmt.dim(`Using profile "${auth.profile}" (matches Pen owner).`));
  }

  if (!jsonMode) {
    output.log(`Fetching Pen ${fmt.cyan(apiIdentifier)}…`);
  }
  let pen: Pen;
  try {
    pen = await client.getPen(apiIdentifier);
  } catch (error) {
    if (error instanceof CodePenApiError && error.status === 404) {
      const pastedUrl = await handlePenNotFoundOnFetch({
        action: 'clone',
        apiIdentifier,
        originalUrl,
        auth,
        client,
        interactive,
        allowBrowserFallback: options.allowBrowserFallback,
        output,
        confirmImpl,
        textImpl,
        openBrowserImpl: options.openBrowser,
      });
      if (!pastedUrl) {
        return null;
      }
      return clonePenWorkflow({
        ...options,
        urlArg: pastedUrl,
        explicitProfile: undefined,
        allowBrowserFallback: false,
      });
    }
    throw error;
  }

  // Check whether this Pen belongs to a stored profile (handles Pen IDs / preview URLs without an owner in the input)
  let penOwner =
    extractCodePenOwnerFromUrl(pen.urls.editor) ??
    (originalUrl ? extractCodePenOwnerFromUrl(originalUrl) : null);

  if (
    penOwner &&
    !options.explicitProfile &&
    auth.source === 'file' &&
    auth.profile?.toLowerCase() !== penOwner.toLowerCase()
  ) {
    const matchedStoredProfile = findMatchingProfile(auth.availableProfiles, pen.urls.editor);
    if (matchedStoredProfile && matchedStoredProfile !== auth.profile) {
      auth = await resolveCommandAuth({
        explicitProfile: matchedStoredProfile,
        interactive,
        output,
        env: options.env,
        homeDir: options.homeDir,
      });
      client = new CodePenClient({ apiKey: auth.apiKey, baseUrl: options.baseUrl });
      if (!jsonMode) {
        output.log(fmt.dim(`Using profile "${matchedStoredProfile}" (matches Pen owner).`));
      }
    }
  }

  let currentUsername = penOwner ? await resolveCurrentUsername(client, auth, penOwner) : null;
  let isOwnedByAnotherUser = Boolean(
    penOwner && currentUsername && penOwner.toLowerCase() !== currentUsername.toLowerCase(),
  );
  let effectiveUrl = originalUrl ?? pen.urls.editor;

  if (isOwnedByAnotherUser && penOwner && currentUsername) {
    if (!jsonMode) {
      output.log(
        fmt.yellow(
          `\nThis Pen belongs to ${fmt.bold(penOwner)} (your current account is ${fmt.bold(currentUsername)}).`,
        ),
      );
    }

    if (interactive && options.forkUnowned) {
      const shouldFork = await confirmImpl(
        `Fork this Pen under ${currentUsername} instead?`,
        true,
      );
      if (shouldFork) {
        const forkedResult = await options.forkUnowned({
          urlArg: options.urlArg,
          folderArg: options.folderArg,
          cwd,
          resolvedAuth: auth,
          sourcePen: pen,
          allowOverwrite: Boolean(targetDir),
          output,
          baseUrl: options.baseUrl,
          interactive,
          env: options.env,
          homeDir: options.homeDir,
          openBrowser: options.openBrowser,
          prompts: {
            text: textImpl,
            confirm: confirmImpl,
            select: selectImpl,
            secret: secretImpl,
          },
        });
        if (!forkedResult) {
          return null;
        }

        return {
          pen: forkedResult.pen,
          sourcePen: forkedResult.sourcePen ?? undefined,
          rootDir: forkedResult.project.rootDir,
          writtenPaths: forkedResult.writtenPaths,
          auth: forkedResult.auth,
          forked: true,
          linked: true,
          project: forkedResult.project,
          ...(forkedResult.exitCode !== undefined ? { exitCode: forkedResult.exitCode } : {}),
        };
      }
    }
  }

  if (pen.editor === 'Classic' && !isOwnedByAnotherUser && interactive) {
    const classicResolution = await handleClassicPenClone({
      pen,
      apiIdentifier,
      effectiveUrl,
      auth,
      client,
      explicitProfile: options.explicitProfile,
      baseUrl: options.baseUrl,
      env: options.env,
      homeDir: options.homeDir,
      openBrowserImpl: options.openBrowser,
      output,
      selectImpl,
      textImpl,
    });
    if (classicResolution.action === 'cancel') {
      return null;
    }
    pen = classicResolution.pen;
    effectiveUrl = classicResolution.effectiveUrl;
    auth = classicResolution.auth;
    client = classicResolution.client;
    isOwnedByAnotherUser = classicResolution.isOwnedByAnotherUser;
    penOwner = classicResolution.penOwner;
    currentUsername = classicResolution.currentUsername;
  }

  if (!targetDir) {
    const defaultFolder = suggestFolderName(pen);
    if (interactive) {
      const chosen = (await textImpl('Target folder', defaultFolder)).trim();
      targetFolderDisplay = chosen || defaultFolder;
    } else {
      targetFolderDisplay = defaultFolder;
    }

    targetDir = path.resolve(cwd, targetFolderDisplay);
    const ready = await ensureCloneTargetReady(targetDir, targetFolderDisplay, {
      force,
      interactive,
      output,
      confirmImpl,
    });
    if (!ready) {
      return null;
    }
  }

  const remoteFiles = await client.getPenFiles(pen.id);
  const result = await syncRemoteFilesToDisk({
    client,
    rootDir: targetDir,
    remoteFiles,
    pruneRemoved: false,
  });

  const isUnlinked = isOwnedByAnotherUser || pen.editor === 'Classic';

  if (isUnlinked) {
    if (jsonMode) {
      printJsonResponse(
        200,
        `Cloned ${pen.title || 'Untitled'} into ${targetFolderDisplay} (unlinked local copy).`,
        {
          pen,
          linked: false,
          forked: false,
          profile: auth.profile,
          folder: targetFolderDisplay,
          root_dir: targetDir,
          config_path: null,
          version_id: pen.saved_version?.id ?? null,
          written_paths: result.writtenPaths,
        },
        output,
      );
    } else {
      output.log(
        `\n${fmt.green('✓')} Cloned ${fmt.bold(pen.title || 'Untitled')} ${fmt.dim(`(${pen.id})`)} into ${fmt.cyan(targetFolderDisplay)} ${fmt.dim('(unlinked local copy)')}`,
      );
      output.log(`  Source:  ${fmt.dim(effectiveUrl)}`);
      output.log(`  Files:   ${result.writtenPaths.length} downloaded`);

      if (isOwnedByAnotherUser) {
        output.log(
          fmt.yellow(
            `\nNote: No ${PROJECT_CONFIG_FILENAME} was created because this Pen belongs to ${penOwner}, not ${currentUsername}.\n` +
              `Run \`cdpn push\` inside ${targetFolderDisplay} later to publish it as a new Pen under your account, or \`cdpn fork ${effectiveUrl}\` to fork it on CodePen.`,
          ),
        );
      } else {
        output.log(
          fmt.yellow(
            `\nNote: No ${PROJECT_CONFIG_FILENAME} was created because this is a Classic (v1) Pen (read-only through CodePen API v2).\n` +
              `Run \`cdpn push\` inside ${targetFolderDisplay} later to publish it as a new CodePen 2.0 Pen, or convert it to 2.0 on CodePen via the Save button dropdown and re-clone.`,
          ),
        );
      }
    }

    return {
      pen,
      rootDir: targetDir,
      writtenPaths: result.writtenPaths,
      auth,
      forked: false,
      linked: false,
      project: null,
    };
  }

  const syncedFiles = buildSyncedFileMap(remoteFiles, result.localSha256ByPath);
  const config = {
    url: effectiveUrl,
    pen_id: pen.id,
    ...(auth.profile ? { profile: auth.profile } : {}),
    last_synced_version_id: pen.saved_version?.id ?? null,
    editor: pen.editor,
    ...buildPenInfoConfigFields(pen),
    files: syncedFiles,
  };
  const configPath = await writeProjectConfig(targetDir, config);

  if (jsonMode) {
    printJsonResponse(
      200,
      `Cloned ${pen.title || 'Untitled'} into ${targetFolderDisplay}.`,
      {
        pen,
        linked: true,
        forked: false,
        profile: auth.profile,
        folder: targetFolderDisplay,
        root_dir: targetDir,
        config_path: configPath,
        version_id: pen.saved_version?.id ?? null,
        written_paths: result.writtenPaths,
      },
      output,
    );
  } else {
    output.log(
      `\n${fmt.green('✓')} Cloned ${fmt.bold(pen.title || 'Untitled')} ${fmt.dim(`(${pen.id})`)} into ${fmt.cyan(targetFolderDisplay)}`,
    );
    if (auth.profile) {
      output.log(`  Profile: ${fmt.cyan(auth.profile)}`);
    }
    output.log(`  Files:   ${result.writtenPaths.length} downloaded`);
    if (pen.saved_version) {
      output.log(`  Version: ${fmt.dim(shortId(pen.saved_version.id))}`);
    }
    output.log(`  Config:  ${fmt.dim(path.join(targetFolderDisplay, PROJECT_CONFIG_FILENAME))}`);
  }

  return {
    pen,
    rootDir: targetDir,
    writtenPaths: result.writtenPaths,
    auth,
    forked: false,
    linked: true,
    project: {
      rootDir: targetDir,
      configPath,
      config,
    },
  };
}
