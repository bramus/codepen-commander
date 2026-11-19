import type { Command } from 'commander';
import {
  API_KEY_ENV_VAR,
  API_KEY_FILENAME,
  findMatchingProfile,
  getKeyType,
  readAuthStore,
  validateProfileName,
  type ResolvedAuth,
} from '../config/auth.js';
import {
  PROJECT_CONFIG_FILENAME,
  writeProjectConfig,
  type ProjectLocation,
} from '../config/project.js';
import { fmt } from '../utils/format.js';
import { CliError } from '../utils/json.js';
import { isInteractive, promptSelect, type SelectOption } from '../utils/prompts.js';

export interface ResolveCommandAuthOptions {
  /** Explicit `--profile <name>` passed on the command line. */
  explicitProfile?: string;
  /** Synced project when running inside an existing Pen folder. */
  project?: ProjectLocation;
  /** Optional CodePen URL hint used to pre-select (or auto-select) a matching profile. */
  urlHint?: string;
  /**
   * When true and `urlHint` matches a stored profile name in `~/.cdpn`, automatically
   * selects that profile without prompting interactively (e.g. for `cdpn clone <url>`).
   */
  autoSelectUrlMatch?: boolean;
  /** Prompt question shown when asking the user to pick a profile. */
  promptMessage?: string;
  /**
   * When true (default) and `project` has no `profile` yet, persists the chosen
   * profile back to `.cdpn.json` so future commands don't ask again.
   */
  persistProfileToProject?: boolean;
  /** Override TTY interactivity check (e.g. false for `--json` output or tests). */
  interactive?: boolean;
  /** Injectable env map (for testing). */
  env?: NodeJS.ProcessEnv;
  /** Injectable home directory (for testing). */
  homeDir?: string;
  /** Injectable prompt implementation (for testing). */
  selectProfile?: (
    question: string,
    options: SelectOption<string>[],
    defaultIndex: number,
  ) => Promise<string>;
}

/**
 * Extracts the global `--profile <name>` option from any Commander command instance.
 */
export function getGlobalProfileOption(command?: Command): string | undefined {
  if (!command) return undefined;
  const globals = command.optsWithGlobals<{ profile?: string }>();
  const value = globals.profile?.trim();
  return value || undefined;
}

/**
 * Resolves authentication for CLI commands with full multi-profile support:
 *
 * 1. Explicit `--profile <name>` -> loads that profile from `~/.cdpn` (errors if missing).
 * 2. `CODEPEN_API_KEY` env var -> uses env key (CI / shell override).
 * 3. `project.config.profile` (from `.cdpn.json`) -> loads that profile from `~/.cdpn` (errors if missing).
 * 4. If `~/.cdpn` has 1 profile -> uses it automatically.
 * 5. If `~/.cdpn` has 2+ profiles -> prompts interactively (pre-selecting URL owner match or default),
 *    or falls back to the default profile in non-interactive mode.
 */
