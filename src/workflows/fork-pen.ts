import fs from 'node:fs/promises';
import path from 'node:path';
import { CodePenClient } from '../api/client.js';
import { CodePenApiError } from '../api/errors.js';
import type { Build, Pen } from '../api/types.js';
import type { ResolvedAuth } from '../config/auth.js';
import {
  buildSyncedFileMap,
  hasProjectConfigInDir,
  writeProjectConfig,
  type ProjectLocation,
} from '../config/project.js';
import { MIN_PROTECTED_PASSWORD_LENGTH } from '../constants.js';
import { CliError } from '../errors.js';
import { isDirectoryNonEmpty } from '../sync/fs.js';
import { buildPenInfoConfigFields } from '../sync/info.js';
import { syncRemoteFilesToDisk } from '../sync/materialize.js';
import {
  assertValidProtectedPassword,
  assertValidTagCount,
  resolveAccessOrVisibility,
} from '../utils/cli-options.js';
import { normalizePenReference, suggestFolderName } from '../utils/codepen-url.js';
import { fmt, printBuildSummary, shortId } from '../utils/format.js';
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
import { slugifyTitle } from '../utils/strings.js';
import { resolveCommandAuth } from './auth-context.js';
import { clonePenWorkflow } from './clone-pen.js';
import { assertEmptyTargetDirectory } from './scaffold.js';
import {
  findUnmatchedStoredOwner,
  handlePenNotFoundOnFetch,
  handleUnownedPenAccess,
} from './unowned-pen.js';

export interface ForkPenOptions {
  /** Mandatory CodePen Pen URL or ID to fork. */
  urlArg: string;
  /** Optional target local folder (asked interactively or auto-generated when omitted). */
  folderArg?: string;
  /** Working directory for resolving relative paths (defaults to `process.cwd()`). */
  cwd?: string;
  /** Explicit `--profile <name>` flag value. */
  explicitProfile?: string;
  title?: string;
  description?: string;
  tags?: string[];
  access?: string;
  visibility?: string;
  password?: string;
  /** Wait for initial build to settle (defaults to true). */
  wait?: boolean;
  /** Output fork result as JSON. */
  json?: boolean;
  /** Injectable output sink (defaults to stdout/stderr). */
  output?: CommandOutput;
  /** Pre-resolved auth (avoids double-prompting when invoked from `cdpn clone`). */
  resolvedAuth?: ResolvedAuth;
  /** Pre-fetched source Pen (avoids duplicate `GET /v2/pens/{id}` when invoked from `cdpn clone`). */
  sourcePen?: Pen;
  /** Allow writing into an explicitly provided non-empty folder (used when `cdpn clone --force` delegates to fork). */
  allowOverwrite?: boolean;
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
    select?: <T extends string>(
      question: string,
      options: SelectOption<T>[],
      defaultIndex?: number,
    ) => Promise<T>;
    secret?: (question: string) => Promise<string>;
  };
}

export interface ForkPenResult {
  /** Original Pen when forked directly via CodePen API v2; null when forked in the browser and cloned back. */
  sourcePen: Pen | null;
  pen: Pen;
  versionId: string | null;
  build: Build | null;
  writtenPaths: string[];
  auth: ResolvedAuth;
  project: ProjectLocation;
  /** True when the user forked another user's Pen in the browser and pasted the forked URL to clone. */
  forkedInBrowser?: boolean;
  exitCode?: number;
}

const FORK_NON_EMPTY_HINT =
  'Choose a different target folder (e.g. `cdpn fork <url> my-fork`) or remove existing files first.';

async function isPathOccupied(candidatePath: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(candidatePath);
    if (!stat.isDirectory()) return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
  return (await hasProjectConfigInDir(candidatePath)) || (await isDirectoryNonEmpty(candidatePath));
}

/**
 * Generates an available default folder name for a forked Pen, automatically appending
 * `-fork` (or `-fork-2`, etc.) if the original Pen's folder name is already occupied.
 */
async function suggestAvailableForkFolder(cwd: string, baseName: string): Promise<string> {
  if (!(await isPathOccupied(path.resolve(cwd, baseName)))) {
    return baseName;
  }

  const withFork = `${baseName}-fork`;
  if (!(await isPathOccupied(path.resolve(cwd, withFork)))) {
    return withFork;
  }

  for (let i = 2; i <= 100; i++) {
    const candidate = `${baseName}-fork-${i}`;
    if (!(await isPathOccupied(path.resolve(cwd, candidate)))) {
      return candidate;
    }
  }

  return `${baseName}-fork-${Date.now()}`;
}

/**
 * Forks an existing CodePen Pen via `POST /v2/pens/{id}/fork` and downloads the new fork
 * into a local folder linked with `.cdpn.json`.
 */
