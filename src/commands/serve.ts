import fs from 'node:fs/promises';
import path from 'node:path';
import type { Command } from 'commander';
import {
  buildPenConfigObject,
  ensureStarterClassicConfigSafe,
  hasPackageJsonDependencies,
  readExistingPenConfigSafe,
  removeBlocksFromPenConfig,
  writePenConfigSafe,
} from '../config/pen-blocks.js';
import { CLASSIC_CONFIG_FILENAME, CODEPEN_DIR, PEN_CONFIG_FILENAME } from '../constants.js';
import {
  classifyDirectoryMode,
  inspectTargetDirectory,
  type DirectoryInspection,
} from '../site/detect.js';
import {
  DEFAULT_SERVE_PORT,
  parseServePort,
  startDevServer,
  type RunningDevServer,
} from '../site/server.js';
import { openBrowser } from '../utils/browser.js';
import { fmt } from '../utils/format.js';
import { isWithinRoot, resolveSafeFile } from '../utils/fs-safe.js';
import { defaultOutput, type CommandOutput } from '../utils/output.js';
import {
  isInteractive,
  promptConfirm,
  promptSelect,
  type SelectOption,
} from '../utils/prompts/index.js';

export interface ServeCliOptions {
  port?: string;
  open?: boolean;
  shell?: string;
  title?: string;
  subtitle?: string;
  footer?: string;
}

export interface ServeCommandPrompts {
  confirm?: (question: string, defaultYes?: boolean) => Promise<boolean>;
  select?: <T extends string>(
    question: string,
    options: SelectOption<T>[],
    defaultIndex?: number,
  ) => Promise<T>;
}

