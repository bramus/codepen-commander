import fs from 'node:fs/promises';
import path from 'node:path';
import type { Command } from 'commander';
import { CodePenClient } from '../api/client.js';
import type { ResolvedAuth } from '../config/auth.js';
import {
  buildSyncedFileMap,
  slugifyTitle,
  writeProjectConfig,
  type ProjectLocation,
} from '../config/project.js';
import {
  buildPenConfigObject,
  CLASSIC_CONFIG_FILENAME,
  CODEPEN_DIR,
  normalizePenBlocksList,
  parseBlocksOption,
  PEN_CONFIG_FILENAME,
} from '../site/blocks.js';
import { isDirectoryNonEmpty } from '../sync/fs.js';
import { buildPenInfoConfigFields } from '../sync/info.js';
import { syncRemoteFilesToDisk } from '../sync/materialize.js';
import type { BinaryUploadPart, Build, FileChange, Pen, PenFile, PenFileRequest } from '../types.js';
import { fmt, formatDate, printBuildSummary, shortId } from '../utils/format.js';
import { CliError, printJsonResponse } from '../utils/json.js';
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
  assertEmptyTargetDirectory,
  fetchPenFilesAsUploadPayload,
  listAccountTemplates,
  resolveTemplatePen,
} from './scaffold.js';

export interface NewPenCliOptions {
  title?: string;
  description?: string;
  tags?: string;
  access?: string;
  visibility?: string;
  blocks?: string;
  password?: string;
  template?: string;
  asTemplate?: boolean;
  wait?: boolean;
  json?: boolean;
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
  visibility?: string;
  /** Optional CodePen blocks to enable (`validate-1` and `fingerprint-1` are always included). */
  blocks?: string | string[];
  password?: string;
  /** CodePen Template ID, URL, or title (`--template`). */
  template?: string;
  /** Mark the newly scaffolded Pen itself as a CodePen Template (`--as-template`). */
  asTemplate?: boolean;
  /** Wait for initial build to settle (defaults to true). */
  wait?: boolean;
  /** Output scaffold result as JSON. */
  json?: boolean;
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
  templateLabel: string;
  blocks?: string[];
}

type SelectedTemplate =
  | { kind: 'default-starter'; label: string }
  | { kind: 'template'; pen: Pen; label: string };

const NEW_NON_EMPTY_HINT =
  'To push an existing local demo folder to CodePen, run `cdpn push` inside that folder, or pass a new folder name (e.g. `cdpn new my-pen`).';

const PEN_CONFIG_PEN_PATH = `/${CODEPEN_DIR}/${PEN_CONFIG_FILENAME}`;
const CLASSIC_CONFIG_PEN_PATH = `/${CODEPEN_DIR}/${CLASSIC_CONFIG_FILENAME}`;

