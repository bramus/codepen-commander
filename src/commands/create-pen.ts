import fs from 'node:fs/promises';
import path from 'node:path';
import { CodePenClient } from '../api/client.js';
import type { ResolvedAuth } from '../config/auth.js';
import {
  buildSyncedFileMap,
  hasProjectConfigInDir,
  PROJECT_CONFIG_FILENAME,
  writeProjectConfig,
  type ProjectLocation,
} from '../config/project.js';
import { scanLocalFiles } from '../sync/fs.js';
import { syncRemoteFilesToDisk } from '../sync/materialize.js';
import type { BinaryUploadPart, Build, Pen, PenAccess, PenFileRequest } from '../types.js';
import { fmt, printBuildSummary, shortId } from '../utils/format.js';
import { extractHtmlTitle } from '../utils/html.js';
import { CliError } from '../utils/json.js';
import {
  isInteractive,
  promptConfirm,
  promptSecret,
  promptSelect,
  promptText,
  type SelectOption,
} from '../utils/prompts.js';
import { resolveCommandAuth } from './auth-context.js';

const VALID_ACCESS = new Set(['public', 'private', 'protected', 'collaborators']);

export function normalizeAccess(raw?: string): PenAccess | undefined {
  if (!raw) return undefined;
  const lower = raw.trim().toLowerCase();
  if (!VALID_ACCESS.has(lower)) {
    throw new CliError(
      400,
      `Invalid access level "${raw}". Use: Public, Private, Protected, or Collaborators.`,
    );
  }
  return (lower[0]!.toUpperCase() + lower.slice(1)) as PenAccess;
}

export interface VisibilityPromptCallbacks {
  select?: <T extends string>(
    question: string,
    options: SelectOption<T>[],
    defaultIndex?: number,
  ) => Promise<T>;
  secret?: (question: string) => Promise<string>;
}

/**
 * Validates or interactively prompts for Pen visibility (`Public` default, `Private`,
 * `Protected`, or `Collaborators`) and password when `Protected` is chosen.
 */
export async function resolveVisibilityAndPassword(options: {
  rawAccess?: string;
  rawPassword?: string;
  interactive: boolean;
  prompts?: VisibilityPromptCallbacks;
}): Promise<{ access: PenAccess; password?: string }> {
  const selectImpl = options.prompts?.select ?? promptSelect;
  const secretImpl = options.prompts?.secret ?? promptSecret;

  let access = normalizeAccess(options.rawAccess);
  if (access === 'Protected' && options.rawPassword !== undefined && options.rawPassword.length < 8) {
    throw new CliError(400, 'Protected Pens require --password with at least 8 characters.');
  }
  if (access === 'Protected' && !options.rawPassword && !options.interactive) {
    throw new CliError(400, 'Protected Pens require --password with at least 8 characters.');
  }

  if (!access) {
    if (options.interactive) {
      access = await selectImpl<PenAccess>(
        'Pen visibility:',
        [
          { value: 'Public', label: 'Public', description: 'visible to everyone (default)' },
          { value: 'Private', label: 'Private', description: 'visible only to you / your team' },
          {
            value: 'Protected',
            label: 'Protected',
            description: 'password-protected (min 8 characters)',
          },
          {
            value: 'Collaborators',
            label: 'Collaborators',
            description: 'visible only to you and collaborators',
          },
        ],
        0,
      );
    } else {
      access = 'Public';
    }
  }

  let password = options.rawPassword;
  if (access === 'Protected' && (!password || password.length < 8)) {
    if (!options.interactive) {
      throw new CliError(400, 'Protected Pens require --password with at least 8 characters.');
    }
    for (;;) {
      password = await secretImpl('Password for Protected Pen (min 8 characters)');
      if (password.length >= 8) break;
      console.log(fmt.yellow('Password must be at least 8 characters.'));
    }
  }

  return {
    access,
    ...(access === 'Protected' && password ? { password } : {}),
  };
}

