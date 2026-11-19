import type { Command } from 'commander';
import { CodePenClient } from '../api/client.js';
import { isCodePenApiError } from '../api/errors.js';
import {
  API_KEY_ENV_VAR,
  CODEPEN_API_SETTINGS_URL,
  getKeyType,
  getShellExportSnippets,
  isRecognizedKeyFormat,
  maskApiKey,
  removeApiKeyFile,
  resolveAuth,
  saveApiKeyToFile,
} from '../config/auth.js';
import { openBrowser } from '../utils/browser.js';
import { fmt } from '../utils/format.js';
import { isInteractive, promptConfirm, promptSecret, promptSelect } from '../utils/prompts.js';

export function registerAuthCommands(program: Command): void {
  const authCmd = program
    .command('auth')
    .description('Manage CodePen API v2 authentication');

  authCmd
    .command('status')
    .description('Show whether a CodePen API key is loaded and verify it')
    .option('--offline', 'Skip live verification against the CodePen API')
    .action(async (options: { offline?: boolean }) => {
      const auth = await resolveAuth();

      if (!auth) {
        console.log(`${fmt.red('✗')} Not authenticated.`);
        console.log(
          fmt.dim(
            `No API key found in ${API_KEY_ENV_VAR} or ~/.codepen. Run \`cdpn auth login\` to get started.`,
          ),
        );
        process.exitCode = 1;
        return;
      }

      const sourceLabel =
        auth.source === 'env'
          ? `environment variable (${API_KEY_ENV_VAR})`
          : `config file (${auth.filePath})`;

      console.log(`${fmt.green('✓')} API key loaded from ${fmt.bold(sourceLabel)}`);
      console.log(`  Key:  ${fmt.cyan(maskApiKey(auth.apiKey))} ${fmt.dim(`(${getKeyType(auth.apiKey)} key)`)}`);

      if (auth.hasEnv && auth.hasFile) {
        console.log(
          fmt.dim(`  Note: Both ${API_KEY_ENV_VAR} and ${auth.filePath} are set; ${API_KEY_ENV_VAR} takes precedence.`),
        );
      }

      if (auth.hasFile && auth.insecureFilePermissions) {
        console.log(
          fmt.yellow(
            `  Warning: ${auth.filePath} is readable by other users. Tighten permissions with: chmod 600 ~/.codepen`,
          ),
        );
      }

      if (!options.offline) {
        const client = new CodePenClient({ apiKey: auth.apiKey });
        try {
          await client.verifyAuth();
          console.log(`  API:  ${fmt.green('Valid')} ${fmt.dim('(verified with api.codepen.io/v2)')}`);
        } catch (error) {
          if (isCodePenApiError(error)) {
            console.log(`  API:  ${fmt.red('Invalid')} — ${error.message}`);
          } else {
            console.log(`  API:  ${fmt.red('Verification failed')} — ${(error as Error).message}`);
          }
          process.exitCode = 1;
        }
      }
    });

  authCmd
    .command('login')
    .description('Open CodePen API settings, verify your key, and configure storage')
    .option('--no-open', 'Do not automatically open the browser')
    .action(async (options: { open?: boolean }) => {
      if (!isInteractive()) {
        throw new Error(
          `Interactive login requires a TTY. Set ${API_KEY_ENV_VAR} in your environment instead.`,
        );
      }

      if (options.open !== false) {
        console.log(`Opening ${fmt.cyan(CODEPEN_API_SETTINGS_URL)} in your browser…`);
        const launched = await openBrowser(CODEPEN_API_SETTINGS_URL);
        if (!launched) {
          console.log(
            fmt.yellow(`Could not launch browser automatically. Open this URL manually:\n  ${CODEPEN_API_SETTINGS_URL}`),
          );
        }
      } else {
        console.log(`Generate or reveal your API key at:\n  ${fmt.cyan(CODEPEN_API_SETTINGS_URL)}`);
      }

      console.log(fmt.dim('Click "Generate API Key" (or "Reveal") and paste it below.\n'));

      let apiKey = '';
      for (;;) {
        apiKey = await promptSecret('CodePen API key');
        if (!apiKey) {
          console.log(fmt.yellow('API key cannot be empty.'));
          continue;
        }

        if (!isRecognizedKeyFormat(apiKey)) {
          console.log(
            fmt.yellow(
              'Heads up: CodePen API v2 keys usually start with `cp_user_` or `cp_team_`.',
            ),
          );
        }

        process.stdout.write('Verifying key with CodePen API v2… ');
        const client = new CodePenClient({ apiKey });
        try {
          await client.verifyAuth();
          console.log(fmt.green('✓ Valid!'));
          console.log(
            `Recognized ${fmt.bold(getKeyType(apiKey))} key (${fmt.cyan(maskApiKey(apiKey))}).\n`,
          );
          break;
        } catch (error) {
          console.log(fmt.red('✗ Failed'));
          const msg = isCodePenApiError(error) ? error.message : (error as Error).message;
          console.log(fmt.red(`  ${msg}`));
          const retry = await promptConfirm('Try entering a different key?', true);
          if (!retry) {
            process.exitCode = 1;
            return;
          }
        }
      }

      const storageChoice = await promptSelect<'file' | 'env'>(
        'How would you like to store your API key?',
        [
          {
            value: 'file',
            label: 'Save to ~/.codepen',
            description: 'written with owner-only (0600) permissions',
          },
          {
            value: 'env',
            label: 'Add to my shell environment variables myself',
            description: 'print export lines for ~/.zshrc, ~/.bashrc, etc.',
          },
        ],
        0,
      );

      if (storageChoice === 'file') {
        const savedPath = await saveApiKeyToFile(apiKey);
        console.log(`\n${fmt.green('✓')} Saved API key to ${fmt.bold(savedPath)} ${fmt.dim('(mode 0600)')}`);

        if (process.env[API_KEY_ENV_VAR]) {
          console.log(
            fmt.yellow(
              `Note: ${API_KEY_ENV_VAR} is currently set in your shell and will take precedence over ~/.codepen until unset.`,
            ),
          );
        }
      } else {
        const snippets = getShellExportSnippets(apiKey);
        console.log('\nAdd the appropriate line to your shell configuration file:\n');
        for (const snippet of snippets) {
          console.log(`  ${fmt.bold(snippet.shell)} ${fmt.dim(`(${snippet.rcFile})`)}:`);
          console.log(`    ${fmt.cyan(snippet.line)}\n`);
        }
        console.log(
          fmt.dim('Then reload your shell (e.g. `source ~/.zshrc`) and run `cdpn auth status` to verify.'),
        );
      }
    });

  authCmd
    .command('logout')
    .description('Remove the stored API key file (~/.codepen)')
    .action(async () => {
      const removed = await removeApiKeyFile();
      if (removed) {
        console.log(`${fmt.green('✓')} Removed ~/.codepen.`);
      } else {
        console.log(fmt.dim('No ~/.codepen file found.'));
      }

      if (process.env[API_KEY_ENV_VAR]) {
        console.log(
          fmt.yellow(
            `Note: ${API_KEY_ENV_VAR} is still set in your environment. Unset it in your shell config to log out completely.`,
          ),
        );
      }
    });
}
