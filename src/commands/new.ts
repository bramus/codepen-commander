import path from 'node:path';
import type { Command } from 'commander';
import { getGlobalProfileOption } from './auth-context.js';
import { createPenFromDirectory } from './create-pen.js';

export interface NewPenOptions {
  title?: string;
  description?: string;
  tags?: string;
  access?: string;
  password?: string;
  template?: boolean;
  starter?: boolean;
  force?: boolean;
}

export function registerNewCommand(program: Command): void {
  program
    .command('new [folder]')
    .description('Create a new CodePen 2.0 Pen (from local folder files or CodePen starter files)')
    .option('-t, --title <title>', 'Title for the new Pen (defaults to index.html <title> when present)')
    .option('-d, --description <text>', 'Description for the new Pen')
    .option('--tags <tags>', 'Comma-separated tags (up to 5)')
    .option('--access <level>', 'Privacy: Public, Private, Protected, or Collaborators')
    .option('--password <password>', 'Password (min 8 chars; required with --access Protected)')
    .option('--template', 'Mark the Pen as a template')
    .option('--starter', 'Create with CodePen starter files instead of uploading local files')
    .option('-f, --force', 'Skip confirmation warning when no index.html is present')
    .action(async (folderArg: string | undefined, options: NewPenOptions, command: Command) => {
      const tags = options.tags
        ? options.tags
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean)
        : undefined;

      const targetDir = folderArg ? path.resolve(process.cwd(), folderArg) : process.cwd();
      const folderDisplay = folderArg ?? '.';

      await createPenFromDirectory({
        targetDir,
        folderDisplay,
        hasExplicitFolder: Boolean(folderArg),
        explicitProfile: getGlobalProfileOption(command),
        title: options.title,
        description: options.description,
        tags,
        access: options.access,
        password: options.password,
        template: options.template,
        starter: options.starter,
        force: options.force,
        requireLocalFiles: false,
      });
    });
}
