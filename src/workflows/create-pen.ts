import fs from 'node:fs/promises';
import path from 'node:path';
import { CodePenClient } from '../api/client.js';
import type { BinaryUploadPart, Build, Pen, PenAccess, PenFileRequest } from '../api/types.js';
import type { ResolvedAuth } from '../config/auth.js';
import {
  buildSyncedFileMap,
  hasProjectConfigInDir,
  readProjectConfigFile,
  writeProjectConfig,
  type PenInfo,
  type ProjectLocation,
} from '../config/project.js';
import {
  MAX_PEN_TAGS,
  MIN_PROTECTED_PASSWORD_LENGTH,
  PEN_ACCESS_CHOICES,
  PROJECT_CONFIG_FILENAME,
} from '../constants.js';
import { CliError } from '../errors.js';
import { scanLocalFiles } from '../sync/fs.js';
import { buildPenInfoConfigFields, hasAnyPenInfoFields } from '../sync/info.js';
import { syncRemoteFilesToDisk } from '../sync/materialize.js';
import {
  assertValidProtectedPassword,
  normalizeAccess,
  resolveAccessOrVisibility,
} from '../utils/cli-options.js';
import { fmt, printBuildSummary, shortId } from '../utils/format.js';
import { extractHtmlTitle } from '../utils/html.js';
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

