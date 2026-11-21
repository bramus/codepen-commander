import type { Pen } from '../api/types.js';
import { CliError } from '../errors.js';
import { slugifyTitle } from './strings.js';

const PEN_ID_PATTERN = /^[A-Za-z0-9_-]{3,64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PEN_VIEW_SEGMENTS = new Set(['pen', 'full', 'details', 'debug', 'live', 'embed']);
const CLASSIC_PEN_VIEW_SEGMENTS = new Set([...PEN_VIEW_SEGMENTS, 'editor']);

const RESERVED_CODEPEN_SEGMENTS = new Set([
  'pen',
  'editor',
  'full',
  'details',
  'debug',
  'live',
  'embed',
  'settings',
  'trending',
  'following',
  'your-work',
  'collections',
  'project',
  'projects',
  'api',
]);

/**
 * Extracts a Pen's cpid or hashid from a CodePen URL, when present in the URL path or host.
 */
export function extractPenIdFromUrl(rawUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return null;
  }

  const host = parsed.hostname.toLowerCase();

  if (host === 'codepen.io' || host === 'www.codepen.io') {
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length < 2) {
      return null;
    }

    let idx = 0;
    const isV2EditorPath = segments[0]?.toLowerCase() === 'editor';
    const viewSegments = isV2EditorPath ? PEN_VIEW_SEGMENTS : CLASSIC_PEN_VIEW_SEGMENTS;

    if (isV2EditorPath) {
      idx++;
      if (segments.length === 2 && segments[1] && UUID_PATTERN.test(segments[1])) {
        return segments[1];
      }
    }

    if (segments[idx]?.toLowerCase() === 'team') {
      // Skip `team/<team-slug>`
      idx += 2;
    } else if (segments[idx] && !viewSegments.has(segments[idx]!.toLowerCase())) {
      // Skip `<username>`
      idx += 1;
    }

    const view = segments[idx]?.toLowerCase();
    if (!view || !viewSegments.has(view)) {
      return null;
    }
    idx++;

    // Handle `/embed/preview/<id>`
    if (view === 'embed' && segments[idx]?.toLowerCase() === 'preview') {
      idx++;
    }

    const idCandidate = segments[idx]?.trim();
    if (idCandidate && PEN_ID_PATTERN.test(idCandidate)) {
      return idCandidate;
    }
    return null;
  }

  // Content or preview subdomains carrying a UUID cpid (e.g. `<cpid>.codepenusercontent.com`)
  const firstLabel = host.split('.')[0];
  if (
    firstLabel &&
    UUID_PATTERN.test(firstLabel) &&
    (host.endsWith('.codepen.dev') ||
      host.endsWith('.codepen.app') ||
      host.endsWith('.codepenusercontent.com'))
  ) {
    return firstLabel;
  }

  return null;
}

/**
 * Validates and normalizes a Pen identifier or CodePen URL passed by the user.
 */
export function normalizePenReference(rawInput: string): { apiIdentifier: string; originalUrl?: string } {
  const trimmed = rawInput.trim();
  if (!trimmed) {
    throw new CliError(400, 'Pen URL or ID cannot be empty.');
  }

  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new CliError(400, `Invalid URL: ${trimmed}`);
    }
    const host = parsed.hostname.toLowerCase();
    const isCodePenHost =
      host === 'codepen.io' ||
      host.endsWith('.codepen.io') ||
      host.endsWith('.codepen.dev') ||
      host.endsWith('.codepen.app') ||
      host.endsWith('.codepenusercontent.com');
    if (!isCodePenHost) {
      throw new CliError(400, `Expected a CodePen URL (codepen.io / codepen.dev / codepen.app), got: ${host}`);
    }
    const extractedId = extractPenIdFromUrl(trimmed);
    return {
      apiIdentifier: extractedId ?? trimmed,
      originalUrl: trimmed,
    };
  }

  // Raw cpid (UUID) or hashid
  if (!PEN_ID_PATTERN.test(trimmed)) {
    throw new CliError(400, `Invalid Pen ID: "${trimmed}". Provide a Pen URL, cpid, or hashid.`);
  }

  return { apiIdentifier: trimmed };
}

/**
 * Produces a safe default local folder name for a Pen based on its title or ID.
 */
export function suggestFolderName(pen: Pick<Pen, 'id' | 'title'>): string {
  return slugifyTitle(pen.title) ?? pen.id.replace(/[^A-Za-z0-9_-]/g, '-');
}

/**
 * Extracts the CodePen username or team slug from a `codepen.io` URL, if present.
 */
export function extractCodePenOwnerFromUrl(rawUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return null;
  }

  const host = parsed.hostname.toLowerCase();
  if (host !== 'codepen.io' && host !== 'www.codepen.io') {
    return null;
  }

  const segments = parsed.pathname.split('/').filter(Boolean);
  let idx = 0;

  // CodePen 2.0 editor URLs place `/editor/` before the username/team slug
  if (segments[idx]?.toLowerCase() === 'editor') {
    idx++;
  }

  // Team URLs may include a `/team/` prefix before the team slug
  if (segments[idx]?.toLowerCase() === 'team') {
    idx++;
  }

  // Require at least `<owner>/<view-or-resource>` remaining (e.g. `bramus/pen/<id>`)
  if (segments.length - idx < 2) {
    return null;
  }

  const candidate = segments[idx]?.trim();
  if (!candidate || RESERVED_CODEPEN_SEGMENTS.has(candidate.toLowerCase())) {
    return null;
  }

  if (/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(candidate)) {
    return candidate;
  }
  return null;
}

/**
 * Validates that a URL is an HTTPS `codepen.io` (or `*.codepen.io`) URL safe for rendering in HTML.
 */
export function sanitizeCodePenUrl(rawUrl: unknown): string | null {
  if (typeof rawUrl !== 'string') return null;
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== 'https:') return null;
    if (parsed.hostname !== 'codepen.io' && !parsed.hostname.endsWith('.codepen.io')) {
      return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
}
