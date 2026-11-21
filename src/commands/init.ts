import fs from 'node:fs/promises';
import path from 'node:path';
import type { Command } from 'commander';
import {
  hasProjectConfigInDir,
  PROJECT_CONFIG_FILENAME,
  readProjectConfigFile,
  writeUnlinkedProjectInfo,
} from '../config/project.js';
import {
  buildPenConfigObject,
  buildStarterClassicConfig,
  CLASSIC_CONFIG_FILENAME,
  CODEPEN_DIR,
  INIT_BLOCK_CHOICES,
  isWithinRoot,
  normalizePenBlocksList,
  parseBlocksOption,
  PEN_CONFIG_FILENAME,
  readPenBlocks,
} from '../site/blocks.js';
import { formatFolderTitle } from '../site/manifest.js';
import type { PenAccess, PenInfo } from '../types.js';
import { fmt } from '../utils/format.js';
import { extractHtmlTitle } from '../utils/html.js';
import { CliError, printJsonResponse } from '../utils/json.js';
import {
  isInteractive,
  promptConfirm,
  promptMultiSelect,
  promptSelect,
  promptValidatedTextWithIO,
  type MultiSelectOption,
  type SelectOption,
} from '../utils/prompts.js';
import { getGlobalProfileOption } from './auth-context.js';
import {
  createPenFromDirectory,
  normalizeAccess,
  type CreatePenFlowResult,
} from './create-pen.js';

const CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f]/;

export interface InitCliOptions {
  title?: string;
  access?: string;
  visibility?: string;
  blocks?: string;
  description?: string;
  tags?: string;
  template?: string | boolean;
  asTemplate?: boolean;
  force?: boolean;
  yes?: boolean;
  json?: boolean;
}

export interface InitCommandPrompts {
  text?: (question: string, defaultValue?: string) => Promise<string>;
  select?: <T extends string>(
    question: string,
    options: SelectOption<T>[],
    defaultIndex?: number,
  ) => Promise<T>;
  multiSelect?: <T extends string>(
    question: string,
    options: MultiSelectOption<T>[],
  ) => Promise<T[]>;
  confirm?: (question: string, defaultYes?: boolean) => Promise<boolean>;
  secret?: (question: string) => Promise<string>;
}

export interface InitCommandOptions {
  dirArg?: string;
  cwd?: string;
  explicitProfile?: string;
  title?: string;
  access?: string;
  visibility?: string;
  blocks?: string | string[];
  description?: string;
  tags?: string[];
  template?: boolean;
  force?: boolean;
  yes?: boolean;
  json?: boolean;
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  interactive?: boolean;
  prompts?: InitCommandPrompts;
}

export interface InitCommandResult {
  initialized: boolean;
  aborted: boolean;
  pushed: boolean;
  pushResult: CreatePenFlowResult | null;
  rootDir: string;
  configPath: string;
  penConfigPath: string;
  classicConfigPath: string | null;
  info: Required<PenInfo>;
  blocks: string[];
  writtenFiles: string[];
}

function parseTemplateCliFlag(
  rawTemplate: string | boolean | undefined,
  asTemplate: boolean | undefined,
): boolean | undefined {
  let parsedTemplate: boolean | undefined;
  if (typeof rawTemplate === 'boolean') {
    parsedTemplate = rawTemplate;
  } else if (typeof rawTemplate === 'string') {
    const lower = rawTemplate.trim().toLowerCase();
    if (lower === 'true' || lower === '1' || lower === 'yes' || lower === 'on') {
      parsedTemplate = true;
    } else if (lower === 'false' || lower === '0' || lower === 'no' || lower === 'off') {
      parsedTemplate = false;
    } else {
      throw new CliError(
        400,
        `Invalid boolean value "${rawTemplate}" for --template. Use true or false.`,
      );
    }
  }

  if (parsedTemplate !== undefined && asTemplate !== undefined && parsedTemplate !== asTemplate) {
    throw new CliError(400, 'Cannot combine conflicting --template and --as-template flags.');
  }

  return parsedTemplate ?? asTemplate;
}

