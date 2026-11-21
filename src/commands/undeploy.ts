import type { Command } from 'commander';
import { CodePenClient } from '../api/client.js';
import type { Deployment } from '../api/types.js';
import { requireProject } from '../config/project.js';
import { CliError } from '../errors.js';
import { fmt } from '../utils/format.js';
import { printJsonResponse } from '../utils/json.js';
import { defaultOutput, type CommandOutput } from '../utils/output.js';
import { isInteractive, promptConfirm, type SelectOption } from '../utils/prompts/index.js';
import { getGlobalProfileOption, resolveCommandAuth } from '../workflows/auth-context.js';
import { fetchLinkedPenOrHandleMissing, type MissingPenPrompts } from '../workflows/missing-pen.js';

export interface RunUndeployCommandOptions {
  yes?: boolean;
  json?: boolean;
  cwd?: string;
  explicitProfile?: string;
  baseUrl?: string;
  interactive?: boolean;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  output?: CommandOutput;
  prompts?: MissingPenPrompts & {
    selectProfile?: (
      question: string,
      options: SelectOption<string>[],
      defaultIndex: number,
    ) => Promise<string>;
  };
}

export interface UndeployCommandResult {
  penId: string;
  profile: string | null;
  undeployed: boolean;
  previousDeployment: Deployment | null;
}

export async function runUndeployCommand(
  options: RunUndeployCommandOptions = {},
): Promise<UndeployCommandResult | null> {
  const output = options.output ?? defaultOutput;
  const jsonMode = Boolean(options.json);
  const interactive = !jsonMode && (options.interactive ?? isInteractive());
  const confirmImpl = options.prompts?.confirm ?? promptConfirm;

  const project = await requireProject(options.cwd ?? process.cwd());
  const auth = await resolveCommandAuth({
    explicitProfile: options.explicitProfile,
    project,
    interactive,
    persistProfileToProject: !jsonMode,
    output,
    env: options.env,
    homeDir: options.homeDir,
    selectProfile: options.prompts?.selectProfile,
  });
  const client = new CodePenClient({ apiKey: auth.apiKey, baseUrl: options.baseUrl });

  const penLookup = await fetchLinkedPenOrHandleMissing({
    client,
    project,
    auth,
    commandName: 'undeploy',
    interactive,
    json: jsonMode,
    output,
    prompts: options.prompts,
  });
  if (!penLookup.found) {
    return null;
  }

  const pen = penLookup.pen;
  if (!pen.deployment) {
    if (jsonMode) {
      printJsonResponse(
        200,
        'This Pen is not currently deployed.',
        {
          pen_id: project.config.pen_id,
          profile: auth.profile,
          undeployed: false,
          previous_deployment: null,
        },
        output,
      );
    } else {
      output.log(fmt.dim('This Pen is not currently deployed.'));
    }
    return {
      penId: project.config.pen_id,
      profile: auth.profile,
      undeployed: false,
      previousDeployment: null,
    };
  }

  if (!options.yes) {
    if (!interactive) {
      throw new CliError(400, 'Refusing to undeploy in non-interactive mode without --yes.');
    }
    const ok = await confirmImpl(
      `Take down live deployment at ${fmt.cyan(pen.deployment.url)}?`,
      false,
    );
    if (!ok) {
      output.log('Aborted.');
      return null;
    }
  }

  await client.undeployPen(project.config.pen_id);

  if (jsonMode) {
    printJsonResponse(
      200,
      'Deployment taken down. Your Pen and saved versions remain intact.',
      {
        pen_id: project.config.pen_id,
        profile: auth.profile,
        undeployed: true,
        previous_deployment: pen.deployment,
      },
      output,
    );
  } else {
    output.log(
      `${fmt.green('✓')} Deployment taken down. Your Pen and saved versions remain intact.`,
    );
  }

  return {
    penId: project.config.pen_id,
    profile: auth.profile,
    undeployed: true,
    previousDeployment: pen.deployment,
  };
}

export function registerUndeployCommand(program: Command): void {
  program
    .command('undeploy')
    .description('Take down the Pen’s live deployment (Pen and versions stay intact)')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--json', 'Output undeploy result as JSON')
    .action(async (options: { yes?: boolean; json?: boolean }, command: Command) => {
      await runUndeployCommand({
        yes: options.yes,
        json: options.json,
        explicitProfile: getGlobalProfileOption(command),
      });
    });
}
