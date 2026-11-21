import {
  API_KEY_ENV_VAR,
  API_KEY_FILENAME,
  getKeyType,
} from '../../config/auth.js';
import {
  clearAllProfilesFromFile,
  readAuthStore,
  removeProfileFromFile,
} from '../../config/user-store.js';
import { CliError } from '../../errors.js';
import { fmt } from '../../utils/format.js';
import { printJsonResponse } from '../../utils/json.js';
import { defaultOutput, type CommandOutput } from '../../utils/output.js';
import { isInteractive, promptSelect, type SelectOption } from '../../utils/prompts/index.js';

export interface RunAuthLogoutOptions {
  profileArg?: string;
  explicitProfile?: string;
  all?: boolean;
  json?: boolean;
  interactive?: boolean;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  output?: CommandOutput;
  selectProfile?: (
    question: string,
    options: SelectOption<string>[],
    defaultIndex: number,
  ) => Promise<string>;
}

export interface AuthLogoutResult {
  removed: boolean;
  removedProfiles: string[];
  remainingProfiles: string[];
  exitCode?: number;
}

export async function runAuthLogoutCommand(
  options: RunAuthLogoutOptions = {},
): Promise<AuthLogoutResult> {
  const output = options.output ?? defaultOutput;
  const env = options.env ?? process.env;
  const interactive = !options.json && (options.interactive ?? isInteractive());
  const selectImpl = options.selectProfile ?? promptSelect;

  const { store, exists } = await readAuthStore({ homeDir: options.homeDir });
  const profileNames = Object.keys(store.profiles).sort((a, b) => a.localeCompare(b));
  const envVarStillSet = Boolean(env[API_KEY_ENV_VAR]);
  const explicitTarget = options.profileArg?.trim() || options.explicitProfile;

  let removed = false;
  let removedProfiles: string[] = [];
  let remainingProfiles: string[] = [...profileNames];

  if (!exists || profileNames.length === 0) {
    if (options.json) {
      if (explicitTarget && !options.all) {
        printJsonResponse(
          404,
          `Profile "${explicitTarget}" was not found in ~/${API_KEY_FILENAME}.`,
          {
            removed: false,
            removed_profiles: [],
            remaining_profiles: [],
            default_profile: null,
            file_deleted: false,
            env_var_still_set: envVarStillSet,
          },
          output,
        );
        return { removed: false, removedProfiles: [], remainingProfiles: [], exitCode: 1 };
      }
      printJsonResponse(
        200,
        `No ~/${API_KEY_FILENAME} file found.`,
        {
          removed: false,
          removed_profiles: [],
          remaining_profiles: [],
          default_profile: null,
          file_deleted: false,
          env_var_still_set: envVarStillSet,
        },
        output,
      );
      return { removed: false, removedProfiles: [], remainingProfiles: [] };
    }
    output.log(fmt.dim(`No ~/${API_KEY_FILENAME} file found.`));
  } else if (options.all) {
    const cleared = await clearAllProfilesFromFile({ homeDir: options.homeDir });
    const msg = cleared.fileDeleted
      ? `Removed ~/${API_KEY_FILENAME} (all profiles).`
      : `Removed all profiles from ~/${API_KEY_FILENAME} (kept global config).`;
    removed = true;
    removedProfiles = [...profileNames];
    remainingProfiles = [];
    if (options.json) {
      printJsonResponse(
        200,
        msg,
        {
          removed: true,
          removed_profiles: profileNames,
          remaining_profiles: [],
          default_profile: null,
          file_deleted: cleared.fileDeleted,
          env_var_still_set: envVarStillSet,
        },
        output,
      );
      return { removed, removedProfiles, remainingProfiles };
    }
    output.log(`${fmt.green('✓')} ${msg}`);
  } else {
    let target = explicitTarget;

    if (!target) {
      if (profileNames.length === 1) {
        const cleared = await clearAllProfilesFromFile({ homeDir: options.homeDir });
        const msg = cleared.fileDeleted
          ? `Removed profile ${profileNames[0]!} (~/${API_KEY_FILENAME}).`
          : `Removed profile ${profileNames[0]!} from ~/${API_KEY_FILENAME} (kept global config).`;
        removed = true;
        removedProfiles = [profileNames[0]!];
        remainingProfiles = [];
        if (options.json) {
          printJsonResponse(
            200,
            msg,
            {
              removed: true,
              removed_profiles: [profileNames[0]!],
              remaining_profiles: [],
              default_profile: null,
              file_deleted: cleared.fileDeleted,
              env_var_still_set: envVarStillSet,
            },
            output,
          );
          return { removed, removedProfiles, remainingProfiles };
        }
        output.log(
          cleared.fileDeleted
            ? `${fmt.green('✓')} Removed profile ${fmt.bold(profileNames[0]!)} (~/${API_KEY_FILENAME}).`
            : `${fmt.green('✓')} Removed profile ${fmt.bold(profileNames[0]!)} from ~/${API_KEY_FILENAME} ${fmt.dim('(kept global config)')}.`,
        );
      } else if (interactive) {
        const ALL_SENTINEL = '__ALL__';
        const choice = await selectImpl(
          `Which profile would you like to remove from ~/${API_KEY_FILENAME}?`,
          [
            ...profileNames.map((name) => ({
              value: name,
              label: name,
              description: `${getKeyType(store.profiles[name]!)}${name === store.defaultProfile ? ' · default' : ''}`,
            })),
            {
              value: ALL_SENTINEL,
              label: `Remove all profiles (~/${API_KEY_FILENAME})`,
            },
          ],
          0,
        );

        if (choice === ALL_SENTINEL) {
          const cleared = await clearAllProfilesFromFile({ homeDir: options.homeDir });
          removed = true;
          removedProfiles = [...profileNames];
          remainingProfiles = [];
          output.log(
            cleared.fileDeleted
              ? `${fmt.green('✓')} Removed ~/${API_KEY_FILENAME} (all profiles).`
              : `${fmt.green('✓')} Removed all profiles from ~/${API_KEY_FILENAME} ${fmt.dim('(kept global config)')}.`,
          );
        } else {
          target = choice;
        }
      } else {
        throw new CliError(
          400,
          `Multiple profiles exist (${profileNames.join(', ')}). Run \`cdpn auth logout <profile>\` or \`cdpn auth logout --all\`.`,
          { available_profiles: profileNames },
        );
      }
    }

    if (target) {
      const result = await removeProfileFromFile(target, { homeDir: options.homeDir });
      const remaining = [...result.remainingProfiles].sort((a, b) => a.localeCompare(b));
      remainingProfiles = remaining;

      if (!result.removed) {
        if (options.json) {
          printJsonResponse(
            404,
            `Profile "${target}" was not found in ~/${API_KEY_FILENAME}.`,
            {
              removed: false,
              removed_profiles: [],
              remaining_profiles: remaining,
              default_profile: result.newDefault,
              file_deleted: false,
              env_var_still_set: envVarStillSet,
            },
            output,
          );
          return { removed: false, removedProfiles: [], remainingProfiles: remaining, exitCode: 1 };
        }
        output.log(fmt.yellow(`Profile "${target}" was not found in ~/${API_KEY_FILENAME}.`));
      } else if (remaining.length === 0) {
        removed = true;
        removedProfiles = [target];
        const msg = result.fileDeleted
          ? `Removed profile ${target} and deleted ~/${API_KEY_FILENAME}.`
          : `Removed profile ${target} from ~/${API_KEY_FILENAME} (kept global config).`;
        if (options.json) {
          printJsonResponse(
            200,
            msg,
            {
              removed: true,
              removed_profiles: [target],
              remaining_profiles: [],
              default_profile: null,
              file_deleted: result.fileDeleted,
              env_var_still_set: envVarStillSet,
            },
            output,
          );
          return { removed, removedProfiles, remainingProfiles };
        }
        output.log(
          result.fileDeleted
            ? `${fmt.green('✓')} Removed profile ${fmt.bold(target)} and deleted ~/${API_KEY_FILENAME}.`
            : `${fmt.green('✓')} Removed profile ${fmt.bold(target)} from ~/${API_KEY_FILENAME} ${fmt.dim('(kept global config)')}.`,
        );
      } else {
        removed = true;
        removedProfiles = [target];
        if (options.json) {
          printJsonResponse(
            200,
            `Removed profile ${target} from ~/${API_KEY_FILENAME}.`,
            {
              removed: true,
              removed_profiles: [target],
              remaining_profiles: remaining,
              default_profile: result.newDefault,
              file_deleted: false,
              env_var_still_set: envVarStillSet,
            },
            output,
          );
          return { removed, removedProfiles, remainingProfiles };
        }
        output.log(`${fmt.green('✓')} Removed profile ${fmt.bold(target)} from ~/${API_KEY_FILENAME}.`);
        if (result.newDefault) {
          output.log(fmt.dim(`  Default profile: ${result.newDefault}`));
        }
      }
    }
  }

  if (envVarStillSet) {
    output.log(
      fmt.yellow(
        `Note: ${API_KEY_ENV_VAR} is still set in your environment. Unset it in your shell config to log out completely.`,
      ),
    );
  }

  return { removed, removedProfiles, remainingProfiles };
}
