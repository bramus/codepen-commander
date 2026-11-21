import { CodePenClient } from '../api/client.js';
import { CodePenApiError } from '../api/errors.js';
import type { Pen } from '../api/types.js';
import { DEFAULT_PROFILE_NAME, findMatchingProfile, type ResolvedAuth } from '../config/auth.js';
import { PROJECT_CONFIG_FILENAME } from '../constants.js';
import { CliError } from '../errors.js';
import { openBrowser, validateBrowserUrl } from '../utils/browser.js';
import { extractCodePenOwnerFromUrl, normalizePenReference } from '../utils/codepen-url.js';
import { fmt } from '../utils/format.js';
import { defaultOutput, type CommandOutput } from '../utils/output.js';
import type { SelectOption } from '../utils/prompts/index.js';
import { resolveCommandAuth } from './auth-context.js';

type ClassicCloneAction = 'convert' | 'clone-unlinked';
type ClassicRetryAction = 'retry' | 'clone-unlinked' | 'cancel';

export interface ClassicPenResolution {
  action: 'clone-linked' | 'clone-unlinked' | 'cancel';
  pen: Pen;
  effectiveUrl: string;
  auth: ResolvedAuth;
  client: CodePenClient;
  isOwnedByAnotherUser: boolean;
  penOwner: string | null;
  currentUsername: string | null;
}

function validateEditorBrowserUrl(rawUrl: string): string {
  let candidate = rawUrl.trim();
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol === 'http:') {
      parsed.protocol = 'https:';
    }
    candidate = parsed.toString();
  } catch {
    // Let validateBrowserUrl throw a clean validation error
  }

  const safeUrl = validateBrowserUrl(candidate);
  const host = new URL(safeUrl).hostname.toLowerCase();
  const isCodePenHost = host === 'codepen.io' || host.endsWith('.codepen.io');
  if (!isCodePenHost) {
    throw new CliError(400, `Refusing to open non-CodePen URL in browser: ${host}`);
  }
  return safeUrl;
}

async function promptClassicRetryChoice(
  selectImpl: <T extends string>(
    question: string,
    options: SelectOption<T>[],
    defaultIndex?: number,
  ) => Promise<T>,
): Promise<ClassicRetryAction> {
  return selectImpl<ClassicRetryAction>(
    'How would you like to proceed?',
    [
      {
        value: 'retry',
        label: 'Check again / paste 2.0 Pen URL',
        description: 're-fetch after converting or enter the new URL',
      },
      {
        value: 'clone-unlinked',
        label: 'Just clone without linking',
        description: `download files without ${PROJECT_CONFIG_FILENAME}`,
      },
      {
        value: 'cancel',
        label: 'Cancel',
        description: 'abort clone',
      },
    ],
    0,
  );
}

/**
 * Resolves the authenticated CodePen username for ownership comparisons during clone.
 */
export async function resolveCurrentUsername(
  client: CodePenClient,
  auth: ResolvedAuth,
  penOwner: string,
): Promise<string | null> {
  // Fast path: named profile already matches the Pen owner
  if (
    auth.profile &&
    auth.profile !== DEFAULT_PROFILE_NAME &&
    auth.profile.toLowerCase() === penOwner.toLowerCase()
  ) {
    return auth.profile;
  }

  // Inspect one Pen owned by this API key to discover the actual CodePen account username
  // (handles CODEPEN_API_KEY env var, "default" profile, and custom profile aliases)
  try {
    const samplePen = await client.verifyAuth();
    const detected = samplePen?.urls?.editor
      ? extractCodePenOwnerFromUrl(samplePen.urls.editor)
      : null;
    if (detected) {
      return detected;
    }
  } catch {
    // Fall back to profile name if the account has no Pens or listing fails
  }

  if (auth.profile && auth.profile !== DEFAULT_PROFILE_NAME) {
    return auth.profile;
  }

  return null;
}

/**
 * Interactive workflow when cloning a Classic (v1) Pen: offers to open it in the browser
 * so the user can convert it to CodePen 2.0 and immediately re-fetch, or clone it unlinked.
 */
