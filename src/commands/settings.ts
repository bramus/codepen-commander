import type { Command } from 'commander';
import { CodePenClient } from '../api/client.js';
import type { IndentWith, PenSettings, SettingsUpdateRequest } from '../api/types.js';
import type { ResolvedAuth } from '../config/auth.js';
import { requireProject, type ProjectLocation } from '../config/project.js';
import { CliError } from '../errors.js';
import { parseBooleanOption } from '../utils/cli-options.js';
import { fmt } from '../utils/format.js';
import { printJsonResponse } from '../utils/json.js';
import { defaultOutput, type CommandOutput } from '../utils/output.js';
import { isInteractive, type SelectOption } from '../utils/prompts/index.js';
import { getGlobalProfileOption, resolveCommandAuth } from '../workflows/auth-context.js';
import {
  fetchLinkedPenOrHandleMissing,
  handleMissingRemotePen,
  isRemotePenNotFoundError,
  type MissingPenPrompts,
} from '../workflows/missing-pen.js';

export interface RunSettingsCommandOptions {
  autoDeploy?: string;
  autoRun?: string;
  autoSave?: string;
  indentWith?: string;
  tabSize?: string;
  json?: boolean;
  cwd?: string;
  explicitProfile?: string;
  baseUrl?: string;
  interactive?: boolean;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  output?: CommandOutput;
  selectProfile?: (
    question: string,
    options: SelectOption<string>[],
    defaultIndex: number,
  ) => Promise<string>;
  prompts?: MissingPenPrompts;
}

export interface SettingsCommandResult {
  settings: PenSettings;
  updated: boolean;
  auth: ResolvedAuth;
  project: ProjectLocation;
}

function renderPenSettings(settings: PenSettings, output: CommandOutput): void {
  const boolText = (b: boolean) => (b ? fmt.green('true') : fmt.dim('false'));
  output.log(`auto_deploy: ${boolText(settings.auto_deploy)}`);
  output.log(`auto_run:    ${boolText(settings.auto_run)}`);
  output.log(`auto_save:   ${boolText(settings.auto_save)}`);
  output.log(`indent_with: ${fmt.cyan(settings.indent_with)}`);
  output.log(`tab_size:    ${fmt.cyan(String(settings.tab_size))}`);
}

export async function runSettingsCommand(
  options: RunSettingsCommandOptions = {},
): Promise<SettingsCommandResult | null> {
  const output = options.output ?? defaultOutput;
  const interactive = !options.json && (options.interactive ?? isInteractive());
  const project = await requireProject(options.cwd ?? process.cwd());
  const auth = await resolveCommandAuth({
    explicitProfile: options.explicitProfile,
    project,
    interactive,
    persistProfileToProject: !options.json,
    output,
    env: options.env,
    homeDir: options.homeDir,
    selectProfile: options.selectProfile,
  });
  const client = new CodePenClient({ apiKey: auth.apiKey, baseUrl: options.baseUrl });

  const patch: SettingsUpdateRequest = {};
  if (options.autoDeploy !== undefined) {
    patch.auto_deploy = parseBooleanOption(options.autoDeploy, '--auto-deploy');
  }
  if (options.autoRun !== undefined) {
    patch.auto_run = parseBooleanOption(options.autoRun, '--auto-run');
  }
  if (options.autoSave !== undefined) {
    patch.auto_save = parseBooleanOption(options.autoSave, '--auto-save');
  }
  if (options.indentWith !== undefined) {
    const lower = options.indentWith.trim().toLowerCase();
    if (lower !== 'tabs' && lower !== 'spaces') {
      throw new CliError(400, 'Invalid --indent-with value. Use "tabs" or "spaces".');
    }
    patch.indent_with = lower as IndentWith;
  }
  if (options.tabSize !== undefined) {
    const parsed = Number.parseInt(options.tabSize, 10);
    if (Number.isNaN(parsed) || parsed < 1 || parsed > 6) {
      throw new CliError(400, '--tab-size must be an integer between 1 and 6.');
    }
    patch.tab_size = parsed;
  }

  const hasUpdates = Object.keys(patch).length > 0;
  let settings: PenSettings;
  if (hasUpdates) {
    try {
      settings = await client.updateSettings(project.config.pen_id, patch);
    } catch (error) {
      if (!isRemotePenNotFoundError(error)) {
        throw error;
      }
      const resolution = await handleMissingRemotePen({
        client,
        project,
        auth,
        commandName: 'settings',
        interactive,
        json: options.json,
        output,
        prompts: options.prompts,
      });
      if (resolution.action !== 'recovered') {
        return null;
      }
      settings = await client.updateSettings(project.config.pen_id, patch);
    }
  } else {
    const penLookup = await fetchLinkedPenOrHandleMissing({
      client,
      project,
      auth,
      commandName: 'settings',
      interactive,
      json: options.json,
      output,
      prompts: options.prompts,
    });
    if (!penLookup.found) {
      return null;
    }
    settings = penLookup.pen.settings;
  }

  if (options.json) {
    printJsonResponse(
      200,
      hasUpdates ? 'Updated Pen settings.' : 'Fetched Pen settings.',
      settings,
      output,
    );
    return { settings, updated: hasUpdates, auth, project };
  }

  if (hasUpdates) {
    output.log(`${fmt.green('✓')} Updated Pen settings.\n`);
  }
  renderPenSettings(settings, output);
  return { settings, updated: hasUpdates, auth, project };
}

export function registerSettingsCommand(program: Command): void {
  program
    .command('settings')
    .description('View or update Pen editor & deploy settings')
    .option('--auto-deploy <bool>', 'Auto-deploy on save (true/false)')
    .option('--auto-run <bool>', 'Auto-run preview (true/false)')
    .option('--auto-save <bool>', 'Auto-save in editor (true/false)')
    .option('--indent-with <mode>', 'Indentation style: tabs or spaces')
    .option('--tab-size <n>', 'Tab size (integer between 1 and 6)')
    .option('--json', 'Output settings as JSON')
    .action(
      async (
        options: {
          autoDeploy?: string;
          autoRun?: string;
          autoSave?: string;
          indentWith?: string;
          tabSize?: string;
          json?: boolean;
        },
        command: Command,
      ) => {
        await runSettingsCommand({
          ...options,
          explicitProfile: getGlobalProfileOption(command),
        });
      },
    );
}
