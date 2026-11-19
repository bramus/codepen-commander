import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CliError } from '../utils/json.js';
import { extractCodePenOwnerFromUrl } from './project.js';

export const CODEPEN_API_SETTINGS_URL = 'https://codepen.io/settings/api';
export const API_KEY_ENV_VAR = 'CODEPEN_API_KEY';
export const API_KEY_FILENAME = '.cdpn';
export const DEFAULT_PROFILE_NAME = 'default';

const FORBIDDEN_PROFILE_NAMES = new Set(['__proto__', 'constructor', 'prototype']);
const PROFILE_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const SINGLE_KEY_FIELDS = ['api_key', 'apiKey', 'key', 'token'] as const;

export type AuthSource = 'env' | 'file';
export type ApiKeyType = 'User' | 'Team' | 'Unknown';

export interface AuthStore {
  defaultProfile: string | null;
  profiles: Record<string, string>;
}

export interface ReadAuthStoreResult {
  store: AuthStore;
  filePath: string;
  exists: boolean;
  insecurePermissions: boolean;
}

export interface ResolvedAuth {
  apiKey: string;
  source: AuthSource;
  /** Stored profile name (e.g. `bramus` or `username`), or `null` when resolved from `CODEPEN_API_KEY`. */
  profile: string | null;
  filePath: string;
  hasEnv: boolean;
  hasFile: boolean;
  availableProfiles: string[];
  defaultProfile: string | null;
  insecureFilePermissions: boolean;
}

export interface AuthOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  profile?: string;
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

export function isValidProfileName(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return false;
  if (FORBIDDEN_PROFILE_NAMES.has(trimmed.toLowerCase())) return false;
  return PROFILE_NAME_PATTERN.test(trimmed);
}

export function validateProfileName(name: string): string {
  const trimmed = name.trim();
  if (!isValidProfileName(trimmed)) {
    throw new CliError(
      400,
      `Invalid profile name "${name}". Use 1-64 characters: letters, numbers, hyphens, underscores, or dots (starting with a letter or number).`,
    );
  }
  return trimmed;
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

function extractKeyFromValue(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const field of SINGLE_KEY_FIELDS) {
      const candidate = obj[field];
      if (typeof candidate === 'string' && candidate.trim()) {
        return candidate.trim();
      }
    }
  }
  return null;
}

function createEmptyStore(): AuthStore {
  return {
    defaultProfile: null,
    profiles: Object.create(null) as Record<string, string>,
  };
}

/**
 * Parses `~/.cdpn` content into a normalized multi-profile `AuthStore`.
 *
 * Supported formats:
 * - Multi-profile JSON (canonical format written by `cdpn auth login`):
 *   `{ "default": "bramus", "profiles": { "bramus": "cp_user_...", "username": "cp_team_..." } }`
 * - Flat JSON map of profile names to API keys:
 *   `{ "bramus": "cp_user_...", "username": "cp_team_..." }`
 * - Single-key JSON (`{ "api_key": "..." }`, `{ "key": "..." }`, `{ "token": "..." }`)
 * - Plain raw key (`cp_user_...`) or env assignment (`export CODEPEN_API_KEY="..."`)
 */
