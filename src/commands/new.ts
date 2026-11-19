import fs from 'node:fs/promises';
import path from 'node:path';
import type { Command } from 'commander';
import { CodePenClient } from '../api/client.js';
import type { ResolvedAuth } from '../config/auth.js';
import {
  buildSyncedFileMap,
  hasProjectConfigInDir,
  normalizePenReference,
  PROJECT_CONFIG_FILENAME,
  slugifyTitle,
  writeProjectConfig,
  type ProjectLocation,
} from '../config/project.js';
import { isDirectoryNonEmpty } from '../sync/fs.js';
import { syncRemoteFilesToDisk } from '../sync/materialize.js';
import type { BinaryUploadPart, Build, Pen, PenFileRequest } from '../types.js';
import { fmt, formatDate, printBuildSummary, shortId } from '../utils/format.js';
import {
  isInteractive,
  promptSecret,
  promptSelect,
  promptText,
  type SelectOption,
} from '../utils/prompts.js';
import { getGlobalProfileOption, resolveCommandAuth } from './auth-context.js';
import { normalizeAccess, resolveVisibilityAndPassword } from './create-pen.js';
import {
  buildStarterFiles,
  fetchPenFilesAsUploadPayload,
  getPresetFilePaths,
  listAccountTemplates,
  normalizeScaffoldPreset,
  parseCustomFileList,
  readLocalScaffoldFolder,
  resolveExistingLocalDirectory,
  resolveTemplatePen,
  type ScaffoldPreset,
} from './scaffold.js';

export interface NewPenCliOptions {
  title?: string;
  description?: string;
  tags?: string;
  access?: string;
  password?: string;
  template?: string;
  scaffold?: string;
  files?: string;
  from?: string;
  fork?: string;
  asTemplate?: boolean;
  wait?: boolean;
}

export interface ScaffoldNewPenOptions {
  /** Optional local folder argument (e.g. `my-demo` or `.`). */
  folderArg?: string;
  /** Working directory for resolving relative paths (defaults to `process.cwd()`). */
  cwd?: string;
  /** Explicit `--profile <name>` flag value. */
  explicitProfile?: string;
  title?: string;
  description?: string;
  tags?: string[];
  access?: string;
  password?: string;
  /** CodePen Template ID, URL, or title (`--template`). */
  template?: string;
  /** Built-in scaffold preset: `starter`, `html-css`, `html-css-js`, or `blank` (`--scaffold`). */
  scaffold?: string;
  /** Comma-separated starter file paths (`--files`). */
  files?: string;
  /** Copy files from an existing CodePen Pen (ID/URL) or local folder (`--from`). */
  from?: string;
  /** Fork an existing CodePen Pen via `POST /v2/pens/{id}/fork` (`--fork`). */
  fork?: string;
  /** Mark the newly scaffolded Pen itself as a CodePen Template (`--as-template`). */
  asTemplate?: boolean;
  /** Wait for initial build to settle (defaults to true). */
  wait?: boolean;
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
    text?: (question: string, defaultValue?: string) => Promise<string>;
    select?: <T extends string>(
      question: string,
      options: SelectOption<T>[],
      defaultIndex?: number,
    ) => Promise<T>;
    secret?: (question: string) => Promise<string>;
  };
}

export interface ScaffoldNewPenResult {
  pen: Pen;
  versionId: string | null;
  build: Build | null;
  auth: ResolvedAuth;
  project: ProjectLocation;
  scaffoldLabel: string;
}

type ResolvedScaffold =
  | { kind: 'starter'; label: string }
  | { kind: 'preset'; preset: Exclude<ScaffoldPreset, 'starter'>; filePaths: string[]; label: string }
  | { kind: 'custom-files'; filePaths: string[]; label: string }
  | { kind: 'template'; pen: Pen; label: string }
  | { kind: 'pen'; pen: Pen; label: string }
  | { kind: 'local-dir'; dirPath: string; label: string }
  | { kind: 'fork'; pen: Pen; label: string };

