import fs from 'node:fs/promises';
import path from 'node:path';
import type { Command } from 'commander';
import { CodePenClient } from '../api/client.js';
import type { BinaryUploadPart, Build, FileChange, Pen, PenFile, PenFileRequest } from '../api/types.js';
import type { ResolvedAuth } from '../config/auth.js';
import {
  buildPenConfigObject,
  buildStarterClassicConfigFromPaths,
  normalizePenBlocksList,
  parseBlocksOption,
} from '../config/pen-blocks.js';
import {
  buildSyncedFileMap,
  writeProjectConfig,
  type ProjectLocation,
} from '../config/project.js';
import {
  CLASSIC_CONFIG_FILENAME,
  CODEPEN_DIR,
  PEN_CONFIG_FILENAME,
} from '../constants.js';
import { buildPenInfoConfigFields } from '../sync/info.js';
import { syncRemoteFilesToDisk } from '../sync/materialize.js';
import {
  assertValidProtectedPassword,
  assertValidTagCount,
  parseTagsOption,
  resolveAccessOrVisibility,
} from '../utils/cli-options.js';
import { fmt, formatDate, printBuildSummary, shortId } from '../utils/format.js';
import { printJsonResponse } from '../utils/json.js';
import { defaultOutput, type CommandOutput } from '../utils/output.js';
import {
  isInteractive,
  promptSecret,
  promptSelect,
  promptText,
  type SelectOption,
} from '../utils/prompts/index.js';
import { isPlainObject } from '../utils/strings.js';
import { getGlobalProfileOption, resolveCommandAuth } from '../workflows/auth-context.js';
import { resolveVisibilityAndPassword } from '../workflows/create-pen.js';
import {
  assertEmptyTargetDirectory,
  fetchPenFilesAsUploadPayload,
  listAccountTemplates,
  resolveTemplatePen,
} from '../workflows/scaffold.js';

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

export interface RunNewCommandOptions {
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
    text?: (question: string, defaultValue?: string) => Promise<string>;
    select?: <T extends string>(
      question: string,
      options: SelectOption<T>[],
      defaultIndex?: number,
    ) => Promise<T>;
    secret?: (question: string) => Promise<string>;
  };
}

export interface NewCommandResult {
  pen: Pen;
  versionId: string | null;
  build: Build | null;
  auth: ResolvedAuth;
  project: ProjectLocation;
  templateLabel: string;
  blocks?: string[];
  exitCode?: number;
}

type SelectedTemplate =
  | { kind: 'default-starter'; label: string }
  | { kind: 'template'; pen: Pen; label: string };

const NEW_NON_EMPTY_HINT =
  'To convert an existing local demo into a CodePen demo, run `cdpn init` inside that folder — or pass a new folder name (e.g. `cdpn new my-pen`).';

const PEN_CONFIG_PEN_PATH = `/${CODEPEN_DIR}/${PEN_CONFIG_FILENAME}`;
const CLASSIC_CONFIG_PEN_PATH = `/${CODEPEN_DIR}/${CLASSIC_CONFIG_FILENAME}`;

