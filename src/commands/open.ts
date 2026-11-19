import type { Command } from 'commander';
import { CodePenClient } from '../api/client.js';
import { requireProject } from '../config/project.js';
import { openBrowser } from '../utils/browser.js';
import { fmt } from '../utils/format.js';
import { getGlobalProfileOption, resolveCommandAuth } from './auth-context.js';

export interface OpenOptions {
  preview?: boolean;
  live?: boolean;
}

export function registerOpenCommand(program: Command): void {
  program
    .command('open')
    .description('Open the Pen in your browser (editor by default, or --preview / --live)')
    .option('-p, --preview', 'Open the saved head preview URL')
    .option('-l, --live', 'Open the live deployed URL')
    .action(async (options: OpenOptions, command: Command) => {
      if (options.preview && options.live) {
        throw new Error('Specify at most one of --preview or --live.');
      }

      const project = await requireProject();
      const auth = await resolveCommandAuth({
        explicitProfile: getGlobalProfileOption(command),
        project,
      });
      const client = new CodePenClient({ apiKey: auth.apiKey });

      const pen = await client.getPen(project.config.pen_id);

      let targetUrl: string;
      let label: string;

      if (options.live) {
        if (!pen.deployment) {
          throw new Error('This Pen is not deployed yet. Run `cdpn deploy` first.');
        }
        targetUrl = pen.deployment.url;
        label = 'live deployment';
      } else if (options.preview) {
        targetUrl = pen.urls.preview;
        label = 'preview';
      } else {
        targetUrl = pen.urls.editor || project.config.url;
        label = 'editor';
      }

      console.log(`Opening ${label}: ${fmt.cyan(targetUrl)}`);
      const launched = await openBrowser(targetUrl);
      if (!launched) {
        console.log(fmt.yellow('Could not launch browser automatically. Open the URL above manually.'));
      }
    });
}
