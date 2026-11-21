import {
  API_KEY_FILENAME,
  getKeyType,
  validateProfileName,
} from '../../config/auth.js';
import { readAuthStore, setDefaultProfile } from '../../config/user-store.js';
import { CliError } from '../../errors.js';
import { fmt } from '../../utils/format.js';
import { printJsonResponse } from '../../utils/json.js';
import { defaultOutput, type CommandOutput } from '../../utils/output.js';
import { isInteractive, promptSelect, type SelectOption } from '../../utils/prompts/index.js';

export interface RunAuthDefaultOptions {
  profileArg?: string;
  explicitProfile?: string;
  json?: boolean;
  interactive?: boolean;
  homeDir?: string;
  output?: CommandOutput;
  selectProfile?: (
    question: string,
    options: SelectOption<string>[],
    defaultIndex: number,
  ) => Promise<string>;
}

export interface AuthDefaultResult {
  defaultProfile: string;
  profiles: string[];
}

export async function runAuthDefaultCommand(
  options: RunAuthDefaultOptions = {},
): Promise<AuthDefaultResult> {
  const output = options.output ?? defaultOutput;
  const interactive = !options.json && (options.interactive ?? isInteractive());
  const selectImpl = options.selectProfile ?? promptSelect;

  const { store } = await readAuthStore({ homeDir: options.homeDir });
  const profileNames = Object.keys(store.profiles).sort((a, b) => a.localeCompare(b));

  if (profileNames.length === 0) {
    throw new CliError(
      404,
      `No profiles found in ~/${API_KEY_FILENAME}. Run \`cdpn auth login\` first.`,
    );
  }

  let target = options.profileArg?.trim() || options.explicitProfile;
  if (!target) {
    if (!interactive) {
      throw new CliError(
        400,
        `Specify a profile name: \`cdpn auth default <profile>\`. Available: ${profileNames.join(', ')}`,
        { available_profiles: profileNames },
      );
    }
    const defaultIdx = Math.max(
      0,
      store.defaultProfile ? profileNames.indexOf(store.defaultProfile) : 0,
    );
    target = await selectImpl(
      'Select your default CodePen profile:',
      profileNames.map((name) => ({
        value: name,
        label: name,
        description: `${getKeyType(store.profiles[name]!)}${name === store.defaultProfile ? ' · current default' : ''}`,
      })),
      defaultIdx,
    );
  }

  const validTarget = validateProfileName(target);
  await setDefaultProfile(validTarget, { homeDir: options.homeDir });

  if (options.json) {
    printJsonResponse(
      200,
      `Default profile set to "${validTarget}".`,
      {
        default_profile: validTarget,
        profiles: profileNames,
      },
      output,
    );
    return { defaultProfile: validTarget, profiles: profileNames };
  }

  output.log(`${fmt.green('✓')} Default profile set to ${fmt.bold(validTarget)}.`);
  return { defaultProfile: validTarget, profiles: profileNames };
}
