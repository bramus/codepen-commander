import fs from 'node:fs/promises';
import path from 'node:path';
import type { Command } from 'commander';
import { CliError } from '../errors.js';
import {
  DEFAULT_BUILD_DIR,
  buildProject,
  resolveBuildTargetDir,
  watchBuild,
  type BuildProjectResult,
  type ResolvedBuildTarget,
} from '../site/builder.js';
import { inspectTargetDirectory } from '../site/detect.js';
import {
  ensureIgnoredInCdpnIgnore,
  inspectGitIgnoreStatus,
  updateGitIgnore,
} from '../site/ignore-files.js';
import { fmt } from '../utils/format.js';
import { printJsonResponse } from '../utils/json.js';
import { defaultOutput, type CommandOutput } from '../utils/output.js';
import {
  isInteractive,
  promptConfirm,
  promptValidatedTextWithIO,
  type TextValidationResult,
} from '../utils/prompts/index.js';

export interface BuildCliOptions {
  out?: string;
  yes?: boolean;
  force?: boolean;
  watch?: boolean;
  shell?: string;
  title?: string;
  subtitle?: string;
  footer?: string;
  json?: boolean;
}

export interface BuildCommandPrompts {
  askOutDir?: (
    question: string,
    defaultValue: string,
    validate: (raw: string) => Promise<TextValidationResult<ResolvedBuildTarget>>,
  ) => Promise<ResolvedBuildTarget>;
  confirm?: (question: string, defaultYes?: boolean) => Promise<boolean>;
}

export interface RunBuildCommandOptions extends BuildCliOptions {
  dirArg?: string;
  cwd?: string;
  homeDir?: string;
  interactive?: boolean;
  output?: CommandOutput;
  prompts?: BuildCommandPrompts;
}

export interface BuildCommandOutcome {
  built: boolean;
  aborted: boolean;
  result: BuildProjectResult | null;
  target: ResolvedBuildTarget;
  cdpnIgnoreUpdated: boolean;
  cdpnIgnoreEntry: string | null;
  gitIgnoreUpdated: boolean;
  gitIgnoreCreated: boolean;
  gitIgnoreEntry: string | null;
  watcher: { close: () => void } | null;
}