export interface CreatePenFlowOptions {
  /** Target local directory (defaults to cwd). */
  targetDir: string;
  /** Display label for the folder in user-facing output. */
  folderDisplay: string;
  /** Explicit `--profile <name>` flag value. */
  explicitProfile?: string;
  /** Pre-supplied Pen title (skips title prompt if provided). */
  title?: string;
  description?: string;
  tags?: string[];
  /** Pre-supplied Pen access level (skips visibility prompt if provided). */
  access?: string;
  /** Pre-supplied password (for Protected Pens). */
  password?: string;
  template?: boolean;
  /** Skip confirmation when `index.html` is missing. */
  force?: boolean;
  /** Wait for initial build to settle (defaults to true). */
  wait?: boolean;
  /** Suppress stdout progress/summary logs and interactive prompts (used by --json callers). */
  silent?: boolean;
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
    text?: (question: string, defaultValue?: string) => Promise<string>;
    select?: <T extends string>(
      question: string,
      options: SelectOption<T>[],
      defaultIndex?: number,
    ) => Promise<T>;
    secret?: (question: string) => Promise<string>;
  };
}

export interface CreatePenFlowResult {
  pen: Pen;
  versionId: string | null;
  build: Build | null;
  auth: ResolvedAuth;
  project: ProjectLocation;
}

export function printMissingIndexHtmlWarning(targetDir: string, fileCount: number): void {
  const headline = '  WARNING: No index.html found in this folder!  ';
  const border = '═'.repeat(headline.length);
  console.log('');
  console.log(fmt.yellow(fmt.bold(`╔${border}╗`)));
  console.log(fmt.yellow(fmt.bold(`║${headline}║`)));
  console.log(fmt.yellow(fmt.bold(`╚${border}╝`)));
  console.log(
    fmt.yellow(
      `CodePen expects an index.html file at the root of your demo.\n` +
        `Double-check that you are in the right folder before pushing:\n` +
        `  Folder: ${targetDir} (${fileCount} file(s) found)`,
    ),
  );
  console.log('');
}

/**
 * First-time Pen creation flow used by `cdpn push` and `cdpn deploy` when invoked inside
 * an unlinked local demo folder:
 *
 * 1. Checks for `/index.html`; if absent, displays a prominent warning and asks for confirmation.
 * 2. Resolves or asks which CodePen account/profile to push to (when multiple keys are in `~/.cdpn`).
 * 3. Asks for a title (pre-filled from `index.html`'s `<title>` when available).
 * 4. Asks for visibility (`Public` default, `Private`, `Protected`, or `Collaborators`).
 */
