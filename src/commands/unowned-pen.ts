import type { CodePenClient } from '../api/client.js';
import {
  API_KEY_ENV_VAR,
  DEFAULT_PROFILE_NAME,
  findMatchingProfile,
  readAuthStore,
  type ResolvedAuth,
} from '../config/auth.js';
import { extractCodePenOwnerFromUrl } from '../config/project.js';
import { openBrowser } from '../utils/browser.js';
import { fmt } from '../utils/format.js';

export interface UnmatchedStoredOwner {
  urlOwner: string;
  availableProfiles: string[];
}

/**
 * Checks before interactive profile prompting or network calls whether a Pen URL clearly
 * belongs to an account not present among the user's named stored profiles in `~/.cdpn`.
 *
 * Returns `null` whenever:
 * - `--profile` or `CODEPEN_API_KEY` was explicitly provided (let the API verify),
 * - the URL carries no owner segment (e.g. raw ID or preview URL),
 * - fewer than 2 profiles are stored (single-profile setups don't prompt anyway, so trying
 *   the API preserves custom profile aliases and still handles 404 cleanly),
 * - a generic `default` profile exists, or
 * - one of the stored profile names matches the URL's owner.
 */
export async function findUnmatchedStoredOwner(options: {
  originalUrl?: string;
  explicitProfile?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}): Promise<UnmatchedStoredOwner | null> {
  if (options.explicitProfile) return null;

  const env = options.env ?? process.env;
  if (env[API_KEY_ENV_VAR]?.trim()) return null;

  if (!options.originalUrl) return null;
  const urlOwner = extractCodePenOwnerFromUrl(options.originalUrl);
  if (!urlOwner) return null;

  const { store } = await readAuthStore({ homeDir: options.homeDir });
  const availableProfiles = Object.keys(store.profiles).sort((a, b) => a.localeCompare(b));
  if (availableProfiles.length < 2) return null;
  if (availableProfiles.includes(DEFAULT_PROFILE_NAME)) return null;

  if (findMatchingProfile(availableProfiles, options.originalUrl) !== null) {
    return null;
  }

  return { urlOwner, availableProfiles };
}

function toHttpsUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol === 'http:') {
      parsed.protocol = 'https:';
    }
    return parsed.toString();
  } catch {
    return rawUrl;
  }
}

export interface UnownedPenAccessOptions {
  action: 'fork' | 'clone';
  penUrl: string;
  urlOwner: string;
  /** Stored profile names when failing fast before auth resolution. */
  availableProfiles?: string[];
  /** Active profile name when failing after a 404 response. */
  currentProfile?: string | null;
  interactive: boolean;
  allowBrowserFallback?: boolean;
  confirmImpl: (question: string, defaultYes?: boolean) => Promise<boolean>;
  textImpl: (question: string, defaultValue?: string) => Promise<string>;
  openBrowserImpl?: (url: string) => Promise<boolean>;
}

/**
 * Explains CodePen API v2's owner-only scope for another user's Pen and, in interactive mode,
 * offers to open the Pen in the browser so the user can fork it on codepen.io and paste the
 * forked URL back to clone immediately.
 *
 * Returns the pasted forked Pen URL/ID if the user provides one, or `null` if they exit.
 * In non-interactive mode (or when `allowBrowserFallback` is false), throws a clear Error.
 */