async function assertScaffoldDirectoryEmpty(targetDir: string, folderDisplay: string): Promise<void> {
  try {
    const stat = await fs.lstat(targetDir);
    if (!stat.isDirectory()) {
      throw new Error(`Target path ${folderDisplay} already exists and is not a directory.`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw error;
  }

  if (await hasProjectConfigInDir(targetDir)) {
    throw new Error(
      `${folderDisplay} already contains ${PROJECT_CONFIG_FILENAME}. \`cdpn new\` is only for scaffolding brand-new Pens.\n` +
        'Use `cdpn push` to update the existing Pen, or pass a new folder name (e.g. `cdpn new my-pen`).',
    );
  }

  if (await isDirectoryNonEmpty(targetDir)) {
    throw new Error(
      `Folder ${folderDisplay} is not empty. \`cdpn new\` is only for scaffolding brand-new Pens into a new or empty folder.\n` +
        'To push an existing local demo folder to CodePen, run `cdpn push` inside that folder, or pass a new folder name (e.g. `cdpn new my-pen`).',
    );
  }
}

async function resolveFromSource(
  client: CodePenClient,
  rawSource: string,
  cwd: string,
): Promise<ResolvedScaffold> {
  const trimmed = rawSource.trim();
  if (!trimmed) {
    throw new Error('--from requires a CodePen Pen URL/ID or a local directory path.');
  }

  const localDir = await resolveExistingLocalDirectory(trimmed, cwd);
  if (localDir) {
    return {
      kind: 'local-dir',
      dirPath: localDir,
      label: `Local folder (${trimmed})`,
    };
  }

  const ref = normalizePenReference(trimmed);
  const sourcePen = await client.getPen(ref.apiIdentifier);
  return {
    kind: 'pen',
    pen: sourcePen,
    label: `Pen: ${sourcePen.title || 'Untitled'} (${sourcePen.id})`,
  };
}

function presetLabel(preset: Exclude<ScaffoldPreset, 'starter'>): string {
  switch (preset) {
    case 'blank':
      return 'Blank HTML (index.html)';
    case 'html-css':
      return 'HTML + CSS (index.html, style.css)';
    case 'html-css-js':
      return 'HTML + CSS + JS (index.html, style.css, script.js)';
  }
}

/**
 * Scaffolds a brand-new CodePen 2.0 Pen from a CodePen Template, CodePen's built-in starter,
 * a built-in minimal preset, custom starter files, an existing Pen/local folder, or a fork,
 * and materializes it into a new/empty local folder linked with `.cdpn.json`.
 */
export async function scaffoldNewPen(
  options: ScaffoldNewPenOptions = {},
): Promise<ScaffoldNewPenResult> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const interactive = options.interactive ?? isInteractive();
  const textImpl = options.prompts?.text ?? promptText;
  const selectImpl = options.prompts?.select ?? promptSelect;
  const secretImpl = options.prompts?.secret ?? promptSecret;

  // Validate mutually exclusive scaffold source flags
  const providedSources = [
    options.template !== undefined ? '--template' : null,
    options.scaffold !== undefined ? '--scaffold' : null,
    options.files !== undefined ? '--files' : null,
    options.from !== undefined ? '--from' : null,
    options.fork !== undefined ? '--fork' : null,
  ].filter(Boolean);

  if (providedSources.length > 1) {
    throw new Error(
      `Specify only one scaffold source (${providedSources.join(', ')} cannot be combined).`,
    );
  }

  if (options.tags && options.tags.length > 5) {
    throw new Error('CodePen allows at most 5 tags per Pen.');
  }

  // Pre-validate --scaffold, --files, --access, and --password before hitting the network
  const parsedPreset =
    options.scaffold !== undefined ? normalizeScaffoldPreset(options.scaffold) : undefined;
  const parsedCustomFiles =
    options.files !== undefined ? parseCustomFileList(options.files) : undefined;

  const prevalidatedAccess = normalizeAccess(options.access);
  if (prevalidatedAccess === 'Protected' && options.password !== undefined && options.password.length < 8) {
    throw new Error('Protected Pens require --password with at least 8 characters.');
  }
  if (prevalidatedAccess === 'Protected' && !options.password && !interactive) {
    throw new Error('Protected Pens require --password with at least 8 characters.');
  }

  // If the user passed an explicit folder argument, validate immediately that it is empty/new
  let targetDir: string | null = null;
  let folderDisplay = options.folderArg?.trim() || '';
  if (folderDisplay) {
    targetDir = path.resolve(cwd, folderDisplay);
    await assertScaffoldDirectoryEmpty(targetDir, folderDisplay);
  }

  // Extract optional CodePen URL hint from --template / --from / --fork for profile pre-selection
  const urlCandidate = [options.template, options.from, options.fork].find(
    (v) => v && /^https?:\/\//i.test(v.trim()),
  );

  // 1. Resolve CodePen account/profile (prompts only if multiple profiles exist in ~/.cdpn)
  const auth = await resolveCommandAuth({
    explicitProfile: options.explicitProfile,
    urlHint: urlCandidate,
    promptMessage: 'Which CodePen account/profile would you like to scaffold under?',
    interactive,
    env: options.env,
    homeDir: options.homeDir,
    selectProfile: selectImpl,
  });
  const client = new CodePenClient({ apiKey: auth.apiKey, baseUrl: options.baseUrl });

  // 2. Resolve what the scaffold looks like
  let scaffold: ResolvedScaffold;

  if (options.template !== undefined) {
    const tplPen = await resolveTemplatePen(client, options.template);
    scaffold = {
      kind: 'template',
      pen: tplPen,
      label: `CodePen template: ${tplPen.title || 'Untitled'} (${tplPen.id})`,
    };
  } else if (parsedPreset !== undefined) {
    if (parsedPreset === 'starter') {
      scaffold = { kind: 'starter', label: 'CodePen default starter' };
    } else {
      scaffold = {
        kind: 'preset',
        preset: parsedPreset,
        filePaths: getPresetFilePaths(parsedPreset),
        label: presetLabel(parsedPreset),
      };
    }
  } else if (parsedCustomFiles !== undefined) {
    scaffold = {
      kind: 'custom-files',
      filePaths: parsedCustomFiles,
      label: `Custom files (${parsedCustomFiles.map((p) => p.slice(1)).join(', ')})`,
    };
  } else if (options.from !== undefined) {
    scaffold = await resolveFromSource(client, options.from, cwd);
  } else if (options.fork !== undefined) {
    const ref = normalizePenReference(options.fork);
    const sourcePen = await client.getPen(ref.apiIdentifier);
    scaffold = {
      kind: 'fork',
      pen: sourcePen,
      label: `Fork of ${sourcePen.title || 'Untitled'} (${sourcePen.id})`,
    };
  } else if (interactive) {
    console.log(fmt.dim('Fetching your CodePen templates…'));
    const templates = await listAccountTemplates(client, 25);

    const choices: SelectOption<string>[] = [
      {
        value: 'starter',
        label: 'CodePen default starter',
        description: 'CodePen’s built-in 2.0 starter files',
      },
    ];

    for (const tpl of templates) {
      choices.push({
        value: `template:${tpl.id}`,
        label: `Template: ${tpl.title || 'Untitled'}`,
        description: `${tpl.editor} template · updated ${formatDate(tpl.updated_at)}`,
      });
    }

    choices.push(
      {
        value: 'preset:html-css',
        label: 'HTML + CSS',
        description: 'index.html and style.css',
      },
      {
        value: 'preset:html-css-js',
        label: 'HTML + CSS + JS',
        description: 'index.html, style.css, and script.js',
      },
      {
        value: 'preset:blank',
        label: 'Blank HTML',
        description: 'index.html only',
      },
      {
        value: 'custom-files',
        label: 'Custom files…',
        description: 'choose exact starter files (e.g. index.html, style.css)',
      },
      {
        value: 'from-source',
        label: 'From existing Pen or local folder…',
        description: 'copy files from any of your Pens (URL/ID) or a local directory',
      },
    );

    if (templates.length === 0) {
      console.log(
        fmt.dim(
          'No CodePen templates found on this account yet. Mark any Pen as a template on CodePen (or run `cdpn info --template true`) to see it here.',
        ),
      );
    }

    const chosen = await selectImpl('Choose a scaffold:', choices, 0);

    if (chosen === 'starter') {
      scaffold = { kind: 'starter', label: 'CodePen default starter' };
    } else if (chosen.startsWith('template:')) {
      const tplId = chosen.slice('template:'.length);
      const tplPen = templates.find((t) => t.id === tplId)!;
      scaffold = {
        kind: 'template',
        pen: tplPen,
        label: `CodePen template: ${tplPen.title || 'Untitled'} (${tplPen.id})`,
      };
    } else if (chosen.startsWith('preset:')) {
      const preset = chosen.slice('preset:'.length) as Exclude<ScaffoldPreset, 'starter'>;
      scaffold = {
        kind: 'preset',
        preset,
        filePaths: getPresetFilePaths(preset),
        label: presetLabel(preset),
      };
    } else if (chosen === 'custom-files') {
      const rawFiles = await textImpl('Starter files (comma-separated)', 'index.html, style.css');
      const filePaths = parseCustomFileList(rawFiles);
      scaffold = {
        kind: 'custom-files',
        filePaths,
        label: `Custom files (${filePaths.map((p) => p.slice(1)).join(', ')})`,
      };
    } else {
      const rawSource = await textImpl('CodePen Pen URL/ID or local folder path');
      scaffold = await resolveFromSource(client, rawSource, cwd);
    }
  } else {
    scaffold = { kind: 'starter', label: 'CodePen default starter' };
  }

  // 3. Determine Pen title
  const cwdIsEmpty = !(await isDirectoryNonEmpty(cwd));
  const defaultTitle =
    targetDir && folderDisplay !== '.'
      ? path.basename(targetDir) || 'Untitled'
      : scaffold.kind === 'fork'
        ? scaffold.pen.title || 'Untitled'
        : cwdIsEmpty
          ? path.basename(cwd) || 'Untitled'
          : 'Untitled';

  let title = options.title?.trim();
  if (!title) {
    if (interactive) {
      title = (await textImpl('Pen title', defaultTitle)).trim() || defaultTitle;
    } else if (scaffold.kind !== 'fork') {
      title = defaultTitle;
    }
  }

  // 4. Determine visibility (Public default, Private, Protected, Collaborators)
  const { access, password } = await resolveVisibilityAndPassword({
    rawAccess: options.access,
    rawPassword: options.password,
    interactive,
    prompts: {
      select: selectImpl,
      secret: secretImpl,
    },
  });

  // 5. Resolve & validate target folder (if omitted on CLI) BEFORE creating the Pen on CodePen
  if (!targetDir) {
    const defaultFolder = cwdIsEmpty ? '.' : (slugifyTitle(title) ?? 'new-pen');
    if (interactive) {
      const chosenFolder = (await textImpl('Local folder to scaffold into', defaultFolder)).trim();
      folderDisplay = chosenFolder || defaultFolder;
    } else {
      folderDisplay = defaultFolder;
    }
    targetDir = path.resolve(cwd, folderDisplay);
    await assertScaffoldDirectoryEmpty(targetDir, folderDisplay);
  }

  // 6. Prepare files and create (or fork) the Pen on CodePen
  const shouldWait = options.wait !== false;
  let created: Pen;

  if (scaffold.kind === 'fork') {
    console.log(`\nForking ${fmt.bold(scaffold.pen.title || 'Untitled')} ${fmt.dim(`(${scaffold.pen.id})`)}…`);
    created = await client.forkPen(scaffold.pen.id, {
      ...(title ? { title } : {}),
      ...(options.description ? { description: options.description } : {}),
      ...(options.tags && options.tags.length > 0 ? { tags: options.tags } : {}),
      access,
      ...(password ? { password } : {}),
      wait: shouldWait ? 45 : 0,
    });
    if (options.asTemplate) {
      const initialBuild = created.build;
      const updated = await client.updatePen(created.id, { template: true });
      created = { ...updated, build: initialBuild };
    }
  } else {
    let textFiles: PenFileRequest[] | undefined;
    let binaryFiles: BinaryUploadPart[] = [];

    if (scaffold.kind === 'preset' || scaffold.kind === 'custom-files') {
      textFiles = buildStarterFiles(scaffold.filePaths, title || 'Untitled');
    } else if (scaffold.kind === 'template' || scaffold.kind === 'pen') {
      console.log(
        fmt.dim(`\nReading files from ${scaffold.pen.title || 'Untitled'} (${scaffold.pen.id})…`),
      );
      const payload = await fetchPenFilesAsUploadPayload(client, scaffold.pen.id);
      if (payload.textFiles.length > 0 || payload.binaryFiles.length > 0) {
        textFiles = payload.textFiles;
        binaryFiles = payload.binaryFiles;
      }
    } else if (scaffold.kind === 'local-dir') {
      const payload = await readLocalScaffoldFolder(scaffold.dirPath);
      textFiles = payload.textFiles;
      binaryFiles = payload.binaryFiles;
    }

    console.log(
      scaffold.kind === 'starter'
        ? '\nCreating new CodePen 2.0 Pen with CodePen default starter files…'
        : `\nCreating new CodePen 2.0 Pen from ${scaffold.label}…`,
    );

    created = await client.createPen(
      {
        ...(title ? { title } : {}),
        ...(options.description ? { description: options.description } : {}),
        ...(options.tags && options.tags.length > 0 ? { tags: options.tags } : {}),
        access,
        ...(password ? { password } : {}),
        ...(options.asTemplate ? { template: true } : {}),
        ...(textFiles !== undefined ? { files: textFiles } : {}),
        wait: shouldWait ? 45 : 0,
      },
      binaryFiles,
    );
  }

  let finalBuild = created.build ?? null;
  if (finalBuild && shouldWait) {
    finalBuild = await client.settleBuild(finalBuild);
    printBuildSummary(finalBuild);
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
    console.log(
      `\n${fmt.yellow('!')} Scaffolded Pen ${fmt.bold(created.title || 'Untitled')} ${fmt.dim(`(${created.id})`)}, but the initial build failed.`,
    );
    process.exitCode = 1;
  } else {
    console.log(
      `\n${fmt.green('✓')} Scaffolded Pen ${fmt.bold(created.title || 'Untitled')} ${fmt.dim(`(${created.id})`)}`,
    );
  }
  console.log(`  Scaffold:   ${scaffold.label}`);
  if (auth.profile) {
    console.log(`  Profile:    ${fmt.cyan(auth.profile)}`);
  }
  console.log(`  Visibility: ${created.access}${created.template ? fmt.dim(' · Template') : ''}`);
  console.log(`  Folder:     ${fmt.cyan(folderDisplay)}`);
  console.log(`  Files:      ${materialized.writtenPaths.length} written`);
  console.log(`  Editor:     ${fmt.cyan(created.urls.editor)}`);
  console.log(`  Preview:    ${fmt.cyan(created.urls.preview)}`);
  console.log(`  Version:    ${fmt.dim(shortId(finalVersionId))}`);

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
    scaffoldLabel: scaffold.label,
  };
}

