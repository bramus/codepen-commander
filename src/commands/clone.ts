import fs from 'node:fs/promises';
import path from 'node:path';
import type { Command } from 'commander';
import { CodePenClient } from '../api/client.js';
import { CodePenApiError } from '../api/errors.js';
import { DEFAULT_PROFILE_NAME, findMatchingProfile, type ResolvedAuth } from '../config/auth.js';
import {
  buildSyncedFileMap,
  extractCodePenOwnerFromUrl,
  hasProjectConfigInDir,
  normalizePenReference,
  PROJECT_CONFIG_FILENAME,
  suggestFolderName,
  writeProjectConfig,
  type ProjectLocation,
} from '../config/project.js';
import { isDirectoryNonEmpty } from '../sync/fs.js';
import { buildPenInfoConfigFields } from '../sync/info.js';
import { syncRemoteFilesToDisk } from '../sync/materialize.js';
import type { Pen } from '../types.js';
import { openBrowser, validateBrowserUrl } from '../utils/browser.js';
import { fmt, shortId } from '../utils/format.js';
import { CliError, printJsonResponse } from '../utils/json.js';
import {
  isInteractive,
  promptConfirm,
  promptSecret,
  promptSelect,
  promptText,
  type SelectOption,
} from '../utils/prompts.js';
import { getGlobalProfileOption, resolveCommandAuth } from './auth-context.js';
import { forkPenCommand } from './fork.js';
import {
  findUnmatchedStoredOwner,
  handlePenNotFoundOnFetch,
  handleUnownedPenAccess,
} from './unowned-pen.js';

export interface CloneCliOptions {
  force?: boolean;
  json?: boolean;
}

export interface ClonePenCommandOptions {
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
}

type ClassicCloneAction = 'convert' | 'clone-unlinked';
type ClassicRetryAction = 'retry' | 'clone-unlinked' | 'cancel';

interface ClassicPenResolution {
  action: 'clone-linked' | 'clone-unlinked' | 'cancel';
  pen: Pen;
  effectiveUrl: string;
  auth: ResolvedAuth;
  client: CodePenClient;
  isOwnedByAnotherUser: boolean;
  penOwner: string | null;
  currentUsername: string | null;
}

function validateEditorBrowserUrl(rawUrl: string): string {
  let candidate = rawUrl.trim();
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol === 'http:') {
      parsed.protocol = 'https:';
    }
    candidate = parsed.toString();
  } catch {
    // Let validateBrowserUrl throw a clean validation error
  }

  const safeUrl = validateBrowserUrl(candidate);
  const host = new URL(safeUrl).hostname.toLowerCase();
  const isCodePenHost = host === 'codepen.io' || host.endsWith('.codepen.io');
  if (!isCodePenHost) {
    throw new CliError(400, `Refusing to open non-CodePen URL in browser: ${host}`);
  }
  return safeUrl;
}

async function promptClassicRetryChoice(
  selectImpl: <T extends string>(
    question: string,
    options: SelectOption<T>[],
    defaultIndex?: number,
  ) => Promise<T>,
): Promise<ClassicRetryAction> {
  return selectImpl<ClassicRetryAction>(
    'How would you like to proceed?',
    [
      {
        value: 'retry',
        label: 'Check again / paste 2.0 Pen URL',
        description: 're-fetch after converting or enter the new URL',
      },
      {
        value: 'clone-unlinked',
        label: 'Just clone without linking',
        description: `download files without ${PROJECT_CONFIG_FILENAME}`,
      },
      {
        value: 'cancel',
        label: 'Cancel',
        description: 'abort clone',
      },
    ],
    0,
  );
}

async function resolveCurrentUsername(
  client: CodePenClient,
  auth: ResolvedAuth,
  penOwner: string,
): Promise<string | null> {
  // Fast path: named profile already matches the Pen owner
  if (
    auth.profile &&
    auth.profile !== DEFAULT_PROFILE_NAME &&
    auth.profile.toLowerCase() === penOwner.toLowerCase()
  ) {
    return auth.profile;
  }

  // Inspect one Pen owned by this API key to discover the actual CodePen account username
  // (handles CODEPEN_API_KEY env var, "default" profile, and custom profile aliases)
  try {
    const samplePen = await client.verifyAuth();
    const detected = samplePen?.urls?.editor
      ? extractCodePenOwnerFromUrl(samplePen.urls.editor)
      : null;
    if (detected) {
      return detected;
    }
  } catch {
    // Fall back to profile name if the account has no Pens or listing fails
  }

  if (auth.profile && auth.profile !== DEFAULT_PROFILE_NAME) {
    return auth.profile;
  }

  return null;
}

