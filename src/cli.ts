#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { isCodePenApiError } from './api/errors.js';
import { registerAuthCommands } from './commands/auth.js';
import { registerDeployCommands } from './commands/deploy.js';
import { registerDomainsCommand } from './commands/domains.js';
import { registerForkCommand } from './commands/fork.js';
import { registerListCommand } from './commands/list.js';
import { registerMetaCommands } from './commands/meta.js';
import { registerNewCommand } from './commands/new.js';
import { registerOpenCommand } from './commands/open.js';
import { registerPrivacyCommand } from './commands/privacy.js';
import { registerPullCommand } from './commands/pull.js';
import { registerPushCommand } from './commands/push.js';
import { registerStatusCommand } from './commands/status.js';
import { registerVersionCommands } from './commands/versions.js';
import { fmt } from './utils/format.js';

function readPackageVersion(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  // Works both in published dist/ (package.json beside cli.js) and local dev (../package.json)
  const candidates = [
    path.join(__dirname, 'package.json'),
    path.join(__dirname, '..', 'package.json'),
  ];

  for (const candidate of candidates) {
    try {
      const pkg = JSON.parse(fs.readFileSync(candidate, 'utf8')) as { version?: string };
      if (pkg.version) return pkg.version;
    } catch {
      // Try next candidate
    }
  }
  return '0.0.0';
}

export function createProgram(): Command {
  const program = new Command();

  program
    .name('cdpn')
    .description('Sync local folders with CodePen 2.0 Pens via the CodePen API v2')
    .version(readPackageVersion(), '-v, --version')
    .option('--profile <name>', 'Use a specific API key profile from ~/.cdpn');

  registerAuthCommands(program);
  registerPullCommand(program);
  registerForkCommand(program);
  registerStatusCommand(program);
  registerPushCommand(program);
  registerDeployCommands(program);
  registerDomainsCommand(program);
  registerNewCommand(program);
  registerPrivacyCommand(program);
  registerOpenCommand(program);
  registerListCommand(program);
  registerVersionCommands(program);
  registerMetaCommands(program);

  return program;
}

async function main(): Promise<void> {
  const program = createProgram();
  try {
    await program.parseAsync(process.argv);
  } catch (error) {
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
