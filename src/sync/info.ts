import crypto from 'node:crypto';
import type {
  CdpnConfig,
  CompletePenInfo,
  Pen,
  PenAccess,
  PenInfo,
  PenUpdateRequest,
} from '../types.js';
import { CliError } from '../utils/json.js';

export const PEN_INFO_FIELDS = ['title', 'description', 'tags', 'access', 'template'] as const;
export type PenInfoField = (typeof PEN_INFO_FIELDS)[number];

export interface InfoDiffItem<K extends PenInfoField = PenInfoField> {
  field: K;
  local: CompletePenInfo[K];
  remote: CompletePenInfo[K];
}

export interface InfoSyncAnalysis {
  /** Whether `.cdpn.json` includes any Pen `info` fields (false for legacy `.cdpn.json` files). */
  tracked: boolean;
  /** Whether local `info` was edited relative to `last_synced_info_hash` (or provided without a baseline hash). */
  localChanged: boolean;
  /** Whether remote Pen metadata changed relative to `last_synced_info_hash`. */
  remoteChanged: boolean;
  /** Field-by-field differences between defined local `info` fields and remote Pen metadata. */
  changes: InfoDiffItem[];
  /** Canonical complete metadata from the remote Pen. */
  remoteInfo: CompletePenInfo;
}

const VALID_ACCESS = new Set(['public', 'private', 'protected', 'collaborators']);

function parseAccessValue(raw: string): PenAccess | null {
  const lower = raw.trim().toLowerCase();
  if (!VALID_ACCESS.has(lower)) {
    return null;
  }
  return (lower[0]!.toUpperCase() + lower.slice(1)) as PenAccess;
}

/**
 * Extracts editable Pen metadata from a CodePen API v2 `Pen` payload.
 * Intentionally excludes `password` (never stored in `.cdpn.json`) and volatile read-only stats.
 */
export function extractPenInfo(
  pen: Pick<Pen, 'title' | 'description' | 'tags' | 'access' | 'template'>,
): CompletePenInfo {
  return {
    title: typeof pen.title === 'string' ? pen.title : '',
    description: typeof pen.description === 'string' ? pen.description : '',
    tags: Array.isArray(pen.tags)
      ? pen.tags
          .filter((t): t is string => typeof t === 'string')
          .map((t) => t.trim())
          .filter(Boolean)
      : [],
    access: pen.access,
    template: Boolean(pen.template),
  };
}

/**
 * Returns a copy of complete Pen info with deterministic key ordering for hashing & serialization.
 */
export function canonicalizePenInfo(info: CompletePenInfo): CompletePenInfo {
  return {
    title: info.title,
    description: info.description,
    tags: [...info.tags],
    access: info.access,
    template: info.template,
  };
}

/**
 * Orders defined keys of a (potentially partial) `PenInfo` object consistently for writing `.cdpn.json`.
 */
export function normalizePartialPenInfo(info: PenInfo): PenInfo {
  const ordered: PenInfo = {};
  if (info.title !== undefined) ordered.title = info.title;
  if (info.description !== undefined) ordered.description = info.description;
  if (info.tags !== undefined) ordered.tags = [...info.tags];
  if (info.access !== undefined) ordered.access = info.access;
  if (info.template !== undefined) ordered.template = info.template;
  return ordered;
}

export function hasAnyPenInfoFields(info: PenInfo | undefined): boolean {
  if (!info) return false;
  return PEN_INFO_FIELDS.some((field) => info[field] !== undefined);
}

export function isCompletePenInfo(info: PenInfo | undefined): info is CompletePenInfo {
  if (!info) return false;
  return (
    typeof info.title === 'string' &&
    typeof info.description === 'string' &&
    Array.isArray(info.tags) &&
    typeof info.access === 'string' &&
    typeof info.template === 'boolean'
  );
}

/**
 * Computes a deterministic SHA-256 digest of complete Pen metadata.
 */
export function hashPenInfo(info: CompletePenInfo): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonicalizePenInfo(info)))
    .digest('hex');
}

/**
 * Builds the `info` and `last_synced_info_hash` fields to persist in `.cdpn.json` from a synced `Pen`.
 */
export function buildPenInfoConfigFields(
  pen: Pick<Pen, 'title' | 'description' | 'tags' | 'access' | 'template'>,
): { info: CompletePenInfo; last_synced_info_hash: string } {
  const info = extractPenInfo(pen);
  return {
    info,
    last_synced_info_hash: hashPenInfo(info),
  };
}

/**
 * Validates and normalizes the optional `info` object parsed from `.cdpn.json`.
 * Returns `undefined` when absent (backwards-compatible with older `.cdpn.json` files).
 */
