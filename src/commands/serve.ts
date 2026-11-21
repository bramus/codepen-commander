import path from 'node:path';
import type { Command } from 'commander';
import {
  DEFAULT_SERVE_PORT,
  startDevServer,
  type RunningDevServer,
} from '../site/server.js';
import { openBrowser } from '../utils/browser.js';
import { fmt } from '../utils/format.js';
import { defaultOutput, type CommandOutput } from '../utils/output.js';

export interface ServeCliOptions {
  port?: string;
  open?: boolean;
  shell?: string;
  title?: string;
  subtitle?: string;
  footer?: string;
}

export interface RunServeCommandOptions extends ServeCliOptions {
  dirArg?: string;
  cwd?: string;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  allowEphemeralPort?: boolean;
  output?: CommandOutput;
  openBrowserImpl?: (url: string, opts?: { allowLocalhostHttp?: boolean }) => Promise<boolean>;
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

export async function runServeCommand(
  options: RunServeCommandOptions = {},
): Promise<RunningDevServer> {
  const output = options.output ?? defaultOutput;
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const env = options.env ?? process.env;
  const rawPort = options.port ?? env.PORT ?? String(DEFAULT_SERVE_PORT);
  const openBrowserImpl = options.openBrowserImpl ?? openBrowser;

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
