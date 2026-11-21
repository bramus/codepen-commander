import type { Command } from 'commander';
import { parseTagsOption } from '../utils/cli-options.js';
import { getGlobalProfileOption } from '../workflows/auth-context.js';
import {
  forkPenWorkflow,
  type ForkPenOptions,
  type ForkPenResult,
} from '../workflows/fork-pen.js';

export type { ForkPenResult };
export type RunForkCommandOptions = ForkPenOptions;

export interface ForkCliOptions {
  title?: string;
  description?: string;
  tags?: string;
  access?: string;
  visibility?: string;
  password?: string;
  wait?: boolean;
  json?: boolean;
}

/**
 * Forks an existing CodePen Pen and downloads the new fork into a local linked folder.
 */
export async function runForkCommand(
  options: RunForkCommandOptions,
): Promise<ForkPenResult | null> {
  return forkPenWorkflow(options);
}

export function registerForkCommand(program: Command): void {
  program
    .command('fork <url> [folder]')
    .description('Fork an existing CodePen Pen and download it into a local folder')
    .option('-t, --title <title>', 'Title for the forked Pen (defaults to the original Pen’s title)')
    .option('-d, --description <text>', 'Description for the forked Pen')
    .option('--tags <tags>', 'Comma-separated tags (up to 5)')
    .option('--access <level>', 'Privacy: Public, Private, Protected, or Collaborators')
    .option('--visibility <level>', 'Alias for --access')
    .option('--password <password>', 'Password (min 8 chars; required for Protected forks)')
    .option('--no-wait', 'Return as soon as files are saved without waiting for the build')
    .option('--json', 'Output fork result as JSON')
    .action(
      async (
        urlArg: string,
        folderArg: string | undefined,
        options: ForkCliOptions,
        command: Command,
      ) => {
        const result = await runForkCommand({
          urlArg,
          folderArg,
          explicitProfile: getGlobalProfileOption(command),
          title: options.title,
          description: options.description,
          tags: parseTagsOption(options.tags),
          access: options.access,
          visibility: options.visibility,
          password: options.password,
          wait: options.wait,
          json: options.json,
        });
        if (result?.exitCode !== undefined) {
          process.exitCode = result.exitCode;
        }
      },
    );
}