export async function createPenFromDirectory(
  options: CreatePenFlowOptions,
): Promise<CreatePenFlowResult | null> {
  const silent = Boolean(options.silent);
  const interactive = silent ? false : (options.interactive ?? isInteractive());
  const confirmImpl = options.prompts?.confirm ?? promptConfirm;
  const textImpl = options.prompts?.text ?? promptText;
  const selectImpl = options.prompts?.select ?? promptSelect;

  // Validate --access / --password early before prompting or scanning
  const prevalidatedAccess = normalizeAccess(options.access);
  if (prevalidatedAccess === 'Protected' && options.password !== undefined && options.password.length < 8) {
    throw new CliError(400, 'Protected Pens require --password with at least 8 characters.');
  }
  if (prevalidatedAccess === 'Protected' && !options.password && !interactive) {
    throw new CliError(400, 'Protected Pens require --password with at least 8 characters.');
  }

  const targetDir = path.resolve(options.targetDir);
  const folderDisplay = options.folderDisplay;

  if (await hasProjectConfigInDir(targetDir)) {
    throw new CliError(
      409,
      `${targetDir} already contains ${PROJECT_CONFIG_FILENAME}. Use \`cdpn push\` to update the existing Pen.`,
    );
  }

  const scanned = await scanLocalFiles(targetDir);
  if (scanned.size === 0) {
    throw new CliError(
      400,
      `No ${PROJECT_CONFIG_FILENAME} found and no syncable files in ${targetDir}.\n` +
        'Run `cdpn clone <url>` to clone an existing Pen or `cdpn new` to scaffold a brand-new Pen.',
    );
  }

  const indexFile = scanned.get('/index.html');

  // 1. Check for index.html before pushing a local demo for the first time
  if (!indexFile) {
    if (!silent) {
      printMissingIndexHtmlWarning(targetDir, scanned.size);
    }
    if (!options.force) {
      if (!interactive) {
        throw new CliError(
          400,
          `No index.html found in ${targetDir}. Pass --force to push this folder without an index.html.`,
        );
      }
      const ok = await confirmImpl(
        'Are you sure you want to push this folder without an index.html?',
        false,
      );
      if (!ok) {
        console.log('Aborted.');
        return null;
      }
    }
  }

  // 2. Ask which account/profile to push to (only prompts if multiple keys exist in ~/.cdpn)
  const auth = await resolveCommandAuth({
    explicitProfile: options.explicitProfile,
    promptMessage: 'Which CodePen account/profile would you like to push to?',
    interactive,
    env: options.env,
    homeDir: options.homeDir,
    selectProfile: selectImpl,
  });
  const client = new CodePenClient({ apiKey: auth.apiKey, baseUrl: options.baseUrl });

  // 3. Determine title (defaulting to index.html's <title> when present)
  const htmlTitle =
    indexFile && !indexFile.isBinary && indexFile.textContent
      ? extractHtmlTitle(indexFile.textContent)
      : null;
  const fallbackTitle = path.basename(targetDir) || 'Untitled';
  const defaultTitle = htmlTitle ?? fallbackTitle;

  let title = options.title?.trim();
  if (!title) {
    if (interactive) {
      title = (await textImpl('Pen title', defaultTitle)).trim() || defaultTitle;
    } else {
      title = defaultTitle;
    }
  }

  // 4. Ask for visibility (Public by default, Private, Protected, or Collaborators)
  const { access, password } = await resolveVisibilityAndPassword({
    rawAccess: options.access,
    rawPassword: options.password,
    interactive,
    prompts: options.prompts,
  });

  const textFiles: PenFileRequest[] = [];
  const binaryFiles: BinaryUploadPart[] = [];

  for (const [filePath, lf] of scanned) {
    if (lf.isBinary && lf.buffer.length > 0) {
      binaryFiles.push({ path: filePath, content: lf.buffer });
    } else {
      textFiles.push({ path: filePath, content: lf.textContent ?? '' });
    }
  }

  const shouldWait = options.wait !== false;

  if (!silent) {
    console.log(`\nCreating new Pen from ${textFiles.length + binaryFiles.length} local file(s)…`);
  }

  const created = await client.createPen(
    {
      ...(title ? { title } : {}),
      ...(options.description ? { description: options.description } : {}),
      ...(options.tags && options.tags.length > 0 ? { tags: options.tags } : {}),
      access,
      ...(password ? { password } : {}),
      ...(options.template ? { template: true } : {}),
      files: textFiles,
      wait: shouldWait ? 45 : 0,
    },
    binaryFiles,
  );

  let finalBuild = created.build ?? null;
  if (finalBuild && shouldWait) {
    finalBuild = await client.settleBuild(finalBuild);
    if (!silent) {
      printBuildSummary(finalBuild);
    }
  }

  await fs.mkdir(targetDir, { recursive: true });

  const finalVersionId = finalBuild?.version_id ?? created.saved_version?.id ?? null;
  const remoteFiles = finalVersionId
    ? (await client.getVersion(finalVersionId)).files ?? (await client.getPenFiles(created.id))
    : await client.getPenFiles(created.id);

  const materialized = await syncRemoteFilesToDisk({
    client,
    rootDir: targetDir,
    remoteFiles,
    pruneRemoved: false,
  });

  const config = {
    url: created.urls.editor,
    pen_id: created.id,
    ...(auth.profile ? { profile: auth.profile } : {}),
    last_synced_version_id: finalVersionId,
    editor: created.editor,
    files: buildSyncedFileMap(remoteFiles, materialized.localSha256ByPath),
  };
  const configPath = await writeProjectConfig(targetDir, config);

  if (finalBuild?.status === 'Failed') {
    if (!silent) {
      console.log(
        `\n${fmt.yellow('!')} Created Pen ${fmt.bold(created.title || 'Untitled')} ${fmt.dim(`(${created.id})`)}, but the initial build failed.`,
      );
    }
    process.exitCode = 1;
  } else if (!silent) {
    console.log(
      `\n${fmt.green('✓')} Created Pen ${fmt.bold(created.title || 'Untitled')} ${fmt.dim(`(${created.id})`)}`,
    );
  }
  if (!silent) {
    if (auth.profile) {
      console.log(`  Profile:    ${fmt.cyan(auth.profile)}`);
    }
    console.log(`  Visibility: ${created.access}`);
    console.log(`  Folder:     ${fmt.cyan(folderDisplay)}`);
    console.log(`  Editor:     ${fmt.cyan(created.urls.editor)}`);
    console.log(`  Preview:    ${fmt.cyan(created.urls.preview)}`);
    console.log(`  Version:    ${fmt.dim(shortId(finalVersionId))}`);
  }

  return {
    pen: created,
    versionId: finalVersionId,
    build: finalBuild,
    auth,
    project: {
      rootDir: targetDir,
      configPath,
      config,
    },
  };
}
