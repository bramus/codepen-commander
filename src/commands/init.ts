import fs from 'node:fs/promises';
import path from 'node:path';
import type { Command } from 'commander';
import type { PenAccess } from '../api/types.js';
import {
  INIT_BLOCK_CHOICES,
  assertNoClassicBlockConflict,
  buildPenConfigObject,
  buildStarterClassicConfig,
  hasPackageJsonDependencies,
  normalizePenBlocksList,
  parseBlocksOption,
} from '../config/pen-blocks.js';
import {
  hasProjectConfigInDir,
  readProjectConfigFile,
  writeUnlinkedProjectInfo,
  type PenInfo,
} from '../config/project.js';
import {
  CLASSIC_CONFIG_FILENAME,
  CODEPEN_DIR,
  PEN_ACCESS_CHOICES,
  PEN_CONFIG_FILENAME,
  PROJECT_CONFIG_FILENAME,
} from '../constants.js';
import { CliError } from '../errors.js';
import { readPenBlocks } from '../site/blocks/index.js';
import {
  assertValidTagCount,
  parseTagsOption,
  parseTemplateCliFlag,
  resolveAccessOrVisibility,
} from '../utils/cli-options.js';
import { fmt } from '../utils/format.js';
import {
  fileExistsRegular,
  isWithinRoot,
  resolveSafeFile,
} from '../utils/fs-safe.js';
import { extractHtmlTitle } from '../utils/html.js';
import { printJsonResponse } from '../utils/json.js';
import { defaultOutput, type CommandOutput } from '../utils/output.js';
import {
  isInteractive,
  promptConfirm,
  promptMultiSelect,
  promptSelect,
  promptValidatedTextWithIO,
  type MultiSelectOption,
  type SelectOption,
} from '../utils/prompts/index.js';
import { formatFolderTitle, hasControlChars, isPlainObject } from '../utils/strings.js';
import { getGlobalProfileOption } from '../workflows/auth-context.js';
import { createPenFromDirectory, type CreatePenFlowResult } from '../workflows/create-pen.js';

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