export async function handleClassicPenClone(params: {
  pen: Pen;
  apiIdentifier: string;
  effectiveUrl: string;
  auth: ResolvedAuth;
  client: CodePenClient;
  explicitProfile?: string;
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  openBrowserImpl?: (url: string) => Promise<boolean>;
  output?: CommandOutput;
  selectImpl: <T extends string>(
    question: string,
    options: SelectOption<T>[],
    defaultIndex?: number,
  ) => Promise<T>;
  textImpl: (question: string, defaultValue?: string) => Promise<string>;
}): Promise<ClassicPenResolution> {
  const { pen, apiIdentifier, effectiveUrl, selectImpl, textImpl } = params;
  const output = params.output ?? defaultOutput;
  let currentAuth = params.auth;
  let currentClient = params.client;
  let fallbackPen = pen;

  const makeFallbackResult = (action: 'clone-unlinked' | 'cancel'): ClassicPenResolution => ({
    action,
    pen: fallbackPen,
    effectiveUrl,
    auth: currentAuth,
    client: currentClient,
    isOwnedByAnotherUser: false,
    penOwner: null,
    currentUsername: null,
  });

  output.log(
    `\n${fmt.yellow('This is a Classic (v1) Pen, which is read-only through CodePen API v2 and cannot be synced.')}`,
  );
  output.log(
    'You can convert it to a CodePen 2.0 Pen in the browser using the dropdown on the Save button.\n',
  );

  const initialChoice = await selectImpl<ClassicCloneAction>(
    'How would you like to proceed?',
    [
      {
        value: 'convert',
        label: 'Open the Pen to convert it first',
        description: 'open in browser, then clone linked',
      },
      {
        value: 'clone-unlinked',
        label: 'Just clone without linking',
        description: `download files without ${PROJECT_CONFIG_FILENAME}`,
      },
    ],
    0,
  );

  if (initialChoice === 'clone-unlinked') {
    return makeFallbackResult('clone-unlinked');
  }

  const editorUrl = validateEditorBrowserUrl(pen.urls.editor || effectiveUrl);
  const openImpl = params.openBrowserImpl ?? openBrowser;
  const opened = await openImpl(editorUrl);
  if (opened) {
    output.log(`\n${fmt.green('✓')} Opened ${fmt.cyan(editorUrl)} in your browser.`);
  } else {
    output.log(
      `\n${fmt.yellow('!')} Could not launch a browser automatically. Open this URL manually:\n  ${fmt.cyan(editorUrl)}`,
    );
  }
  output.log(
    fmt.dim('In CodePen, use the dropdown on the Save button to convert this Pen to CodePen 2.0.'),
  );

  for (;;) {
    output.log('');
    const pasted = (
      await textImpl(
        'Press Enter once converted to re-fetch & clone (or paste the new 2.0 Pen URL)',
      )
    ).trim();

    let targetApiId = apiIdentifier;
    let pastedOriginalUrl: string | undefined;

    if (pasted) {
      try {
        const normalized = normalizePenReference(pasted);
        targetApiId = normalized.apiIdentifier;
        pastedOriginalUrl = normalized.originalUrl;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        output.log(`\n${fmt.yellow('!')} ${msg}\n`);
        const nextAction = await promptClassicRetryChoice(selectImpl);
        if (nextAction === 'retry') continue;
        if (nextAction === 'clone-unlinked') return makeFallbackResult('clone-unlinked');
        output.log('Aborted.');
        return makeFallbackResult('cancel');
      }

      if (!params.explicitProfile && currentAuth.source === 'file' && pastedOriginalUrl) {
        const matchedProfile = findMatchingProfile(currentAuth.availableProfiles, pastedOriginalUrl);
        if (matchedProfile && matchedProfile !== currentAuth.profile) {
          currentAuth = await resolveCommandAuth({
            explicitProfile: matchedProfile,
            interactive: true,
            output,
            env: params.env,
            homeDir: params.homeDir,
          });
          currentClient = new CodePenClient({ apiKey: currentAuth.apiKey, baseUrl: params.baseUrl });
          output.log(fmt.dim(`Using profile "${matchedProfile}" (matches Pen owner).`));
        }
      }
    }

    output.log(`Fetching Pen ${fmt.cyan(targetApiId)}…`);

    let refetched: Pen;
    try {
      refetched = await currentClient.getPen(targetApiId);
    } catch (error) {
      const msg =
        error instanceof CodePenApiError
          ? error.formatForUser()
          : error instanceof Error
            ? error.message
            : String(error);
      output.log(`\n${fmt.yellow('!')} Could not fetch Pen ${targetApiId}: ${msg}\n`);
      const nextAction = await promptClassicRetryChoice(selectImpl);
      if (nextAction === 'retry') continue;
      if (nextAction === 'clone-unlinked') return makeFallbackResult('clone-unlinked');
      output.log('Aborted.');
      return makeFallbackResult('cancel');
    }

    const refetchedOwner =
      extractCodePenOwnerFromUrl(refetched.urls.editor) ??
      (pastedOriginalUrl ? extractCodePenOwnerFromUrl(pastedOriginalUrl) : null);

    if (
      refetchedOwner &&
      !params.explicitProfile &&
      currentAuth.source === 'file' &&
      currentAuth.profile?.toLowerCase() !== refetchedOwner.toLowerCase()
    ) {
      const matchedStoredProfile = findMatchingProfile(
        currentAuth.availableProfiles,
        refetched.urls.editor,
      );
      if (matchedStoredProfile && matchedStoredProfile !== currentAuth.profile) {
        currentAuth = await resolveCommandAuth({
          explicitProfile: matchedStoredProfile,
          interactive: true,
          output,
          env: params.env,
          homeDir: params.homeDir,
        });
        currentClient = new CodePenClient({ apiKey: currentAuth.apiKey, baseUrl: params.baseUrl });
        output.log(fmt.dim(`Using profile "${matchedStoredProfile}" (matches Pen owner).`));
      }
    }

    if (refetched.editor !== 'Classic') {
      const detectedUsername = refetchedOwner
        ? await resolveCurrentUsername(currentClient, currentAuth, refetchedOwner)
        : null;
      const ownedByOther = Boolean(
        refetchedOwner &&
          detectedUsername &&
          refetchedOwner.toLowerCase() !== detectedUsername.toLowerCase(),
      );

      const resolvedUrl = pasted
        ? (pastedOriginalUrl ?? refetched.urls.editor)
        : (refetched.urls.editor || effectiveUrl);

      if (!ownedByOther) {
        output.log(
          `\n${fmt.green('✓')} Pen is now CodePen 2.0 ${fmt.dim(`(${refetched.id})`)} — continuing linked clone.`,
        );
      }

      return {
        action: ownedByOther ? 'clone-unlinked' : 'clone-linked',
        pen: refetched,
        effectiveUrl: resolvedUrl,
        auth: currentAuth,
        client: currentClient,
        isOwnedByAnotherUser: ownedByOther,
        penOwner: refetchedOwner,
        currentUsername: detectedUsername,
      };
    }

    if (!pasted) {
      fallbackPen = refetched;
    }

    output.log(
      `\n${fmt.yellow('!')} ${fmt.bold(refetched.title || 'Untitled')} is still a Classic (v1) Pen on CodePen.`,
    );
    output.log(
      fmt.dim(
        'Make sure you converted it to 2.0 via the Save button dropdown (or paste the new 2.0 Pen URL if CodePen opened a new one).\n',
      ),
    );

    const nextAction = await promptClassicRetryChoice(selectImpl);
    if (nextAction === 'retry') {
      continue;
    }
    if (nextAction === 'clone-unlinked') {
      return makeFallbackResult('clone-unlinked');
    }
    output.log('Aborted.');
    return makeFallbackResult('cancel');
  }
}
