import type { Command } from 'commander';
import { API_KEY_FILENAME } from '../../config/auth.js';
import { resolveInheritedJsonOption } from '../../utils/cli-options.js';
import { getGlobalProfileOption } from '../../workflows/auth-context.js';
import { runAuthDefaultCommand } from './default.js';
import { runAuthListCommand } from './list.js';
import { runAuthLoginCommand } from './login.js';
import { runAuthLogoutCommand } from './logout.js';
import { runAuthStatusCommand } from './status.js';

export {
  runAuthDefaultCommand,
  runAuthListCommand,
  runAuthLoginCommand,
  runAuthLogoutCommand,
  runAuthStatusCommand,
};

export function registerAuthCommand(program: Command): void {
  const authCmd = program
    .command('auth')
    .description('Manage CodePen API v2 authentication and profiles')
    .option('--json', 'Output result as JSON (for status, list, default, logout)');

  authCmd
    .command('status')
    .description('Show loaded CodePen API keys/profiles and verify them')
    .option('--offline', 'Skip live verification against the CodePen API')
    .option('--json', 'Output authentication status as JSON')
    .action(async (options: { offline?: boolean; json?: boolean }, command: Command) => {
      const result = await runAuthStatusCommand({
        offline: options.offline,
        json: resolveInheritedJsonOption(options, command),
        requestedProfile: getGlobalProfileOption(command),
      });
      if (result.exitCode !== undefined) {
        process.exitCode = result.exitCode;
      }
    });

  authCmd
    .command('list')
    .alias('ls')
    .description(`List stored CodePen profiles in ~/${API_KEY_FILENAME}`)
    .option('--json', 'Output stored profiles as JSON')
    .action(async (options: { json?: boolean }, command: Command) => {
      await runAuthListCommand({
        json: resolveInheritedJsonOption(options, command),
      });
    });

  authCmd
    .command('default [profile]')
    .description(`Set the default CodePen profile in ~/${API_KEY_FILENAME}`)
    .option('--json', 'Output result as JSON')
    .action(async (profileArg: string | undefined, options: { json?: boolean }, command: Command) => {
      await runAuthDefaultCommand({
        profileArg,
        explicitProfile: getGlobalProfileOption(command),
        json: resolveInheritedJsonOption(options, command),
      });
    });

  authCmd
    .command('login [profile]')
    .description(`Open CodePen API settings, verify a key, and save a profile to ~/${API_KEY_FILENAME}`)
    .option('--default', 'Set this profile as the default profile')
    .option('--no-open', 'Do not automatically open the browser')
    .action(
      async (
        profileArg: string | undefined,
        options: { default?: boolean; open?: boolean },
        command: Command,
      ) => {
        const result = await runAuthLoginCommand({
          profileArg,
          explicitProfile: getGlobalProfileOption(command),
          default: options.default,
          open: options.open,
        });
        if (result.exitCode !== undefined) {
          process.exitCode = result.exitCode;
        }
      },
    );

  authCmd
    .command('logout [profile]')
    .description(`Remove a stored profile or the entire ~/${API_KEY_FILENAME} file`)
    .option('--all', `Remove all stored profiles (~/${API_KEY_FILENAME})`)
    .option('--json', 'Output logout result as JSON')
    .action(
      async (
        profileArg: string | undefined,
        options: { all?: boolean; json?: boolean },
        command: Command,
      ) => {
        const result = await runAuthLogoutCommand({
          profileArg,
          explicitProfile: getGlobalProfileOption(command),
          all: options.all,
          json: resolveInheritedJsonOption(options, command),
        });
        if (result.exitCode !== undefined) {
          process.exitCode = result.exitCode;
        }
      },
    );
}
