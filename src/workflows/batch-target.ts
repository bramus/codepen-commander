import fs from 'node:fs/promises';
import path from 'node:path';
import { hasProjectConfigInDir } from '../config/project.js';
import { PROJECT_CONFIG_FILENAME } from '../constants.js';
import { CliError } from '../errors.js';
import { fmt } from '../utils/format.js';
import { defaultOutput, type CommandOutput } from '../utils/output.js';
import { promptConfirm, promptSelect, type SelectOption } from '../utils/prompts/index.js';
import type { BatchMode } from './batch-pens.js';
import { discoverPenDirectories, type DiscoveredPen } from './discover-pens.js';

export interface BatchTargetPrompts {
  confirm?: (question: string, defaultYes?: boolean) => Promise<boolean>;
  select?: <T extends string>(
    question: string,
    options: SelectOption<T>[],
    defaultIndex?: number,
  ) => Promise<T>;
}

export type ResolvedCommandTarget =
  | { mode: 'single'; targetDir: string; fromExplicitDir: boolean; displayDir: string }
  | { mode: 'batch'; rootDir: string; discovered: DiscoveredPen[] };

export type BatchFallbackResolution =
  | { action: 'none' }
  | { action: 'batch'; discovered: DiscoveredPen[] }
  | { action: 'canceled' };

async function isExistingDirectory(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Performs a single non-recursive `readdir` on `dirPath` (zero subdirectory traversal)
 * to check whether candidate subdirectories or a direct `index.html` exist.
 */
async function inspectDirectChildren(
  dirPath: string,
): Promise<{ hasSubdirs: boolean; hasIndexHtml: boolean }> {
  let entries;
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    return { hasSubdirs: false, hasIndexHtml: false };
  }

  let hasSubdirs = false;
  let hasIndexHtml = false;
  for (const entry of entries) {
    if (entry.name === 'index.html' && entry.isFile()) {
      hasIndexHtml = true;
    } else if (!entry.name.startsWith('.') && entry.name !== 'node_modules' && entry.isDirectory()) {
      hasSubdirs = true;
    }
    if (hasSubdirs && hasIndexHtml) {
      break;
    }
  }
  return { hasSubdirs, hasIndexHtml };
}

/**
 * Resolves the optional `[target]` positional argument shared by batch-capable commands
 * (`status`, `push`, `pull`, `sync`, `delete`, `unlink`):
 *
 * - Omitted -> single-Pen mode on `cwd` (never walks subdirectories automatically).
 * - Bare `"all"` -> batch tree-walk mode on `cwd`; if a directory named `all` also exists
 *   in `cwd`, prompts interactively to choose between targeting `./all` vs running on all Pens
 *   (or throws `409` in non-interactive mode advising `./all`).
 * - Any other directory path (including `./all`) -> single-Pen mode on that resolved directory.
 */
export async function resolveBatchCommandTarget(options: {
  commandName: BatchMode;
  cwd: string;
  target?: string;
  interactive: boolean;
  output?: CommandOutput;
  prompts?: BatchTargetPrompts;
}): Promise<ResolvedCommandTarget> {
  const cwd = path.resolve(options.cwd);
  const rawTarget = options.target?.trim();

  if (!rawTarget) {
    return {
      mode: 'single',
      targetDir: cwd,
      fromExplicitDir: false,
      displayDir: '.',
    };
  }

  if (/^https?:\/\//i.test(rawTarget)) {
    const cloneHint =
      options.commandName === 'pull'
        ? ' To clone a Pen from a URL, run `cdpn clone <url>`.'
        : '';
    throw new CliError(
      400,
      `Expected a local directory path or "all", not a URL ("${rawTarget}").${cloneHint}`,
    );
  }

  if (rawTarget === 'all') {
    const allDirPath = path.join(cwd, 'all');
    const hasAllDir = await isExistingDirectory(allDirPath);

    if (hasAllDir) {
      if (!options.interactive) {
        throw new CliError(
          409,
          `Ambiguous target "all": a directory named "all" exists in ${cwd}.\n` +
            `Run interactively to choose between the "./all" directory and all Pens, or pass "./all" to target that directory explicitly.`,
        );
      }

      const selectImpl = options.prompts?.select ?? promptSelect;
      const allDirHasConfig = await hasProjectConfigInDir(allDirPath);
      const choice = await selectImpl<'directory' | 'batch'>(
        'A directory named "all" exists here. What would you like to do?',
        [
          {
            value: 'directory',
            label: `Run \`cdpn ${options.commandName}\` on the "./all" directory`,
            description: allDirHasConfig
              ? `target the Pen inside ./all`
              : `target only the ./all directory`,
          },
          {
            value: 'batch',
            label: `Run \`cdpn ${options.commandName} all\` on all Pens in this tree`,
            description: 'walk subdirectories and process every discovered Pen',
          },
        ],
        0,
      );

      if (choice === 'directory') {
        return {
          mode: 'single',
          targetDir: allDirPath,
          fromExplicitDir: true,
          displayDir: 'all',
        };
      }
    }

    const discovered = await discoverPenDirectories(cwd);
    if (discovered.length === 0) {
      const selfIsPen = await hasProjectConfigInDir(cwd);
      const hint = selfIsPen
        ? `\nThis directory itself is a Pen — run \`cdpn ${options.commandName}\` without "all".`
        : '';
      throw new CliError(
        404,
        `No Pens (${PROJECT_CONFIG_FILENAME}) found in any subdirectory of ${cwd}.${hint}`,
      );
    }

    return {
      mode: 'batch',
      rootDir: cwd,
      discovered,
    };
  }

  const targetDir = path.resolve(cwd, rawTarget);
  let stat;
  try {
    stat = await fs.stat(targetDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new CliError(404, `Directory not found: ${rawTarget}`);
    }
    throw error;
  }
  if (!stat.isDirectory()) {
    throw new CliError(400, `Not a directory: ${rawTarget}`);
  }

  return {
    mode: 'single',
    targetDir,
    fromExplicitDir: true,
    displayDir: rawTarget,
  };
}

