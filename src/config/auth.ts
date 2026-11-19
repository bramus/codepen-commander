import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const CODEPEN_API_SETTINGS_URL = 'https://codepen.io/settings/api';
export const API_KEY_ENV_VAR = 'CODEPEN_API_KEY';
export const API_KEY_FILENAME = '.codepen';

export type AuthSource = 'env' | 'file';
export type ApiKeyType = 'User' | 'Team' | 'Unknown';

export interface ResolvedAuth {
  apiKey: string;
  source: AuthSource;
  filePath: string;
  hasEnv: boolean;
  hasFile: boolean;
  insecureFilePermissions: boolean;
}

export interface AuthOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

export function getApiKeyFilePath(homeDir?: string): string {
  return path.join(homeDir ?? os.homedir(), API_KEY_FILENAME);
}

export function getKeyType(apiKey: string): ApiKeyType {
  if (apiKey.startsWith('cp_user_')) return 'User';
  if (apiKey.startsWith('cp_team_')) return 'Team';
  return 'Unknown';
}

export function isRecognizedKeyFormat(apiKey: string): boolean {
  const trimmed = apiKey.trim();
  return (trimmed.startsWith('cp_user_') || trimmed.startsWith('cp_team_')) && trimmed.length >= 16;
}

/**
 * Masks an API key so the full secret is never printed to terminal output or logs.
 */
export function maskApiKey(apiKey: string): string {
  const trimmed = apiKey.trim();
  if (trimmed.length <= 8) {
    return '********';
  }
  const suffix = trimmed.slice(-4);
  if (trimmed.startsWith('cp_user_')) {
    return `cp_user_••••••••${suffix}`;
  }
  if (trimmed.startsWith('cp_team_')) {
    return `cp_team_••••••••${suffix}`;
  }
  return `••••••••${suffix}`;
}

/**
 * Parses an API key from `~/.codepen`, supporting:
 * - Plain raw key (`cp_user_...`)
 * - Env assignment (`CODEPEN_API_KEY=...` or `export CODEPEN_API_KEY="..."`)
 * - JSON object (`{ "api_key": "..." }`, `{ "key": "..." }`, or `{ "token": "..." }`)
 */
export function parseKeyFileContent(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      for (const field of ['api_key', 'apiKey', 'key', 'token']) {
        const value = parsed[field];
        if (typeof value === 'string' && value.trim()) {
          return value.trim();
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  for (const line of trimmed.split(/\r?\n/)) {
    const cleanLine = line.trim();
    if (!cleanLine || cleanLine.startsWith('#')) continue;

    const envMatch = cleanLine.match(/^(?:export\s+)?CODEPEN_API_KEY\s*=\s*(.+)$/);
    if (envMatch?.[1]) {
      const val = envMatch[1].trim().replace(/^['"]|['"]$/g, '').trim();
      if (val) return val;
    }

    return cleanLine.replace(/^['"]|['"]$/g, '').trim();
  }

  return null;
}

export async function readApiKeyFile(
  options: Pick<AuthOptions, 'homeDir'> = {},
): Promise<{ apiKey: string | null; filePath: string; exists: boolean; insecurePermissions: boolean }> {
  const filePath = getApiKeyFilePath(options.homeDir);

  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile()) {
      return { apiKey: null, filePath, exists: false, insecurePermissions: false };
    }
    const content = await fs.readFile(filePath, 'utf8');
    const insecurePermissions = process.platform !== 'win32' && (stat.mode & 0o077) !== 0;
    return {
      apiKey: parseKeyFileContent(content),
      filePath,
      exists: true,
      insecurePermissions,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { apiKey: null, filePath, exists: false, insecurePermissions: false };
    }
    throw error;
  }
}

export async function resolveAuth(options: AuthOptions = {}): Promise<ResolvedAuth | null> {
  const env = options.env ?? process.env;
  const envKey = env[API_KEY_ENV_VAR]?.trim() || '';
  const fileInfo = await readApiKeyFile({ homeDir: options.homeDir });

  const hasEnv = Boolean(envKey);
  const hasFile = Boolean(fileInfo.apiKey);

  if (hasEnv) {
    return {
      apiKey: envKey,
      source: 'env',
      filePath: fileInfo.filePath,
      hasEnv,
      hasFile,
      insecureFilePermissions: fileInfo.insecurePermissions,
    };
  }

  if (fileInfo.apiKey) {
    return {
      apiKey: fileInfo.apiKey,
      source: 'file',
      filePath: fileInfo.filePath,
      hasEnv,
      hasFile,
      insecureFilePermissions: fileInfo.insecurePermissions,
    };
  }

  return null;
}

export async function requireAuth(options: AuthOptions = {}): Promise<ResolvedAuth> {
  const auth = await resolveAuth(options);
  if (!auth) {
    throw new Error(
      `No CodePen API key found. Run \`cdpn auth login\` or set the ${API_KEY_ENV_VAR} environment variable.`,
    );
  }
  return auth;
}

/**
 * Persists the API key to `~/.codepen` with strict owner-only (`0o600`) file permissions.
 */
export async function saveApiKeyToFile(
  apiKey: string,
  options: Pick<AuthOptions, 'homeDir'> = {},
): Promise<string> {
  const trimmed = apiKey.trim();
  if (!trimmed) {
    throw new Error('Cannot save an empty API key.');
  }

  const filePath = getApiKeyFilePath(options.homeDir);
  await fs.writeFile(filePath, `${trimmed}\n`, { encoding: 'utf8', mode: 0o600 });
  if (process.platform !== 'win32') {
    await fs.chmod(filePath, 0o600);
  }
  return filePath;
}

export async function removeApiKeyFile(options: Pick<AuthOptions, 'homeDir'> = {}): Promise<boolean> {
  const filePath = getApiKeyFilePath(options.homeDir);
  try {
    await fs.unlink(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

export interface ShellSnippet {
  shell: string;
  rcFile: string;
  line: string;
}

export function getShellExportSnippets(apiKey: string, shellPath = process.env.SHELL ?? ''): ShellSnippet[] {
  const escapedPosix = apiKey.replaceAll("'", "'\\''");
  const all: ShellSnippet[] = [
    {
      shell: 'zsh',
      rcFile: '~/.zshrc',
      line: `export ${API_KEY_ENV_VAR}='${escapedPosix}'`,
    },
    {
      shell: 'bash',
      rcFile: '~/.bashrc',
      line: `export ${API_KEY_ENV_VAR}='${escapedPosix}'`,
    },
    {
      shell: 'fish',
      rcFile: '~/.config/fish/config.fish',
      line: `set -gx ${API_KEY_ENV_VAR} '${escapedPosix}'`,
    },
  ];

  const base = path.basename(shellPath).toLowerCase();
  const preferredIdx = all.findIndex((s) => s.shell === base);
  if (preferredIdx > 0) {
    const [preferred] = all.splice(preferredIdx, 1);
    if (preferred) all.unshift(preferred);
  }
  return all;
}