export function registerNewCommand(program: Command): void {
  program
    .command('new [folder]')
    .description('Scaffold a brand-new CodePen 2.0 Pen into a new or empty local folder')
    .option('-t, --title <title>', 'Title for the new Pen')
    .option('-d, --description <text>', 'Description for the new Pen')
    .option('--tags <tags>', 'Comma-separated tags (up to 5)')
    .option('--access <level>', 'Privacy: Public, Private, Protected, or Collaborators')
    .option('--password <password>', 'Password (min 8 chars; required with --access Protected)')
    .option('--template <id-or-name>', 'Scaffold from one of your CodePen Templates (ID, URL, or title)')
    .option('--scaffold <preset>', 'Built-in scaffold preset: starter, html-css, html-css-js, or blank')
    .option('--files <paths>', 'Comma-separated starter files to create (e.g. index.html,style.css)')
    .option('--from <pen-or-dir>', 'Copy starter files from an existing CodePen Pen (ID/URL) or local folder')
    .option('--fork <pen>', 'Fork one of your existing CodePen Pens (keeps parent link on CodePen)')
    .option('--as-template', 'Mark the newly created Pen as a Template on CodePen')
    .option('--no-wait', 'Return as soon as files are saved without waiting for the build')
    .action(async (folderArg: string | undefined, options: NewPenCliOptions, command: Command) => {
      const tags = options.tags
        ? options.tags
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean)
        : undefined;

      await scaffoldNewPen({
        folderArg,
        explicitProfile: getGlobalProfileOption(command),
        title: options.title,
        description: options.description,
        tags,
        access: options.access,
        password: options.password,
        template: options.template,
        scaffold: options.scaffold,
        files: options.files,
        from: options.from,
        fork: options.fork,
        asTemplate: options.asTemplate,
        wait: options.wait,
      });
    });
}