export function parseAuthStoreContent(raw: string): AuthStore {
  const trimmed = raw.trim();
  if (!trimmed) {
    return createEmptyStore();
  }

  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return createEmptyStore();
      }
      const record = parsed as Record<string, unknown>;
      const profiles: Record<string, string> = Object.create(null) as Record<string, string>;

      // Format 1: { "default": "...", "profiles": { "bramus": "cp_user_...", ... } }
      if (record.profiles && typeof record.profiles === 'object' && !Array.isArray(record.profiles)) {
        for (const [name, entry] of Object.entries(record.profiles as Record<string, unknown>)) {
          if (!isValidProfileName(name)) continue;
          const key = extractKeyFromValue(entry);
          if (key) {
            profiles[name.trim()] = key;
          }
        }

        const profileNames = Object.keys(profiles);
        const rawDefault =
          typeof record.default === 'string'
            ? record.default.trim()
            : typeof record.defaultProfile === 'string'
              ? record.defaultProfile.trim()
              : typeof record.default_profile === 'string'
                ? record.default_profile.trim()
                : '';

        const defaultProfile =
          rawDefault && Object.hasOwn(profiles, rawDefault)
            ? rawDefault
            : (profileNames[0] ?? null);

        return { defaultProfile, profiles };
      }

      // Format 2: Single-key JSON ({ "api_key": "..." })
      for (const field of SINGLE_KEY_FIELDS) {
        const value = record[field];
        if (typeof value === 'string' && value.trim()) {
          profiles[DEFAULT_PROFILE_NAME] = value.trim();
          return { defaultProfile: DEFAULT_PROFILE_NAME, profiles };
        }
      }

      // Format 3: Flat map JSON ({ "bramus": "cp_user_...", "username": "cp_team_..." })
      const metaKeys = new Set(['default', 'defaultProfile', 'default_profile']);
      for (const [name, entry] of Object.entries(record)) {
        if (metaKeys.has(name) || !isValidProfileName(name)) continue;
        const key = extractKeyFromValue(entry);
        if (key) {
          profiles[name.trim()] = key;
        }
      }

      const profileNames = Object.keys(profiles);
      if (profileNames.length > 0) {
        const rawDefault = typeof record.default === 'string' ? record.default.trim() : '';
        const defaultProfile =
          rawDefault && Object.hasOwn(profiles, rawDefault)
            ? rawDefault
            : (profileNames[0] ?? null);
        return { defaultProfile, profiles };
      }

      return createEmptyStore();
    } catch {
      return createEmptyStore();
    }
  }

  // Format 4: Plain key or env assignment line
  for (const line of trimmed.split(/\r?\n/)) {
    const cleanLine = line.trim();
    if (!cleanLine || cleanLine.startsWith('#')) continue;

    const envMatch = cleanLine.match(/^(?:export\s+)?CODEPEN_API_KEY\s*=\s*(.+)$/);
    const key = envMatch?.[1]
      ? envMatch[1].trim().replace(/^['"]|['"]$/g, '').trim()
      : cleanLine.replace(/^['"]|['"]$/g, '').trim();

    if (key) {
      const profiles: Record<string, string> = Object.create(null) as Record<string, string>;
      profiles[DEFAULT_PROFILE_NAME] = key;
      return { defaultProfile: DEFAULT_PROFILE_NAME, profiles };
    }
  }

  return createEmptyStore();
}

/**
 * Extracts the default (or sole) API key from `~/.cdpn` content.
 */
export function parseKeyFileContent(raw: string): string | null {
  const store = parseAuthStoreContent(raw);
  if (store.defaultProfile && Object.hasOwn(store.profiles, store.defaultProfile)) {
    return store.profiles[store.defaultProfile] ?? null;
  }
  const first = Object.keys(store.profiles)[0];
  return first ? (store.profiles[first] ?? null) : null;
}

export async function readAuthStore(
  options: Pick<AuthOptions, 'homeDir'> = {},
): Promise<ReadAuthStoreResult> {
  const filePath = getApiKeyFilePath(options.homeDir);

  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile()) {
      return {
        store: createEmptyStore(),
        filePath,
        exists: false,
        insecurePermissions: false,
      };
    }
    const content = await fs.readFile(filePath, 'utf8');
    const insecurePermissions = process.platform !== 'win32' && (stat.mode & 0o077) !== 0;
    return {
      store: parseAuthStoreContent(content),
      filePath,
      exists: true,
      insecurePermissions,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        store: createEmptyStore(),
        filePath,
        exists: false,
        insecurePermissions: false,
      };
    }
    throw error;
  }
}

export async function readApiKeyFile(
  options: Pick<AuthOptions, 'homeDir'> = {},
): Promise<{ apiKey: string | null; filePath: string; exists: boolean; insecurePermissions: boolean }> {
  const result = await readAuthStore(options);
  const { store } = result;
  const activeProfile = store.defaultProfile ?? Object.keys(store.profiles)[0] ?? null;
  const apiKey = activeProfile && Object.hasOwn(store.profiles, activeProfile)
    ? (store.profiles[activeProfile] ?? null)
    : null;

  return {
    apiKey,
    filePath: result.filePath,
    exists: result.exists,
    insecurePermissions: result.insecurePermissions,
  };
}

