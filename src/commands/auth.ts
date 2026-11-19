import type { Command } from 'commander';
import { CodePenClient } from '../api/client.js';
import { isCodePenApiError } from '../api/errors.js';
import {
  API_KEY_ENV_VAR,
  API_KEY_FILENAME,
  CODEPEN_API_SETTINGS_URL,
  DEFAULT_PROFILE_NAME,
  getKeyType,
  getShellExportSnippets,
  isRecognizedKeyFormat,
  isValidProfileName,
  maskApiKey,
  readAuthStore,
  removeApiKeyFile,
  removeProfileFromFile,
  saveProfileToFile,
  setDefaultProfile,
  validateProfileName,
} from '../config/auth.js';
import { extractCodePenOwnerFromUrl, findProject } from '../config/project.js';
import { openBrowser } from '../utils/browser.js';
import { fmt, formatTable } from '../utils/format.js';
import { isInteractive, promptConfirm, promptSecret, promptSelect, promptText } from '../utils/prompts.js';
import { getGlobalProfileOption } from './auth-context.js';

async function verifyKeyForStatus(apiKey: string): Promise<{ ok: boolean; detail: string }> {
  const client = new CodePenClient({ apiKey });
  try {
    await client.verifyAuth();
    return {
      ok: true,
      detail: `${fmt.green('Valid')} ${fmt.dim('(verified with api.codepen.io/v2)')}`,
    };
  } catch (error) {
    const msg = isCodePenApiError(error) ? error.message : (error as Error).message;
    return {
      ok: false,
      detail: `${fmt.red('Invalid')} — ${msg}`,
    };
  }
}

