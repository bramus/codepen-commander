import type { Command } from 'commander';
import { CodePenClient } from '../api/client.js';
import { requireProject } from '../config/project.js';
import { fmt, shortId } from '../utils/format.js';
import { isInteractive, promptConfirm } from '../utils/prompts.js';
import { getGlobalProfileOption, resolveCommandAuth } from './auth-context.js';
import { executePush } from './push.js';

export interface DeployOptions {
  push?: boolean;
  version?: string;
  force?: boolean;
  label?: string;
}

export function registerDeployCommands(program: Command): void {
  program
    .command('deploy')
    .description('Push local changes and deploy the Pen to CodePen Hosting')
    .option('--no-push', 'Deploy the current remote saved head without pushing local files first')
    .option('--version <version-id>', 'Deploy a specific saved version ID instead of pushing')
    .option('-f, --force', 'Overwrite remote head if it moved since last sync when pushing')
    .option('-m, --label <label>', 'Label for the saved version created by push')
    .action(async (options: DeployOptions, command: Command) => {
      const project = await requireProject();
      const auth = await resolveCommandAuth({
        explicitProfile: getGlobalProfileOption(command),
        project,
      });
      const client = new CodePenClient({ apiKey: auth.apiKey });

      let versionIdToDeploy = options.version;

      if (!versionIdToDeploy && options.push !== false) {
        const pushResult = await executePush(client, project, {
          force: options.force,
          label: options.label,
          wait: true,
        });

        if (pushResult.build?.status === 'Failed') {
          throw new Error('Aborting deploy because the build failed. Fix build errors and try again.');
        }

        if (pushResult.versionId) {
          versionIdToDeploy = pushResult.versionId;
        }
      }

      console.log(
        versionIdToDeploy
          ? `\nDeploying version ${fmt.dim(shortId(versionIdToDeploy))}…`
          : '\nDeploying saved head…',
      );

      const deployment = await client.deployPen(project.config.pen_id, versionIdToDeploy);

      console.log(`${fmt.green('✓')} Deployed successfully!`);
      if (auth.profile) {
        console.log(`  Profile: ${fmt.cyan(auth.profile)}`);
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
    .action(async (options: { yes?: boolean }, command: Command) => {
      const project = await requireProject();
      const auth = await resolveCommandAuth({
        explicitProfile: getGlobalProfileOption(command),
        project,
      });
      const client = new CodePenClient({ apiKey: auth.apiKey });

      const pen = await client.getPen(project.config.pen_id);
      if (!pen.deployment) {
        console.log(fmt.dim('This Pen is not currently deployed.'));
        return;
      }

      if (!options.yes) {
        if (!isInteractive()) {
          throw new Error('Refusing to undeploy in non-interactive mode without --yes.');
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
      console.log(`${fmt.green('✓')} Deployment taken down. Your Pen and saved versions remain intact.`);
    });
}
