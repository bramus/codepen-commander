import type { Command } from 'commander';
import type { PenAccess } from '../api/types.js';
import {
  ALL_PEN_ACCESS_LEVELS,
  MAX_PEN_TAGS,
  MAX_VERSION_LABEL_LENGTH,
  MIN_PROTECTED_PASSWORD_LENGTH,
  VALID_PEN_ACCESS_LOWER,
} from '../constants.js';
import { CliError } from '../errors.js';

export interface AccessFilter {
  /** Normalized access levels included by this filter (ordered canonically). */
  levels: readonly PenAccess[];
  /** True when `all` was requested (includes all PenAccess values as well as Pens with unspecified/unknown access). */
  includeAll: boolean;
}

export const DEFAULT_BUILD_ACCESS_FILTER: AccessFilter = Object.freeze({
  levels: Object.freeze(['Public'] as const),
  includeAll: false,
});

export function parseAccessValue(raw: string): PenAccess | null {
  const lower = raw.trim().toLowerCase();
  if (!VALID_PEN_ACCESS_LOWER.has(lower)) {
    return null;
  }
  return (lower[0]!.toUpperCase() + lower.slice(1)) as PenAccess;
}

export function normalizeAccess(raw?: string): PenAccess | undefined {
  if (!raw) return undefined;
  const parsed = parseAccessValue(raw);
  if (!parsed) {
    throw new CliError(
      400,
      `Invalid access level "${raw}". Use: Public, Private, Protected, or Collaborators.`,
    );
  }
  return parsed;
}

export function resolveAccessOrVisibility(
  rawAccess?: string,
  rawVisibility?: string,
): PenAccess | undefined {
  const access = normalizeAccess(rawAccess);
  const visibility = normalizeAccess(rawVisibility);
  if (access && visibility && access !== visibility) {
    throw new CliError(
      400,
      `Conflicting --access ("${access}") and --visibility ("${visibility}") values.`,
    );
  }
  return access ?? visibility;
}

export function formatAccessFilter(filter: AccessFilter): string {
  return filter.includeAll ? 'all' : filter.levels.join(', ');
}

function areAccessFiltersEqual(a: AccessFilter, b: AccessFilter): boolean {
  if (a.includeAll !== b.includeAll) return false;
  if (a.levels.length !== b.levels.length) return false;
  return a.levels.every((level, index) => level === b.levels[index]);
}

export function parseAccessFilter(raw: string | readonly string[]): AccessFilter {
  const entries = typeof raw === 'string' ? [raw] : raw;
  const tokens = entries
    .flatMap((entry) => entry.split(','))
    .map((token) => token.trim())
    .filter(Boolean);

  if (tokens.length === 0) {
    throw new CliError(
      400,
      'Invalid access filter: specify one or more of Public, Private, Protected, Collaborators, or all.',
    );
  }

  let includeAll = false;
  const selected = new Set<PenAccess>();

  for (const token of tokens) {
    if (token.toLowerCase() === 'all') {
      includeAll = true;
      continue;
    }
    const parsed = parseAccessValue(token);
    if (!parsed) {
      throw new CliError(
        400,
        `Invalid access level "${token}". Use: Public, Private, Protected, Collaborators, or all.`,
      );
    }
    selected.add(parsed);
  }

  const levels = includeAll
    ? [...ALL_PEN_ACCESS_LEVELS]
    : ALL_PEN_ACCESS_LEVELS.filter((level) => selected.has(level));

  return { levels, includeAll };
}

export function resolveAccessFilterOrVisibility(
  rawAccess?: string | readonly string[],
  rawVisibility?: string | readonly string[],
): AccessFilter | undefined {
  const access = rawAccess !== undefined ? parseAccessFilter(rawAccess) : undefined;
  const visibility = rawVisibility !== undefined ? parseAccessFilter(rawVisibility) : undefined;

  if (access && visibility && !areAccessFiltersEqual(access, visibility)) {
    throw new CliError(
      400,
      `Conflicting --access ("${formatAccessFilter(access)}") and --visibility ("${formatAccessFilter(visibility)}") values.`,
    );
  }
  return access ?? visibility;
}

export function matchesAccessFilter(
  access: PenAccess | null | undefined,
  filter: AccessFilter,
): boolean {
  if (filter.includeAll) return true;
  if (!access) return false;
  return filter.levels.includes(access);
}

export function parseTagsOption(raw?: string): string[] | undefined {
  if (raw === undefined) return undefined;
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

export function assertValidTagCount(tags: readonly string[] | undefined, sourceHint = ''): void {
  if (tags && tags.length > MAX_PEN_TAGS) {
    const suffix = sourceHint ? ` (${sourceHint})` : '';
    throw new CliError(
      400,
      `CodePen allows at most ${MAX_PEN_TAGS} tags per Pen (found ${tags.length}${suffix}).`,
    );
  }
}

export function assertValidVersionLabel(label?: string): void {
  if (label && label.length > MAX_VERSION_LABEL_LENGTH) {
    throw new CliError(
      400,
      `Version label must be at most ${MAX_VERSION_LABEL_LENGTH} characters.`,
    );
  }
}

export function assertValidProtectedPassword(
  access: PenAccess | undefined,
  password: string | undefined,
  interactive: boolean,
): void {
  if (access !== 'Protected') return;
  if (password !== undefined && password.length < MIN_PROTECTED_PASSWORD_LENGTH) {
    throw new CliError(
      400,
      `Protected Pens require --password with at least ${MIN_PROTECTED_PASSWORD_LENGTH} characters.`,
    );
  }
  if (!password && !interactive) {
    throw new CliError(
      400,
      `Protected Pens require --password with at least ${MIN_PROTECTED_PASSWORD_LENGTH} characters.`,
    );
  }
}

export function parseBooleanOption(raw: string, flagName: string): boolean {
  const lower = raw.trim().toLowerCase();
  if (lower === 'true' || lower === '1' || lower === 'yes' || lower === 'on') return true;
  if (lower === 'false' || lower === '0' || lower === 'no' || lower === 'off') return false;
  throw new CliError(400, `Invalid boolean value "${raw}" for ${flagName}. Use true or false.`);
}

export function parseTemplateCliFlag(
  rawTemplate: string | boolean | undefined,
  asTemplate: boolean | undefined,
): boolean | undefined {
  let parsedTemplate: boolean | undefined;
  if (typeof rawTemplate === 'boolean') {
    parsedTemplate = rawTemplate;
  } else if (typeof rawTemplate === 'string') {
    parsedTemplate = parseBooleanOption(rawTemplate, '--template');
  }

  if (parsedTemplate !== undefined && asTemplate !== undefined && parsedTemplate !== asTemplate) {
    throw new CliError(400, 'Cannot combine conflicting --template and --as-template flags.');
  }

  return parsedTemplate ?? asTemplate;
}

export function resolveInheritedJsonOption(
  options: { json?: boolean },
  command: Command,
): boolean {
  return Boolean(options.json || command.parent?.opts<{ json?: boolean }>().json);
}