export interface RunInitCommandOptions {
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
  output?: CommandOutput;
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
  exitCode?: number;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

export async function runInitCommand(
  options: RunInitCommandOptions = {},
): Promise<InitCommandResult> {
  const output = options.output ?? defaultOutput;
  const jsonMode = Boolean(options.json);
  const interactive = !jsonMode && (options.interactive ?? isInteractive());
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const dirDisplay = options.dirArg?.trim() || '.';

  if (hasControlChars(dirDisplay)) {
    throw new CliError(400, 'Directory path cannot contain control characters.');
  }

  // Pre-validate CLI flags before touching disk or prompting
  const explicitAccess = resolveAccessOrVisibility(options.access, options.visibility);

  let explicitBlocks: string[] | undefined;
  if (options.blocks !== undefined) {
    explicitBlocks =
      typeof options.blocks === 'string'
        ? parseBlocksOption(options.blocks)
        : normalizePenBlocksList(options.blocks);
    assertNoClassicBlockConflict(explicitBlocks);
  }

  assertValidTagCount(options.tags);

  if (options.title !== undefined && hasControlChars(options.title)) {
    throw new CliError(400, 'Pen title cannot contain control characters.');
  }

  const targetDir = path.resolve(cwd, dirDisplay);
  try {
    const stat = await fs.lstat(targetDir);
    if (stat.isSymbolicLink()) {
      throw new CliError(
        400,
        `"${dirDisplay}" is a symbolic link. Please choose a regular directory.`,
      );
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
          if (hasControlChars(trimmed)) {
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
        output.log(fmt.dim('Init aborted.'));
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
      output.log('');
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
    const visibilityOptions: SelectOption<PenAccess>[] = PEN_ACCESS_CHOICES.map((c) => ({
      value: c.value,
      label: c.label,
      description:
        c.value === 'Protected'
          ? 'private and password-protected (set password on push)'
          : c.description,
    }));
    const defaultVisIndex = existingInfo?.access
      ? Math.max(0, visibilityOptions.findIndex((o) => o.value === existingInfo?.access))
      : 0;
    output.log('');
    access = await selectImpl<PenAccess>('Pen visibility', visibilityOptions, defaultVisIndex);
  } else {
    access = existingInfo?.access ?? 'Public';
  }

  // 3. Blocks multi-select (validate & fingerprint are locked; classic is mutually exclusive with other optional blocks)
  let selectedBlocks: string[];
  if (explicitBlocks !== undefined) {
    selectedBlocks = explicitBlocks;
  } else {
    const [existingPenBlocks, hasPackageDeps, hasPenHtml] = await Promise.all([
      readPenBlocks(realTargetDir, realTargetDir),
      hasPackageJsonDependencies(realTargetDir),
      fileExistsRegular(path.join(realTargetDir, 'index.pen.html')),
    ]);

    const autoCheckClassic = Boolean(existingPenBlocks?.hasClassic) || hasPenHtml;
    const autoCheckPackages =
      !autoCheckClassic && (Boolean(existingPenBlocks?.hasPackages) || hasPackageDeps);

    if (interactive) {
      const blockOptions: MultiSelectOption<string>[] = INIT_BLOCK_CHOICES.map((choice) => ({
        value: choice.blockName,
        label: choice.label,
        description: choice.description,
        locked: choice.locked,
        ...(choice.exclusive ? { exclusive: true } : {}),
        checked:
          choice.locked ||
          (choice.id === 'packages' && autoCheckPackages) ||
          (choice.id === 'classic' && autoCheckClassic),
      }));

      output.log('');
      const picked = await multiSelectImpl('Blocks to add', blockOptions);
      selectedBlocks = normalizePenBlocksList(picked);
      assertNoClassicBlockConflict(selectedBlocks);
    } else {
      const defaults: string[] = [];
      if (autoCheckClassic) defaults.push('classic-1');
      if (autoCheckPackages) defaults.push('packages-1');
      selectedBlocks = normalizePenBlocksList(defaults);
    }
  }

  // 4. Classic Pen HTML entrypoint: if `classic` was chosen and `index.pen.html` does not exist yet,
  // offer to rename an existing `index.html` or create an `index.pen.html`.
  let classicHtmlAction: 'rename' | 'create' | null = null;
  const penHtmlPath = path.join(realTargetDir, 'index.pen.html');
  if (interactive && selectedBlocks.includes('classic-1')) {
    const penHtmlExists = await pathExists(penHtmlPath);
    if (!penHtmlExists) {
      const hasIndexHtml = await fileExistsRegular(indexPath);
      output.log('');
      output.log(
        `${fmt.boldYellow('⚠')} ${fmt.boldYellow('The classic block requires an `index.pen.html` file, which was not found in this folder.')}`,
      );
      output.log('');
      if (hasIndexHtml) {
        if (await confirmImpl('Rename index.html to index.pen.html?', true)) {
          classicHtmlAction = 'rename';
        }
      } else {
        if (await confirmImpl('Create an index.pen.html file?', true)) {
          classicHtmlAction = 'create';
        }
      }
    }
  }

  // Extra CLI-only metadata fields (not asked in UI)
  const description =
    options.description !== undefined ? options.description : (existingInfo?.description ?? '');
  const tags = options.tags !== undefined ? options.tags : (existingInfo?.tags ?? []);
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
      throw new CliError(
        400,
        `${CODEPEN_DIR} must be a regular directory (symlinks are not allowed).`,
      );
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
    if (isPlainObject(parsed)) {
      existingPenConfig = parsed;
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

  const penConfigPayload = buildPenConfigObject(selectedBlocks, {
    existing: existingPenConfig,
    pruneUnselected: true,
  });
  await fs.writeFile(penConfigPath, `${JSON.stringify(penConfigPayload, null, 2)}\n`, 'utf8');
  writtenFiles.push(`${CODEPEN_DIR}/${PEN_CONFIG_FILENAME}`);

  let createdClassicConfigPath: string | null = null;
  if (selectedBlocks.includes('classic-1') && !classicConfigExists) {
    const classicConfig = await buildStarterClassicConfig(realTargetDir);
    await fs.writeFile(classicConfigPath, `${JSON.stringify(classicConfig, null, 2)}\n`, 'utf8');
    createdClassicConfigPath = classicConfigPath;
    writtenFiles.push(`${CODEPEN_DIR}/${CLASSIC_CONFIG_FILENAME}`);
  }

  if (classicHtmlAction === 'rename') {
    const safeIndex = await resolveSafeFile(indexPath, realTargetDir);
    if (safeIndex && isWithinRoot(penHtmlPath, realTargetDir) && !(await pathExists(penHtmlPath))) {
      await fs.rename(safeIndex.realPath, penHtmlPath);
      writtenFiles.push('index.pen.html');
    }
  } else if (classicHtmlAction === 'create') {
    if (isWithinRoot(penHtmlPath, realTargetDir) && !(await pathExists(penHtmlPath))) {
      await fs.writeFile(penHtmlPath, '', { encoding: 'utf8', flag: 'wx' });
      writtenFiles.push('index.pen.html');
    }
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
    printJsonResponse(
      201,
      `Initialized CodePen demo "${info.title}" in ${dirDisplay}.`,
      {
        root_dir: result.rootDir,
        config_path: result.configPath,
        pen_config_path: result.penConfigPath,
        classic_config_path: result.classicConfigPath,
        info: result.info,
        blocks: result.blocks,
        written_files: result.writtenFiles,
      },
      output,
    );
    return result;
  }

  output.log('');
  output.log(
    `${fmt.boldGreen('✓')} ${fmt.bold('Initialized CodePen demo')} ${fmt.boldCyan(info.title)} ${fmt.dim(`(${info.access})`)}`,
  );
  output.log(`  ${fmt.dim('Folder:')} ${fmt.magenta(realTargetDir)}`);
  output.log(`  ${fmt.dim('Blocks:')} ${fmt.cyan(selectedBlocks.join(', '))}`);
  output.log('');
  for (const rel of writtenFiles) {
    if (rel === 'index.pen.html' && classicHtmlAction === 'rename') {
      output.log(`  ${fmt.boldCyan('→')} index.html → index.pen.html`);
    } else {
      output.log(`  ${fmt.boldGreen('+')} ${rel}`);
    }
  }

  if (interactive) {
    output.log('');
    const shouldPush = await confirmImpl('Do you want to push this to CodePen right now?', false);
    if (shouldPush) {
      const pushResult = await createPenFromDirectory({
        targetDir: realTargetDir,
        folderDisplay: dirDisplay,
        explicitProfile: options.explicitProfile,
        interactive: true,
        output,
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
      if (pushResult?.exitCode !== undefined) {
        result.exitCode = pushResult.exitCode;
      }
    } else {
      output.log(
        fmt.dim('\nNext steps: run `cdpn serve` to preview locally or `cdpn push` to upload to CodePen.'),
      );
    }
  } else {
    output.log(
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
      'Comma-separated CodePen blocks to enable (e.g. packages or classic; classic cannot be combined with other optional blocks; validate and fingerprint are always included)',
    )
    .option('-d, --description <text>', 'Pen description (CLI flag only)')
    .option('--tags <tags>', 'Comma-separated tags, up to 5 (CLI flag only)')
    .option('--template [bool]', 'Mark Pen as a CodePen Template: true or false (CLI flag only)')
    .option('--as-template', 'Alias for --template true (CLI flag only)')
    .option('-f, --force', 'Overwrite existing .cdpn.json without confirmation')
    .option('-y, --yes', 'Alias for --force')
    .option('--json', 'Output initialization result as JSON')
    .action(async (dirArg: string | undefined, options: InitCliOptions, command: Command) => {
      const result = await runInitCommand({
        dirArg,
        explicitProfile: getGlobalProfileOption(command),
        title: options.title,
        access: options.access,
        visibility: options.visibility,
        blocks: options.blocks,
        description: options.description,
        tags: parseTagsOption(options.tags),
        template: parseTemplateCliFlag(options.template, options.asTemplate),
        force: options.force,
        yes: options.yes,
        json: options.json,
      });
      if (result.exitCode !== undefined) {
        process.exitCode = result.exitCode;
      }
    });
}
