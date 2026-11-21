import { CodePenClient } from '../../api/client.js';
import { isCodePenApiError } from '../../api/errors.js';
import {
  API_KEY_ENV_VAR,
  API_KEY_FILENAME,
  getKeyType,
  maskApiKey,
  validateProfileName,
} from '../../config/auth.js';
import { findProject } from '../../config/project.js';
import { readAuthStore } from '../../config/user-store.js';
import { fmt } from '../../utils/format.js';
import { printJsonResponse } from '../../utils/json.js';
import { defaultOutput, type CommandOutput } from '../../utils/output.js';

export interface RunAuthStatusOptions {
  offline?: boolean;
  json?: boolean;
  requestedProfile?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  baseUrl?: string;
  output?: CommandOutput;
}

export interface AuthStatusResult {
  authenticated: boolean;
  exitCode?: number;
}

async function verifyKeyForStatus(
  apiKey: string,
  baseUrl?: string,
): Promise<{ ok: boolean; error: string | null; detail: string }> {
  const client = new CodePenClient({ apiKey, baseUrl });
  try {
    await client.verifyAuth();
    return {
      ok: true,
      error: null,
      detail: `${fmt.green('Valid')} ${fmt.dim('(verified with api.codepen.io/v2)')}`,
    };
  } catch (error) {
    const msg = isCodePenApiError(error) ? error.message : (error as Error).message;
    return {
      ok: false,
      error: msg,
      detail: `${fmt.red('Invalid')} — ${msg}`,
    };
  }
}

