#!/usr/bin/env node

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Command, CommanderError } from 'commander';
import { isCodePenApiError } from './api/errors.js';
import { registerAuthCommand } from './commands/auth/index.js';
import { registerBuildCommand } from './commands/build.js';
import { registerCloneCommand } from './commands/clone.js';
import { registerDeleteCommand } from './commands/delete.js';
import { registerDeployCommand } from './commands/deploy.js';
import { registerDomainsCommand } from './commands/domains.js';
import { registerForkCommand } from './commands/fork.js';
import { registerInfoCommand } from './commands/info.js';
import { registerInitCommand } from './commands/init.js';
import { registerListCommand } from './commands/list.js';
import { registerNewCommand } from './commands/new.js';
import { registerOpenCommand } from './commands/open.js';
import { registerPrivacyCommand } from './commands/privacy.js';
import { registerPullCommand } from './commands/pull.js';
import { registerPushCommand } from './commands/push.js';
import { registerRestoreCommand } from './commands/restore.js';
import { registerRollbackCommand } from './commands/rollback.js';
import { registerServeCommand } from './commands/serve.js';
import { registerSettingsCommand } from './commands/settings.js';
import { registerShellCommand } from './commands/shell.js';
import { registerStatusCommand } from './commands/status.js';
import { registerUndeployCommand } from './commands/undeploy.js';
import { registerUnlinkCommand } from './commands/unlink.js';
import { registerVersionsCommand } from './commands/versions.js';
import { fmt } from './utils/format.js';
import { errorToJsonEnvelope, wantsJsonOutput } from './utils/json.js';
import { readPackageVersion } from './utils/package-paths.js';
import { isPromptCanceledError } from './utils/prompts/index.js';

export function createProgram(): Command {
  const program = new Command();

  program
    .name('cdpn')
    .description('Sync local folders with CodePen 2.0 Pens via the CodePen API v2')
    .version(readPackageVersion(), '-v, --version')
    .option('--profile <name>', 'Use a specific API key profile from ~/.cdpn');

  registerAuthCommand(program);
  registerInitCommand(program);
  registerCloneCommand(program);
  registerForkCommand(program);
  registerPullCommand(program);
  registerStatusCommand(program);
  registerPushCommand(program);
  registerDeployCommand(program);
  registerUndeployCommand(program);
  registerDomainsCommand(program);
  registerNewCommand(program);
  registerPrivacyCommand(program);
  registerDeleteCommand(program);
  registerRestoreCommand(program);
  registerUnlinkCommand(program);
  registerOpenCommand(program);
  registerListCommand(program);
  registerVersionsCommand(program);
  registerRollbackCommand(program);
  registerInfoCommand(program);
  registerSettingsCommand(program);
  registerServeCommand(program);
  registerBuildCommand(program);
  registerShellCommand(program);

  return program;
}

function configureJsonErrorMode(cmd: Command): void {
  cmd.exitOverride();
  cmd.configureOutput({
    writeErr: () => {
      // Suppress Commander's plain-text stderr errors so --json mode emits a single JSON envelope
    },
  });
  for (const sub of cmd.commands) {
    configureJsonErrorMode(sub);
  }
}

async function main(): Promise<void> {
  const program = createProgram();
  const jsonMode = wantsJsonOutput(process.argv);

  if (jsonMode) {
    configureJsonErrorMode(program);
  }

  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    if (error instanceof CommanderError && error.exitCode === 0) {
      return;
    }

    if (jsonMode) {
      const envelope = errorToJsonEnvelope(error);
      console.log(JSON.stringify(envelope, null, 2));
      process.exitCode = 1;
      return;
    }

    if (isPromptCanceledError(error)) {
      process.exitCode = 130;
      return;
    }

    if (isCodePenApiError(error)) {
      console.error(`\n${fmt.red('Error:')} ${error.formatForUser()}`);
    } else if (error instanceof Error) {
      console.error(`\n${fmt.red('Error:')} ${error.message}`);
      if (process.env.DEBUG && error.stack) {
        console.error(fmt.dim(error.stack));
      }
    } else {
      console.error(`\n${fmt.red('Error:')} ${String(error)}`);
    }
    process.exitCode = 1;
  }
}

function isExecutedDirectly(): boolean {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isExecutedDirectly()) {
  void main();
}
