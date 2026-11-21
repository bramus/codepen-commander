import {
  API_KEY_ENV_VAR,
  API_KEY_FILENAME,
  getKeyType,
  maskApiKey,
} from '../../config/auth.js';
import { findProject } from '../../config/project.js';
import { readAuthStore } from '../../config/user-store.js';
import { fmt, formatTable } from '../../utils/format.js';
import { printJsonResponse } from '../../utils/json.js';
import { defaultOutput, type CommandOutput } from '../../utils/output.js';

export interface RunAuthListOptions {
  json?: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  output?: CommandOutput;
}

export interface AuthListResult {
  profiles: string[];
  defaultProfile: string | null;
  projectProfile: string | null;
}

export async function runAuthListCommand(
  options: RunAuthListOptions = {},
): Promise<AuthListResult> {
  const output = options.output ?? defaultOutput;
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const { store, filePath, insecurePermissions } = await readAuthStore({
    homeDir: options.homeDir,
  });
  const profileNames = Object.keys(store.profiles).sort((a, b) => a.localeCompare(b));
  const project = await findProject(cwd).catch(() => null);
  const projectProfile = project?.config.profile ?? null;

  if (options.json) {
    const message =
      profileNames.length === 0
        ? `No profiles stored in ~/${API_KEY_FILENAME}.`
        : `Found ${profileNames.length} stored profile(s).`;
    printJsonResponse(
      200,
      message,
      {
        file_path: filePath,
        default_profile: store.defaultProfile,
        project_profile: projectProfile,
        env_var_set: Boolean(env[API_KEY_ENV_VAR]?.trim()),
        insecure_permissions: insecurePermissions,
        profiles: profileNames.map((name) => {
          const key = store.profiles[name]!;
          return {
            name,
            key_type: getKeyType(key),
            masked_key: maskApiKey(key),
            is_default: name === store.defaultProfile,
            is_project_profile: name === projectProfile,
          };
        }),
      },
      output,
    );
    return {
      profiles: profileNames,
      defaultProfile: store.defaultProfile,
      projectProfile,
    };
  }

  if (profileNames.length === 0) {
    output.log(
      fmt.dim(`No profiles stored in ${filePath}. Run \`cdpn auth login\` to add one.`),
    );
    if (env[API_KEY_ENV_VAR]) {
      output.log(fmt.dim(`(${API_KEY_ENV_VAR} is currently set in your environment.)`));
    }
    return {
      profiles: profileNames,
      defaultProfile: store.defaultProfile,
      projectProfile,
    };
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

  output.log(formatTable(['Profile', 'Type', 'Key', 'Markers'], rows));

  if (insecurePermissions) {
    output.log(
      fmt.yellow(
        `\nWarning: ${filePath} is readable by other users. Tighten permissions with: chmod 600 ~/${API_KEY_FILENAME}`,
      ),
    );
  }

  return {
    profiles: profileNames,
    defaultProfile: store.defaultProfile,
    projectProfile,
  };
}
