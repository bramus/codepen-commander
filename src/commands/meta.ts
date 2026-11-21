import type { Command } from 'commander';
import { CodePenClient } from '../api/client.js';
import type { ResolvedAuth } from '../config/auth.js';
import { requireProject, writeProjectConfig, type ProjectLocation } from '../config/project.js';
import { mergeUpdatedPenInfoIntoConfig } from '../sync/info.js';
import type {
  IndentWith,
  Pen,
  PenAccess,
  PenSettings,
  PenUpdateRequest,
  SettingsUpdateRequest,
} from '../types.js';
import { fmt, formatDate, shortId } from '../utils/format.js';
import { CliError, printJsonResponse } from '../utils/json.js';
import { isInteractive, type SelectOption } from '../utils/prompts.js';
import { getGlobalProfileOption, resolveCommandAuth } from './auth-context.js';
import {
  fetchLinkedPenOrHandleMissing,
  handleMissingRemotePen,
  isRemotePenNotFoundError,
  type MissingPenPrompts,
} from './missing-pen.js';

const VALID_ACCESS = new Set(['public', 'private', 'protected', 'collaborators']);

export interface InfoPenCommandOptions {
  title?: string;
  description?: string;
  tags?: string;
  access?: string;
  password?: string;
  template?: string;
  json?: boolean;
  cwd?: string;
  explicitProfile?: string;
  baseUrl?: string;
  interactive?: boolean;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  selectProfile?: (
    question: string,
    options: SelectOption<string>[],
    defaultIndex: number,
  ) => Promise<string>;
  prompts?: MissingPenPrompts;
}

export interface InfoPenResult {
  pen: Pen;
  updated: boolean;
  auth: ResolvedAuth;
  project: ProjectLocation;
}

function parseBooleanOption(raw: string, flagName: string): boolean {
  const lower = raw.trim().toLowerCase();
  if (lower === 'true' || lower === '1' || lower === 'yes' || lower === 'on') return true;
  if (lower === 'false' || lower === '0' || lower === 'no' || lower === 'off') return false;
  throw new CliError(400, `Invalid boolean value "${raw}" for ${flagName}. Use true or false.`);
}

function renderPenInfo(pen: Pen, profile?: string | null): void {
  console.log(`${fmt.bold(pen.title || 'Untitled')} ${fmt.dim(`(${pen.id})`)}`);
  if (profile) {
    console.log(`Profile:     ${fmt.cyan(profile)}`);
  }
  if (pen.description) {
    console.log(`Description: ${pen.description}`);
  }
  console.log(`Editor:      ${pen.editor}`);
  console.log(`Access:      ${pen.access}${pen.template ? fmt.dim(' · Template') : ''}`);
  console.log(`Tags:        ${pen.tags.length > 0 ? pen.tags.join(', ') : fmt.dim('none')}`);
  console.log(`Stats:       ${pen.views_count} views · ${pen.loves_count} loves`);
  console.log(`Editor URL:  ${fmt.cyan(pen.urls.editor)}`);
  console.log(`Preview URL: ${fmt.cyan(pen.urls.preview)}`);
  if (pen.deployment) {
    console.log(`Deployed:    ${fmt.cyan(pen.deployment.url)} ${fmt.dim(`(v ${shortId(pen.deployment.version_id)})`)}`);
    if (pen.deployment.custom_domains.length > 0) {
      console.log(`Domains:     ${pen.deployment.custom_domains.join(', ')}`);
    }
  } else {
    console.log(`Deployed:    ${fmt.dim('not deployed')}`);
  }
  console.log(`Created:     ${fmt.dim(formatDate(pen.created_at))}`);
  console.log(`Updated:     ${fmt.dim(formatDate(pen.updated_at))}`);
}

function renderPenSettings(settings: PenSettings): void {
  const boolText = (b: boolean) => (b ? fmt.green('true') : fmt.dim('false'));
  console.log(`auto_deploy: ${boolText(settings.auto_deploy)}`);
  console.log(`auto_run:    ${boolText(settings.auto_run)}`);
  console.log(`auto_save:   ${boolText(settings.auto_save)}`);
  console.log(`indent_with: ${fmt.cyan(settings.indent_with)}`);
  console.log(`tab_size:    ${fmt.cyan(String(settings.tab_size))}`);
}

