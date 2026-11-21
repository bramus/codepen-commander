import path from 'node:path';
import type { Command } from 'commander';
import { CodePenClient } from '../api/client.js';
import type { Deployment } from '../api/types.js';
import { findNearestConfig, type ProjectLocation } from '../config/project.js';
import { PROJECT_CONFIG_FILENAME } from '../constants.js';
import { CliError } from '../errors.js';
import { assertValidVersionLabel, resolveAccessOrVisibility } from '../utils/cli-options.js';
import { fmt, shortId } from '../utils/format.js';
import { printJsonResponse } from '../utils/json.js';
import { defaultOutput, type CommandOutput } from '../utils/output.js';
import { isInteractive, type SelectOption } from '../utils/prompts/index.js';
import { getGlobalProfileOption, resolveCommandAuth } from '../workflows/auth-context.js';
import { createPenFromDirectory } from '../workflows/create-pen.js';
import { fetchLinkedPenOrHandleMissing } from '../workflows/missing-pen.js';
import { executePush } from '../workflows/push-pen.js';

export interface DeployCliOptions {
  push?: boolean;
  version?: string;
  force?: boolean;
  label?: string;
  title?: string;
  access?: string;
  visibility?: string;
  password?: string;
  json?: boolean;
}

export interface RunDeployCommandOptions extends DeployCliOptions {
  cwd?: string;
  explicitProfile?: string;
  baseUrl?: string;
  interactive?: boolean;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  output?: CommandOutput;
  prompts?: {
    confirm?: (question: string, defaultYes?: boolean) => Promise<boolean>;
    text?: (question: string, defaultValue?: string) => Promise<string>;
    select?: <T extends string>(
      question: string,
      options: SelectOption<T>[],
      defaultIndex?: number,
    ) => Promise<T>;
    secret?: (question: string) => Promise<string>;
  };
}

export interface DeployCommandResult {
  penId: string;
  profile: string | null;
  created: boolean;
  pushed: boolean;
  deployment: Deployment;
}