function parseJsonObjectSafe(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function buildStarterClassicConfigFromPaths(filePaths: readonly string[]): string {
  const pathSet = new Set(filePaths.map((p) => (p.startsWith('/') ? p : `/${p}`)));
  const config = {
    head: '<meta name="viewport" content="width=device-width" />',
    htmlClasses: '',
    scripts: pathSet.has('/script.js') ? ['/script.js'] : [],
    styles: pathSet.has('/style.css') ? ['/style.css'] : [],
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

/**
 * Scaffolds a brand-new CodePen 2.0 Pen strictly from CodePen's built-in default starter
 * or one of your CodePen Templates, and materializes it into a new/empty local folder
 * linked with `.cdpn.json`.
 */
export async function scaffoldNewPen(
  options: ScaffoldNewPenOptions = {},
): Promise<ScaffoldNewPenResult> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const jsonMode = Boolean(options.json);
  const interactive = (options.interactive ?? isInteractive()) && !jsonMode;
  const textImpl = options.prompts?.text ?? promptText;
  const selectImpl = options.prompts?.select ?? promptSelect;
  const secretImpl = options.prompts?.secret ?? promptSecret;

  if (options.tags && options.tags.length > 5) {
    throw new CliError(400, 'CodePen allows at most 5 tags per Pen.');
  }

  // Pre-validate --access / --visibility, --blocks, and --password before hitting the network
  const parsedAccessFlag = normalizeAccess(options.access);
  const parsedVisibilityFlag = normalizeAccess(options.visibility);
  if (parsedAccessFlag && parsedVisibilityFlag && parsedAccessFlag !== parsedVisibilityFlag) {
    throw new CliError(
      400,
      `Conflicting --access ("${parsedAccessFlag}") and --visibility ("${parsedVisibilityFlag}") values.`,
    );
  }
  const effectiveRawAccess = options.access ?? options.visibility;
  const prevalidatedAccess = parsedAccessFlag ?? parsedVisibilityFlag;

  let resolvedBlocks: string[] | undefined;
  if (options.blocks !== undefined) {
    resolvedBlocks =
      typeof options.blocks === 'string'
        ? parseBlocksOption(options.blocks)
        : normalizePenBlocksList(options.blocks);
  }

  if (prevalidatedAccess === 'Protected' && options.password !== undefined && options.password.length < 8) {
    throw new CliError(400, 'Protected Pens require --password with at least 8 characters.');
  }
  if (prevalidatedAccess === 'Protected' && !options.password && !interactive) {
    throw new CliError(400, 'Protected Pens require --password with at least 8 characters.');
  }

  // If the user passed an explicit folder argument, validate immediately that it is empty/new
  let targetDir: string | null = null;
  let folderDisplay = options.folderArg?.trim() || '';
  if (folderDisplay) {
    targetDir = path.resolve(cwd, folderDisplay);
    await assertEmptyTargetDirectory(targetDir, folderDisplay, {
      commandName: 'new',
      nonEmptyHint: NEW_NON_EMPTY_HINT,
    });
  }

  const urlHint =
    options.template && /^https?:\/\//i.test(options.template.trim())
      ? options.template.trim()
      : undefined;

  // 1. Resolve CodePen account/profile (prompts only if multiple profiles exist in ~/.cdpn)
  const auth = await resolveCommandAuth({
    explicitProfile: options.explicitProfile,
    urlHint,
    promptMessage: 'Which CodePen account/profile would you like to scaffold under?',
    interactive,
    env: options.env,
    homeDir: options.homeDir,
    selectProfile: selectImpl,
  });
  const client = new CodePenClient({ apiKey: auth.apiKey, baseUrl: options.baseUrl });

  // 2. Select CodePen Template (or CodePen's built-in default starter)
  let selected: SelectedTemplate;

  if (options.template !== undefined) {
    const tplPen = await resolveTemplatePen(client, options.template);
    selected = {
      kind: 'template',
      pen: tplPen,
      label: `CodePen template: ${tplPen.title || 'Untitled'} (${tplPen.id})`,
    };
  } else if (interactive) {
    console.log(fmt.dim('Fetching your CodePen templates…'));
    const templates = await listAccountTemplates(client, 25);

    if (templates.length === 0) {
      console.log(
        fmt.dim(
          'No custom CodePen templates found — using CodePen’s default 2.0 starter.\n' +
            'Tip: Mark any Pen as a template on CodePen (or run `cdpn info --template true`) to choose it here.',
        ),
      );
      selected = { kind: 'default-starter', label: 'CodePen default starter' };
    } else {
      const choices: SelectOption<string>[] = [
        {
          value: 'default-starter',
          label: 'CodePen default starter',
          description: 'CodePen’s built-in 2.0 starter files',
        },
        ...templates.map((tpl) => ({
          value: `template:${tpl.id}`,
          label: tpl.title || 'Untitled',
          description: `${tpl.editor} template · updated ${formatDate(tpl.updated_at)}`,
        })),
      ];

      const chosen = await selectImpl('Choose a template:', choices, 0);
      if (chosen === 'default-starter') {
        selected = { kind: 'default-starter', label: 'CodePen default starter' };
      } else {
        const tplId = chosen.slice('template:'.length);
        const tplPen = templates.find((t) => t.id === tplId)!;
        selected = {
          kind: 'template',
          pen: tplPen,
          label: `CodePen template: ${tplPen.title || 'Untitled'} (${tplPen.id})`,
        };
      }
    }
  } else {
    selected = { kind: 'default-starter', label: 'CodePen default starter' };
  }

  // 3. Determine Pen title
  const cwdIsEmpty = !(await isDirectoryNonEmpty(cwd));
  const defaultTitle =
    targetDir && folderDisplay !== '.'
      ? path.basename(targetDir) || 'Untitled'
      : cwdIsEmpty
        ? path.basename(cwd) || 'Untitled'
        : 'Untitled';

  let title = options.title?.trim();
  if (!title) {
    if (interactive) {
      title = (await textImpl('Pen title', defaultTitle)).trim() || defaultTitle;
    } else {
      title = defaultTitle;
    }
  }

  // 4. Determine visibility (Public default, Private, Protected, Collaborators)
  const { access, password } = await resolveVisibilityAndPassword({
    rawAccess: effectiveRawAccess,
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
    await assertEmptyTargetDirectory(targetDir, folderDisplay, {
      commandName: 'new',
      nonEmptyHint: NEW_NON_EMPTY_HINT,
    });
  }

  // 6. Fetch template files (if using a custom CodePen Template) and create Pen
  const shouldWait = options.wait !== false;
  let textFiles: PenFileRequest[] | undefined;
  let binaryFiles: BinaryUploadPart[] = [];

  if (selected.kind === 'template') {
    if (!jsonMode) {
      console.log(
        fmt.dim(`\nReading template files from ${selected.pen.title || 'Untitled'} (${selected.pen.id})…`),
      );
    }
    const payload = await fetchPenFilesAsUploadPayload(client, selected.pen.id);
    if (payload.textFiles.length > 0 || payload.binaryFiles.length > 0) {
      textFiles = payload.textFiles;
      binaryFiles = payload.binaryFiles;
    }

    if (resolvedBlocks !== undefined) {
      const mergedFiles = textFiles ? [...textFiles] : [];
      const existingPenConfigIdx = mergedFiles.findIndex(
        (file) => (file.path.startsWith('/') ? file.path : `/${file.path}`) === PEN_CONFIG_PEN_PATH,
      );
      const existingPenConfig =
        existingPenConfigIdx >= 0 ? parseJsonObjectSafe(mergedFiles[existingPenConfigIdx]?.content) : null;
      const penConfigJson = `${JSON.stringify(
        buildPenConfigObject(resolvedBlocks, { existing: existingPenConfig }),
        null,
        2,
      )}\n`;

      if (existingPenConfigIdx >= 0) {
        mergedFiles[existingPenConfigIdx] = { path: PEN_CONFIG_PEN_PATH, content: penConfigJson };
      } else {
        mergedFiles.push({ path: PEN_CONFIG_PEN_PATH, content: penConfigJson });
      }

      const hasClassicConfig = mergedFiles.some(
        (file) => (file.path.startsWith('/') ? file.path : `/${file.path}`) === CLASSIC_CONFIG_PEN_PATH,
      );
      if (resolvedBlocks.includes('classic-1') && !hasClassicConfig) {
        mergedFiles.push({
          path: CLASSIC_CONFIG_PEN_PATH,
          content: buildStarterClassicConfigFromPaths([
            ...mergedFiles.map((file) => file.path),
            ...binaryFiles.map((file) => file.path),
          ]),
        });
      }

      textFiles = mergedFiles;
    }
  }

  if (!jsonMode) {
    console.log(
      selected.kind === 'default-starter'
        ? '\nCreating new CodePen 2.0 Pen with CodePen default starter files…'
        : `\nCreating new CodePen 2.0 Pen from ${selected.label}…`,
    );
  }

  const created = await client.createPen(
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

  let finalBuild = created.build ?? null;
  if (finalBuild && shouldWait) {
    finalBuild = await client.settleBuild(finalBuild);
    if (!jsonMode) {
      printBuildSummary(finalBuild);
    }
  }

  let finalVersionId = finalBuild?.version_id ?? created.saved_version?.id ?? null;
  let remoteFiles: PenFile[] = finalVersionId
    ? (await client.getVersion(finalVersionId)).files ?? (await client.getPenFiles(created.id))
    : await client.getPenFiles(created.id);

  // When scaffolding from CodePen's default starter with explicit --blocks, apply the
  // block configuration in a follow-up file write so CodePen's starter files are preserved.
  if (selected.kind === 'default-starter' && resolvedBlocks !== undefined) {
    const existingPenConfigFile = remoteFiles.find(
      (file) => (file.path.startsWith('/') ? file.path : `/${file.path}`) === PEN_CONFIG_PEN_PATH,
    );
    let existingPenConfigRaw: string | null = null;
    if (existingPenConfigFile && !existingPenConfigFile.is_binary) {
      if (existingPenConfigFile.content !== null) {
        existingPenConfigRaw = existingPenConfigFile.content;
      } else if (existingPenConfigFile.download_url) {
        existingPenConfigRaw = (await client.downloadFile(existingPenConfigFile.download_url)).toString('utf8');
      }
    }

    const penConfigJson = `${JSON.stringify(
      buildPenConfigObject(resolvedBlocks, { existing: parseJsonObjectSafe(existingPenConfigRaw) }),
      null,
      2,
    )}\n`;

    const blockChanges: FileChange[] = [
      {
        ...(existingPenConfigFile ? { id: existingPenConfigFile.id } : {}),
        path: PEN_CONFIG_PEN_PATH,
        content: penConfigJson,
      },
    ];

    const hasClassicConfig = remoteFiles.some(
      (file) => (file.path.startsWith('/') ? file.path : `/${file.path}`) === CLASSIC_CONFIG_PEN_PATH,
    );
    if (resolvedBlocks.includes('classic-1') && !hasClassicConfig) {
      blockChanges.push({
        path: CLASSIC_CONFIG_PEN_PATH,
        content: buildStarterClassicConfigFromPaths(remoteFiles.map((file) => file.path)),
      });
    }

    if (!jsonMode) {
      console.log(fmt.dim(`Configuring CodePen blocks (${resolvedBlocks.join(', ')})…`));
    }
    const writeResult = await client.writePenFiles(created.id, {
      files: blockChanges,
      ...(finalVersionId ? { expected_version_id: finalVersionId } : {}),
      wait: shouldWait ? 45 : 0,
    });
    if (writeResult.build) {
      finalBuild = shouldWait ? await client.settleBuild(writeResult.build) : writeResult.build;
      if (shouldWait && !jsonMode) {
        printBuildSummary(finalBuild);
      }
    }
    finalVersionId = finalBuild?.version_id ?? writeResult.version?.id ?? finalVersionId;
    remoteFiles = finalVersionId
      ? (await client.getVersion(finalVersionId)).files ?? (await client.getPenFiles(created.id))
      : await client.getPenFiles(created.id);
  }

  await fs.mkdir(targetDir, { recursive: true });

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
    process.exitCode = 1;
  }

  if (jsonMode) {
    const code = buildFailed ? 422 : 201;
    const message = buildFailed
      ? `Scaffolded Pen ${created.title || 'Untitled'}, but the initial build failed.`
      : `Scaffolded Pen ${created.title || 'Untitled'} into ${folderDisplay}.`;
    printJsonResponse(code, message, {
      pen: created,
      template: selected.label,
      profile: auth.profile,
      folder: folderDisplay,
      root_dir: targetDir,
      config_path: configPath,
      version_id: finalVersionId,
      build: finalBuild,
      written_paths: materialized.writtenPaths,
      ...(resolvedBlocks ? { blocks: resolvedBlocks } : {}),
    });
  } else {
    if (buildFailed) {
      console.log(
        `\n${fmt.yellow('!')} Scaffolded Pen ${fmt.bold(created.title || 'Untitled')} ${fmt.dim(`(${created.id})`)}, but the initial build failed.`,
      );
    } else {
      console.log(
        `\n${fmt.green('✓')} Scaffolded Pen ${fmt.bold(created.title || 'Untitled')} ${fmt.dim(`(${created.id})`)}`,
      );
    }
    console.log(`  Template:   ${selected.label}`);
    if (auth.profile) {
      console.log(`  Profile:    ${fmt.cyan(auth.profile)}`);
    }
    console.log(`  Visibility: ${created.access}${created.template ? fmt.dim(' · Template') : ''}`);
    if (resolvedBlocks) {
      console.log(`  Blocks:     ${fmt.cyan(resolvedBlocks.join(', '))}`);
    }
    console.log(`  Folder:     ${fmt.cyan(folderDisplay)}`);
    console.log(`  Files:      ${materialized.writtenPaths.length} written`);
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
    templateLabel: selected.label,
    ...(resolvedBlocks ? { blocks: resolvedBlocks } : {}),
  };
}

export function registerNewCommand(program: Command): void {
  program
    .command('new [folder]')
    .description('Scaffold a brand-new CodePen 2.0 Pen from a CodePen Template into a new or empty folder')
    .option('-t, --title <title>', 'Title for the new Pen')
    .option('-d, --description <text>', 'Description for the new Pen')
    .option('--tags <tags>', 'Comma-separated tags (up to 5)')
    .option('--access <level>', 'Privacy: Public, Private, Protected, or Collaborators')
    .option('--visibility <level>', 'Alias for --access (Public, Private, Protected, or Collaborators)')
    .option(
      '--blocks <blocks>',
      'Comma-separated CodePen blocks to enable (e.g. packages,classic; validate and fingerprint are always included)',
    )
    .option('--password <password>', 'Password (min 8 chars; required with --access Protected)')
    .option('--template <id-or-name>', 'Scaffold from one of your CodePen Templates (ID, URL, or title)')
    .option('--as-template', 'Mark the newly created Pen as a Template on CodePen')
    .option('--no-wait', 'Return as soon as files are saved without waiting for the build')
    .option('--json', 'Output scaffolded Pen result as JSON')
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
        visibility: options.visibility,
        blocks: options.blocks,
        password: options.password,
        template: options.template,
        asTemplate: options.asTemplate,
        wait: options.wait,
        json: options.json,
      });
    });
}