async function handleClassicPenClone(params: {
  pen: Pen;
  apiIdentifier: string;
  effectiveUrl: string;
  auth: ResolvedAuth;
  client: CodePenClient;
  options: ClonePenCommandOptions;
  selectImpl: <T extends string>(
    question: string,
    options: SelectOption<T>[],
    defaultIndex?: number,
  ) => Promise<T>;
  textImpl: (question: string, defaultValue?: string) => Promise<string>;
}): Promise<ClassicPenResolution> {
  const { pen, apiIdentifier, effectiveUrl, options, selectImpl, textImpl } = params;
  let currentAuth = params.auth;
  let currentClient = params.client;
  let fallbackPen = pen;

  const makeFallbackResult = (action: 'clone-unlinked' | 'cancel'): ClassicPenResolution => ({
    action,
    pen: fallbackPen,
    effectiveUrl,
    auth: currentAuth,
    client: currentClient,
    isOwnedByAnotherUser: false,
    penOwner: null,
    currentUsername: null,
  });

  console.log(
    `\n${fmt.yellow('This is a Classic (v1) Pen, which is read-only through CodePen API v2 and cannot be synced.')}`,
  );
  console.log(
    'You can convert it to a CodePen 2.0 Pen in the browser using the dropdown on the Save button.\n',
  );

  const initialChoice = await selectImpl<ClassicCloneAction>(
    'How would you like to proceed?',
    [
      {
        value: 'convert',
        label: 'Open the Pen to convert it first',
        description: 'open in browser, then clone linked',
      },
      {
        value: 'clone-unlinked',
        label: 'Just clone without linking',
        description: `download files without ${PROJECT_CONFIG_FILENAME}`,
      },
    ],
    0,
  );

  if (initialChoice === 'clone-unlinked') {
    return makeFallbackResult('clone-unlinked');
  }

  const editorUrl = validateEditorBrowserUrl(pen.urls.editor || effectiveUrl);
  const openImpl = options.openBrowser ?? openBrowser;
  const opened = await openImpl(editorUrl);
  if (opened) {
    console.log(`\n${fmt.green('✓')} Opened ${fmt.cyan(editorUrl)} in your browser.`);
  } else {
    console.log(
      `\n${fmt.yellow('!')} Could not launch a browser automatically. Open this URL manually:\n  ${fmt.cyan(editorUrl)}`,
    );
  }
  console.log(
    fmt.dim('In CodePen, use the dropdown on the Save button to convert this Pen to CodePen 2.0.'),
  );

  for (;;) {
    console.log('');
    const pasted = (
      await textImpl(
        'Press Enter once converted to re-fetch & clone (or paste the new 2.0 Pen URL)',
      )
    ).trim();

    let targetApiId = apiIdentifier;
    let pastedOriginalUrl: string | undefined;

    if (pasted) {
      try {
        const normalized = normalizePenReference(pasted);
        targetApiId = normalized.apiIdentifier;
        pastedOriginalUrl = normalized.originalUrl;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.log(`\n${fmt.yellow('!')} ${msg}\n`);
        const nextAction = await promptClassicRetryChoice(selectImpl);
        if (nextAction === 'retry') continue;
        if (nextAction === 'clone-unlinked') return makeFallbackResult('clone-unlinked');
        console.log('Aborted.');
        return makeFallbackResult('cancel');
      }

      if (!options.explicitProfile && currentAuth.source === 'file' && pastedOriginalUrl) {
        const matchedProfile = findMatchingProfile(currentAuth.availableProfiles, pastedOriginalUrl);
        if (matchedProfile && matchedProfile !== currentAuth.profile) {
          currentAuth = await resolveCommandAuth({
            explicitProfile: matchedProfile,
            interactive: true,
            env: options.env,
            homeDir: options.homeDir,
          });
          currentClient = new CodePenClient({ apiKey: currentAuth.apiKey, baseUrl: options.baseUrl });
          console.log(fmt.dim(`Using profile "${matchedProfile}" (matches Pen owner).`));
        }
      }
    }

    console.log(`Fetching Pen ${fmt.cyan(targetApiId)}…`);

    let refetched: Pen;
    try {
      refetched = await currentClient.getPen(targetApiId);
    } catch (error) {
      const msg =
        error instanceof CodePenApiError
          ? error.formatForUser()
          : error instanceof Error
            ? error.message
            : String(error);
      console.log(`\n${fmt.yellow('!')} Could not fetch Pen ${targetApiId}: ${msg}\n`);
      const nextAction = await promptClassicRetryChoice(selectImpl);
      if (nextAction === 'retry') continue;
      if (nextAction === 'clone-unlinked') return makeFallbackResult('clone-unlinked');
      console.log('Aborted.');
      return makeFallbackResult('cancel');
    }

    const refetchedOwner =
      extractCodePenOwnerFromUrl(refetched.urls.editor) ??
      (pastedOriginalUrl ? extractCodePenOwnerFromUrl(pastedOriginalUrl) : null);

    if (
      refetchedOwner &&
      !options.explicitProfile &&
      currentAuth.source === 'file' &&
      currentAuth.profile?.toLowerCase() !== refetchedOwner.toLowerCase()
    ) {
      const matchedStoredProfile = findMatchingProfile(
        currentAuth.availableProfiles,
        refetched.urls.editor,
      );
      if (matchedStoredProfile && matchedStoredProfile !== currentAuth.profile) {
        currentAuth = await resolveCommandAuth({
          explicitProfile: matchedStoredProfile,
          interactive: true,
          env: options.env,
          homeDir: options.homeDir,
        });
        currentClient = new CodePenClient({ apiKey: currentAuth.apiKey, baseUrl: options.baseUrl });
        console.log(fmt.dim(`Using profile "${matchedStoredProfile}" (matches Pen owner).`));
      }
    }

    if (refetched.editor !== 'Classic') {
      const detectedUsername = refetchedOwner
        ? await resolveCurrentUsername(currentClient, currentAuth, refetchedOwner)
        : null;
      const ownedByOther = Boolean(
        refetchedOwner &&
          detectedUsername &&
          refetchedOwner.toLowerCase() !== detectedUsername.toLowerCase(),
      );

      const resolvedUrl = pasted
        ? (pastedOriginalUrl ?? refetched.urls.editor)
        : (refetched.urls.editor || effectiveUrl);

      if (!ownedByOther) {
        console.log(
          `\n${fmt.green('✓')} Pen is now CodePen 2.0 ${fmt.dim(`(${refetched.id})`)} — continuing linked clone.`,
        );
      }

      return {
        action: ownedByOther ? 'clone-unlinked' : 'clone-linked',
        pen: refetched,
        effectiveUrl: resolvedUrl,
        auth: currentAuth,
        client: currentClient,
        isOwnedByAnotherUser: ownedByOther,
        penOwner: refetchedOwner,
        currentUsername: detectedUsername,
      };
    }

    if (!pasted) {
      fallbackPen = refetched;
    }

    console.log(
      `\n${fmt.yellow('!')} ${fmt.bold(refetched.title || 'Untitled')} is still a Classic (v1) Pen on CodePen.`,
    );
    console.log(
      fmt.dim(
        'Make sure you converted it to 2.0 via the Save button dropdown (or paste the new 2.0 Pen URL if CodePen opened a new one).\n',
      ),
    );

    const nextAction = await promptClassicRetryChoice(selectImpl);
    if (nextAction === 'retry') {
      continue;
    }
    if (nextAction === 'clone-unlinked') {
      return makeFallbackResult('clone-unlinked');
    }
    console.log('Aborted.');
    return makeFallbackResult('cancel');
  }
}