export function parsePenInfoInput(raw: unknown, configLabel = '.cdpn.json'): PenInfo | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }

  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CliError(400, `Invalid ${configLabel}: "info" must be a JSON object.`);
  }

  const record = raw as Record<string, unknown>;

  if (Object.hasOwn(record, 'password') && record.password !== undefined) {
    throw new CliError(
      400,
      `Invalid ${configLabel}: "info.password" is not supported (passwords must not be stored in ${configLabel}).\n` +
        'Use `cdpn privacy protected` or `cdpn info --access Protected --password <password>` instead.',
    );
  }

  const parsed: PenInfo = {};

  if (record.title !== undefined) {
    if (typeof record.title !== 'string') {
      throw new CliError(400, `Invalid ${configLabel}: "info.title" must be a string.`);
    }
    parsed.title = record.title;
  }

  if (record.description !== undefined) {
    if (typeof record.description !== 'string') {
      throw new CliError(400, `Invalid ${configLabel}: "info.description" must be a string.`);
    }
    parsed.description = record.description;
  }

  if (record.tags !== undefined) {
    if (!Array.isArray(record.tags) || !record.tags.every((t) => typeof t === 'string')) {
      throw new CliError(400, `Invalid ${configLabel}: "info.tags" must be an array of strings.`);
    }
    parsed.tags = record.tags.map((t) => t.trim()).filter(Boolean);
  }

  if (record.access !== undefined) {
    if (typeof record.access !== 'string') {
      throw new CliError(
        400,
        `Invalid ${configLabel}: "info.access" must be one of Public, Private, Protected, or Collaborators.`,
      );
    }
    const normalizedAccess = parseAccessValue(record.access);
    if (!normalizedAccess) {
      throw new CliError(
        400,
        `Invalid ${configLabel}: "info.access" value "${record.access}" is invalid. Use: Public, Private, Protected, or Collaborators.`,
      );
    }
    parsed.access = normalizedAccess;
  }

  if (record.template !== undefined) {
    if (typeof record.template !== 'boolean') {
      throw new CliError(400, `Invalid ${configLabel}: "info.template" must be a boolean.`);
    }
    parsed.template = record.template;
  }

  return parsed;
}

function areTagArraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Offline baseline check used by `cdpn pull` to detect whether the user has uncommitted local
 * edits to `info` inside `.cdpn.json`.
 *
 * Returns `false` for legacy `.cdpn.json` files without `info` so pulling seamlessly upgrades them.
 */
export function isLocalInfoDirty(
  localInfo: PenInfo | undefined,
  lastSyncedInfoHash: string | undefined,
): boolean {
  if (!hasAnyPenInfoFields(localInfo)) {
    return false;
  }

  if (lastSyncedInfoHash) {
    if (isCompletePenInfo(localInfo) && hashPenInfo(localInfo) === lastSyncedInfoHash) {
      return false;
    }
    return true;
  }

  // User explicitly provided `info` fields without a baseline hash -> protect local values on pull
  return true;
}

/**
 * Compares local `.cdpn.json` `info` (and optional `last_synced_info_hash` baseline) against
 * the remote Pen's metadata from CodePen.
 */
export function analyzeInfoSync(
  localInfo: PenInfo | undefined,
  lastSyncedInfoHash: string | undefined,
  remotePen: Pick<Pen, 'title' | 'description' | 'tags' | 'access' | 'template'>,
): InfoSyncAnalysis {
  const remoteInfo = extractPenInfo(remotePen);

  if (!hasAnyPenInfoFields(localInfo) || !localInfo) {
    return {
      tracked: false,
      localChanged: false,
      remoteChanged: false,
      changes: [],
      remoteInfo,
    };
  }

  const changes: InfoDiffItem[] = [];

  if (localInfo.title !== undefined && localInfo.title !== remoteInfo.title) {
    changes.push({ field: 'title', local: localInfo.title, remote: remoteInfo.title });
  }
  if (localInfo.description !== undefined && localInfo.description !== remoteInfo.description) {
    changes.push({
      field: 'description',
      local: localInfo.description,
      remote: remoteInfo.description,
    });
  }
  if (localInfo.tags !== undefined && !areTagArraysEqual(localInfo.tags, remoteInfo.tags)) {
    changes.push({
      field: 'tags',
      local: [...localInfo.tags],
      remote: [...remoteInfo.tags],
    });
  }
  if (localInfo.access !== undefined && localInfo.access !== remoteInfo.access) {
    changes.push({ field: 'access', local: localInfo.access, remote: remoteInfo.access });
  }
  if (localInfo.template !== undefined && localInfo.template !== remoteInfo.template) {
    changes.push({ field: 'template', local: localInfo.template, remote: remoteInfo.template });
  }

  if (changes.length === 0) {
    return {
      tracked: true,
      localChanged: false,
      remoteChanged: false,
      changes: [],
      remoteInfo,
    };
  }

  if (lastSyncedInfoHash) {
    const remoteChanged = hashPenInfo(remoteInfo) !== lastSyncedInfoHash;
    const localChanged = isCompletePenInfo(localInfo)
      ? hashPenInfo(localInfo) !== lastSyncedInfoHash
      : true;
    return {
      tracked: true,
      localChanged,
      remoteChanged,
      changes,
      remoteInfo,
    };
  }

  // No baseline hash (e.g. user manually added `info` to an older `.cdpn.json`): treat diffs as local edits
  return {
    tracked: true,
    localChanged: true,
    remoteChanged: false,
    changes,
    remoteInfo,
  };
}