export async function resolveCommandAuth(
  options: ResolveCommandAuthOptions = {},
): Promise<ResolvedAuth> {
  const env = options.env ?? process.env;
  const envKey = env[API_KEY_ENV_VAR]?.trim() || '';
  const { store, filePath, insecurePermissions } = await readAuthStore({
    homeDir: options.homeDir,
  });

  const availableProfiles = Object.keys(store.profiles).sort((a, b) => a.localeCompare(b));
  const hasEnv = Boolean(envKey);
  const hasFile = availableProfiles.length > 0;
  const interactive = options.interactive ?? isInteractive();
  const selectImpl = options.selectProfile ?? promptSelect;

  const makeFileAuth = (profileName: string): ResolvedAuth => ({
    apiKey: store.profiles[profileName]!,
    source: 'file',
    profile: profileName,
    filePath,
    hasEnv,
    hasFile,
    availableProfiles,
    defaultProfile: store.defaultProfile,
    insecureFilePermissions: insecurePermissions,
  });

  // 1. Explicit --profile flag takes highest precedence
  if (options.explicitProfile) {
    const requested = validateProfileName(options.explicitProfile);
    if (!Object.hasOwn(store.profiles, requested)) {
      const availableNote =
        availableProfiles.length > 0
          ? ` Available profiles: ${availableProfiles.join(', ')}.`
          : '';
      throw new CliError(
        404,
        `Profile "${requested}" not found in ~/${API_KEY_FILENAME}.${availableNote}\n` +
          `Run \`cdpn auth login ${requested}\` to add it.`,
        { requested_profile: requested, available_profiles: availableProfiles },
      );
    }
    return makeFileAuth(requested);
  }

  // 2. Environment variable override (e.g. CI or shell export)
  if (hasEnv) {
    return {
      apiKey: envKey,
      source: 'env',
      profile: null,
      filePath,
      hasEnv,
      hasFile,
      availableProfiles,
      defaultProfile: store.defaultProfile,
      insecureFilePermissions: insecurePermissions,
    };
  }

  // 3. No stored profiles at all
  if (!hasFile) {
    throw new CliError(
      401,
      `No CodePen API key found. Run \`cdpn auth login\` or set the ${API_KEY_ENV_VAR} environment variable.`,
    );
  }

  // 4. Pen folder is already associated with a profile in .cdpn.json
  const projectProfile = options.project?.config.profile?.trim();
  if (projectProfile) {
    const validProjectProfile = validateProfileName(projectProfile);
    if (!Object.hasOwn(store.profiles, validProjectProfile)) {
      const availableNote = ` Available profiles: ${availableProfiles.join(', ')}.`;
      throw new CliError(
        404,
        `Profile "${validProjectProfile}" (configured in ${PROJECT_CONFIG_FILENAME}) was not found in ~/${API_KEY_FILENAME}.${availableNote}\n` +
          `Run \`cdpn auth login ${validProjectProfile}\` to add it, or pass \`--profile <name>\` to override.`,
        { requested_profile: validProjectProfile, available_profiles: availableProfiles },
      );
    }
    return makeFileAuth(validProjectProfile);
  }

  // 5. Pen is not associated with a profile (or command isn't tied to a Pen)
  let chosenProfile: string;

  if (availableProfiles.length === 1) {
    chosenProfile = availableProfiles[0]!;
  } else {
    const effectiveUrlHint = options.urlHint ?? options.project?.config.url;
    const matchedProfile = findMatchingProfile(availableProfiles, effectiveUrlHint);

    if (matchedProfile && (options.autoSelectUrlMatch || !interactive)) {
      chosenProfile = matchedProfile;
    } else if (interactive) {
      const preselected = matchedProfile ?? store.defaultProfile ?? availableProfiles[0]!;
      const defaultIndex = Math.max(0, availableProfiles.indexOf(preselected));

      const selectOptions: SelectOption<string>[] = availableProfiles.map((name) => {
        const key = store.profiles[name]!;
        const parts: string[] = [getKeyType(key)];
        if (name === store.defaultProfile) parts.push('default');
        if (name === matchedProfile) parts.push('matches URL');
        return {
          value: name,
          label: name,
          description: parts.join(' · '),
        };
      });

      const question =
        options.promptMessage ??
        (options.project
          ? `This Pen is not associated with a profile yet. Which profile should be used?`
          : 'Which CodePen profile should be used?');

      chosenProfile = await selectImpl(question, selectOptions, defaultIndex);
    } else if (store.defaultProfile && Object.hasOwn(store.profiles, store.defaultProfile)) {
      chosenProfile = store.defaultProfile;
    } else {
      throw new CliError(
        400,
        `Multiple profiles exist in ~/${API_KEY_FILENAME} (${availableProfiles.join(', ')}).\n` +
          'Pass `--profile <name>` or set a default profile with `cdpn auth default <name>`.',
        { available_profiles: availableProfiles },
      );
    }
  }

  // Persist chosen profile into an existing .cdpn.json that didn't have one yet
  if (options.project && !options.project.config.profile && options.persistProfileToProject !== false) {
    options.project.config.profile = chosenProfile;
    await writeProjectConfig(options.project.rootDir, options.project.config);
    if (interactive) {
      console.log(
        fmt.dim(`Associated this Pen with profile "${chosenProfile}" in ${PROJECT_CONFIG_FILENAME}.`),
      );
    }
  }

  return makeFileAuth(chosenProfile);
}