function resolveAccessInput(rawAccess?: string, rawVisibility?: string): PenAccess | undefined {
  const access = normalizeAccess(rawAccess);
  const visibility = normalizeAccess(rawVisibility);
  if (access && visibility && access !== visibility) {
    throw new CliError(
      400,
      `Conflicting --access ("${access}") and --visibility ("${visibility}") values.`,
    );
  }
  return access ?? visibility;
}

async function fileExistsRegular(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(filePath);
    return !stat.isSymbolicLink() && stat.isFile();
  } catch {
    return false;
  }
}

export async function runInitCommand(
  options: InitCommandOptions = {},
): Promise<InitCommandResult> {
  const jsonMode = Boolean(options.json);
  const interactive = !jsonMode && (options.interactive ?? isInteractive());
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const dirDisplay = options.dirArg?.trim() || '.';

  if (CONTROL_CHAR_PATTERN.test(dirDisplay)) {
    throw new CliError(400, 'Directory path cannot contain control characters.');
  }

  // Pre-validate CLI flags before touching disk or prompting
  const explicitAccess = resolveAccessInput(options.access, options.visibility);

  let explicitBlocks: string[] | undefined;
  if (options.blocks !== undefined) {
    explicitBlocks =
      typeof options.blocks === 'string'
        ? parseBlocksOption(options.blocks)
        : normalizePenBlocksList(options.blocks);
  }

  if (options.tags && options.tags.length > 5) {
    throw new CliError(400, `CodePen allows at most 5 tags per Pen (got ${options.tags.length}).`);
  }

  if (options.title !== undefined && CONTROL_CHAR_PATTERN.test(options.title)) {
    throw new CliError(400, 'Pen title cannot contain control characters.');
  }

  const targetDir = path.resolve(cwd, dirDisplay);
  try {
    const stat = await fs.lstat(targetDir);
    if (stat.isSymbolicLink()) {
      throw new CliError(400, `"${dirDisplay}" is a symbolic link. Please choose a regular directory.`);
    }
    if (!stat.isDirectory()) {
      throw new CliError(400, `"${dirDisplay}" already exists and is not a directory.`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      await fs.mkdir(targetDir, { recursive: true });
    } else {
      throw error;
    }
  }

  const realTargetDir = await fs.realpath(targetDir);
  const configPath = path.join(realTargetDir, PROJECT_CONFIG_FILENAME);
  const codepenDir = path.join(realTargetDir, CODEPEN_DIR);
  const penConfigPath = path.join(codepenDir, PEN_CONFIG_FILENAME);
  const classicConfigPath = path.join(codepenDir, CLASSIC_CONFIG_FILENAME);

  const autoForce = Boolean(options.force || options.yes);
  const confirmImpl = options.prompts?.confirm ?? promptConfirm;
  const selectImpl = options.prompts?.select ?? promptSelect;
  const multiSelectImpl = options.prompts?.multiSelect ?? promptMultiSelect;
  const textImpl =
    options.prompts?.text ??
    ((question: string, defaultValue?: string) =>
      promptValidatedTextWithIO<string>(question, {
        defaultValue,
        validate(raw) {
          const trimmed = raw.trim();
          if (CONTROL_CHAR_PATTERN.test(trimmed)) {
            return { ok: false, error: 'Pen title cannot contain control characters.' };
          }
          const value = trimmed || defaultValue || 'Untitled';
          return { ok: true, value, displayValue: value };
        },
      }));

  // Check for existing .cdpn.json
  let existingInfo: PenInfo | undefined;
  if (await hasProjectConfigInDir(realTargetDir)) {
    let isLinked = false;
    try {
      const existing = await readProjectConfigFile(realTargetDir);
      isLinked = existing.linked;
      existingInfo = existing.config.info;
    } catch {
      // Malformed existing .cdpn.json — treat as unlinked overwrite candidate
    }

    if (isLinked && !autoForce) {
      throw new CliError(
        409,
        `${realTargetDir} is already linked to a CodePen Pen (${PROJECT_CONFIG_FILENAME}).\n` +
          'Use `cdpn info` to edit metadata, or pass --force to re-initialize locally.',
      );
    }

    if (!isLinked && !autoForce) {
      if (!interactive) {
        throw new CliError(
          409,
          `${PROJECT_CONFIG_FILENAME} already exists in ${realTargetDir}. Pass --force (or --yes) to overwrite it.`,
        );
      }
      const overwrite = await confirmImpl(
        `${PROJECT_CONFIG_FILENAME} already exists in this folder. Overwrite it?`,
        false,
      );
      if (!overwrite) {
        console.log(fmt.dim('Init aborted.'));
        return {
          initialized: false,
          aborted: true,
          pushed: false,
          pushResult: null,
          rootDir: realTargetDir,
          configPath,
          penConfigPath,
          classicConfigPath: null,
          info: {
            title: existingInfo?.title ?? '',
            description: existingInfo?.description ?? '',
            tags: existingInfo?.tags ?? [],
            access: existingInfo?.access ?? 'Public',
            template: existingInfo?.template ?? false,
          },
          blocks: [],
          writtenFiles: [],
        };
      }
    }
  }

  // Detect default title from existing .cdpn.json, index.html <title>, or folder name
  let htmlTitle: string | null = null;
  const indexPath = path.join(realTargetDir, 'index.html');
  if (await fileExistsRegular(indexPath)) {
    try {
      const rawHtml = await fs.readFile(indexPath, 'utf8');
      htmlTitle = extractHtmlTitle(rawHtml);
    } catch {
      htmlTitle = null;
    }
  }
  const defaultTitle =
    existingInfo?.title?.trim() ||
    htmlTitle ||
    formatFolderTitle(path.basename(realTargetDir)) ||
    'Untitled';

  // 1. Pen Title (prompted interactively unless --title supplied)
  let title = options.title?.trim();
  if (!title) {
    if (interactive) {
      console.log('');
      title = (await textImpl('Pen title', defaultTitle)).trim() || defaultTitle;
    } else {
      title = defaultTitle;
    }
  }

  // 2. Pen Visibility (prompted interactively unless --access / --visibility supplied)
  let access: PenAccess;
  if (explicitAccess) {
    access = explicitAccess;
  } else if (interactive) {
    const visibilityOptions: SelectOption<PenAccess>[] = [
      { value: 'Public', label: 'Public', description: 'visible to everyone' },
      { value: 'Private', label: 'Private', description: 'visible only to you / your team' },
      {
        value: 'Protected',
        label: 'Protected',
        description: 'password-protected (set password on push)',
      },
      {
        value: 'Collaborators',
        label: 'Collaborators',
        description: 'visible only to you and collaborators',
      },
    ];
    const defaultVisIndex = existingInfo?.access
      ? Math.max(0, visibilityOptions.findIndex((o) => o.value === existingInfo?.access))
      : 0;
    console.log('');
    access = await selectImpl<PenAccess>('Pen visibility', visibilityOptions, defaultVisIndex);
  } else {
    access = existingInfo?.access ?? 'Public';
  }

  // 3. Blocks multi-select (validate & fingerprint are locked and cannot be unselected)
  let selectedBlocks: string[];
  if (explicitBlocks !== undefined) {
    selectedBlocks = explicitBlocks;
  } else if (interactive) {
    const [existingPenBlocks, hasPackageJson, hasPenHtml] = await Promise.all([
      readPenBlocks(realTargetDir, realTargetDir),
      fileExistsRegular(path.join(realTargetDir, 'package.json')),
      fileExistsRegular(path.join(realTargetDir, 'index.pen.html')),
    ]);

    const blockOptions: MultiSelectOption<string>[] = INIT_BLOCK_CHOICES.map((choice) => ({
      value: choice.blockName,
      label: choice.label,
      description: choice.description,
      locked: choice.locked,
      checked:
        choice.locked ||
        (choice.id === 'packages' && (Boolean(existingPenBlocks?.hasPackages) || hasPackageJson)) ||
        (choice.id === 'classic' && (Boolean(existingPenBlocks?.hasClassic) || hasPenHtml)),
    }));

    console.log('');
    const picked = await multiSelectImpl('Blocks to add', blockOptions);
    selectedBlocks = normalizePenBlocksList(picked);
  } else {
    selectedBlocks = normalizePenBlocksList([]);
  }

  // Extra CLI-only metadata fields (not asked in UI)
  const description =
    options.description !== undefined ? options.description : (existingInfo?.description ?? '');
  const tags =
    options.tags !== undefined ? options.tags : (existingInfo?.tags ?? []);
  const template =
    options.template !== undefined ? options.template : (existingInfo?.template ?? false);

  const info: Required<PenInfo> = {
    title,
    description,
    tags,
    access,
    template,
  };

  // Verify `.codepen` and config targets are not symlinks / escaping realTargetDir
  try {
    const codepenStat = await fs.lstat(codepenDir);
    if (codepenStat.isSymbolicLink() || !codepenStat.isDirectory()) {
      throw new CliError(400, `${CODEPEN_DIR} must be a regular directory (symlinks are not allowed).`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      await fs.mkdir(codepenDir, { recursive: true });
    } else {
      throw error;
    }
  }
  const realCodepenDir = await fs.realpath(codepenDir);
  if (!isWithinRoot(realCodepenDir, realTargetDir)) {
    throw new CliError(400, `${CODEPEN_DIR} resolves outside the target directory.`);
  }

  let existingPenConfig: Record<string, unknown> | null = null;
  try {
    const penConfigStat = await fs.lstat(penConfigPath);
    if (penConfigStat.isSymbolicLink() || !penConfigStat.isFile()) {
      throw new CliError(400, `${CODEPEN_DIR}/${PEN_CONFIG_FILENAME} must be a regular file.`);
    }
    const rawExisting = await fs.readFile(penConfigPath, 'utf8');
    const parsed: unknown = JSON.parse(rawExisting);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      existingPenConfig = parsed as Record<string, unknown>;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && error instanceof CliError) {
      throw error;
    }
  }

  let classicConfigExists = false;
  try {
    const classicStat = await fs.lstat(classicConfigPath);
    if (classicStat.isSymbolicLink() || !classicStat.isFile()) {
      throw new CliError(400, `${CODEPEN_DIR}/${CLASSIC_CONFIG_FILENAME} must be a regular file.`);
    }
    classicConfigExists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  // Write `.cdpn.json` (unlinked info-only) and `.codepen/pen.config.json`
  await writeUnlinkedProjectInfo(realTargetDir, info);
  const writtenFiles: string[] = [PROJECT_CONFIG_FILENAME];

  const penConfigPayload = buildPenConfigObject(selectedBlocks, { existing: existingPenConfig });
  await fs.writeFile(penConfigPath, `${JSON.stringify(penConfigPayload, null, 2)}\n`, 'utf8');
  writtenFiles.push(`${CODEPEN_DIR}/${PEN_CONFIG_FILENAME}`);

  let createdClassicConfigPath: string | null = null;
  if (selectedBlocks.includes('classic-1') && !classicConfigExists) {
    const classicConfig = await buildStarterClassicConfig(realTargetDir);
    await fs.writeFile(classicConfigPath, `${JSON.stringify(classicConfig, null, 2)}\n`, 'utf8');
    createdClassicConfigPath = classicConfigPath;
    writtenFiles.push(`${CODEPEN_DIR}/${CLASSIC_CONFIG_FILENAME}`);
  }

  const result: InitCommandResult = {
    initialized: true,
    aborted: false,
    pushed: false,
    pushResult: null,
    rootDir: realTargetDir,
    configPath,
    penConfigPath,
    classicConfigPath: createdClassicConfigPath,
    info,
    blocks: selectedBlocks,
    writtenFiles,
  };

  if (jsonMode) {
    printJsonResponse(201, `Initialized CodePen demo "${info.title}" in ${dirDisplay}.`, {
      root_dir: result.rootDir,
      config_path: result.configPath,
      pen_config_path: result.penConfigPath,
      classic_config_path: result.classicConfigPath,
      info: result.info,
      blocks: result.blocks,
      written_files: result.writtenFiles,
    });
    return result;
  }

  console.log('');
  console.log(
    `${fmt.boldGreen('✓')} ${fmt.bold('Initialized CodePen demo')} ${fmt.boldCyan(info.title)} ${fmt.dim(`(${info.access})`)}`,
  );
  console.log(`  ${fmt.dim('Folder:')} ${fmt.magenta(realTargetDir)}`);
  console.log(`  ${fmt.dim('Blocks:')} ${fmt.cyan(selectedBlocks.join(', '))}`);
  console.log('');
  for (const rel of writtenFiles) {
    console.log(`  ${fmt.boldGreen('+')} ${rel}`);
  }

  if (interactive) {
    console.log('');
    const shouldPush = await confirmImpl('Do you want to push this to CodePen right now?', false);
    if (shouldPush) {
      const pushResult = await createPenFromDirectory({
        targetDir: realTargetDir,
        folderDisplay: dirDisplay,
        explicitProfile: options.explicitProfile,
        interactive: true,
        baseUrl: options.baseUrl,
        env: options.env,
        homeDir: options.homeDir,
        prompts: {
          confirm: confirmImpl,
          text: options.prompts?.text,
          select: selectImpl,
          secret: options.prompts?.secret,
        },
      });
      result.pushed = Boolean(pushResult);
      result.pushResult = pushResult;
    } else {
      console.log(
        fmt.dim('\nNext steps: run `cdpn serve` to preview locally or `cdpn push` to upload to CodePen.'),
      );
    }
  } else {
    console.log(
      fmt.dim('\nNext steps: run `cdpn serve` to preview locally or `cdpn push` to upload to CodePen.'),
    );
  }

  return result;
}

export function registerInitCommand(program: Command): void {
  program
    .command('init [dir]')
    .description('Initialize a local folder as a CodePen demo (.cdpn.json + .codepen/pen.config.json)')
    .option('-t, --title <title>', 'Pen title')
    .option('--access <level>', 'Pen visibility: Public, Private, Protected, or Collaborators')
    .option('--visibility <level>', 'Alias for --access (Public, Private, Protected, or Collaborators)')
    .option(
      '--blocks <blocks>',
      'Comma-separated CodePen blocks to enable (e.g. packages,classic; validate and fingerprint are always included)',
    )
    .option('-d, --description <text>', 'Pen description (CLI flag only)')
    .option('--tags <tags>', 'Comma-separated tags, up to 5 (CLI flag only)')
    .option('--template [bool]', 'Mark Pen as a CodePen Template: true or false (CLI flag only)')
    .option('--as-template', 'Alias for --template true (CLI flag only)')
    .option('-f, --force', 'Overwrite existing .cdpn.json without confirmation')
    .option('-y, --yes', 'Alias for --force')
    .option('--json', 'Output initialization result as JSON')
    .action(async (dirArg: string | undefined, options: InitCliOptions, command: Command) => {
      const tags =
        options.tags !== undefined
          ? options.tags
              .split(',')
              .map((t) => t.trim())
              .filter(Boolean)
          : undefined;
      const template = parseTemplateCliFlag(options.template, options.asTemplate);

      await runInitCommand({
        dirArg,
        explicitProfile: getGlobalProfileOption(command),
        title: options.title,
        access: options.access,
        visibility: options.visibility,
        blocks: options.blocks,
        description: options.description,
        tags,
        template,
        force: options.force,
        yes: options.yes,
        json: options.json,
      });
    });
}
