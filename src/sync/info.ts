import crypto from 'node:crypto';
import type { Pen, PenAccess, PenUpdateRequest } from '../api/types.js';
import {
  type CdpnConfig,
  type CompletePenInfo,
  type PenInfo,
  normalizePartialPenInfo,
  parsePenInfoInput,
} from '../config/project.js';
import { MAX_PEN_TAGS } from '../constants.js';
import { CliError } from '../errors.js';

export { normalizePartialPenInfo, parsePenInfoInput };

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
        if (tags.length > MAX_PEN_TAGS) {
          throw new CliError(
            400,
            `CodePen allows at most ${MAX_PEN_TAGS} tags per Pen (found ${tags.length} in .cdpn.json).`,
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