export async function forkPenWorkflow(options: ForkPenOptions): Promise<ForkPenResult | null> {
  const output = options.output ?? defaultOutput;
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const jsonMode = Boolean(options.json);
  const interactive = (options.interactive ?? isInteractive()) && !jsonMode;
  const textImpl = options.prompts?.text ?? promptText;
  const confirmImpl = options.prompts?.confirm ?? promptConfirm;
  const selectImpl = options.prompts?.select ?? promptSelect;
  const secretImpl = options.prompts?.secret ?? promptSecret;

  const { apiIdentifier, originalUrl } = normalizePenReference(options.urlArg);

  assertValidTagCount(options.tags);

  const explicitAccess = resolveAccessOrVisibility(options.access, options.visibility);
  assertValidProtectedPassword(explicitAccess, options.password, interactive);

  // If target folder was passed explicitly, validate before hitting the network
  let targetDir: string | null = null;
  let folderDisplay = options.folderArg?.trim() || '';
  if (folderDisplay) {
    targetDir = path.resolve(cwd, folderDisplay);
    if (!options.allowOverwrite) {
      await assertEmptyTargetDirectory(targetDir, folderDisplay, {
        commandName: 'fork',
        nonEmptyHint: FORK_NON_EMPTY_HINT,
      });
    }
  }

  const clonePastedForkUrl = async (pastedUrl: string): Promise<ForkPenResult | null> => {
    const cloned = await clonePenWorkflow({
      urlArg: pastedUrl,
      folderArg: options.folderArg,
      cwd,
      output,
      baseUrl: options.baseUrl,
      interactive,
      env: options.env,
      homeDir: options.homeDir,
      openBrowser: options.openBrowser,
      allowBrowserFallback: false,
      prompts: {
        text: textImpl,
        confirm: confirmImpl,
        select: selectImpl,
        secret: secretImpl,
      },
    });
    if (!cloned || !cloned.project) {
      return null;
    }
    return {
      sourcePen: null,
      pen: cloned.pen,
      versionId: cloned.pen.saved_version?.id ?? null,
      build: null,
      writtenPaths: cloned.writtenPaths,
      auth: cloned.auth,
      project: cloned.project,
      forkedInBrowser: true,
    };
  };

  if (!options.resolvedAuth && !options.sourcePen) {
    const unmatched = await findUnmatchedStoredOwner({
      originalUrl,
      explicitProfile: options.explicitProfile,
      env: options.env,
      homeDir: options.homeDir,
    });
    if (unmatched && originalUrl) {
      const pastedUrl = await handleUnownedPenAccess({
        action: 'fork',
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
      return clonePastedForkUrl(pastedUrl);
    }
  }

  const auth =
    options.resolvedAuth ??
    (await resolveCommandAuth({
      explicitProfile: options.explicitProfile,
      urlHint: originalUrl ?? options.urlArg,
      promptMessage: 'Which CodePen profile should be used to fork this Pen?',
      interactive,
      output,
      env: options.env,
      homeDir: options.homeDir,
      selectProfile: selectImpl,
    }));
  const client = new CodePenClient({ apiKey: auth.apiKey, baseUrl: options.baseUrl });

  let sourcePen: Pen;
  if (options.sourcePen) {
    sourcePen = options.sourcePen;
  } else {
    if (!jsonMode) {
      output.log(`Fetching Pen ${fmt.cyan(apiIdentifier)}…`);
    }
    try {
      sourcePen = await client.getPen(apiIdentifier);
    } catch (error) {
      if (error instanceof CodePenApiError && error.status === 404) {
        const pastedUrl = await handlePenNotFoundOnFetch({
          action: 'fork',
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
        return clonePastedForkUrl(pastedUrl);
      }
      throw error;
    }
  }

  // CodePen API requires a password when forking a Protected Pen (unless access is overridden)
  const effectiveAccess = explicitAccess ?? sourcePen.access;
  let password = options.password;
  if (
    effectiveAccess === 'Protected' &&
    (!password || password.length < MIN_PROTECTED_PASSWORD_LENGTH)
  ) {
    if (!interactive) {
      throw new CliError(
        400,
        `Forking a Protected Pen requires --password with at least ${MIN_PROTECTED_PASSWORD_LENGTH} characters (or pass --access Public/Private).`,
      );
    }
    for (;;) {
      password = await secretImpl(
        `Password for Protected fork (min ${MIN_PROTECTED_PASSWORD_LENGTH} characters)`,
      );
      if (password.length >= MIN_PROTECTED_PASSWORD_LENGTH) break;
      output.log(
        fmt.yellow(`Password must be at least ${MIN_PROTECTED_PASSWORD_LENGTH} characters.`),
      );
    }
  }

  const title = options.title?.trim() || undefined;

  // Determine target folder if omitted (asked interactively or generated cleanly) BEFORE calling fork
  if (!targetDir) {
    const baseName = (title ? slugifyTitle(title) : null) ?? suggestFolderName(sourcePen);
    const defaultFolder = await suggestAvailableForkFolder(cwd, baseName);

    if (interactive) {
      const chosen = (await textImpl('Target folder', defaultFolder)).trim();
      folderDisplay = chosen || defaultFolder;
    } else {
      folderDisplay = defaultFolder;
    }

    targetDir = path.resolve(cwd, folderDisplay);
    await assertEmptyTargetDirectory(targetDir, folderDisplay, {
      commandName: 'fork',
      nonEmptyHint: FORK_NON_EMPTY_HINT,
    });
  }

  const shouldWait = options.wait !== false;
  if (!jsonMode) {
    output.log(
      `\nForking ${fmt.bold(sourcePen.title || 'Untitled')} ${fmt.dim(`(${sourcePen.id})`)}…`,
    );
  }

  const forked = await client.forkPen(sourcePen.id, {
    ...(title ? { title } : {}),
    ...(options.description ? { description: options.description } : {}),
    ...(options.tags && options.tags.length > 0 ? { tags: options.tags } : {}),
    ...(explicitAccess ? { access: explicitAccess } : {}),
    ...(effectiveAccess === 'Protected' && password ? { password } : {}),
    wait: shouldWait ? 45 : 0,
  });

  let finalBuild = forked.build ?? null;
  if (finalBuild && shouldWait) {
    finalBuild = await client.settleBuild(finalBuild);
    if (!jsonMode) {
      printBuildSummary(finalBuild, output);
    }
  }

  await fs.mkdir(targetDir, { recursive: true });

  const finalVersionId = finalBuild?.version_id ?? forked.saved_version?.id ?? null;
  const remoteFiles = finalVersionId
    ? (await client.getVersion(finalVersionId)).files ?? (await client.getPenFiles(forked.id))
    : await client.getPenFiles(forked.id);

  const materialized = await syncRemoteFilesToDisk({
    client,
    rootDir: targetDir,
    remoteFiles,
    pruneRemoved: false,
  });

  const config = {
    url: forked.urls.editor,
    pen_id: forked.id,
    ...(auth.profile ? { profile: auth.profile } : {}),
    last_synced_version_id: finalVersionId,
    editor: forked.editor,
    ...buildPenInfoConfigFields(forked),
    files: buildSyncedFileMap(remoteFiles, materialized.localSha256ByPath),
  };
  const configPath = await writeProjectConfig(targetDir, config);

  const buildFailed = finalBuild?.status === 'Failed';

  if (jsonMode) {
    const code = buildFailed ? 422 : 201;
    const message = buildFailed
      ? `Forked ${forked.title || 'Untitled'}, but the initial build failed.`
      : `Forked ${forked.title || 'Untitled'} into ${folderDisplay}.`;
    printJsonResponse(
      code,
      message,
      {
        pen: forked,
        source_pen: sourcePen,
        profile: auth.profile,
        folder: folderDisplay,
        root_dir: targetDir,
        config_path: configPath,
        version_id: finalVersionId,
        build: finalBuild,
        written_paths: materialized.writtenPaths,
      },
      output,
    );
  } else {
    if (buildFailed) {
      output.log(
        `\n${fmt.yellow('!')} Forked ${fmt.bold(forked.title || 'Untitled')} ${fmt.dim(`(${forked.id})`)}, but the initial build failed.`,
      );
    } else {
      output.log(
        `\n${fmt.green('✓')} Forked ${fmt.bold(forked.title || 'Untitled')} ${fmt.dim(`(${forked.id})`)}`,
      );
    }
    output.log(`  From:       ${fmt.dim(sourcePen.urls.editor)}`);
    if (auth.profile) {
      output.log(`  Profile:    ${fmt.cyan(auth.profile)}`);
    }
    output.log(`  Visibility: ${forked.access}`);
    output.log(`  Folder:     ${fmt.cyan(folderDisplay)}`);
    output.log(`  Files:      ${materialized.writtenPaths.length} downloaded`);
    output.log(`  Editor:     ${fmt.cyan(forked.urls.editor)}`);
    output.log(`  Preview:    ${fmt.cyan(forked.urls.preview)}`);
    output.log(`  Version:    ${fmt.dim(shortId(finalVersionId))}`);
  }

  return {
    sourcePen,
    pen: forked,
    versionId: finalVersionId,
    build: finalBuild,
    writtenPaths: materialized.writtenPaths,
    auth,
    project: {
      rootDir: targetDir,
      configPath,
      config,
    },
    ...(buildFailed ? { exitCode: 1 } : {}),
  };
}
