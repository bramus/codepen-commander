import type { Command } from 'commander';
import { getGlobalProfileOption } from '../workflows/auth-context.js';
import {
  clonePenWorkflow,
  type ClonePenOptions,
  type ClonePenResult,
} from '../workflows/clone-pen.js';
import { forkPenWorkflow } from '../workflows/fork-pen.js';

export type { ClonePenResult };

export interface CloneCliOptions {
  force?: boolean;
  json?: boolean;
}

export type RunCloneCommandOptions = Omit<ClonePenOptions, 'forkUnowned'>;

/**
 * Clones an existing CodePen Pen into a local folder, offering to convert Classic Pens
 * or fork unowned Pens interactively.
 */
export async function runCloneCommand(
  options: RunCloneCommandOptions,
): Promise<ClonePenResult | null> {
  return clonePenWorkflow({
    ...options,
    forkUnowned: (params) => forkPenWorkflow(params),
  });
}

export function registerCloneCommand(program: Command): void {
  program
    .command('clone <url> [folder]')
    .description(
      'Clone a CodePen Pen into a local folder (offers to convert Classic Pens or fork unowned Pens)',
    )
    .option('-f, --force', 'Overwrite files if the target directory already exists and is not empty')
    .option('--json', 'Output clone result as JSON')
    .action(
      async (
        urlArg: string,
        folderArg: string | undefined,
        options: CloneCliOptions,
        command: Command,
      ) => {
        const result = await runCloneCommand({
          urlArg,
          folderArg,
          force: options.force,
          json: options.json,
          explicitProfile: getGlobalProfileOption(command),
        });
        if (result?.exitCode !== undefined) {
          process.exitCode = result.exitCode;
        }
      },
    );
}