export async function runBuildCommand(
  options: RunBuildCommandOptions = {},
): Promise<BuildCommandOutcome> {
  const output = options.output ?? defaultOutput;
  const jsonMode = Boolean(options.json);
  const watchMode = Boolean(options.watch);
  if (watchMode && jsonMode) {
    throw new CliError(400, 'Cannot combine --watch with --json.');
  }

  const cwd = path.resolve(options.cwd ?? process.cwd());
  const sourceDirArg = options.dirArg ?? '.';
  const resolvedSource = path.resolve(cwd, sourceDirArg);

  let sourceStat;
  try {
    sourceStat = await fs.stat(resolvedSource);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new CliError(404, `Source directory not found: ${resolvedSource}`);
    }
    throw error;
  }
  if (!sourceStat.isDirectory()) {
    throw new CliError(400, `Source path is not a directory: ${resolvedSource}`);
  }

  const inspection = await inspectTargetDirectory(resolvedSource);
  const interactive = !jsonMode && (options.interactive ?? isInteractive());
  const confirmImpl = options.prompts?.confirm ?? promptConfirm;
  const askOutDirImpl =
    options.prompts?.askOutDir ??
    ((question, defaultValue, validate) =>
      promptValidatedTextWithIO<ResolvedBuildTarget>(question, {
        defaultValue,
        validate,
      }));

  // 1. Resolve output directory (explicit --out, interactive prompt, or default "build")
  let target: ResolvedBuildTarget;
  if (options.out !== undefined) {
    const validated = await resolveBuildTargetDir(options.out, inspection.rootRealpath, {
      homeDir: options.homeDir,
    });
    if (!validated.ok) {
      throw new CliError(400, validated.error);
    }
    target = validated.target;
  } else if (interactive) {
    output.log('');
    target = await askOutDirImpl(
      'Where would you like to build into?',
      DEFAULT_BUILD_DIR,
      async (raw) => {
        const candidate = raw.trim() || DEFAULT_BUILD_DIR;
        const validated = await resolveBuildTargetDir(candidate, inspection.rootRealpath, {
          homeDir: options.homeDir,
        });
        if (!validated.ok) {
          return { ok: false, error: validated.error };
        }
        return { ok: true, value: validated.target, displayValue: candidate };
      },
    );
  } else {
    const validated = await resolveBuildTargetDir(DEFAULT_BUILD_DIR, inspection.rootRealpath, {
      homeDir: options.homeDir,
    });
    if (!validated.ok) {
      throw new CliError(400, validated.error);
    }
    target = validated.target;
  }

  // 2. Confirm overwrite if target directory already exists
  const autoConfirmOverwrite = Boolean(options.yes || options.force);
  if (target.exists && !autoConfirmOverwrite) {
    if (!interactive) {
      throw new CliError(
        409,
        `Build directory "${target.displayPath}" already exists. Pass --yes (or --force) to overwrite it.`,
        { out_dir: target.outDir },
      );
    }

    output.log('');
    const overwrite = await confirmImpl(
      `Directory "${target.displayPath}" already exists. Overwrite it?`,
      false,
    );
    if (!overwrite) {
      output.log(fmt.dim('Build aborted.'));
      return {
        built: false,
        aborted: true,
        result: null,
        target,
        cdpnIgnoreUpdated: false,
        cdpnIgnoreEntry: null,
        gitIgnoreUpdated: false,
        gitIgnoreCreated: false,
        gitIgnoreEntry: null,
        watcher: null,
      };
    }
  }

  const buildOptions = {
    sourceDir: inspection.rootRealpath,
    outDir: target.outDir,
    explicitShell: options.shell,
    site: {
      title: options.title,
      subtitle: options.subtitle,
      footer: options.footer,
    },
    homeDir: options.homeDir,
    cwd,
  };

  // 3. Execute build (passing preResolved inspection & target to avoid duplicate stat work)
  const result = await buildProject({
    ...buildOptions,
    preResolved: { inspection, target },
  });

  // 4. For a Pen built into a subfolder of itself, update .cdpnignore and offer .gitignore
  let cdpnIgnoreUpdated = false;
  let cdpnIgnoreEntry: string | null = null;
  let gitIgnoreUpdated = false;
  let gitIgnoreCreated = false;
  let gitIgnoreEntry: string | null = null;

  if (result.mode === 'pen' && target.isInsideSource && target.relInsideSource) {
    const ignoreRes = await ensureIgnoredInCdpnIgnore(
      inspection.rootRealpath,
      target.relInsideSource,
    );
    cdpnIgnoreUpdated = ignoreRes.updated;
    cdpnIgnoreEntry = ignoreRes.entry;

    if (!jsonMode) {
      output.log('');
      if (ignoreRes.updated) {
        const verb = ignoreRes.created ? 'Created' : 'Updated';
        output.log(
          `  ${fmt.boldGreen('+')} ${verb} ${fmt.magenta('.cdpnignore')} ${fmt.dim(`(added ${ignoreRes.entry})`)}`,
        );
      } else if (ignoreRes.alreadyIgnored) {
        output.log(
          `  ${fmt.dim('·')} ${fmt.dim(`.cdpnignore already ignores ${ignoreRes.entry}`)}`,
        );
      }
    }

    const gitStatus = await inspectGitIgnoreStatus(
      inspection.rootRealpath,
      target.relInsideSource,
    );
    if (!gitStatus.alreadyIgnored && interactive) {
      output.log('');
      const gitQuestion = gitStatus.exists
        ? `Add "${gitStatus.entry}" to .gitignore?`
        : `Generate a .gitignore ignoring "${gitStatus.entry}"?`;
      const shouldUpdateGit = await confirmImpl(gitQuestion, true);
      if (shouldUpdateGit) {
        const gitRes = await updateGitIgnore(inspection.rootRealpath, target.relInsideSource);
        gitIgnoreUpdated = gitRes.updated;
        gitIgnoreCreated = gitRes.created;
        gitIgnoreEntry = gitRes.entry;
        if (gitRes.updated) {
          const verb = gitRes.created ? 'Created' : 'Updated';
          output.log(
            `  ${fmt.boldGreen('+')} ${verb} ${fmt.magenta('.gitignore')} ${fmt.dim(`(added ${gitRes.entry})`)}`,
          );
        }
      }
    }
  }

  // 5. Output summary
  const relOutDisplay = path.relative(cwd, result.outDir) || result.outDir;

  if (jsonMode) {
    const message =
      result.mode === 'collection'
        ? `Built ${relOutDisplay} (${result.demoCount} ${result.demoCount === 1 ? 'demo' : 'demos'}).`
        : `Built ${relOutDisplay}.`;
    printJsonResponse(
      200,
      message,
      {
        mode: result.mode,
        source_dir: result.sourceDir,
        out_dir: result.outDir,
        demo_count: result.demoCount,
        shell_source: result.shell?.source ?? null,
        shell_dir: result.shell?.dir ?? null,
        unsupported_demos: result.unsupportedDemos,
        cdpnignore_updated: cdpnIgnoreUpdated,
        cdpnignore_entry: cdpnIgnoreEntry,
        gitignore_updated: gitIgnoreUpdated,
        gitignore_created: gitIgnoreCreated,
        gitignore_entry: gitIgnoreEntry,
      },
      output,
    );
  } else {
    output.log('');
    if (result.mode === 'collection') {
      const countLabel = `${result.demoCount} ${result.demoCount === 1 ? 'demo' : 'demos'}`;
      output.log(
        `${fmt.boldGreen('✓')} ${fmt.bold('Built')} ${fmt.magenta(relOutDisplay)} ${fmt.dim(`(${countLabel})`)}`,
      );
      if (result.shell && result.shell.source !== 'builtin') {
        const sourceLabel = result.shell.source === 'flag' ? '--shell' : '~/.cdpn';
        output.log(
          `  ${fmt.dim('Shell:')} ${fmt.magenta(result.shell.dir)} ${fmt.dim(`(${sourceLabel})`)}`,
        );
      }
      if (result.unsupportedDemos.length > 0) {
        output.log(
          `\n  ${fmt.boldYellow('!')} ${fmt.yellow(`${result.unsupportedDemos.length} demo(s) use unsupported CodePen blocks (rendered info pages):`)}`,
        );
        for (const item of result.unsupportedDemos) {
          output.log(
            `    ${fmt.yellow('•')} ${item.path} ${fmt.dim(`(${item.blocks.join(', ')})`)}`,
          );
        }
      }
    } else {
      output.log(
        `${fmt.boldGreen('✓')} ${fmt.bold('Built Pen into')} ${fmt.magenta(relOutDisplay)}`,
      );
    }
  }

  // 6. Optional watch mode
  let watcher: { close: () => void } | null = null;
  if (watchMode) {
    output.log(`\n${fmt.dim('Watching for changes… (Press Ctrl+C to stop)')}`);
    watcher = watchBuild({
      buildOptions,
      canonicalOutDir: target.canonicalOutDir,
      onRebuild(updated) {
        if (updated.mode === 'collection') {
          output.log(
            `${fmt.cyan('↻')} Rebuilt ${fmt.magenta(relOutDisplay)} ${fmt.dim(`(${updated.demoCount} ${updated.demoCount === 1 ? 'demo' : 'demos'})`)}`,
          );
        } else {
          output.log(`${fmt.cyan('↻')} Rebuilt ${fmt.magenta(relOutDisplay)}`);
        }
      },
      onError(error) {
        output.error(`${fmt.red('✗')} Rebuild error: ${error.message}`);
      },
    });
  }

  return {
    built: true,
    aborted: false,
    result,
    target,
    cdpnIgnoreUpdated,
    cdpnIgnoreEntry,
    gitIgnoreUpdated,
    gitIgnoreCreated,
    gitIgnoreEntry,
    watcher,
  };
}

export function registerBuildCommand(program: Command): void {
  program
    .command('build [dir]')
    .description('Build a local Pen or directory of Pens into a static deployable folder')
    .option(
      '-o, --out <dir>',
      `Target output directory (default: prompts interactively, or "${DEFAULT_BUILD_DIR}")`,
    )
    .option('-y, --yes', 'Overwrite existing output directory without confirmation')
    .option(
      '-f, --force',
      'Alias for --yes (overwrite existing output directory without confirmation)',
    )
    .option('-w, --watch', 'Watch source files and rebuild on changes')
    .option('--shell <dir>', 'Custom shell directory for the demo index page (overrides ~/.cdpn)')
    .option('--title <text>', 'Custom title for the demo index page (defaults to folder name)')
    .option('--subtitle <text>', 'Custom subtitle for the demo index page')
    .option('--footer <text>', 'Custom footer for the demo index page')
    .option('--json', 'Output build result as JSON')
    .action(async (dirArg: string | undefined, options: BuildCliOptions) => {
      const outcome = await runBuildCommand({
        dirArg,
        ...options,
      });

      if (outcome.watcher) {
        const shutdown = () => {
          outcome.watcher?.close();
          process.exit(0);
        };
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
      }
    });
}