function parseJsonObjectSafe(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Scaffolds a brand-new CodePen 2.0 Pen strictly from CodePen's built-in default starter
 * or one of your CodePen Templates, and materializes it into a new/empty local folder
 * linked with `.cdpn.json`.
 */
export async function runNewCommand(
  options: RunNewCommandOptions = {},
): Promise<NewCommandResult> {
  const output = options.output ?? defaultOutput;
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const jsonMode = Boolean(options.json);
  const interactive = (options.interactive ?? isInteractive()) && !jsonMode;
  const textImpl = options.prompts?.text ?? promptText;
  const selectImpl = options.prompts?.select ?? promptSelect;
  const secretImpl = options.prompts?.secret ?? promptSecret;

  assertValidTagCount(options.tags);

  // Pre-validate --access / --visibility, --blocks, and --password before hitting the network
  const prevalidatedAccess = resolveAccessOrVisibility(options.access, options.visibility);

  let resolvedBlocks: string[] | undefined;
  if (options.blocks !== undefined) {
    resolvedBlocks =
      typeof options.blocks === 'string'
        ? parseBlocksOption(options.blocks)
        : normalizePenBlocksList(options.blocks);
  }

  assertValidProtectedPassword(prevalidatedAccess, options.password, interactive);

  // Validate target directory immediately (defaults to current directory `.` when omitted)
  const folderDisplay = options.folderArg?.trim() || '.';
  const targetDir = path.resolve(cwd, folderDisplay);
  await assertEmptyTargetDirectory(targetDir, folderDisplay, {
    commandName: 'new',
    nonEmptyHint: NEW_NON_EMPTY_HINT,
  });

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
    output,
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
    output.log(fmt.dim('Fetching your CodePen templates…'));
    const templates = await listAccountTemplates(client, 25);

    if (templates.length === 0) {
      output.log(
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
  const defaultTitle = path.basename(targetDir) || 'Untitled';

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
    rawAccess: prevalidatedAccess,
    rawPassword: options.password,
    interactive,
    output,
    prompts: {
      select: selectImpl,
      secret: secretImpl,
    },
  });

  // 5. Fetch template files (if using a custom CodePen Template) and create Pen
  const shouldWait = options.wait !== false;
  let textFiles: PenFileRequest[] | undefined;
  let binaryFiles: BinaryUploadPart[] = [];

  if (selected.kind === 'template') {
    if (!jsonMode) {
      output.log(
        fmt.dim(
          `\nReading template files from ${selected.pen.title || 'Untitled'} (${selected.pen.id})…`,
        ),
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
        existingPenConfigIdx >= 0
          ? parseJsonObjectSafe(mergedFiles[existingPenConfigIdx]?.content)
          : null;
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
        (file) =>
          (file.path.startsWith('/') ? file.path : `/${file.path}`) === CLASSIC_CONFIG_PEN_PATH,
      );
      if (resolvedBlocks.includes('classic-1') && !hasClassicConfig) {
        mergedFiles.push({
          path: CLASSIC_CONFIG_PEN_PATH,
          content: `${JSON.stringify(
            buildStarterClassicConfigFromPaths([
              ...mergedFiles.map((file) => file.path),
              ...binaryFiles.map((file) => file.path),
            ]),
            null,
            2,
          )}\n`,
        });
      }

      textFiles = mergedFiles;
    }
  }

  if (!jsonMode) {
    output.log(
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
      printBuildSummary(finalBuild, output);
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
        existingPenConfigRaw = (
          await client.downloadFile(existingPenConfigFile.download_url)
        ).toString('utf8');
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
      (file) =>
        (file.path.startsWith('/') ? file.path : `/${file.path}`) === CLASSIC_CONFIG_PEN_PATH,
    );
    if (resolvedBlocks.includes('classic-1') && !hasClassicConfig) {
      blockChanges.push({
        path: CLASSIC_CONFIG_PEN_PATH,
        content: `${JSON.stringify(
          buildStarterClassicConfigFromPaths(remoteFiles.map((file) => file.path)),
          null,
          2,
        )}\n`,
      });
    }

    if (!jsonMode) {
      output.log(fmt.dim(`Configuring CodePen blocks (${resolvedBlocks.join(', ')})…`));
    }
    const writeResult = await client.writePenFiles(created.id, {
      files: blockChanges,
      ...(finalVersionId ? { expected_version_id: finalVersionId } : {}),
      wait: shouldWait ? 45 : 0,
    });
    if (writeResult.build) {
      finalBuild = shouldWait ? await client.settleBuild(writeResult.build) : writeResult.build;
      if (shouldWait && !jsonMode) {
        printBuildSummary(finalBuild, output);
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

  if (jsonMode) {
    const code = buildFailed ? 422 : 201;
    const message = buildFailed
      ? `Scaffolded Pen ${created.title || 'Untitled'}, but the initial build failed.`
      : `Scaffolded Pen ${created.title || 'Untitled'} into ${folderDisplay}.`;
    printJsonResponse(
      code,
      message,
      {
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
      },
      output,
    );
  } else {
    if (buildFailed) {
      output.log(
        `\n${fmt.yellow('!')} Scaffolded Pen ${fmt.bold(created.title || 'Untitled')} ${fmt.dim(`(${created.id})`)}, but the initial build failed.`,
      );
    } else {
      output.log(
        `\n${fmt.green('✓')} Scaffolded Pen ${fmt.bold(created.title || 'Untitled')} ${fmt.dim(`(${created.id})`)}`,
      );
    }
    output.log(`  Template:   ${selected.label}`);
    if (auth.profile) {
      output.log(`  Profile:    ${fmt.cyan(auth.profile)}`);
    }
    output.log(`  Visibility: ${created.access}${created.template ? fmt.dim(' · Template') : ''}`);
    if (resolvedBlocks) {
      output.log(`  Blocks:     ${fmt.cyan(resolvedBlocks.join(', '))}`);
    }
    output.log(`  Folder:     ${fmt.cyan(folderDisplay)}`);
    output.log(`  Files:      ${materialized.writtenPaths.length} written`);
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
    templateLabel: selected.label,
    ...(resolvedBlocks ? { blocks: resolvedBlocks } : {}),
    ...(buildFailed ? { exitCode: 1 } : {}),
  };
}

export function registerNewCommand(program: Command): void {
  program
    .command('new [folder]')
    .description(
      'Scaffold a brand-new CodePen 2.0 Pen from a CodePen Template into a new or empty folder',
    )
    .option('-t, --title <title>', 'Title for the new Pen')
    .option('-d, --description <text>', 'Description for the new Pen')
    .option('--tags <tags>', 'Comma-separated tags (up to 5)')
    .option('--access <level>', 'Privacy: Public, Private, Protected, or Collaborators')
    .option(
      '--visibility <level>',
      'Alias for --access (Public, Private, Protected, or Collaborators)',
    )
    .option(
      '--blocks <blocks>',
      'Comma-separated CodePen blocks to enable (e.g. packages,classic; validate and fingerprint are always included)',
    )
    .option('--password <password>', 'Password (min 8 chars; required with --access Protected)')
    .option(
      '--template <id-or-name>',
      'Scaffold from one of your CodePen Templates (ID, URL, or title)',
    )
    .option('--as-template', 'Mark the newly created Pen as a Template on CodePen')
    .option('--no-wait', 'Return as soon as files are saved without waiting for the build')
    .option('--json', 'Output scaffolded Pen result as JSON')
    .action(async (folderArg: string | undefined, options: NewPenCliOptions, command: Command) => {
      const result = await runNewCommand({
        folderArg,
        explicitProfile: getGlobalProfileOption(command),
        title: options.title,
        description: options.description,
        tags: parseTagsOption(options.tags),
        access: options.access,
        visibility: options.visibility,
        blocks: options.blocks,
        password: options.password,
        template: options.template,
        asTemplate: options.asTemplate,
        wait: options.wait,
        json: options.json,
      });
      if (result.exitCode !== undefined) {
        process.exitCode = result.exitCode;
      }
    });
}
