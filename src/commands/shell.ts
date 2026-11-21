import fs from 'node:fs/promises';
import path from 'node:path';
import type { Command } from 'commander';
import { API_KEY_FILENAME } from '../config/auth.js';
import {
  clearConfiguredShellDir,
  getConfiguredShellDir,
  setConfiguredShellDir,
} from '../config/user-store.js';
import { CliError } from '../errors.js';
import {
  expandHomePath,
  exportBuiltinShell,
  listShellAssetFiles,
  resolveBuiltinShellDir,
  validateShellDir,
} from '../site/shell.js';
import { isDirectoryNonEmpty } from '../sync/fs.js';
import { resolveInheritedJsonOption } from '../utils/cli-options.js';
import { fmt } from '../utils/format.js';
import { printJsonResponse } from '../utils/json.js';
import { defaultOutput, type CommandOutput } from '../utils/output.js';
import {
  isInteractive,
  promptConfirm,
  promptValidatedTextWithIO,
  type TextValidationResult,
} from '../utils/prompts/index.js';
import { hasControlChars } from '../utils/strings.js';

export const DEFAULT_SHELL_EXPORT_DIR = 'cdpn-shell';

export interface ShellCommandBaseOptions {
  cwd?: string;
  homeDir?: string;
  json?: boolean;
  interactive?: boolean;
  output?: CommandOutput;
}

export interface ShellShowResult {
  source: 'config' | 'builtin';
  configuredDir: string | null;
  activeDir: string;
  exists: boolean;
  files: string[];
  warning: string | null;
  exitCode?: number;
}

export async function runShellShowCommand(
  options: ShellCommandBaseOptions = {},
): Promise<ShellShowResult> {
  const output = options.output ?? defaultOutput;
  const jsonMode = Boolean(options.json);
  const builtin = await resolveBuiltinShellDir();
  const configuredDir = await getConfiguredShellDir({ homeDir: options.homeDir });

  let source: 'config' | 'builtin' = 'builtin';
  let activeDir = builtin.dir;
  let exists = true;
  let files: string[] = [];
  let warning: string | null = null;

  if (configuredDir) {
    source = 'config';
    activeDir = configuredDir;
    try {
      const validated = await validateShellDir(configuredDir, {
        cwd: options.homeDir,
        homeDir: options.homeDir,
        sourceLabel: 'config',
      });
      activeDir = validated.dir;
      files = validated.files;
      exists = true;
    } catch (error) {
      exists = false;
      warning = error instanceof Error ? error.message : String(error);
    }
  } else {
    files = await listShellAssetFiles(builtin.realpath);
  }

  const result: ShellShowResult = {
    source,
    configuredDir,
    activeDir,
    exists,
    files,
    warning,
    ...(!exists ? { exitCode: 1 } : {}),
  };

  if (jsonMode) {
    const code = exists ? 200 : 404;
    const message =
      source === 'builtin'
        ? 'Using built-in demo index shell.'
        : exists
          ? `Using custom shell from ~/${API_KEY_FILENAME}: ${activeDir}`
          : warning ?? `Configured shell directory not found: ${activeDir}`;
    printJsonResponse(
      code,
      message,
      {
        source: result.source,
        configured_dir: result.configuredDir,
        active_dir: result.activeDir,
        exists: result.exists,
        files: result.files,
        warning: result.warning,
      },
      output,
    );
    return result;
  }

  if (source === 'builtin') {
    output.log(
      `${fmt.boldGreen('✓')} Active shell: ${fmt.boldCyan('built-in')} ${fmt.dim(`(${builtin.dir})`)}`,
    );
    output.log(`  ${fmt.dim('Files:')} ${files.join(', ')}`);
    output.log(
      fmt.dim('\n  Tip: Run `cdpn shell export <dir>` to copy and customize the built-in shell.'),
    );
  } else if (exists) {
    output.log(
      `${fmt.boldGreen('✓')} Active shell: ${fmt.magenta(activeDir)} ${fmt.dim(`(configured in ~/${API_KEY_FILENAME})`)}`,
    );
    output.log(`  ${fmt.dim('Files:')} ${files.join(', ')}`);
  } else {
    output.log(
      `${fmt.boldRed('✗')} Configured shell in ~/${API_KEY_FILENAME} is invalid or missing: ${fmt.magenta(activeDir)}`,
    );
    if (warning) {
      output.log(`  ${fmt.yellow(warning)}`);
    }
  }

  return result;
}

export interface ShellExportOptions extends ShellCommandBaseOptions {
  dirArg?: string;
  yes?: boolean;
  force?: boolean;
  set?: boolean;
  prompts?: {
    askDir?: (
      question: string,
      defaultValue: string,
      validate: (raw: string) => TextValidationResult<string>,
    ) => Promise<string>;
    confirm?: (question: string, defaultYes?: boolean) => Promise<boolean>;
  };
}

