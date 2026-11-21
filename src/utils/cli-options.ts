import type { Command } from 'commander';
import type { PenAccess } from '../api/types.js';
import {
  MAX_PEN_TAGS,
  MAX_VERSION_LABEL_LENGTH,
  MIN_PROTECTED_PASSWORD_LENGTH,
  VALID_PEN_ACCESS_LOWER,
} from '../constants.js';
import { CliError } from '../errors.js';

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
