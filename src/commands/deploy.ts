import path from 'node:path';
import type { Command } from 'commander';
import { CodePenClient } from '../api/client.js';
import {
  findNearestConfig,
  PROJECT_CONFIG_FILENAME,
  requireProject,
  type ProjectLocation,
} from '../config/project.js';
import { fmt, shortId } from '../utils/format.js';
import { CliError, printJsonResponse } from '../utils/json.js';
import { isInteractive, promptConfirm } from '../utils/prompts.js';
import { getGlobalProfileOption, resolveCommandAuth } from './auth-context.js';
import { createPenFromDirectory } from './create-pen.js';
import { executePush } from './push.js';

export interface DeployOptions {
  push?: boolean;
  version?: string;
  force?: boolean;
  label?: string;
  title?: string;
  access?: string;
  password?: string;
  json?: boolean;
}

export function registerDeployCommands(program: Command): void {
  program
    .command('deploy')
    .description('Push local changes and deploy the Pen to CodePen Hosting')
    .option('--no-push', 'Deploy the current remote saved head without pushing local files first')
    .option('--version <version-id>', 'Deploy a specific saved version ID instead of pushing')
    .option('-f, --force', 'Overwrite remote head if moved (or skip missing index.html prompt on first push)')
    .option('-m, --label <label>', 'Label for the saved version created by push')
    .option('-t, --title <title>', 'Title for a new Pen when deploying an unlinked folder for the first time')
    .option('--access <level>', 'Privacy for a new Pen: Public, Private, Protected, or Collaborators')
    .option('--password <password>', 'Password for a new Protected Pen (min 8 chars)')
    .option('--json', 'Output deployment result as JSON')
    .action(async (options: DeployOptions, command: Command) => {
      if (options.label && options.label.length > 80) {
        throw new CliError(400, 'Version label must be at most 80 characters.');
      }

      const explicitProfile = getGlobalProfileOption(command);
      const nearest = await findNearestConfig(process.cwd());
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

        const targetDir = nearest ? nearest.rootDir : process.cwd();
        const folderDisplay = path.relative(process.cwd(), targetDir) || '.';

        if (!options.json) {
          console.log(
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
          explicitProfile,
          title: options.title,
          access: options.access,
          password: options.password,
          force: options.force,
          wait: true,
          silent: Boolean(options.json),
          interactive: !options.json && isInteractive(),
        });
        if (!created) {
          return;
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
        client = new CodePenClient({ apiKey: created.auth.apiKey });
      } else {
        const auth = await resolveCommandAuth({
          explicitProfile,
          project,
          interactive: !options.json && isInteractive(),
          persistProfileToProject: !options.json,
        });
        activeProfile = auth.profile;
        client = new CodePenClient({ apiKey: auth.apiKey });

        if (!versionIdToDeploy && options.push !== false) {
          const pushResult = await executePush(client, project, {
            force: options.force,
            label: options.label,
            wait: true,
            silent: Boolean(options.json),
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

      if (!options.json) {
        console.log(
          versionIdToDeploy
            ? `\nDeploying version ${fmt.dim(shortId(versionIdToDeploy))}…`
            : '\nDeploying saved head…',
        );
      }

      const deployment = await client.deployPen(project.config.pen_id, versionIdToDeploy);

      if (options.json) {
        printJsonResponse(200, 'Deployed successfully.', {
          pen_id: project.config.pen_id,
          profile: activeProfile,
          created: createdPen,
          pushed: pushedChanges,
          version_id: deployment.version_id,
          deployment,
        });
        return;
      }

      console.log(`${fmt.green('✓')} Deployed successfully!`);
      if (activeProfile) {
        console.log(`  Profile: ${fmt.cyan(activeProfile)}`);
      }
      console.log(`  URL:     ${fmt.cyan(deployment.url)}`);
      console.log(`  Version: ${fmt.dim(shortId(deployment.version_id))}`);
      if (deployment.custom_domains.length > 0) {
        console.log(`  Domains: ${deployment.custom_domains.map((d) => fmt.cyan(`https://${d}`)).join(', ')}`);
      }
    });

  program
    .command('undeploy')
    .description('Take down the Pen’s live deployment (Pen and versions stay intact)')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--json', 'Output undeploy result as JSON')
    .action(async (options: { yes?: boolean; json?: boolean }, command: Command) => {
      const interactive = isInteractive() && !options.json;
      const project = await requireProject();
      const auth = await resolveCommandAuth({
        explicitProfile: getGlobalProfileOption(command),
        project,
        interactive,
        persistProfileToProject: !options.json,
      });
      const client = new CodePenClient({ apiKey: auth.apiKey });

      const pen = await client.getPen(project.config.pen_id);
      if (!pen.deployment) {
        if (options.json) {
          printJsonResponse(200, 'This Pen is not currently deployed.', {
            pen_id: project.config.pen_id,
            profile: auth.profile,
            undeployed: false,
            previous_deployment: null,
          });
          return;
        }
        console.log(fmt.dim('This Pen is not currently deployed.'));
        return;
      }

      if (!options.yes) {
        if (!interactive) {
          throw new CliError(400, 'Refusing to undeploy in non-interactive mode without --yes.');
        }
        const ok = await promptConfirm(
          `Take down live deployment at ${fmt.cyan(pen.deployment.url)}?`,
          false,
        );
        if (!ok) {
          console.log('Aborted.');
          return;
        }
      }

      await client.undeployPen(project.config.pen_id);
      if (options.json) {
        printJsonResponse(200, 'Deployment taken down. Your Pen and saved versions remain intact.', {
          pen_id: project.config.pen_id,
          profile: auth.profile,
          undeployed: true,
          previous_deployment: pen.deployment,
        });
        return;
      }
      console.log(`${fmt.green('✓')} Deployment taken down. Your Pen and saved versions remain intact.`);
    });
}
