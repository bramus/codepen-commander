import { CodePenClient } from '../../api/client.js';
import { isCodePenApiError } from '../../api/errors.js';
import {
  API_KEY_ENV_VAR,
  API_KEY_FILENAME,
  DEFAULT_PROFILE_NAME,
  getKeyType,
  getShellExportSnippets,
  isRecognizedKeyFormat,
  isValidProfileName,
  maskApiKey,
  validateProfileName,
} from '../../config/auth.js';
import { readAuthStore, saveProfileToFile } from '../../config/user-store.js';
import { CODEPEN_API_SETTINGS_URL } from '../../constants.js';
import { CliError } from '../../errors.js';
import { openBrowser } from '../../utils/browser.js';
import { extractCodePenOwnerFromUrl } from '../../utils/codepen-url.js';
import { fmt } from '../../utils/format.js';
import { defaultOutput, type CommandOutput } from '../../utils/output.js';
import {
  isInteractive,
  promptConfirm,
  promptSecret,
  promptSelect,
  promptText,
  type SelectOption,
} from '../../utils/prompts/index.js';

export interface RunAuthLoginOptions {
  profileArg?: string;
  explicitProfile?: string;
  default?: boolean;
  open?: boolean;
  interactive?: boolean;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  baseUrl?: string;
  output?: CommandOutput;
  openBrowser?: (url: string) => Promise<boolean>;
  prompts?: {
    secret?: (question: string) => Promise<string>;
    confirm?: (question: string, defaultYes?: boolean) => Promise<boolean>;
    text?: (question: string, defaultValue?: string) => Promise<string>;
    select?: <T extends string>(
      question: string,
      options: SelectOption<T>[],
      defaultIndex?: number,
    ) => Promise<T>;
  };
}

export interface AuthLoginResult {
  saved: boolean;
  storage?: 'file' | 'env';
  profile?: string;
  exitCode?: number;
}

export async function runAuthLoginCommand(
  options: RunAuthLoginOptions = {},
): Promise<AuthLoginResult> {
  const output = options.output ?? defaultOutput;
  const env = options.env ?? process.env;
  const interactive = options.interactive ?? isInteractive();
  const secretImpl = options.prompts?.secret ?? promptSecret;
  const confirmImpl = options.prompts?.confirm ?? promptConfirm;
  const textImpl = options.prompts?.text ?? promptText;
  const selectImpl = options.prompts?.select ?? promptSelect;
  const openImpl = options.openBrowser ?? openBrowser;

  if (!interactive) {
    throw new CliError(
      400,
      `Interactive login requires a TTY. Set ${API_KEY_ENV_VAR} in your environment instead.`,
    );
  }

  const explicitProfile = options.profileArg?.trim() || options.explicitProfile;
  if (explicitProfile) {
    validateProfileName(explicitProfile);
  }

  if (options.open !== false) {
    output.log(`Opening ${fmt.cyan(CODEPEN_API_SETTINGS_URL)} in your browser…`);
    const launched = await openImpl(CODEPEN_API_SETTINGS_URL);
    if (!launched) {
      output.log(
        fmt.yellow(
          `Could not launch browser automatically. Open this URL manually:\n  ${CODEPEN_API_SETTINGS_URL}`,
        ),
      );
    }
  } else {
    output.log(`Generate or reveal your API key at:\n  ${fmt.cyan(CODEPEN_API_SETTINGS_URL)}`);
  }

  output.log(fmt.dim('Click "Generate API Key" (or "Reveal") and paste it below.\n'));

  let apiKey = '';
  let detectedOwner: string | null = null;

  for (;;) {
    apiKey = await secretImpl('CodePen API key');
    if (!apiKey) {
      output.log(fmt.yellow('API key cannot be empty.'));
      continue;
    }

    if (!isRecognizedKeyFormat(apiKey)) {
      output.log(
        fmt.yellow('Heads up: CodePen API v2 keys usually start with `cp_user_` or `cp_team_`.'),
      );
    }

    output.write('Verifying key with CodePen API v2… ');
    const client = new CodePenClient({ apiKey, baseUrl: options.baseUrl });
    try {
      const samplePen = await client.verifyAuth();
      detectedOwner = samplePen?.urls?.editor
        ? extractCodePenOwnerFromUrl(samplePen.urls.editor)
        : null;
      output.log(fmt.green('✓ Valid!'));
      output.log(
        `Recognized ${fmt.bold(getKeyType(apiKey))} key (${fmt.cyan(maskApiKey(apiKey))})` +
          (detectedOwner ? ` ${fmt.dim(`· account: ${detectedOwner}`)}` : '') +
          '.\n',
      );
      break;
    } catch (error) {
      output.log(fmt.red('✗ Failed'));
      const msg = isCodePenApiError(error) ? error.message : (error as Error).message;
      output.log(fmt.red(`  ${msg}`));
      const retry = await confirmImpl('Try entering a different key?', true);
      if (!retry) {
        return { saved: false, exitCode: 1 };
      }
    }
  }

  const storageChoice = await selectImpl<'file' | 'env'>(
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
    const { store } = await readAuthStore({ homeDir: options.homeDir });
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
        const entered = await textImpl('Profile name', suggested);
        if (isValidProfileName(entered)) {
          profileName = entered.trim();
          break;
        }
        output.log(
          fmt.yellow(
            'Use 1-64 characters: letters, numbers, hyphens, underscores, or dots (starting with a letter or number).',
          ),
        );
      }
    }

    const alreadyExists = Object.hasOwn(store.profiles, profileName);
    if (alreadyExists) {
      const overwrite = await confirmImpl(
        `Profile ${fmt.bold(profileName)} already exists in ~/${API_KEY_FILENAME}. Overwrite its API key?`,
        true,
      );
      if (!overwrite) {
        output.log('Aborted.');
        return { saved: false };
      }
    }

    const hasOtherProfiles = existingNames.some((n) => n !== profileName);
    let setAsDefault = Boolean(options.default) || !hasOtherProfiles;
    if (!setAsDefault && store.defaultProfile !== profileName) {
      setAsDefault = await confirmImpl(
        `Set ${fmt.bold(profileName)} as your default profile?`,
        false,
      );
    }

    const saved = await saveProfileToFile(profileName, apiKey, {
      setAsDefault,
      homeDir: options.homeDir,
    });
    const defaultNote = saved.isDefault ? ` ${fmt.cyan('(default)')}` : '';
    output.log(
      `\n${fmt.green('✓')} Saved profile ${fmt.bold(saved.profile)}${defaultNote} to ${fmt.bold(saved.filePath)} ${fmt.dim('(mode 0600)')}`,
    );

    if (env[API_KEY_ENV_VAR]) {
      output.log(
        fmt.yellow(
          `Note: ${API_KEY_ENV_VAR} is currently set in your shell and will take precedence over ~/${API_KEY_FILENAME} until unset (unless --profile is passed).`,
        ),
      );
    }

    return { saved: true, storage: 'file', profile: saved.profile };
  }

  const snippets = getShellExportSnippets(apiKey);
  output.log('\nAdd the appropriate line to your shell configuration file:\n');
  for (const snippet of snippets) {
    output.log(`  ${fmt.bold(snippet.shell)} ${fmt.dim(`(${snippet.rcFile})`)}:`);
    output.log(`    ${fmt.cyan(snippet.line)}\n`);
  }
  output.log(
    fmt.dim('Then reload your shell (e.g. `source ~/.zshrc`) and run `cdpn auth status` to verify.'),
  );
  return { saved: true, storage: 'env' };
}