export async function infoPenCommand(
  options: InfoPenCommandOptions = {},
): Promise<InfoPenResult | null> {
  const interactive = (options.interactive ?? isInteractive()) && !options.json;
  const project = await requireProject(options.cwd ?? process.cwd());
  const auth = await resolveCommandAuth({
    explicitProfile: options.explicitProfile,
    project,
    interactive,
    persistProfileToProject: !options.json,
    env: options.env,
    homeDir: options.homeDir,
    selectProfile: options.selectProfile,
  });
  const client = new CodePenClient({ apiKey: auth.apiKey, baseUrl: options.baseUrl });

  const patch: PenUpdateRequest = {};
  if (options.title !== undefined) patch.title = options.title;
  if (options.description !== undefined) patch.description = options.description;
  if (options.tags !== undefined) {
    const parsedTags = options.tags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    if (parsedTags.length > 5) {
      throw new CliError(400, 'CodePen allows at most 5 tags per Pen.');
    }
    patch.tags = parsedTags;
  }
  if (options.access !== undefined) {
    const lower = options.access.trim().toLowerCase();
    if (!VALID_ACCESS.has(lower)) {
      throw new CliError(
        400,
        `Invalid --access "${options.access}". Use: Public, Private, Protected, or Collaborators.`,
      );
    }
    patch.access = (lower[0]!.toUpperCase() + lower.slice(1)) as PenAccess;
  }
  if (options.password !== undefined) {
    if (options.password.length < 8) {
      throw new CliError(400, 'Password must be at least 8 characters.');
    }
    patch.password = options.password;
  }
  if (options.template !== undefined) {
    patch.template = parseBooleanOption(options.template, '--template');
  }

  const hasUpdates = Object.keys(patch).length > 0;
  let pen: Pen;
  if (hasUpdates) {
    try {
      pen = await client.updatePen(project.config.pen_id, patch);
    } catch (error) {
      if (!isRemotePenNotFoundError(error)) {
        throw error;
      }
      const resolution = await handleMissingRemotePen({
        client,
        project,
        auth,
        commandName: 'info',
        interactive,
        json: options.json,
        prompts: options.prompts,
      });
      if (resolution.action !== 'recovered') {
        return null;
      }
      pen = await client.updatePen(project.config.pen_id, patch);
    }
  } else {
    const penLookup = await fetchLinkedPenOrHandleMissing({
      client,
      project,
      auth,
      commandName: 'info',
      interactive,
      json: options.json,
      prompts: options.prompts,
    });
    if (!penLookup.found) {
      return null;
    }
    pen = penLookup.pen;
  }

  if (hasUpdates) {
    const nextConfig = mergeUpdatedPenInfoIntoConfig(project.config, pen, patch);
    await writeProjectConfig(project.rootDir, nextConfig);
    project.config = nextConfig;
  }

  if (options.json) {
    printJsonResponse(
      200,
      hasUpdates ? 'Updated Pen metadata.' : 'Fetched Pen metadata.',
      pen,
    );
    return { pen, updated: hasUpdates, auth, project };
  }

  if (hasUpdates) {
    console.log(`${fmt.green('✓')} Updated Pen metadata.\n`);
  }
  renderPenInfo(pen, auth.profile);
  return { pen, updated: hasUpdates, auth, project };
}

export function registerMetaCommands(program: Command): void {
  program
    .command('info')
    .description('Show or update Pen metadata (title, description, tags, access, template)')
    .option('-t, --title <title>', 'Update Pen title')
    .option('-d, --description <text>', 'Update Pen description')
    .option('--tags <tags>', 'Replace tags with comma-separated list (pass "" to clear)')
    .option('--access <level>', 'Update access: Public, Private, Protected, or Collaborators')
    .option('--password <password>', 'Set/replace password (min 8 chars; for Protected Pens)')
    .option('--template <bool>', 'Set template flag (true/false)')
    .option('--json', 'Output Pen metadata as JSON')
    .action(
      async (
        options: {
          title?: string;
          description?: string;
          tags?: string;
          access?: string;
          password?: string;
          template?: string;
          json?: boolean;
        },
        command: Command,
      ) => {
        await infoPenCommand({
          ...options,
          explicitProfile: getGlobalProfileOption(command),
        });
      },
    );

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
        const interactive = !options.json && isInteractive();
        const project = await requireProject();
        const auth = await resolveCommandAuth({
          explicitProfile: getGlobalProfileOption(command),
          project,
          interactive,
          persistProfileToProject: !options.json,
        });
        const client = new CodePenClient({ apiKey: auth.apiKey });

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
            });
            if (resolution.action !== 'recovered') {
              return;
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
          });
          if (!penLookup.found) {
            return;
          }
          settings = penLookup.pen.settings;
        }

        if (options.json) {
          printJsonResponse(
            200,
            hasUpdates ? 'Updated Pen settings.' : 'Fetched Pen settings.',
            settings,
          );
          return;
        }

        if (hasUpdates) {
          console.log(`${fmt.green('✓')} Updated Pen settings.\n`);
        }
        renderPenSettings(settings);
      },
    );
}
