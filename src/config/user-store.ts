import fs from 'node:fs/promises';
import { CliError } from '../errors.js';
import { hasControlChars, isPlainObject } from '../utils/strings.js';
import {
  API_KEY_FILENAME,
  DEFAULT_PROFILE_NAME,
  getApiKeyFilePath,
  isValidProfileName,
  validateProfileName,
} from './auth.js';

const SINGLE_KEY_FIELDS = ['api_key', 'apiKey', 'key', 'token'] as const;
const RESERVED_STORE_KEYS = new Set([
  'default',
  'defaultProfile',
  'default_profile',
  'profiles',
  'config',
  'shell',
]);

export interface GlobalConfig {
  shell?: string;
}

export interface AuthStore {
  defaultProfile: string | null;
  profiles: Record<string, string>;
  config?: GlobalConfig;
}

export interface ReadAuthStoreResult {
  store: AuthStore;
  filePath: string;
  exists: boolean;
  insecurePermissions: boolean;
}

export interface UserStoreOptions {
  homeDir?: string;
}

export function normalizeGlobalConfig(raw: unknown): GlobalConfig {
  if (!isPlainObject(raw)) {
    return {};
  }
  const config: GlobalConfig = {};
  if (typeof raw.shell === 'string') {
    const trimmed = raw.shell.trim();
    if (trimmed && !hasControlChars(trimmed)) {
      config.shell = trimmed;
    }
  }
  return config;
}

export function hasGlobalConfig(config: GlobalConfig | undefined): boolean {
  if (!config) return false;
  return Boolean(config.shell && config.shell.trim());
}