/**
 * Writes the multi-profile store to `~/.cdpn` with strict owner-only (`0o600`) file permissions.
 */
export async function writeAuthStore(
  store: AuthStore,
  options: Pick<AuthOptions, 'homeDir'> = {},
): Promise<string> {
  const filePath = getApiKeyFilePath(options.homeDir);

  const sortedProfiles: Record<string, string> = {};
  for (const name of Object.keys(store.profiles).sort((a, b) => a.localeCompare(b))) {
    const validName = validateProfileName(name);
    const key = store.profiles[name]?.trim();
    if (key) {
      sortedProfiles[validName] = key;
    }
  }

  const names = Object.keys(sortedProfiles);
  const resolvedDefault =
    store.defaultProfile && Object.hasOwn(sortedProfiles, store.defaultProfile)
      ? store.defaultProfile
      : (names[0] ?? null);

  const payload = {
    ...(resolvedDefault ? { default: resolvedDefault } : {}),
    profiles: sortedProfiles,
  };

  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  if (process.platform !== 'win32') {
    await fs.chmod(filePath, 0o600);
  }
  return filePath;
}

/**
 * Adds or updates a named profile inside `~/.cdpn` (creating the file with `0o600` permissions).
 */
export async function saveProfileToFile(
  profileName: string,
  apiKey: string,
  options: { homeDir?: string; setAsDefault?: boolean } = {},
): Promise<{ filePath: string; profile: string; isDefault: boolean }> {
  const validProfile = validateProfileName(profileName);
  const trimmedKey = apiKey.trim();
  if (!trimmedKey) {
    throw new CliError(400, 'Cannot save an empty API key.');
  }

  const { store } = await readAuthStore({ homeDir: options.homeDir });
  store.profiles[validProfile] = trimmedKey;

  const hasValidDefault = Boolean(
    store.defaultProfile && Object.hasOwn(store.profiles, store.defaultProfile),
  );
  if (options.setAsDefault || !hasValidDefault) {
    store.defaultProfile = validProfile;
  }

  const filePath = await writeAuthStore(store, { homeDir: options.homeDir });
  return {
    filePath,
    profile: validProfile,
    isDefault: store.defaultProfile === validProfile,
  };
}

/**
 * Persists an API key to `~/.cdpn` under `options.profile` (default `"default"`) with `0o600` permissions.
 */
export async function saveApiKeyToFile(
  apiKey: string,
  options: { homeDir?: string; profile?: string; setAsDefault?: boolean } = {},
): Promise<string> {
  const result = await saveProfileToFile(
    options.profile ?? DEFAULT_PROFILE_NAME,
    apiKey,
    options,
  );
  return result.filePath;
}

export async function setDefaultProfile(
  profileName: string,
  options: Pick<AuthOptions, 'homeDir'> = {},
): Promise<string> {
  const validProfile = validateProfileName(profileName);
  const { store } = await readAuthStore(options);

  if (!Object.hasOwn(store.profiles, validProfile)) {
    const available = Object.keys(store.profiles);
    const hint =
      available.length > 0
        ? ` Available profiles: ${available.join(', ')}.`
        : ` Run \`cdpn auth login --profile ${validProfile}\` first.`;
    throw new CliError(404, `Profile "${validProfile}" not found in ~/${API_KEY_FILENAME}.${hint}`, {
      requested_profile: validProfile,
      available_profiles: available,
    });
  }

  store.defaultProfile = validProfile;
  return writeAuthStore(store, options);
}