export function registerAuthCommands(program: Command): void {
  const authCmd = program
    .command('auth')
    .description('Manage CodePen API v2 authentication and profiles');

  authCmd
    .command('status')
    .description('Show loaded CodePen API keys/profiles and verify them')
    .option('--offline', 'Skip live verification against the CodePen API')
    .action(async (options: { offline?: boolean }, command: Command) => {
      const requestedProfile = getGlobalProfileOption(command);
      const envKey = process.env[API_KEY_ENV_VAR]?.trim() || '';
      const { store, filePath, insecurePermissions } = await readAuthStore();
      const profileNames = Object.keys(store.profiles).sort((a, b) => a.localeCompare(b));
      const project = await findProject(process.cwd()).catch(() => null);
      const projectProfile = project?.config.profile ?? null;

      if (requestedProfile) {
        const validName = validateProfileName(requestedProfile);
        if (!Object.hasOwn(store.profiles, validName)) {
          console.log(`${fmt.red('✗')} Profile ${fmt.bold(validName)} not found in ${filePath}.`);
          if (profileNames.length > 0) {
            console.log(fmt.dim(`  Available profiles: ${profileNames.join(', ')}`));
          }
          console.log(fmt.dim(`  Run \`cdpn auth login ${validName}\` to add it.`));
          process.exitCode = 1;
          return;
        }

        const key = store.profiles[validName]!;
        const badges: string[] = [];
        if (validName === store.defaultProfile) badges.push(fmt.cyan('default'));
        if (validName === projectProfile) badges.push(fmt.green('current folder'));
        const badgeText = badges.length > 0 ? ` ${fmt.dim(`(${badges.join(', ')})`)}` : '';

        console.log(`${fmt.green('✓')} Profile ${fmt.bold(validName)}${badgeText} from ${fmt.dim(filePath)}`);
        console.log(`  Key:  ${fmt.cyan(maskApiKey(key))} ${fmt.dim(`(${getKeyType(key)} key)`)}`);

        if (insecurePermissions) {
          console.log(
            fmt.yellow(
              `  Warning: ${filePath} is readable by other users. Tighten permissions with: chmod 600 ~/${API_KEY_FILENAME}`,
            ),
          );
        }

        if (!options.offline) {
          const check = await verifyKeyForStatus(key);
          console.log(`  API:  ${check.detail}`);
          if (!check.ok) process.exitCode = 1;
        }
        return;
      }

      if (!envKey && profileNames.length === 0) {
        console.log(`${fmt.red('✗')} Not authenticated.`);
        console.log(
          fmt.dim(
            `No API key found in ${API_KEY_ENV_VAR} or ~/${API_KEY_FILENAME}. Run \`cdpn auth login\` to get started.`,
          ),
        );
        process.exitCode = 1;
        return;
      }

      let anyInvalid = false;

      if (envKey) {
        console.log(`${fmt.green('✓')} API key loaded from ${fmt.bold(`environment variable (${API_KEY_ENV_VAR})`)}`);
        console.log(`  Key:  ${fmt.cyan(maskApiKey(envKey))} ${fmt.dim(`(${getKeyType(envKey)} key)`)}`);
        if (!options.offline) {
          const check = await verifyKeyForStatus(envKey);
          console.log(`  API:  ${check.detail}`);
          if (!check.ok) anyInvalid = true;
        }
        if (profileNames.length > 0) {
          console.log(
            fmt.dim(
              `  Note: ${API_KEY_ENV_VAR} takes precedence over ~/${API_KEY_FILENAME} unless --profile <name> is specified.\n`,
            ),
          );
        }
      }

      if (profileNames.length > 0) {
        console.log(
          `${fmt.green('✓')} Stored profiles in ${fmt.bold(filePath)} ${fmt.dim(`(${profileNames.length})`)}:`,
        );

        for (const name of profileNames) {
          const key = store.profiles[name]!;
          const badges: string[] = [];
          if (name === store.defaultProfile) badges.push(fmt.cyan('default'));
          if (name === projectProfile) badges.push(fmt.green('current folder'));
          const badgeText = badges.length > 0 ? ` ${fmt.dim(`[${badges.join(', ')}]`)}` : '';

          console.log(`  • ${fmt.bold(name)}${badgeText}`);
          console.log(`    Key: ${fmt.cyan(maskApiKey(key))} ${fmt.dim(`(${getKeyType(key)} key)`)}`);
          if (!options.offline) {
            const check = await verifyKeyForStatus(key);
            console.log(`    API: ${check.detail}`);
            if (!check.ok) anyInvalid = true;
          }
        }

        if (projectProfile && !Object.hasOwn(store.profiles, projectProfile)) {
          console.log(
            fmt.yellow(
              `\n  Warning: Current folder’s .cdpn.json references profile "${projectProfile}", which is not in ~/${API_KEY_FILENAME}.`,
            ),
          );
        }

        if (insecurePermissions) {
          console.log(
            fmt.yellow(
              `\n  Warning: ${filePath} is readable by other users. Tighten permissions with: chmod 600 ~/${API_KEY_FILENAME}`,
            ),
          );
        }
      }

      if (anyInvalid) {
        process.exitCode = 1;
      }
    });

  authCmd
    .command('list')
    .alias('ls')
    .description(`List stored CodePen profiles in ~/${API_KEY_FILENAME}`)
    .action(async () => {
      const { store, filePath, insecurePermissions } = await readAuthStore();
      const profileNames = Object.keys(store.profiles).sort((a, b) => a.localeCompare(b));
      const project = await findProject(process.cwd()).catch(() => null);
      const projectProfile = project?.config.profile ?? null;

      if (profileNames.length === 0) {
        console.log(fmt.dim(`No profiles stored in ${filePath}. Run \`cdpn auth login\` to add one.`));
        if (process.env[API_KEY_ENV_VAR]) {
          console.log(fmt.dim(`(${API_KEY_ENV_VAR} is currently set in your environment.)`));
        }
        return;
      }

      const rows = profileNames.map((name) => {
        const key = store.profiles[name]!;
        const markers: string[] = [];
        if (name === store.defaultProfile) markers.push(fmt.cyan('default'));
        if (name === projectProfile) markers.push(fmt.green('current folder'));
        return [
          fmt.bold(name),
          getKeyType(key),
          fmt.cyan(maskApiKey(key)),
          markers.length > 0 ? markers.join(', ') : fmt.dim('—'),
        ];
      });

      console.log(formatTable(['Profile', 'Type', 'Key', 'Markers'], rows));

      if (insecurePermissions) {
        console.log(
          fmt.yellow(
            `\nWarning: ${filePath} is readable by other users. Tighten permissions with: chmod 600 ~/${API_KEY_FILENAME}`,
          ),
        );
      }
    });

  authCmd
    .command('default [profile]')
    .description(`Set the default CodePen profile in ~/${API_KEY_FILENAME}`)
    .action(async (profileArg: string | undefined, _options: Record<string, unknown>, command: Command) => {
      const { store } = await readAuthStore();
      const profileNames = Object.keys(store.profiles).sort((a, b) => a.localeCompare(b));

      if (profileNames.length === 0) {
        throw new Error(`No profiles found in ~/${API_KEY_FILENAME}. Run \`cdpn auth login\` first.`);
      }

      let target = profileArg?.trim() || getGlobalProfileOption(command);
      if (!target) {
        if (!isInteractive()) {
          throw new Error(
            `Specify a profile name: \`cdpn auth default <profile>\`. Available: ${profileNames.join(', ')}`,
          );
        }
        const defaultIdx = Math.max(
          0,
          store.defaultProfile ? profileNames.indexOf(store.defaultProfile) : 0,
        );
        target = await promptSelect(
          'Select your default CodePen profile:',
          profileNames.map((name) => ({
            value: name,
            label: name,
            description: `${getKeyType(store.profiles[name]!)} · ${maskApiKey(store.profiles[name]!)}${name === store.defaultProfile ? ' · current default' : ''}`,
          })),
          defaultIdx,
        );
      }

      await setDefaultProfile(target);
      console.log(`${fmt.green('✓')} Default profile set to ${fmt.bold(target)}.`);
    });

  authCmd
    .command('login [profile]')
    .description(`Open CodePen API settings, verify a key, and save a profile to ~/${API_KEY_FILENAME}`)
    .option('--default', 'Set this profile as the default profile')
    .option('--no-open', 'Do not automatically open the browser')
    .action(
      async (
        profileArg: string | undefined,
        options: { default?: boolean; open?: boolean },
        command: Command,
      ) => {
        if (!isInteractive()) {
          throw new Error(
            `Interactive login requires a TTY. Set ${API_KEY_ENV_VAR} in your environment instead.`,
          );
        }

        const explicitProfile = profileArg?.trim() || getGlobalProfileOption(command);
        if (explicitProfile) {
          validateProfileName(explicitProfile);
        }

        if (options.open !== false) {
          console.log(`Opening ${fmt.cyan(CODEPEN_API_SETTINGS_URL)} in your browser…`);
          const launched = await openBrowser(CODEPEN_API_SETTINGS_URL);
          if (!launched) {
            console.log(
              fmt.yellow(
                `Could not launch browser automatically. Open this URL manually:\n  ${CODEPEN_API_SETTINGS_URL}`,
              ),
            );
          }
        } else {
          console.log(`Generate or reveal your API key at:\n  ${fmt.cyan(CODEPEN_API_SETTINGS_URL)}`);
        }

        console.log(fmt.dim('Click "Generate API Key" (or "Reveal") and paste it below.\n'));

        let apiKey = '';
        let detectedOwner: string | null = null;

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
            const samplePen = await client.verifyAuth();
            detectedOwner = samplePen?.urls?.editor
              ? extractCodePenOwnerFromUrl(samplePen.urls.editor)
              : null;
            console.log(fmt.green('✓ Valid!'));
            console.log(
              `Recognized ${fmt.bold(getKeyType(apiKey))} key (${fmt.cyan(maskApiKey(apiKey))})` +
                (detectedOwner ? ` ${fmt.dim(`· account: ${detectedOwner}`)}` : '') +
                '.\n',
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
              label: `Save to ~/${API_KEY_FILENAME}`,
              description: 'supports multiple profiles, written with owner-only (0600) permissions',
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
          const { store } = await readAuthStore();
          const existingNames = Object.keys(store.profiles);

          let profileName = explicitProfile ?? '';
          if (!profileName) {
            const suggested =
              detectedOwner && isValidProfileName(detectedOwner)
                ? detectedOwner
                : existingNames.length === 0
                  ? DEFAULT_PROFILE_NAME
                  : undefined;

            for (;;) {
              const entered = await promptText('Profile name', suggested);
              if (isValidProfileName(entered)) {
                profileName = entered.trim();
                break;
              }
              console.log(
                fmt.yellow(
                  'Use 1-64 characters: letters, numbers, hyphens, underscores, or dots (starting with a letter or number).',
                ),
              );
            }
          }

          const alreadyExists = Object.hasOwn(store.profiles, profileName);
          if (alreadyExists) {
            const overwrite = await promptConfirm(
              `Profile ${fmt.bold(profileName)} already exists in ~/${API_KEY_FILENAME}. Overwrite its API key?`,
              true,
            );
            if (!overwrite) {
              console.log('Aborted.');
              return;
            }
          }

          const hasOtherProfiles = existingNames.some((n) => n !== profileName);
          let setAsDefault = Boolean(options.default) || !hasOtherProfiles;
          if (!setAsDefault && store.defaultProfile !== profileName) {
            setAsDefault = await promptConfirm(
              `Set ${fmt.bold(profileName)} as your default profile?`,
              false,
            );
          }

          const saved = await saveProfileToFile(profileName, apiKey, { setAsDefault });
          const defaultNote = saved.isDefault ? ` ${fmt.cyan('(default)')}` : '';
          console.log(
            `\n${fmt.green('✓')} Saved profile ${fmt.bold(saved.profile)}${defaultNote} to ${fmt.bold(saved.filePath)} ${fmt.dim('(mode 0600)')}`,
          );

          if (process.env[API_KEY_ENV_VAR]) {
            console.log(
              fmt.yellow(
                `Note: ${API_KEY_ENV_VAR} is currently set in your shell and will take precedence over ~/${API_KEY_FILENAME} until unset (unless --profile is passed).`,
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
      },
    );

  authCmd
    .command('logout [profile]')
    .description(`Remove a stored profile or the entire ~/${API_KEY_FILENAME} file`)
    .option('--all', `Remove all stored profiles (~/${API_KEY_FILENAME})`)
    .action(
      async (
        profileArg: string | undefined,
        options: { all?: boolean },
        command: Command,
      ) => {
        const { store, exists } = await readAuthStore();
        const profileNames = Object.keys(store.profiles).sort((a, b) => a.localeCompare(b));

        if (!exists || profileNames.length === 0) {
          console.log(fmt.dim(`No ~/${API_KEY_FILENAME} file found.`));
        } else if (options.all) {
          await removeApiKeyFile();
          console.log(`${fmt.green('✓')} Removed ~/${API_KEY_FILENAME} (all profiles).`);
        } else {
          let target = profileArg?.trim() || getGlobalProfileOption(command);

          if (!target) {
            if (profileNames.length === 1) {
              await removeApiKeyFile();
              console.log(`${fmt.green('✓')} Removed profile ${fmt.bold(profileNames[0]!)} (~/${API_KEY_FILENAME}).`);
            } else if (isInteractive()) {
              const ALL_SENTINEL = '__ALL__';
              const choice = await promptSelect<string>(
                `Which profile would you like to remove from ~/${API_KEY_FILENAME}?`,
                [
                  ...profileNames.map((name) => ({
                    value: name,
                    label: name,
                    description: `${getKeyType(store.profiles[name]!)} · ${maskApiKey(store.profiles[name]!)}${name === store.defaultProfile ? ' · default' : ''}`,
                  })),
                  {
                    value: ALL_SENTINEL,
                    label: `Remove all profiles (~/${API_KEY_FILENAME})`,
                  },
                ],
                0,
              );

              if (choice === ALL_SENTINEL) {
                await removeApiKeyFile();
                console.log(`${fmt.green('✓')} Removed ~/${API_KEY_FILENAME} (all profiles).`);
              } else {
                target = choice;
              }
            } else {
              throw new Error(
                `Multiple profiles exist (${profileNames.join(', ')}). Run \`cdpn auth logout <profile>\` or \`cdpn auth logout --all\`.`,
              );
            }
          }

          if (target) {
            const result = await removeProfileFromFile(target);
            if (!result.removed) {
              console.log(fmt.yellow(`Profile "${target}" was not found in ~/${API_KEY_FILENAME}.`));
            } else if (result.remainingProfiles.length === 0) {
              console.log(`${fmt.green('✓')} Removed profile ${fmt.bold(target)} and deleted ~/${API_KEY_FILENAME}.`);
            } else {
              console.log(`${fmt.green('✓')} Removed profile ${fmt.bold(target)} from ~/${API_KEY_FILENAME}.`);
              if (result.newDefault) {
                console.log(fmt.dim(`  Default profile: ${result.newDefault}`));
              }
            }
          }
        }

        if (process.env[API_KEY_ENV_VAR]) {
          console.log(
            fmt.yellow(
              `Note: ${API_KEY_ENV_VAR} is still set in your environment. Unset it in your shell config to log out completely.`,
            ),
          );
        }
      },
    );
}