export interface RunServeCommandOptions extends ServeCliOptions {
  dirArg?: string;
  cwd?: string;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  allowEphemeralPort?: boolean;
  interactive?: boolean;
  output?: CommandOutput;
  prompts?: ServeCommandPrompts;
  openBrowserImpl?: (url: string, opts?: { allowLocalhostHttp?: boolean }) => Promise<boolean>;
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

function formatMissingCodepenTip(cdpnState: RunningDevServer['inspection']['cdpnState']): string {
  if (cdpnState === 'linked-v2') {
    return 'No .codepen/ folder found — serving as plain static files. Run `cdpn pull` to restore it from CodePen, or `cdpn push` to sync.';
  }
  if (cdpnState === 'unlinked') {
    return 'No .codepen/ folder found — serving as plain static files. Run `cdpn push` to push to CodePen and generate .codepen/pen.config.json.';
  }
  if (cdpnState === 'linked-classic') {
    return 'No .codepen/ folder found (Classic Pen) — serving as plain static files.';
  }
  return 'No .codepen/ folder found — serving as plain static files.';
}

async function runPreServeBlockChecks(options: {
  inspection: DirectoryInspection;
  interactive: boolean;
  output: CommandOutput;
  confirmImpl: (question: string, defaultYes?: boolean) => Promise<boolean>;
  selectImpl: <T extends string>(
    question: string,
    options: SelectOption<T>[],
    defaultIndex?: number,
  ) => Promise<T>;
}): Promise<string[]> {
  const { inspection, interactive, output, confirmImpl, selectImpl } = options;
  const warnings: string[] = [];

  if (
    classifyDirectoryMode(inspection) !== 'pen' ||
    (inspection.cdpnState === 'linked-classic' && !inspection.hasCodepenDir)
  ) {
    return warnings;
  }

  const rootRealpath = inspection.rootRealpath;
  let hasClassic = Boolean(inspection.penBlocks?.hasClassic);
  let hasPackages = Boolean(inspection.penBlocks?.hasPackages);
  let hasIndexHtml = inspection.hasIndexHtml;
  let hasClassicPenHtml = inspection.hasClassicPenHtml;
  let skipClassicConfigGeneration = false;

  // 1. Classic checks run first so removing `classic` allows the `packages` check to run afterwards
  if (!hasClassic && hasClassicPenHtml) {
    const notice = `Found \`index.pen.html\`, but the \`classic\` block is not enabled in \`${CODEPEN_DIR}/${PEN_CONFIG_FILENAME}\`.`;
    if (!interactive) {
      warnings.push(notice);
    } else {
      output.log('');
      output.log(`${fmt.boldYellow('⚠')} ${fmt.boldYellow(notice)}`);
      if (hasPackages) {
        output.log(
          fmt.dim(
            `  Note: enabling \`classic\` will replace the \`packages\` block in \`${CODEPEN_DIR}/${PEN_CONFIG_FILENAME}\`.`,
          ),
        );
      }
      output.log('');
      const shouldAddClassic = await confirmImpl('Add the `classic` block before serving?', true);
      if (shouldAddClassic) {
        const existingPenConfig = await readExistingPenConfigSafe(rootRealpath);
        const penConfigPayload = buildPenConfigObject(['classic-1'], {
          existing: existingPenConfig,
          pruneUnselected: true,
        });
        await writePenConfigSafe(rootRealpath, penConfigPayload);
        const createdClassicConfig = await ensureStarterClassicConfigSafe(rootRealpath);
        hasClassic = true;
        hasPackages = false;
        output.log(
          `${fmt.boldGreen('✓')} Added ${fmt.cyan('classic')} block to ${fmt.dim(`${CODEPEN_DIR}/${PEN_CONFIG_FILENAME}`)}` +
            (createdClassicConfig
              ? ` ${fmt.dim(`(and created ${CODEPEN_DIR}/${CLASSIC_CONFIG_FILENAME})`)}`
              : '') +
            '.',
        );
      }
    }
  } else if (hasClassic && hasIndexHtml) {
    if (!hasClassicPenHtml) {
      const notice =
        'The `classic` block is enabled, but this folder has `index.html` instead of `index.pen.html`.';
      if (!interactive) {
        warnings.push(notice);
      } else {
        output.log('');
        output.log(`${fmt.boldYellow('⚠')} ${fmt.boldYellow(notice)}`);
        output.log('');
        const choice = await selectImpl<'rename' | 'remove-classic' | 'skip'>(
          'How would you like to proceed?',
          [
            {
              value: 'rename',
              label: 'Rename `index.html` to `index.pen.html`',
              description: 'keep the `classic` block and use `index.pen.html`',
            },
            {
              value: 'remove-classic',
              label: 'Remove the `classic` block',
              description: 'keep `index.html` as a standard (non-Classic) Pen',
            },
            {
              value: 'skip',
              label: 'Keep as-is and serve anyway',
              description: `leave files and \`${CODEPEN_DIR}/${PEN_CONFIG_FILENAME}\` unchanged`,
            },
          ],
          0,
        );

        if (choice === 'rename') {
          const indexPath = path.join(rootRealpath, 'index.html');
          const penHtmlPath = path.join(rootRealpath, 'index.pen.html');
          const safeIndex = await resolveSafeFile(indexPath, rootRealpath);
          if (
            safeIndex &&
            isWithinRoot(penHtmlPath, rootRealpath) &&
            !(await pathExists(penHtmlPath))
          ) {
            await fs.rename(safeIndex.realPath, penHtmlPath);
            const createdClassicConfig = await ensureStarterClassicConfigSafe(rootRealpath);
            hasIndexHtml = false;
            hasClassicPenHtml = true;
            output.log(
              `${fmt.boldGreen('✓')} Renamed ${fmt.cyan('index.html')} → ${fmt.cyan('index.pen.html')}` +
                (createdClassicConfig
                  ? ` ${fmt.dim(`(and created ${CODEPEN_DIR}/${CLASSIC_CONFIG_FILENAME})`)}`
                  : '') +
                '.',
            );
          }
        } else if (choice === 'remove-classic') {
          const existingPenConfig = await readExistingPenConfigSafe(rootRealpath);
          const penConfigPayload = removeBlocksFromPenConfig(existingPenConfig, ['classic']);
          await writePenConfigSafe(rootRealpath, penConfigPayload);
          hasClassic = false;
          output.log(
            `${fmt.boldGreen('✓')} Removed ${fmt.cyan('classic')} block from ${fmt.dim(`${CODEPEN_DIR}/${PEN_CONFIG_FILENAME}`)}.`,
          );
        } else {
          skipClassicConfigGeneration = true;
        }
      }
    } else {
      const notice =
        'The `classic` block is enabled, and both `index.html` and `index.pen.html` exist (`index.html` takes precedence).';
      if (!interactive) {
        warnings.push(notice);
      } else {
        output.log('');
        output.log(`${fmt.boldYellow('⚠')} ${fmt.boldYellow(notice)}`);
        output.log('');
        const choice = await selectImpl<'remove-classic' | 'skip'>(
          'How would you like to proceed?',
          [
            {
              value: 'remove-classic',
              label: 'Remove the `classic` block',
              description: 'serve `index.html` as a standard (non-Classic) Pen',
            },
            {
              value: 'skip',
              label: 'Keep as-is and serve anyway',
              description: `leave files and \`${CODEPEN_DIR}/${PEN_CONFIG_FILENAME}\` unchanged`,
            },
          ],
          1,
        );
        if (choice === 'remove-classic') {
          const existingPenConfig = await readExistingPenConfigSafe(rootRealpath);
          const penConfigPayload = removeBlocksFromPenConfig(existingPenConfig, ['classic']);
          await writePenConfigSafe(rootRealpath, penConfigPayload);
          hasClassic = false;
          output.log(
            `${fmt.boldGreen('✓')} Removed ${fmt.cyan('classic')} block from ${fmt.dim(`${CODEPEN_DIR}/${PEN_CONFIG_FILENAME}`)}.`,
          );
        } else {
          skipClassicConfigGeneration = true;
        }
      }
    }
  }

  // If the classic block is active and `.codepen/classic.config.json` is missing, generate it
  if (hasClassic && !skipClassicConfigGeneration) {
    const createdClassicConfig = await ensureStarterClassicConfigSafe(rootRealpath);
    if (createdClassicConfig) {
      output.log(
        `${fmt.boldGreen('✓')} Generated missing ${fmt.cyan(`${CODEPEN_DIR}/${CLASSIC_CONFIG_FILENAME}`)}.`,
      );
    }
  }

  // 2. Packages check runs after classic checks (skipped when classic is enabled)
  if (!hasClassic && !hasPackages) {
    const hasPackageDeps = await hasPackageJsonDependencies(rootRealpath);
    if (hasPackageDeps) {
      const notice = `Found \`package.json\` with dependencies, but the \`packages\` block is not enabled in \`${CODEPEN_DIR}/${PEN_CONFIG_FILENAME}\`.`;
      if (!interactive) {
        warnings.push(notice);
      } else {
        output.log('');
        output.log(`${fmt.boldYellow('⚠')} ${fmt.boldYellow(notice)}`);
        output.log('');
        const shouldAddPackages = await confirmImpl(
          'Add the `packages` block before serving?',
          true,
        );
        if (shouldAddPackages) {
          const existingPenConfig = await readExistingPenConfigSafe(rootRealpath);
          const penConfigPayload = buildPenConfigObject(['packages-1'], {
            existing: existingPenConfig,
          });
          await writePenConfigSafe(rootRealpath, penConfigPayload);
          hasPackages = true;
          output.log(
            `${fmt.boldGreen('✓')} Added ${fmt.cyan('packages')} block to ${fmt.dim(`${CODEPEN_DIR}/${PEN_CONFIG_FILENAME}`)}.`,
          );
        }
      }
    }
  }

  return warnings;
}

export async function runServeCommand(
  options: RunServeCommandOptions = {},
): Promise<RunningDevServer> {
  const output = options.output ?? defaultOutput;
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const env = options.env ?? process.env;
  const rawPort = options.port ?? env.PORT ?? String(DEFAULT_SERVE_PORT);
  const openBrowserImpl = options.openBrowserImpl ?? openBrowser;
  const interactive = options.interactive ?? isInteractive();
  const confirmImpl = options.prompts?.confirm ?? promptConfirm;
  const selectImpl = options.prompts?.select ?? promptSelect;

  // Validate port upfront before prompting
  parseServePort(rawPort, Boolean(options.allowEphemeralPort));

  const resolvedTarget = path.resolve(cwd, options.dirArg ?? '.');
  let preServeWarnings: string[] = [];
  try {
    const targetStat = await fs.stat(resolvedTarget);
    if (targetStat.isDirectory()) {
      const preInspection = await inspectTargetDirectory(resolvedTarget);
      preServeWarnings = await runPreServeBlockChecks({
        inspection: preInspection,
        interactive,
        output,
        confirmImpl,
        selectImpl,
      });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  const running = await startDevServer({
    targetDir: options.dirArg ?? '.',
    port: rawPort,
    allowEphemeralPort: options.allowEphemeralPort,
    explicitShell: options.shell,
    site: {
      title: options.title,
      subtitle: options.subtitle,
      footer: options.footer,
    },
    homeDir: options.homeDir,
    cwd,
    onManifestUpdate(updatedCount) {
      output.log(
        `${fmt.cyan('↻')} Updated demo index ${fmt.dim(`(${updatedCount} ${updatedCount === 1 ? 'demo' : 'demos'})`)}`,
      );
    },
    onWatchError(error) {
      output.error(`${fmt.yellow('!')} Watch warning: ${error.message}`);
    },
  });

  const displayDir = path.relative(cwd, running.inspection.rootDir) || '.';

  output.log('');
  if (running.mode === 'pen') {
    const titleSuffix = running.inspection.penTitle
      ? ` ${fmt.dim(`(${running.inspection.penTitle})`)}`
      : '';
    output.log(
      `${fmt.boldGreen('✓')} ${fmt.bold('Serving Pen')} ${fmt.magenta(displayDir)}${titleSuffix}`,
    );

    if (!running.inspection.hasCodepenDir) {
      output.log(
        `  ${fmt.boldYellow('!')} ${fmt.dim(formatMissingCodepenTip(running.inspection.cdpnState))}`,
      );
    } else if (running.inspection.penBlocks) {
      const blocks = running.inspection.penBlocks;
      const enabled: string[] = [];
      if (blocks.hasClassic) enabled.push('classic');
      if (blocks.hasPackages) enabled.push('packages');
      if (enabled.length > 0) {
        output.log(`  ${fmt.dim('Blocks:')} ${fmt.cyan(enabled.join(', '))}`);
      }
      if (blocks.unsupportedBlocks.length > 0) {
        output.log(
          `  ${fmt.boldYellow('!')} ${fmt.yellow(`Unsupported block(s): ${blocks.unsupportedBlocks.join(', ')} (browser will display an info page).`)}`,
        );
      }
    }

    for (const warning of preServeWarnings) {
      output.log(`  ${fmt.boldYellow('!')} ${fmt.yellow(warning)}`);
    }

    if (options.shell) {
      output.log(`  ${fmt.dim('Note: --shell is only used when serving a directory of Pens.')}`);
    }
  } else {
    const countLabel = `${running.demoCount} ${running.demoCount === 1 ? 'demo' : 'demos'}`;
    output.log(
      `${fmt.boldGreen('✓')} ${fmt.bold('Serving demo directory')} ${fmt.magenta(displayDir)} ${fmt.dim(`(${countLabel})`)}`,
    );
    if (running.inspection.hasIndexHtml) {
      output.log(
        `  ${fmt.dim('Index:')}  custom ${fmt.cyan('index.html')} ${fmt.dim('(preserving existing index.html)')}`,
      );
    } else if (running.shell && running.shell.source !== 'builtin') {
      const sourceLabel = running.shell.source === 'flag' ? '--shell' : '~/.cdpn';
      output.log(
        `  ${fmt.dim('Shell:')}  ${fmt.magenta(running.shell.dir)} ${fmt.dim(`(${sourceLabel})`)}`,
      );
    }
    output.log(
      `  ${fmt.dim('Watch:')}  watching subdirectories for changes ${fmt.dim('(in-memory demos.json)')}`,
    );
    if (running.demoCount === 0) {
      output.log(
        `  ${fmt.boldYellow('!')} ${fmt.dim('No .cdpn.json demos found. Run `cdpn init` inside a demo folder to mark it as a CodePen demo.')}`,
      );
    }
  }

  output.log(`  ${fmt.dim('URL:')}    ${fmt.boldCyan(running.url)}`);
  output.log(`  ${fmt.dim('Press Ctrl+C to stop.')}\n`);

  if (options.open) {
    const launched = await openBrowserImpl(running.url, { allowLocalhostHttp: true });
    if (!launched) {
      output.log(
        fmt.yellow(`Could not launch browser automatically. Open ${running.url} manually.`),
      );
    }
  }

  return running;
}

export function registerServeCommand(program: Command): void {
  program
    .command('serve [dir]')
    .description('Serve a local CodePen Pen or a directory of Pens on 127.0.0.1')
    .option(
      '-p, --port <port>',
      `Port to listen on (default: PORT env var or ${DEFAULT_SERVE_PORT})`,
    )
    .option('-o, --open', 'Open the local server URL in your browser')
    .option('--shell <dir>', 'Custom shell directory for the demo index page (overrides ~/.cdpn)')
    .option('--title <text>', 'Custom title for the demo index page (defaults to folder name)')
    .option('--subtitle <text>', 'Custom subtitle for the demo index page')
    .option('--footer <text>', 'Custom footer for the demo index page')
    .action(async (dirArg: string | undefined, options: ServeCliOptions) => {
      const running = await runServeCommand({
        dirArg,
        ...options,
      });

      const shutdown = () => {
        void running.close().finally(() => {
          process.exit(0);
        });
      };

      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    });
}