/**
 * Called when a batch-capable command is invoked in a directory that is not a Pen
 * (no `.cdpn.json` in `targetDir` or parents) without the `all` keyword.
 *
 * Performs NO recursive tree prescan so commands return immediately even in large directory trees:
 * - Only inspects direct entries of `targetDir` (single non-recursive `readdir`).
 * - If no subdirectories exist (or for `push`, if `index.html` exists directly for a first-time push),
 *   returns `{ action: 'none' }` so the caller preserves its normal non-Pen behavior.
 * - Non-interactively returns early with `404` advising `cdpn <cmd> all` (zero tree traversal).
 * - Interactively offers `cdpn <cmd> all` (yes/No, default No); only walks the directory tree
 *   if the user confirms `Yes`.
 */
export async function offerBatchAllFallback(options: {
  commandName: BatchMode;
  targetDir: string;
  fromExplicitDir: boolean;
  displayDir: string;
  dryRun?: boolean;
  interactive: boolean;
  output?: CommandOutput;
  prompts?: BatchTargetPrompts;
}): Promise<BatchFallbackResolution> {
  const { hasSubdirs, hasIndexHtml } = await inspectDirectChildren(options.targetDir);

  if (!hasSubdirs) {
    return { action: 'none' };
  }

  // For `cdpn push`, a folder with a direct `index.html` is a standalone local demo for first-time push
  if (options.commandName === 'push' && hasIndexHtml) {
    return { action: 'none' };
  }

  const output = options.output ?? defaultOutput;
  const dryRunSuffix = options.dryRun ? ' --dry-run' : '';
  const whereSuffix = options.fromExplicitDir ? ` inside ${options.displayDir}` : '';

  if (!options.interactive) {
    const actionHint =
      options.commandName === 'status'
        ? `Run \`cdpn init\` to initialize this folder as a CodePen demo, \`cdpn status all\`${whereSuffix} to check Pens in subdirectories, or \`cdpn status <directory>\` for a specific Pen.`
        : `Run \`cdpn ${options.commandName} all${dryRunSuffix}\`${whereSuffix} to ${options.commandName} Pens in subdirectories, or \`cdpn ${options.commandName} <directory>\` for a specific Pen.`;
    throw new CliError(404, `No ${PROJECT_CONFIG_FILENAME} found in ${options.targetDir}.\n${actionHint}`);
  }

  const confirmImpl = options.prompts?.confirm ?? promptConfirm;
  const dirLabel = options.fromExplicitDir ? `"${options.displayDir}"` : 'this directory';
  output.log(fmt.dim(`No ${PROJECT_CONFIG_FILENAME} found in ${dirLabel}.`));
  const ok = await confirmImpl(
    `Run \`cdpn ${options.commandName} all${dryRunSuffix}\`${whereSuffix} across subdirectories instead?`,
    false,
  );
  if (!ok) {
    output.log('Aborted.');
    return { action: 'canceled' };
  }

  const discovered = await discoverPenDirectories(options.targetDir);
  if (discovered.length === 0) {
    throw new CliError(
      404,
      `No Pens (${PROJECT_CONFIG_FILENAME}) found in any subdirectory of ${options.targetDir}.`,
    );
  }

  return { action: 'batch', discovered };
}
