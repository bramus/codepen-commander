import type { Command } from 'commander';
import { CodePenClient } from '../api/client.js';
import type { Pen, PenUpdateRequest } from '../api/types.js';
import type { ResolvedAuth } from '../config/auth.js';
import { requireProject, writeProjectConfig, type ProjectLocation } from '../config/project.js';
import { MIN_PROTECTED_PASSWORD_LENGTH } from '../constants.js';
import { CliError } from '../errors.js';
import { mergeUpdatedPenInfoIntoConfig } from '../sync/info.js';
import {
  assertValidTagCount,
  parseBooleanOption,
  parseTagsOption,
  resolveAccessOrVisibility,
} from '../utils/cli-options.js';
import { fmt, formatDate, shortId } from '../utils/format.js';
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

export interface RunInfoCommandOptions {
  title?: string;
  description?: string;
  tags?: string;
  access?: string;
  visibility?: string;
  password?: string;
  template?: string;
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

export interface InfoCommandResult {
  pen: Pen;
  updated: boolean;
  auth: ResolvedAuth;
  project: ProjectLocation;
}

function renderPenInfo(pen: Pen, profile: string | null | undefined, output: CommandOutput): void {
  output.log(`${fmt.bold(pen.title || 'Untitled')} ${fmt.dim(`(${pen.id})`)}`);
  if (profile) {
    output.log(`Profile:     ${fmt.cyan(profile)}`);
  }
  if (pen.description) {
    output.log(`Description: ${pen.description}`);
  }
  output.log(`Editor:      ${pen.editor}`);
  output.log(`Access:      ${pen.access}${pen.template ? fmt.dim(' · Template') : ''}`);
  output.log(`Tags:        ${pen.tags.length > 0 ? pen.tags.join(', ') : fmt.dim('none')}`);
  output.log(`Stats:       ${pen.views_count} views · ${pen.loves_count} loves`);
  output.log(`Editor URL:  ${fmt.cyan(pen.urls.editor)}`);
  output.log(`Preview URL: ${fmt.cyan(pen.urls.preview)}`);
  if (pen.deployment) {
    output.log(
      `Deployed:    ${fmt.cyan(pen.deployment.url)} ${fmt.dim(`(v ${shortId(pen.deployment.version_id)})`)}`,
    );
    if (pen.deployment.custom_domains.length > 0) {
      output.log(`Domains:     ${pen.deployment.custom_domains.join(', ')}`);
    }
  } else {
    output.log(`Deployed:    ${fmt.dim('not deployed')}`);
  }
  output.log(`Created:     ${fmt.dim(formatDate(pen.created_at))}`);
  output.log(`Updated:     ${fmt.dim(formatDate(pen.updated_at))}`);
}

export async function runInfoCommand(
  options: RunInfoCommandOptions = {},
): Promise<InfoCommandResult | null> {
  const output = options.output ?? defaultOutput;
  const interactive = (options.interactive ?? isInteractive()) && !options.json;
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

  const patch: PenUpdateRequest = {};
  if (options.title !== undefined) patch.title = options.title;
  if (options.description !== undefined) patch.description = options.description;
  if (options.tags !== undefined) {
    const parsedTags = parseTagsOption(options.tags) ?? [];
    assertValidTagCount(parsedTags);
    patch.tags = parsedTags;
  }
  const resolvedAccess = resolveAccessOrVisibility(options.access, options.visibility);
  if (resolvedAccess !== undefined) {
    patch.access = resolvedAccess;
  }
  if (options.password !== undefined) {
    if (options.password.length < MIN_PROTECTED_PASSWORD_LENGTH) {
      throw new CliError(
        400,
        `Password must be at least ${MIN_PROTECTED_PASSWORD_LENGTH} characters.`,
      );
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
        output,
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
      output,
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
      output,
    );
    return { pen, updated: hasUpdates, auth, project };
  }

  if (hasUpdates) {
    output.log(`${fmt.green('✓')} Updated Pen metadata.\n`);
  }
  renderPenInfo(pen, auth.profile, output);
  return { pen, updated: hasUpdates, auth, project };
}

export function registerInfoCommand(program: Command): void {
  program
    .command('info')
    .description('Show or update Pen metadata (title, description, tags, access, template)')
    .option('-t, --title <title>', 'Update Pen title')
    .option('-d, --description <text>', 'Update Pen description')
    .option('--tags <tags>', 'Replace tags with comma-separated list (pass "" to clear)')
    .option('--access <level>', 'Update access: Public, Private, Protected, or Collaborators')
    .option('--visibility <level>', 'Alias for --access')
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
          visibility?: string;
          password?: string;
          template?: string;
          json?: boolean;
        },
        command: Command,
      ) => {
        await runInfoCommand({
          ...options,
          explicitProfile: getGlobalProfileOption(command),
        });
      },
    );
}