async function ensureCloneTargetReady(
  targetDir: string,
  folderDisplay: string,
  options: {
    force: boolean;
    interactive: boolean;
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
      console.log('Aborted.');
      return false;
    }
  }

  return true;
}

/**
 * Clones an existing CodePen Pen into a local folder.
 *
 * When the Pen's owner does not match the current authenticated account, offers to fork it
 * instead (interactively). If not forked, downloads files locally without writing `.cdpn.json`
 * so the local folder is not linked to an online Pen owned by another user.
 *
 * When the Pen is a Classic (v1) Pen (read-only through CodePen API v2), interactively offers
 * a choice to open it in the browser to convert to CodePen 2.0 first (waiting to re-fetch or
 * accept the new 2.0 URL for a linked clone) or to clone it locally without writing `.cdpn.json`.
 *
 * Returns `null` if the user cancels interactively.
 */
export async function clonePenCommand(
  options: ClonePenCommandOptions,
): Promise<ClonePenResult | null> {
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
      confirmImpl,
      textImpl,
      openBrowserImpl: options.openBrowser,
    });
    if (!pastedUrl) {
      return null;
    }
    return clonePenCommand({
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
    console.log(fmt.dim(`Using profile "${auth.profile}" (matches Pen owner).`));
  }

  if (!jsonMode) {
    console.log(`Fetching Pen ${fmt.cyan(apiIdentifier)}…`);
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
        confirmImpl,
        textImpl,
        openBrowserImpl: options.openBrowser,
      });
      if (!pastedUrl) {
        return null;
      }
      return clonePenCommand({
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
        env: options.env,
        homeDir: options.homeDir,
      });
      client = new CodePenClient({ apiKey: auth.apiKey, baseUrl: options.baseUrl });
      if (!jsonMode) {
        console.log(fmt.dim(`Using profile "${matchedStoredProfile}" (matches Pen owner).`));
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
      console.log(
        fmt.yellow(
          `\nThis Pen belongs to ${fmt.bold(penOwner)} (your current account is ${fmt.bold(currentUsername)}).`,
        ),
      );
    }

    if (interactive) {
      const shouldFork = await confirmImpl(
        `Fork this Pen under ${currentUsername} instead?`,
        true,
      );
      if (shouldFork) {
        const forkedResult = await forkPenCommand({
          urlArg: options.urlArg,
          folderArg: options.folderArg,
          cwd,
          resolvedAuth: auth,
          sourcePen: pen,
          allowOverwrite: Boolean(targetDir),
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
      options,
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
      );
    } else {
      console.log(
        `\n${fmt.green('✓')} Cloned ${fmt.bold(pen.title || 'Untitled')} ${fmt.dim(`(${pen.id})`)} into ${fmt.cyan(targetFolderDisplay)} ${fmt.dim('(unlinked local copy)')}`,
      );
      console.log(`  Source:  ${fmt.dim(effectiveUrl)}`);
      console.log(`  Files:   ${result.writtenPaths.length} downloaded`);

      if (isOwnedByAnotherUser) {
        console.log(
          fmt.yellow(
            `\nNote: No ${PROJECT_CONFIG_FILENAME} was created because this Pen belongs to ${penOwner}, not ${currentUsername}.\n` +
              `Run \`cdpn push\` inside ${targetFolderDisplay} later to publish it as a new Pen under your account, or \`cdpn fork ${effectiveUrl}\` to fork it on CodePen.`,
          ),
        );
      } else {
        console.log(
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
    );
  } else {
    console.log(
      `\n${fmt.green('✓')} Cloned ${fmt.bold(pen.title || 'Untitled')} ${fmt.dim(`(${pen.id})`)} into ${fmt.cyan(targetFolderDisplay)}`,
    );
    if (auth.profile) {
      console.log(`  Profile: ${fmt.cyan(auth.profile)}`);
    }
    console.log(`  Files:   ${result.writtenPaths.length} downloaded`);
    if (pen.saved_version) {
      console.log(`  Version: ${fmt.dim(shortId(pen.saved_version.id))}`);
    }
    console.log(`  Config:  ${fmt.dim(path.join(targetFolderDisplay, PROJECT_CONFIG_FILENAME))}`);
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

export function registerCloneCommand(program: Command): void {
  program
    .command('clone <url> [folder]')
    .description(
      'Clone a CodePen Pen into a local folder (offers to convert Classic Pens or fork unowned Pens)',
    )
    .option('-f, --force', 'Overwrite files if the target directory already exists and is not empty')
    .option('--json', 'Output clone result as JSON')
    .action(
      async (
        urlArg: string,
        folderArg: string | undefined,
        options: CloneCliOptions,
        command: Command,
      ) => {
        await clonePenCommand({
          urlArg,
          folderArg,
          force: options.force,
          json: options.json,
          explicitProfile: getGlobalProfileOption(command),
        });
      },
    );
}