function extractKeyFromValue(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (isPlainObject(value)) {
    for (const field of SINGLE_KEY_FIELDS) {
      const candidate = value[field];
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

function extractGlobalConfigFromRecord(record: Record<string, unknown>): GlobalConfig {
  const nested = normalizeGlobalConfig(record.config);
  if (!nested.shell && typeof record.shell === 'string') {
    const trimmed = record.shell.trim();
    if (trimmed && !hasControlChars(trimmed)) {
      nested.shell = trimmed;
    }
  }
  return nested;
}

/**
 * Parses `~/.cdpn` content into a normalized multi-profile `AuthStore` + global `config`.
 *
 * Preserves full backwards compatibility with legacy file formats:
 * - Multi-profile JSON: `{ "default": "bramus", "profiles": { ... }, "config"?: { "shell": "..." } }`
 * - Flat JSON map: `{ "bramus": "cp_user_...", "team": "cp_team_..." }`
 * - Single-key JSON: `{ "api_key": "..." }` / `{ "key": "..." }` / `{ "token": "..." }`
 * - Plain raw key (`cp_user_...`) or env assignment (`export CODEPEN_API_KEY="..."`)
 */
export function parseAuthStoreContent(raw: string): AuthStore {
  const trimmed = raw.trim();
  if (!trimmed) {
    return createEmptyStore();
  }

  if (trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!isPlainObject(parsed)) {
        return createEmptyStore();
      }
      const profiles: Record<string, string> = Object.create(null) as Record<string, string>;
      const config = extractGlobalConfigFromRecord(parsed);
      const configField = hasGlobalConfig(config) ? { config } : {};

      // Format 1: { "default": "...", "profiles": { ... }, "config"?: { ... } }
      if (isPlainObject(parsed.profiles)) {
        for (const [name, entry] of Object.entries(parsed.profiles)) {
          if (!isValidProfileName(name)) continue;
          const key = extractKeyFromValue(entry);
          if (key) {
            profiles[name.trim()] = key;
          }
        }

        const profileNames = Object.keys(profiles);
        const rawDefault =
          typeof parsed.default === 'string'
            ? parsed.default.trim()
            : typeof parsed.defaultProfile === 'string'
              ? parsed.defaultProfile.trim()
              : typeof parsed.default_profile === 'string'
                ? parsed.default_profile.trim()
                : '';

        const defaultProfile =
          rawDefault && Object.hasOwn(profiles, rawDefault)
            ? rawDefault
            : (profileNames[0] ?? null);

        return { defaultProfile, profiles, ...configField };
      }

      // Format 2: Single-key JSON ({ "api_key": "..." })
      for (const field of SINGLE_KEY_FIELDS) {
        const value = parsed[field];
        if (typeof value === 'string' && value.trim()) {
          profiles[DEFAULT_PROFILE_NAME] = value.trim();
          return { defaultProfile: DEFAULT_PROFILE_NAME, profiles, ...configField };
        }
      }

      // Format 3: Flat map JSON ({ "bramus": "cp_user_...", "team": "cp_team_..." })
      for (const [name, entry] of Object.entries(parsed)) {
        if (RESERVED_STORE_KEYS.has(name) || !isValidProfileName(name)) continue;
        const key = extractKeyFromValue(entry);
        if (key) {
          profiles[name.trim()] = key;
        }
      }

      const profileNames = Object.keys(profiles);
      if (profileNames.length > 0) {
        const rawDefault = typeof parsed.default === 'string' ? parsed.default.trim() : '';
        const defaultProfile =
          rawDefault && Object.hasOwn(profiles, rawDefault)
            ? rawDefault
            : (profileNames[0] ?? null);
        return { defaultProfile, profiles, ...configField };
      }

      return { defaultProfile: null, profiles, ...configField };
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

export async function readAuthStore(options: UserStoreOptions = {}): Promise<ReadAuthStoreResult> {
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

/**
 * Writes the multi-profile store and global config to `~/.cdpn` with strict owner-only (`0o600`) file permissions.
 */
export async function writeAuthStore(
  store: AuthStore,
  options: UserStoreOptions = {},
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
  const normalizedConfig = normalizeGlobalConfig(store.config);
  const includeConfig = hasGlobalConfig(normalizedConfig);

  const payload: Record<string, unknown> = {
    ...(resolvedDefault ? { default: resolvedDefault } : {}),
    ...(names.length > 0 ? { profiles: sortedProfiles } : {}),
    ...(includeConfig ? { config: normalizedConfig } : {}),
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

export async function setDefaultProfile(
  profileName: string,
  options: UserStoreOptions = {},
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
  options: UserStoreOptions = {},
): Promise<{
  removed: boolean;
  remainingProfiles: string[];
  newDefault: string | null;
  fileDeleted: boolean;
}> {
  const validProfile = validateProfileName(profileName);
  const { store, exists } = await readAuthStore(options);

  if (!exists || !Object.hasOwn(store.profiles, validProfile)) {
    return {
      removed: false,
      remainingProfiles: Object.keys(store.profiles),
      newDefault: store.defaultProfile,
      fileDeleted: false,
    };
  }

  delete store.profiles[validProfile];
  const remaining = Object.keys(store.profiles).sort((a, b) => a.localeCompare(b));

  if (remaining.length === 0) {
    if (hasGlobalConfig(store.config)) {
      store.defaultProfile = null;
      await writeAuthStore(store, options);
      return { removed: true, remainingProfiles: [], newDefault: null, fileDeleted: false };
    }
    await removeApiKeyFile(options);
    return { removed: true, remainingProfiles: [], newDefault: null, fileDeleted: true };
  }

  if (store.defaultProfile === validProfile) {
    store.defaultProfile = remaining[0] ?? null;
  }

  await writeAuthStore(store, options);
  return {
    removed: true,
    remainingProfiles: remaining,
    newDefault: store.defaultProfile,
    fileDeleted: false,
  };
}

/**
 * Removes all stored API key profiles from `~/.cdpn`, deleting the file only when no global config remains.
 */
export async function clearAllProfilesFromFile(
  options: UserStoreOptions = {},
): Promise<{ removed: boolean; removedProfiles: string[]; fileDeleted: boolean }> {
  const { store, exists } = await readAuthStore(options);
  const profileNames = Object.keys(store.profiles).sort((a, b) => a.localeCompare(b));
  if (!exists || profileNames.length === 0) {
    return { removed: false, removedProfiles: [], fileDeleted: false };
  }

  if (hasGlobalConfig(store.config)) {
    store.profiles = Object.create(null) as Record<string, string>;
    store.defaultProfile = null;
    await writeAuthStore(store, options);
    return { removed: true, removedProfiles: profileNames, fileDeleted: false };
  }

  const deleted = await removeApiKeyFile(options);
  return { removed: true, removedProfiles: profileNames, fileDeleted: deleted };
}

export async function removeApiKeyFile(options: UserStoreOptions = {}): Promise<boolean> {
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

export async function readGlobalConfig(
  options: UserStoreOptions = {},
): Promise<{ config: GlobalConfig; filePath: string; exists: boolean }> {
  const { store, filePath, exists } = await readAuthStore(options);
  return {
    config: normalizeGlobalConfig(store.config),
    filePath,
    exists,
  };
}

export async function getConfiguredShellDir(options: UserStoreOptions = {}): Promise<string | null> {
  const { config } = await readGlobalConfig(options);
  return config.shell ?? null;
}

export async function setConfiguredShellDir(
  shellDir: string,
  options: UserStoreOptions = {},
): Promise<{ filePath: string; shellDir: string }> {
  const trimmed = shellDir.trim();
  if (!trimmed || hasControlChars(trimmed)) {
    throw new CliError(400, 'Shell directory path cannot be empty or contain control characters.');
  }

  const { store } = await readAuthStore(options);
  const nextConfig = normalizeGlobalConfig(store.config);
  nextConfig.shell = trimmed;
  store.config = nextConfig;
  const filePath = await writeAuthStore(store, options);
  return { filePath, shellDir: trimmed };
}

export async function clearConfiguredShellDir(
  options: UserStoreOptions = {},
): Promise<{ filePath: string; cleared: boolean; fileDeleted: boolean }> {
  const { store, filePath, exists } = await readAuthStore(options);
  const currentConfig = normalizeGlobalConfig(store.config);
  if (!exists || !currentConfig.shell) {
    return { filePath, cleared: false, fileDeleted: false };
  }

  delete currentConfig.shell;
  store.config = hasGlobalConfig(currentConfig) ? currentConfig : undefined;

  const hasProfiles = Object.keys(store.profiles).length > 0;
  if (!hasProfiles && !hasGlobalConfig(store.config)) {
    const deleted = await removeApiKeyFile(options);
    return { filePath, cleared: true, fileDeleted: deleted };
  }

  await writeAuthStore(store, options);
  return { filePath, cleared: true, fileDeleted: false };
}