export async function removeProfileFromFile(
  profileName: string,
  options: Pick<AuthOptions, 'homeDir'> = {},
): Promise<{ removed: boolean; remainingProfiles: string[]; newDefault: string | null }> {
  const validProfile = validateProfileName(profileName);
  const { store, exists } = await readAuthStore(options);

  if (!exists || !Object.hasOwn(store.profiles, validProfile)) {
    return {
      removed: false,
      remainingProfiles: Object.keys(store.profiles),
      newDefault: store.defaultProfile,
    };
  }

  delete store.profiles[validProfile];
  const remaining = Object.keys(store.profiles).sort((a, b) => a.localeCompare(b));

  if (remaining.length === 0) {
    await removeApiKeyFile(options);
    return { removed: true, remainingProfiles: [], newDefault: null };
  }

  if (store.defaultProfile === validProfile) {
    store.defaultProfile = remaining[0] ?? null;
  }

  await writeAuthStore(store, options);
  return {
    removed: true,
    remainingProfiles: remaining,
    newDefault: store.defaultProfile,
  };
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

/**
 * Matches a CodePen URL's owner segment (user or team slug) against stored profile names.
 */
export function findMatchingProfile(
  availableProfiles: string[],
  urlHint?: string | null,
): string | null {
  if (!urlHint || availableProfiles.length === 0) return null;
  const owner = extractCodePenOwnerFromUrl(urlHint);
  if (!owner) return null;

  const exact = availableProfiles.find((p) => p === owner);
  if (exact) return exact;

  const lower = owner.toLowerCase();
  return availableProfiles.find((p) => p.toLowerCase() === lower) ?? null;
}

/**
 * Resolves CodePen API credentials non-interactively.
 *
 * Precedence:
 * 1. Explicit `options.profile` from `~/.cdpn` (returns `null` if that profile does not exist).
 * 2. `CODEPEN_API_KEY` environment variable.
 * 3. Default (or sole) profile in `~/.cdpn`.
 */
export async function resolveAuth(options: AuthOptions = {}): Promise<ResolvedAuth | null> {
  const env = options.env ?? process.env;
  const envKey = env[API_KEY_ENV_VAR]?.trim() || '';
  const { store, filePath, insecurePermissions } = await readAuthStore({
    homeDir: options.homeDir,
  });

  const availableProfiles = Object.keys(store.profiles).sort((a, b) => a.localeCompare(b));
  const hasEnv = Boolean(envKey);
  const hasFile = availableProfiles.length > 0;

  if (options.profile !== undefined) {
    const requestedProfile = validateProfileName(options.profile);
    if (Object.hasOwn(store.profiles, requestedProfile)) {
      return {
        apiKey: store.profiles[requestedProfile]!,
        source: 'file',
        profile: requestedProfile,
        filePath,
        hasEnv,
        hasFile,
        availableProfiles,
        defaultProfile: store.defaultProfile,
        insecureFilePermissions: insecurePermissions,
      };
    }
    return null;
  }

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

  if (hasFile) {
    const chosen =
      store.defaultProfile && Object.hasOwn(store.profiles, store.defaultProfile)
        ? store.defaultProfile
        : availableProfiles[0]!;
    return {
      apiKey: store.profiles[chosen]!,
      source: 'file',
      profile: chosen,
      filePath,
      hasEnv,
      hasFile,
      availableProfiles,
      defaultProfile: store.defaultProfile,
      insecureFilePermissions: insecurePermissions,
    };
  }

  return null;
}

export async function requireAuth(options: AuthOptions = {}): Promise<ResolvedAuth> {
  const auth = await resolveAuth(options);
  if (!auth) {
    if (options.profile) {
      const { store } = await readAuthStore({ homeDir: options.homeDir });
      const available = Object.keys(store.profiles).sort((a, b) => a.localeCompare(b));
      const availableNote =
        available.length > 0 ? ` Available profiles: ${available.join(', ')}.` : '';
      throw new CliError(
        404,
        `Profile "${options.profile}" not found in ~/${API_KEY_FILENAME}.${availableNote}\n` +
          `Run \`cdpn auth login --profile ${options.profile}\` to add it.`,
        { requested_profile: options.profile, available_profiles: available },
      );
    }
    throw new CliError(
      401,
      `No CodePen API key found. Run \`cdpn auth login\` or set the ${API_KEY_ENV_VAR} environment variable.`,
    );
  }
  return auth;
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