/**
 * Validates and converts `InfoDiffItem[]` into a `PenUpdateRequest` payload for `PATCH /v2/pens/{id}`.
 */
export function buildInfoUpdatePatch(changes: InfoDiffItem[]): PenUpdateRequest {
  const patch: PenUpdateRequest = {};

  for (const item of changes) {
    switch (item.field) {
      case 'title':
        patch.title = item.local as string;
        break;
      case 'description':
        patch.description = item.local as string;
        break;
      case 'tags': {
        const tags = item.local as string[];
        if (tags.length > 5) {
          throw new CliError(
            400,
            `CodePen allows at most 5 tags per Pen (found ${tags.length} in .cdpn.json).`,
          );
        }
        patch.tags = [...tags];
        break;
      }
      case 'access': {
        const access = item.local as PenAccess;
        if (access === 'Protected' && item.remote !== 'Protected') {
          throw new CliError(
            400,
            'Cannot change Pen access to "Protected" via .cdpn.json because Protected Pens require a password (which is not stored in .cdpn.json).\n' +
              'Run `cdpn privacy protected` or `cdpn info --access Protected --password <password>` instead.',
          );
        }
        patch.access = access;
        break;
      }
      case 'template':
        patch.template = item.local as boolean;
        break;
    }
  }

  return patch;
}

/**
 * Updates a local `CdpnConfig` after an explicit metadata command (`cdpn info` or `cdpn privacy`)
 * patches CodePen, preserving any unpushed local edits to *other* `info` fields in `.cdpn.json`.
 */
export function mergeUpdatedPenInfoIntoConfig(
  config: CdpnConfig,
  updatedPen: Pick<Pen, 'title' | 'description' | 'tags' | 'access' | 'template'>,
  appliedPatch: PenUpdateRequest,
): CdpnConfig {
  const remoteInfo = extractPenInfo(updatedPen);
  const remoteHash = hashPenInfo(remoteInfo);

  if (!hasAnyPenInfoFields(config.info) || !isLocalInfoDirty(config.info, config.last_synced_info_hash)) {
    return {
      ...config,
      info: remoteInfo,
      last_synced_info_hash: remoteHash,
    };
  }

  // Local `info` has unpushed edits: apply only the patched fields from remote and backfill missing fields
  const merged: CompletePenInfo = {
    title:
      appliedPatch.title !== undefined
        ? remoteInfo.title
        : (config.info?.title ?? remoteInfo.title),
    description:
      appliedPatch.description !== undefined
        ? remoteInfo.description
        : (config.info?.description ?? remoteInfo.description),
    tags:
      appliedPatch.tags !== undefined
        ? [...remoteInfo.tags]
        : config.info?.tags !== undefined
          ? [...config.info.tags]
          : [...remoteInfo.tags],
    access:
      appliedPatch.access !== undefined
        ? remoteInfo.access
        : (config.info?.access ?? remoteInfo.access),
    template:
      appliedPatch.template !== undefined
        ? remoteInfo.template
        : (config.info?.template ?? remoteInfo.template),
  };

  return {
    ...config,
    info: merged,
    last_synced_info_hash: remoteHash,
  };
}

/**
 * Formats an `info` field value cleanly for single-line terminal diff output.
 */
export function formatInfoValue(field: PenInfoField, value: unknown): string {
  if (field === 'tags') {
    const arr = Array.isArray(value) ? (value as string[]) : [];
    return `[${arr.join(', ')}]`;
  }
  if (field === 'template') {
    return String(Boolean(value));
  }
  if (field === 'access') {
    return String(value ?? '');
  }
  const str = String(value ?? '');
  if (str.length > 60) {
    return JSON.stringify(`${str.slice(0, 57)}…`);
  }
  return JSON.stringify(str);
}
