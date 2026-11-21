import os from 'node:os';
import path from 'node:path';
import { CODEPEN_API_SETTINGS_URL } from '../constants.js';
import { CliError } from '../errors.js';
import { extractCodePenOwnerFromUrl } from '../utils/codepen-url.js';

export { CODEPEN_API_SETTINGS_URL };
export const API_KEY_ENV_VAR = 'CODEPEN_API_KEY';
export const API_KEY_FILENAME = '.cdpn';
export const DEFAULT_PROFILE_NAME = 'default';

const FORBIDDEN_PROFILE_NAMES = new Set(['__proto__', 'constructor', 'prototype']);
const PROFILE_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export type AuthSource = 'env' | 'file';
export type ApiKeyType = 'User' | 'Team' | 'Unknown';

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

export interface ShellSnippet {
  shell: string;
  rcFile: string;
  line: string;
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