export async function runDeployCommand(
  options: RunDeployCommandOptions = {},
): Promise<DeployCommandResult | null> {
  const output = options.output ?? defaultOutput;
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const jsonMode = Boolean(options.json);
  const interactive = !jsonMode && (options.interactive ?? isInteractive());

  assertValidVersionLabel(options.label);
  const resolvedAccess = resolveAccessOrVisibility(options.access, options.visibility);

  const nearest = await findNearestConfig(cwd);
  let project: ProjectLocation | null = nearest?.linked
    ? {
        rootDir: nearest.rootDir,
        configPath: nearest.configPath,
        config: nearest.config,
      }
    : null;
  let versionIdToDeploy = options.version;
  let client: CodePenClient;
  let activeProfile: string | null;
  let createdPen = false;
  let pushedChanges = false;

  if (!project) {
    if (options.push === false || options.version) {
      throw new CliError(
        404,
        nearest
          ? `${PROJECT_CONFIG_FILENAME} in ${nearest.rootDir} only contains Pen info and is not linked to an online Pen yet.\n` +
              'Run `cdpn deploy` without --no-push/--version to create and link it first.'
          : `No ${PROJECT_CONFIG_FILENAME} found in this directory or any parent directory.\n` +
              'Run `cdpn clone <url>` to clone a Pen or run `cdpn deploy` without --no-push/--version to create one first.',
      );
    }

    const targetDir = nearest ? nearest.rootDir : cwd;
    const folderDisplay = path.relative(cwd, targetDir) || '.';

    if (!jsonMode) {
      output.log(
        fmt.dim(
          nearest
            ? `Found unlinked ${PROJECT_CONFIG_FILENAME} with saved Pen info — pushing this local folder as a new CodePen 2.0 Pen before deploying.`
            : `No ${PROJECT_CONFIG_FILENAME} found — pushing this local folder as a new CodePen 2.0 Pen before deploying.`,
        ),
      );
    }

    const created = await createPenFromDirectory({
      targetDir,
      folderDisplay,
      explicitProfile: options.explicitProfile,
      title: options.title,
      access: resolvedAccess,
      password: options.password,
      force: options.force,
      wait: true,
      silent: jsonMode,
      output,
      baseUrl: options.baseUrl,
      interactive,
      env: options.env,
      homeDir: options.homeDir,
      prompts: options.prompts,
    });
    if (!created) {
      return null;
    }
    if (created.build?.status === 'Failed') {
      throw new CliError(
        422,
        'Aborting deploy because the build failed. Fix build errors and try again.',
        {
          pen_id: created.pen.id,
          version_id: created.versionId,
          build: created.build,
        },
      );
    }

    createdPen = true;
    pushedChanges = true;
    project = created.project;
    versionIdToDeploy = created.versionId ?? undefined;
    activeProfile = created.auth.profile;
    client = new CodePenClient({ apiKey: created.auth.apiKey, baseUrl: options.baseUrl });
  } else {
    const auth = await resolveCommandAuth({
      explicitProfile: options.explicitProfile,
      project,
      interactive,
      persistProfileToProject: !jsonMode,
      output,
      env: options.env,
      homeDir: options.homeDir,
      selectProfile: options.prompts?.select,
    });
    activeProfile = auth.profile;
    client = new CodePenClient({ apiKey: auth.apiKey, baseUrl: options.baseUrl });

    const penLookup = await fetchLinkedPenOrHandleMissing({
      client,
      project,
      auth,
      commandName: 'deploy',
      interactive,
      json: jsonMode,
      output,
      prompts: options.prompts,
    });
    if (!penLookup.found) {
      return null;
    }

    if (!versionIdToDeploy && options.push !== false) {
      const pushResult = await executePush(client, project, {
        force: options.force,
        label: options.label,
        wait: true,
        prefetchedPen: penLookup.pen,
        silent: jsonMode,
        output,
      });

      pushedChanges = pushResult.pushed;

      if (pushResult.build?.status === 'Failed') {
        throw new CliError(
          422,
          'Aborting deploy because the build failed. Fix build errors and try again.',
          {
            pen_id: project.config.pen_id,
            version_id: pushResult.versionId,
            build: pushResult.build,
          },
        );
      }

      if (pushResult.versionId) {
        versionIdToDeploy = pushResult.versionId;
      }
    }
  }

  if (!jsonMode) {
    output.log(
      versionIdToDeploy
        ? `\nDeploying version ${fmt.dim(shortId(versionIdToDeploy))}…`
        : '\nDeploying saved head…',
    );
  }

  const deployment = await client.deployPen(project.config.pen_id, versionIdToDeploy);

  if (jsonMode) {
    printJsonResponse(
      200,
      'Deployed successfully.',
      {
        pen_id: project.config.pen_id,
        profile: activeProfile,
        created: createdPen,
        pushed: pushedChanges,
        version_id: deployment.version_id,
        deployment,
      },
      output,
    );
  } else {
    output.log(`${fmt.green('✓')} Deployed successfully!`);
    if (activeProfile) {
      output.log(`  Profile: ${fmt.cyan(activeProfile)}`);
    }
    output.log(`  URL:     ${fmt.cyan(deployment.url)}`);
    output.log(`  Version: ${fmt.dim(shortId(deployment.version_id))}`);
    if (deployment.custom_domains.length > 0) {
      output.log(
        `  Domains: ${deployment.custom_domains.map((d) => fmt.cyan(`https://${d}`)).join(', ')}`,
      );
    }
  }

  return {
    penId: project.config.pen_id,
    profile: activeProfile,
    created: createdPen,
    pushed: pushedChanges,
    deployment,
  };
}

export function registerDeployCommand(program: Command): void {
  program
    .command('deploy')
    .description('Push local changes and deploy the Pen to CodePen Hosting')
    .option('--no-push', 'Deploy the current remote saved head without pushing local files first')
    .option('--version <version-id>', 'Deploy a specific saved version ID instead of pushing')
    .option(
      '-f, --force',
      'Overwrite remote head if moved (or skip missing index.html prompt on first push)',
    )
    .option('-m, --label <label>', 'Label for the saved version created by push')
    .option(
      '-t, --title <title>',
      'Title for a new Pen when deploying an unlinked folder for the first time',
    )
    .option('--access <level>', 'Privacy for a new Pen: Public, Private, Protected, or Collaborators')
    .option('--visibility <level>', 'Alias for --access')
    .option('--password <password>', 'Password for a new Protected Pen (min 8 chars)')
    .option('--json', 'Output deployment result as JSON')
    .action(async (options: DeployCliOptions, command: Command) => {
      await runDeployCommand({
        ...options,
        explicitProfile: getGlobalProfileOption(command),
      });
    });
}