export interface ShellExportResult {
  exported: boolean;
  aborted: boolean;
  targetDir: string;
  copiedFiles: string[];
  configuredGlobally: boolean;
}

export async function runShellExportCommand(
  options: ShellExportOptions = {},
): Promise<ShellExportResult> {
  const output = options.output ?? defaultOutput;
  const jsonMode = Boolean(options.json);
  const interactive = !jsonMode && (options.interactive ?? isInteractive());
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const confirmImpl = options.prompts?.confirm ?? promptConfirm;
  const askDirImpl =
    options.prompts?.askDir ??
    ((question, defaultValue, validate) =>
      promptValidatedTextWithIO<string>(question, {
        defaultValue,
        validate,
      }));

  let rawDir = options.dirArg?.trim();
  if (!rawDir) {
    if (interactive) {
      output.log('');
      rawDir = await askDirImpl(
        'Where would you like to export the built-in shell?',
        DEFAULT_SHELL_EXPORT_DIR,
        (raw) => {
          const candidate = raw.trim() || DEFAULT_SHELL_EXPORT_DIR;
          if (hasControlChars(candidate)) {
            return { ok: false, error: 'Directory cannot contain control characters.' };
          }
          return { ok: true, value: candidate, displayValue: candidate };
        },
      );
    } else {
      rawDir = DEFAULT_SHELL_EXPORT_DIR;
    }
  }

  if (!rawDir || hasControlChars(rawDir)) {
    throw new CliError(
      400,
      'Export directory path cannot be empty or contain control characters.',
    );
  }

  const expanded = expandHomePath(rawDir, options.homeDir);
  const resolvedTarget = path.resolve(cwd, expanded);

  // Check if path exists as a non-directory or symlink, or non-empty directory
  let nonEmpty = false;
  try {
    const lstat = await fs.lstat(resolvedTarget);
    if (lstat.isSymbolicLink()) {
      throw new CliError(
        400,
        `"${rawDir}" is a symbolic link. Please choose a regular directory.`,
      );
    }
    if (!lstat.isDirectory()) {
      throw new CliError(400, `"${rawDir}" already exists and is not a directory.`);
    }
    nonEmpty = await isDirectoryNonEmpty(resolvedTarget);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  const autoConfirm = Boolean(options.yes || options.force);
  if (nonEmpty && !autoConfirm) {
    if (!interactive) {
      throw new CliError(
        409,
        `Directory "${rawDir}" already exists and is not empty. Pass --yes (or --force) to overwrite shell files.`,
        { target_dir: resolvedTarget },
      );
    }
    output.log('');
    const overwrite = await confirmImpl(
      `Directory "${rawDir}" is not empty. Overwrite existing shell files?`,
      false,
    );
    if (!overwrite) {
      output.log(fmt.dim('Export aborted.'));
      return {
        exported: false,
        aborted: true,
        targetDir: resolvedTarget,
        copiedFiles: [],
        configuredGlobally: false,
      };
    }
  }

  const exported = await exportBuiltinShell(resolvedTarget);
  let configuredGlobally = false;

  if (options.set) {
    await setConfiguredShellDir(exported.targetDir, { homeDir: options.homeDir });
    configuredGlobally = true;
  } else if (interactive) {
    output.log('');
    const shouldSet = await confirmImpl(
      `Set "${rawDir}" as your default global shell in ~/${API_KEY_FILENAME}?`,
      true,
    );
    if (shouldSet) {
      await setConfiguredShellDir(exported.targetDir, { homeDir: options.homeDir });
      configuredGlobally = true;
    }
  }

  if (jsonMode) {
    printJsonResponse(
      201,
      `Exported built-in shell to ${exported.targetDir}.`,
      {
        target_dir: exported.targetDir,
        copied_files: exported.copiedFiles,
        configured_globally: configuredGlobally,
      },
      output,
    );
  } else {
    output.log('');
    output.log(
      `${fmt.boldGreen('✓')} ${fmt.bold('Exported built-in shell to')} ${fmt.magenta(exported.targetDir)}`,
    );
    for (const file of exported.copiedFiles) {
      output.log(`  ${fmt.boldGreen('+')} ${file}`);
    }
    if (configuredGlobally) {
      output.log(
        `\n${fmt.boldGreen('✓')} Saved as default global shell in ${fmt.bold(`~/${API_KEY_FILENAME}`)}.`,
      );
    } else {
      output.log(
        fmt.dim(
          `\nUse it with \`cdpn serve --shell ${rawDir}\` or set it globally with \`cdpn shell set ${rawDir}\`.`,
        ),
      );
    }
  }

  return {
    exported: true,
    aborted: false,
    targetDir: exported.targetDir,
    copiedFiles: exported.copiedFiles,
    configuredGlobally,
  };
}

export interface ShellSetOptions extends ShellCommandBaseOptions {
  dirArg: string;
}

export async function runShellSetCommand(
  options: ShellSetOptions,
): Promise<{ filePath: string; shellDir: string; files: string[] }> {
  const output = options.output ?? defaultOutput;
  const jsonMode = Boolean(options.json);
  const validated = await validateShellDir(options.dirArg, {
    cwd: options.cwd,
    homeDir: options.homeDir,
    sourceLabel: 'flag',
  });
  const saved = await setConfiguredShellDir(validated.dir, { homeDir: options.homeDir });

  if (jsonMode) {
    printJsonResponse(
      200,
      `Default global shell set to ${saved.shellDir}.`,
      {
        file_path: saved.filePath,
        shell_dir: saved.shellDir,
        files: validated.files,
      },
      output,
    );
  } else {
    output.log(
      `${fmt.boldGreen('✓')} Default global shell set to ${fmt.magenta(saved.shellDir)} ${fmt.dim(`(in ~/${API_KEY_FILENAME})`)}`,
    );
  }

  return {
    filePath: saved.filePath,
    shellDir: saved.shellDir,
    files: validated.files,
  };
}

export async function runShellResetCommand(
  options: ShellCommandBaseOptions = {},
): Promise<{ filePath: string; cleared: boolean; fileDeleted: boolean }> {
  const output = options.output ?? defaultOutput;
  const jsonMode = Boolean(options.json);
  const result = await clearConfiguredShellDir({ homeDir: options.homeDir });

  if (jsonMode) {
    const message = result.cleared
      ? `Reset default shell to built-in (updated ~/${API_KEY_FILENAME}).`
      : 'Already using the built-in shell.';
    printJsonResponse(
      200,
      message,
      {
        file_path: result.filePath,
        cleared: result.cleared,
        file_deleted: result.fileDeleted,
      },
      output,
    );
  } else if (result.cleared) {
    output.log(
      `${fmt.boldGreen('✓')} Reset default shell to ${fmt.boldCyan('built-in')} ${fmt.dim(`(updated ~/${API_KEY_FILENAME})`)}.`,
    );
  } else {
    output.log(fmt.dim('Already using the built-in shell.'));
  }

  return result;
}

export function registerShellCommand(program: Command): void {
  const shellCmd = program
    .command('shell')
    .description('Manage the demo index shell used by `cdpn serve` and `cdpn build`')
    .option('--json', 'Output shell configuration as JSON')
    .action(async (options: { json?: boolean }) => {
      const result = await runShellShowCommand({ json: options.json });
      if (result.exitCode !== undefined) {
        process.exitCode = result.exitCode;
      }
    });

  shellCmd
    .command('show')
    .description('Show the active demo index shell (custom ~/.cdpn path or built-in)')
    .option('--json', 'Output shell configuration as JSON')
    .action(async (options: { json?: boolean }, command: Command) => {
      const result = await runShellShowCommand({
        json: resolveInheritedJsonOption(options, command),
      });
      if (result.exitCode !== undefined) {
        process.exitCode = result.exitCode;
      }
    });

  shellCmd
    .command('export [dir]')
    .aliases(['eject', 'init'])
    .description('Copy the built-in shell files into a local directory so you can customize them')
    .option('-y, --yes', 'Overwrite existing files in a non-empty directory without confirmation')
    .option('-f, --force', 'Alias for --yes')
    .option(
      '--set',
      `Also set the exported directory as the default global shell in ~/${API_KEY_FILENAME}`,
    )
    .option('--json', 'Output export result as JSON')
    .action(
      async (
        dirArg: string | undefined,
        options: { yes?: boolean; force?: boolean; set?: boolean; json?: boolean },
        command: Command,
      ) => {
        await runShellExportCommand({
          dirArg,
          yes: options.yes,
          force: options.force,
          set: options.set,
          json: resolveInheritedJsonOption(options, command),
        });
      },
    );

  shellCmd
    .command('set <dir>')
    .description(`Set a custom default shell directory in ~/${API_KEY_FILENAME}`)
    .option('--json', 'Output result as JSON')
    .action(async (dirArg: string, options: { json?: boolean }, command: Command) => {
      await runShellSetCommand({
        dirArg,
        json: resolveInheritedJsonOption(options, command),
      });
    });

  shellCmd
    .command('reset')
    .aliases(['unset', 'clear'])
    .description(`Reset the global shell in ~/${API_KEY_FILENAME} back to the built-in shell`)
    .option('--json', 'Output result as JSON')
    .action(async (options: { json?: boolean }, command: Command) => {
      await runShellResetCommand({
        json: resolveInheritedJsonOption(options, command),
      });
    });
}