export { normalizeAccess };

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
  rawVisibility?: string;
  rawPassword?: string;
  interactive: boolean;
  output?: CommandOutput;
  prompts?: VisibilityPromptCallbacks;
}): Promise<{ access: PenAccess; password?: string }> {
  const output = options.output ?? defaultOutput;
  const selectImpl = options.prompts?.select ?? promptSelect;
  const secretImpl = options.prompts?.secret ?? promptSecret;

  let access = resolveAccessOrVisibility(options.rawAccess, options.rawVisibility);
  assertValidProtectedPassword(access, options.rawPassword, options.interactive);

  if (!access) {
    if (options.interactive) {
      const choices: SelectOption<PenAccess>[] = PEN_ACCESS_CHOICES.map((c) => ({
        value: c.value,
        label: c.label,
        description: c.value === 'Public' ? `${c.description} (default)` : c.description,
      }));
      access = await selectImpl<PenAccess>('Pen visibility:', choices, 0);
    } else {
      access = 'Public';
    }
  }

  let password = options.rawPassword;
  if (access === 'Protected' && (!password || password.length < MIN_PROTECTED_PASSWORD_LENGTH)) {
    if (!options.interactive) {
      assertValidProtectedPassword(access, password, false);
    }
    for (;;) {
      password = await secretImpl(
        `Password for Protected Pen (min ${MIN_PROTECTED_PASSWORD_LENGTH} characters)`,
      );
      if (password.length >= MIN_PROTECTED_PASSWORD_LENGTH) break;
      output.log(
        fmt.yellow(`Password must be at least ${MIN_PROTECTED_PASSWORD_LENGTH} characters.`),
      );
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
  /** Alias for `access`. */
  visibility?: string;
  /** Pre-supplied password (for Protected Pens). */
  password?: string;
  template?: boolean;
  /** Skip confirmation when `index.html` is missing. */
  force?: boolean;
  /** Wait for initial build to settle (defaults to true). */
  wait?: boolean;
  /** Suppress stdout progress/summary logs and interactive prompts (used by --json callers). */
  silent?: boolean;
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
  exitCode?: number;
}

export function printMissingIndexHtmlWarning(
  targetDir: string,
  fileCount: number,
  output: CommandOutput = defaultOutput,
): void {
  const headline = '  WARNING: No index.html found in this folder!  ';
  const border = '═'.repeat(headline.length);
  output.log('');
  output.log(fmt.yellow(fmt.bold(`╔${border}╗`)));
  output.log(fmt.yellow(fmt.bold(`║${headline}║`)));
  output.log(fmt.yellow(fmt.bold(`╚${border}╝`)));
  output.log(
    fmt.yellow(
      `CodePen expects an index.html file at the root of your demo.\n` +
        `Double-check that you are in the right folder before pushing:\n` +
        `  Folder: ${targetDir} (${fileCount} file(s) found)`,
    ),
  );
  output.log('');
}

/**
 * First-time Pen creation flow used by `cdpn push` and `cdpn deploy` when invoked inside
 * an unlinked local demo folder (including one with retained `info` in `.cdpn.json` from
 * `cdpn delete --keep-info`):
 *
 * 1. Checks for `/index.html`; if absent, displays a prominent warning and asks for confirmation.
 * 2. Resolves or asks which CodePen account/profile to push to (when multiple keys are in `~/.cdpn`).
 * 3. Uses retained `info.title` (or `--title`), otherwise asks for a title (pre-filled from `index.html`'s `<title>`).
 * 4. Uses retained `info.access` (or `--access`/`--visibility`), otherwise asks for visibility (`Public` default,
 *    `Private`, `Protected`, or `Collaborators`), prompting for a password if `Protected`.
 * 5. Carries over retained `description`, `tags`, and `template` from `.cdpn.json` when present.
 */
export async function createPenFromDirectory(
  options: CreatePenFlowOptions,
): Promise<CreatePenFlowResult | null> {
  const output = options.output ?? defaultOutput;
  const silent = Boolean(options.silent);
  const interactive = silent ? false : (options.interactive ?? isInteractive());
  const confirmImpl = options.prompts?.confirm ?? promptConfirm;
  const textImpl = options.prompts?.text ?? promptText;
  const selectImpl = options.prompts?.select ?? promptSelect;

  // Validate explicit CLI --access / --visibility / --password early before reading config or scanning
  const explicitAccess = resolveAccessOrVisibility(options.access, options.visibility);
  assertValidProtectedPassword(explicitAccess, options.password, interactive);

  const targetDir = path.resolve(options.targetDir);
  const folderDisplay = options.folderDisplay;

  let retainedInfo: PenInfo | undefined;
  if (await hasProjectConfigInDir(targetDir)) {
    const existing = await readProjectConfigFile(targetDir);
    if (existing.linked) {
      throw new CliError(
        409,
        `${targetDir} already contains ${PROJECT_CONFIG_FILENAME}. Use \`cdpn push\` to update the existing Pen.`,
      );
    }
    retainedInfo = existing.config.info;
  }

  const effectiveAccess = explicitAccess ?? normalizeAccess(retainedInfo?.access);
  const effectiveDescription =
    options.description !== undefined ? options.description : retainedInfo?.description;
  const effectiveTags = options.tags !== undefined ? options.tags : retainedInfo?.tags;
  const effectiveTemplate =
    options.template !== undefined ? options.template : retainedInfo?.template;

  // Validate effective metadata constraints early before scanning or prompting
  if (effectiveTags && effectiveTags.length > MAX_PEN_TAGS) {
    throw new CliError(
      400,
      `CodePen allows at most ${MAX_PEN_TAGS} tags per Pen (found ${effectiveTags.length}${
        options.tags === undefined ? ` in ${PROJECT_CONFIG_FILENAME}` : ''
      }).`,
    );
  }
  assertValidProtectedPassword(effectiveAccess, options.password, interactive);

  const scanned = await scanLocalFiles(targetDir);
  if (scanned.size === 0) {
    throw new CliError(
      400,
      retainedInfo !== undefined
        ? `No syncable files found in ${targetDir} (only an unlinked ${PROJECT_CONFIG_FILENAME} is present).`
        : `No ${PROJECT_CONFIG_FILENAME} found and no syncable files in ${targetDir}.\n` +
            'Run `cdpn clone <url>` to clone an existing Pen or `cdpn new` to scaffold a brand-new Pen.',
    );
  }

  const indexFile = scanned.get('/index.html');

  // 1. Check for index.html before pushing a local demo for the first time
  if (!indexFile) {
    if (!silent) {
      printMissingIndexHtmlWarning(targetDir, scanned.size, output);
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
        output.log('Aborted.');
        return null;
      }
    }
  }

  // 2. Ask which account/profile to push to (only prompts if multiple keys exist in ~/.cdpn)
  const auth = await resolveCommandAuth({
    explicitProfile: options.explicitProfile,
    promptMessage: 'Which CodePen account/profile would you like to push to?',
    interactive,
    output,
    env: options.env,
    homeDir: options.homeDir,
    selectProfile: selectImpl,
  });
  const client = new CodePenClient({ apiKey: auth.apiKey, baseUrl: options.baseUrl });

  // 3. Determine title (explicit --title > retained info.title > index.html <title> > folder basename)
  let title = options.title?.trim() || retainedInfo?.title?.trim();
  if (!title) {
    const htmlTitle =
      indexFile && !indexFile.isBinary && indexFile.textContent
        ? extractHtmlTitle(indexFile.textContent)
        : null;
    const fallbackTitle = path.basename(targetDir) || 'Untitled';
    const defaultTitle = htmlTitle ?? fallbackTitle;

    if (interactive) {
      title = (await textImpl('Pen title', defaultTitle)).trim() || defaultTitle;
    } else {
      title = defaultTitle;
    }
  }

  // 4. Resolve visibility (explicit --access/--visibility > retained info.access > interactive picker / Public default)
  const { access, password } = await resolveVisibilityAndPassword({
    rawAccess: effectiveAccess,
    rawPassword: options.password,
    interactive,
    output,
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
    if (hasAnyPenInfoFields(retainedInfo)) {
      output.log(fmt.dim(`Using saved Pen info from ${PROJECT_CONFIG_FILENAME}.`));
    }
    output.log(`\nCreating new Pen from ${textFiles.length + binaryFiles.length} local file(s)…`);
  }

  const created = await client.createPen(
    {
      ...(title ? { title } : {}),
      ...(effectiveDescription ? { description: effectiveDescription } : {}),
      ...(effectiveTags && effectiveTags.length > 0 ? { tags: effectiveTags } : {}),
      access,
      ...(password ? { password } : {}),
      ...(effectiveTemplate ? { template: true } : {}),
      files: textFiles,
      wait: shouldWait ? 45 : 0,
    },
    binaryFiles,
  );

  let finalBuild = created.build ?? null;
  if (finalBuild && shouldWait) {
    finalBuild = await client.settleBuild(finalBuild);
    if (!silent) {
      printBuildSummary(finalBuild, output);
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
    ...buildPenInfoConfigFields(created),
    files: buildSyncedFileMap(remoteFiles, materialized.localSha256ByPath),
  };
  const configPath = await writeProjectConfig(targetDir, config);

  const buildFailed = finalBuild?.status === 'Failed';
  if (buildFailed) {
    if (!silent) {
      output.log(
        `\n${fmt.yellow('!')} Created Pen ${fmt.bold(created.title || 'Untitled')} ${fmt.dim(`(${created.id})`)}, but the initial build failed.`,
      );
    }
  } else if (!silent) {
    output.log(
      `\n${fmt.green('✓')} Created Pen ${fmt.bold(created.title || 'Untitled')} ${fmt.dim(`(${created.id})`)}`,
    );
  }
  if (!silent) {
    if (auth.profile) {
      output.log(`  Profile:    ${fmt.cyan(auth.profile)}`);
    }
    output.log(`  Visibility: ${created.access}`);
    output.log(`  Folder:     ${fmt.cyan(folderDisplay)}`);
    output.log(`  Editor:     ${fmt.cyan(created.urls.editor)}`);
    output.log(`  Preview:    ${fmt.cyan(created.urls.preview)}`);
    output.log(`  Version:    ${fmt.dim(shortId(finalVersionId))}`);
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
    ...(buildFailed ? { exitCode: 1 } : {}),
  };
}