export async function runAuthStatusCommand(
  options: RunAuthStatusOptions = {},
): Promise<AuthStatusResult> {
  const output = options.output ?? defaultOutput;
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const requestedProfile = options.requestedProfile;
  const envKey = env[API_KEY_ENV_VAR]?.trim() || '';
  const { store, filePath, insecurePermissions } = await readAuthStore({
    homeDir: options.homeDir,
  });
  const profileNames = Object.keys(store.profiles).sort((a, b) => a.localeCompare(b));
  const project = await findProject(cwd).catch(() => null);
  const projectProfile = project?.config.profile ?? null;

  if (requestedProfile) {
    const validName = validateProfileName(requestedProfile);
    if (!Object.hasOwn(store.profiles, validName)) {
      if (options.json) {
        printJsonResponse(
          404,
          `Profile "${validName}" not found in ${filePath}.`,
          {
            authenticated: false,
            offline: Boolean(options.offline),
            requested_profile: validName,
            file_path: filePath,
            available_profiles: profileNames,
          },
          output,
        );
        return { authenticated: false, exitCode: 1 };
      }
      output.log(`${fmt.red('✗')} Profile ${fmt.bold(validName)} not found in ${filePath}.`);
      if (profileNames.length > 0) {
        output.log(fmt.dim(`  Available profiles: ${profileNames.join(', ')}`));
      }
      output.log(fmt.dim(`  Run \`cdpn auth login ${validName}\` to add it.`));
      return { authenticated: false, exitCode: 1 };
    }

    const key = store.profiles[validName]!;
    const check = options.offline ? null : await verifyKeyForStatus(key, options.baseUrl);
    const ok = check ? check.ok : true;

    if (options.json) {
      const code = ok ? 200 : 401;
      const message = options.offline
        ? `Loaded profile "${validName}" (offline mode).`
        : ok
          ? `Profile "${validName}" is valid.`
          : `Profile "${validName}" failed verification: ${check!.error}`;

      printJsonResponse(
        code,
        message,
        {
          authenticated: ok,
          offline: Boolean(options.offline),
          file_path: filePath,
          insecure_permissions: insecurePermissions,
          project_profile: projectProfile,
          profile: {
            name: validName,
            key_type: getKeyType(key),
            masked_key: maskApiKey(key),
            is_default: validName === store.defaultProfile,
            is_project_profile: validName === projectProfile,
            verified: check ? check.ok : null,
            verification_error: check ? check.error : null,
          },
        },
        output,
      );
      return ok ? { authenticated: true } : { authenticated: false, exitCode: 1 };
    }

    const badges: string[] = [];
    if (validName === store.defaultProfile) badges.push(fmt.cyan('default'));
    if (validName === projectProfile) badges.push(fmt.green('current folder'));
    const badgeText = badges.length > 0 ? ` ${fmt.dim(`(${badges.join(', ')})`)}` : '';

    output.log(
      `${fmt.green('✓')} Profile ${fmt.bold(validName)}${badgeText} from ${fmt.dim(filePath)}`,
    );
    output.log(`  Key:  ${fmt.cyan(maskApiKey(key))} ${fmt.dim(`(${getKeyType(key)} key)`)}`);

    if (insecurePermissions) {
      output.log(
        fmt.yellow(
          `  Warning: ${filePath} is readable by other users. Tighten permissions with: chmod 600 ~/${API_KEY_FILENAME}`,
        ),
      );
    }

    if (check) {
      output.log(`  API:  ${check.detail}`);
    }
    return ok ? { authenticated: true } : { authenticated: false, exitCode: 1 };
  }

  if (!envKey && profileNames.length === 0) {
    if (options.json) {
      printJsonResponse(
        401,
        `Not authenticated. No API key found in ${API_KEY_ENV_VAR} or ~/${API_KEY_FILENAME}.`,
        {
          authenticated: false,
          offline: Boolean(options.offline),
          file_path: filePath,
          insecure_permissions: insecurePermissions,
          default_profile: store.defaultProfile,
          project_profile: projectProfile,
          env: null,
          profiles: [],
        },
        output,
      );
      return { authenticated: false, exitCode: 1 };
    }
    output.log(`${fmt.red('✗')} Not authenticated.`);
    output.log(
      fmt.dim(
        `No API key found in ${API_KEY_ENV_VAR} or ~/${API_KEY_FILENAME}. Run \`cdpn auth login\` to get started.`,
      ),
    );
    return { authenticated: false, exitCode: 1 };
  }

  let anyInvalid = false;

  if (options.json) {
    let envEntry: {
      env_var: string;
      key_type: ReturnType<typeof getKeyType>;
      masked_key: string;
      verified: boolean | null;
      verification_error: string | null;
    } | null = null;

    if (envKey) {
      const check = options.offline ? null : await verifyKeyForStatus(envKey, options.baseUrl);
      if (check && !check.ok) anyInvalid = true;
      envEntry = {
        env_var: API_KEY_ENV_VAR,
        key_type: getKeyType(envKey),
        masked_key: maskApiKey(envKey),
        verified: check ? check.ok : null,
        verification_error: check ? check.error : null,
      };
    }

    const profileEntries: Array<{
      name: string;
      key_type: ReturnType<typeof getKeyType>;
      masked_key: string;
      is_default: boolean;
      is_project_profile: boolean;
      verified: boolean | null;
      verification_error: string | null;
    }> = [];

    for (const name of profileNames) {
      const key = store.profiles[name]!;
      const check = options.offline ? null : await verifyKeyForStatus(key, options.baseUrl);
      if (check && !check.ok) anyInvalid = true;
      profileEntries.push({
        name,
        key_type: getKeyType(key),
        masked_key: maskApiKey(key),
        is_default: name === store.defaultProfile,
        is_project_profile: name === projectProfile,
        verified: check ? check.ok : null,
        verification_error: check ? check.error : null,
      });
    }

    const totalCount = (envEntry ? 1 : 0) + profileEntries.length;
    const code = anyInvalid ? 401 : 200;
    const message = options.offline
      ? `Loaded ${totalCount} authentication credential(s) (offline mode).`
      : anyInvalid
        ? 'One or more CodePen API keys failed verification.'
        : 'All CodePen API keys are valid.';

    printJsonResponse(
      code,
      message,
      {
        authenticated: !anyInvalid,
        offline: Boolean(options.offline),
        file_path: filePath,
        insecure_permissions: insecurePermissions,
        default_profile: store.defaultProfile,
        project_profile: projectProfile,
        env: envEntry,
        profiles: profileEntries,
      },
      output,
    );
    return anyInvalid ? { authenticated: false, exitCode: 1 } : { authenticated: true };
  }

  if (envKey) {
    output.log(
      `${fmt.green('✓')} API key loaded from ${fmt.bold(`environment variable (${API_KEY_ENV_VAR})`)}`,
    );
    output.log(
      `  Key:  ${fmt.cyan(maskApiKey(envKey))} ${fmt.dim(`(${getKeyType(envKey)} key)`)}`,
    );
    if (!options.offline) {
      const check = await verifyKeyForStatus(envKey, options.baseUrl);
      output.log(`  API:  ${check.detail}`);
      if (!check.ok) anyInvalid = true;
    }
    if (profileNames.length > 0) {
      output.log(
        fmt.dim(
          `  Note: ${API_KEY_ENV_VAR} takes precedence over ~/${API_KEY_FILENAME} unless --profile <name> is specified.\n`,
        ),
      );
    }
  }

  if (profileNames.length > 0) {
    output.log(
      `${fmt.green('✓')} Stored profiles in ${fmt.bold(filePath)} ${fmt.dim(`(${profileNames.length})`)}:`,
    );

    for (const name of profileNames) {
      const key = store.profiles[name]!;
      const badges: string[] = [];
      if (name === store.defaultProfile) badges.push(fmt.cyan('default'));
      if (name === projectProfile) badges.push(fmt.green('current folder'));
      const badgeText = badges.length > 0 ? ` ${fmt.dim(`[${badges.join(', ')}]`)}` : '';

      output.log(`  • ${fmt.bold(name)}${badgeText}`);
      output.log(`    Key: ${fmt.cyan(maskApiKey(key))} ${fmt.dim(`(${getKeyType(key)} key)`)}`);
      if (!options.offline) {
        const check = await verifyKeyForStatus(key, options.baseUrl);
        output.log(`    API: ${check.detail}`);
        if (!check.ok) anyInvalid = true;
      }
    }

    if (projectProfile && !Object.hasOwn(store.profiles, projectProfile)) {
      output.log(
        fmt.yellow(
          `\n  Warning: Current folder’s .cdpn.json references profile "${projectProfile}", which is not in ~/${API_KEY_FILENAME}.`,
        ),
      );
    }

    if (insecurePermissions) {
      output.log(
        fmt.yellow(
          `\n  Warning: ${filePath} is readable by other users. Tighten permissions with: chmod 600 ~/${API_KEY_FILENAME}`,
        ),
      );
    }
  }

  return anyInvalid ? { authenticated: false, exitCode: 1 } : { authenticated: true };
}