export async function handleUnownedPenAccess(
  options: UnownedPenAccessOptions,
): Promise<string | null> {
  const safeUrl = toHttpsUrl(options.penUrl);
  const { action, urlOwner, availableProfiles, currentProfile, interactive } = options;
  const allowBrowserFallback = options.allowBrowserFallback !== false;

  const profileLine =
    availableProfiles && availableProfiles.length > 0
      ? `Stored profiles: ${availableProfiles.join(', ')} (pass --profile <name> if one of them is an alias for ${urlOwner}).`
      : currentProfile
        ? `Active profile: ${currentProfile} (if another profile owns ${urlOwner}’s Pens, pass --profile <name>).`
        : null;

  if (!interactive || !allowBrowserFallback) {
    const lines = [
      `Cannot ${action} ${urlOwner}’s Pen via CodePen API v2.`,
      `CodePen API v2 keys can only access and fork Pens owned by the key’s account (other users’ Pens return 404, even when public).`,
      ...(profileLine ? [profileLine] : []),
      `Fork this Pen in your browser at ${safeUrl}, then run \`cdpn clone <your-fork-url>\`.`,
    ];
    throw new Error(lines.join('\n'));
  }

  console.log(
    `\n${fmt.yellow(`Cannot ${action} ${fmt.bold(urlOwner)}’s Pen via CodePen API v2.`)}`,
  );
  console.log(
    'CodePen API v2 keys can only access and fork Pens owned by the key’s account — other users’ Pens return 404, even when public.',
  );
  if (profileLine) {
    console.log(fmt.dim(`  ${profileLine}`));
  }
  console.log(
    `\nWorkaround: fork this Pen in your browser on codepen.io, then clone your fork locally.`,
  );

  const shouldOpen = await options.confirmImpl(
    `Open ${safeUrl} in your browser to fork it?`,
    true,
  );
  if (!shouldOpen) {
    console.log(fmt.dim('Run `cdpn clone <your-fork-url>` once you have forked it on CodePen.'));
    return null;
  }

  const openImpl = options.openBrowserImpl ?? openBrowser;
  const opened = await openImpl(safeUrl);
  if (opened) {
    console.log(`\n${fmt.green('✓')} Opened ${fmt.cyan(safeUrl)} in your browser.`);
  } else {
    console.log(
      `\n${fmt.yellow('!')} Could not launch a browser automatically. Open this URL manually:\n  ${fmt.cyan(safeUrl)}`,
    );
  }

  const pasted = (
    await options.textImpl('Paste your forked Pen URL to clone it now (or press Enter to exit)')
  ).trim();

  if (!pasted) {
    console.log(fmt.dim('Run `cdpn clone <your-fork-url>` whenever you are ready to clone your fork.'));
    return null;
  }

  return pasted;
}

/**
 * Handles a `404 NOT_FOUND` error from `GET /v2/pens/{id}` in `cdpn clone` / `cdpn fork`.
 * If the URL points to another user's Pen, triggers the friendly explanation and optional
 * browser fork-and-clone workflow; otherwise throws a clear, contextual 404 error.
 */
export async function handlePenNotFoundOnFetch(options: {
  action: 'fork' | 'clone';
  apiIdentifier: string;
  originalUrl?: string;
  auth: ResolvedAuth;
  client: CodePenClient;
  interactive: boolean;
  allowBrowserFallback?: boolean;
  confirmImpl: (question: string, defaultYes?: boolean) => Promise<boolean>;
  textImpl: (question: string, defaultValue?: string) => Promise<string>;
  openBrowserImpl?: (url: string) => Promise<boolean>;
}): Promise<string | null> {
  const { action, apiIdentifier, originalUrl, auth, client } = options;
  const urlOwner = originalUrl ? extractCodePenOwnerFromUrl(originalUrl) : null;
  const accountLabel = auth.profile ? `profile "${auth.profile}"` : 'the current API key';

  if (urlOwner && originalUrl) {
    let matchesAuthenticatedOwner = Boolean(
      auth.profile &&
        auth.profile !== DEFAULT_PROFILE_NAME &&
        auth.profile.toLowerCase() === urlOwner.toLowerCase(),
    );

    if (!matchesAuthenticatedOwner && (!auth.profile || auth.profile === DEFAULT_PROFILE_NAME)) {
      try {
        const samplePen = await client.verifyAuth();
        const detected = samplePen?.urls?.editor
          ? extractCodePenOwnerFromUrl(samplePen.urls.editor)
          : null;
        if (detected && detected.toLowerCase() === urlOwner.toLowerCase()) {
          matchesAuthenticatedOwner = true;
        }
      } catch {
        // Ignore verifyAuth errors; treat as unowned fallback
      }
    }

    if (!matchesAuthenticatedOwner) {
      return handleUnownedPenAccess({
        action,
        penUrl: originalUrl,
        urlOwner,
        currentProfile: auth.profile,
        interactive: options.interactive,
        allowBrowserFallback: options.allowBrowserFallback,
        confirmImpl: options.confirmImpl,
        textImpl: options.textImpl,
        openBrowserImpl: options.openBrowserImpl,
      });
    }

    throw new Error(
      `Pen ${apiIdentifier} was not found under ${accountLabel}. Verify the Pen URL/ID exists and is not in the trash.`,
    );
  }

  throw new Error(
    `Pen ${apiIdentifier} was not found for ${accountLabel}.\n` +
      `Note: CodePen API v2 keys can only access and fork Pens owned by the key’s account (other users’ Pens return 404, even when public).`,
  );
}
