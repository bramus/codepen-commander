import fs from 'node:fs/promises';
import path from 'node:path';
import { CodePenClient } from '../api/client.js';
import { isCodePenApiError } from '../api/errors.js';
import type { Pen, PenAccess, TrashItem } from '../api/types.js';
import type { ResolvedAuth } from '../config/auth.js';
import {
  normalizePartialPenInfo,
  writeUnlinkedProjectInfo,
  type ProjectLocation,
} from '../config/project.js';
import {
  CODEPEN_DELETED_ITEMS_URL,
  CODEPEN_DIR,
  MAX_PEN_TAGS,
  PROJECT_CONFIG_FILENAME,
} from '../constants.js';
import { CliError } from '../errors.js';
import { scanLocalFiles } from '../sync/fs.js';
import {
  analyzeInfoSync,
  extractPenInfo,
  formatInfoValue,
  type InfoDiffItem,
} from '../sync/info.js';
import {
  assertValidProtectedPassword,
  normalizeAccess,
  resolveAccessOrVisibility,
} from '../utils/cli-options.js';
import { extractPenIdFromUrl } from '../utils/codepen-url.js';
import { fmt, formatDate, shortId } from '../utils/format.js';
import { extractHtmlTitle } from '../utils/html.js';
import { printJsonResponse } from '../utils/json.js';
import { defaultOutput, type CommandOutput } from '../utils/output.js';
import { promptConfirm, type SelectOption } from '../utils/prompts/index.js';
import { resolveCommandAuth } from './auth-context.js';
import { createPenFromDirectory } from './create-pen.js';
import type { DiscoveredPen } from './discover-pens.js';
import {
  isRemotePenNotFoundError,
  removeCodepenDirSafe,
  unlinkLinkedProject,
} from './missing-pen.js';
import { executePull } from './pull-pen.js';
import { executePush } from './push-pen.js';
import {
  formatFileDiffLines,
  formatSyncChangeSummary,
  inspectLinkedPenSyncState,
} from './sync-pen.js';

export type BatchMode = 'status' | 'push' | 'pull' | 'sync' | 'delete' | 'unlink';

export type BatchItemAction =
  | 'created'
  | 'pushed'
  | 'pulled'
  | 'deleted'
  | 'unlinked'
  | 'up-to-date'
  | 'skipped'
  | 'conflict'
  | 'error';

export interface BatchCounts {
  discovered: number;
  created: number;
  pushed: number;
  pulled: number;
  deleted: number;
  unlinked: number;
  upToDate: number;
  skipped: number;
  conflicts: number;
  errors: number;
}

export interface BatchItemResult {
  path: string;
  rootDir: string;
  action: BatchItemAction;
  dryRun: boolean;
  penId?: string;
  url?: string;
  title?: string;
  versionId?: string | null;
  reason?: string;
  error?: string;
}

export interface BatchExecutionResult {
  batch: true;
  mode: BatchMode;
  dryRun: boolean;
  rootDir: string;
  counts: BatchCounts;
  results: BatchItemResult[];
  aborted?: boolean;
  exitCode?: number;
}

export interface BatchPromptCallbacks {
  confirm?: (question: string, defaultYes?: boolean) => Promise<boolean>;
  select?: <T extends string>(
    question: string,
    options: SelectOption<T>[],
    defaultIndex?: number,
  ) => Promise<T>;
}

export interface BatchBaseOptions {
  rootDir: string;
  discovered: DiscoveredPen[];
  dryRun?: boolean;
  json?: boolean;
  interactive?: boolean;
  explicitProfile?: string;
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  output?: CommandOutput;
  prompts?: BatchPromptCallbacks;
}

export interface RunBatchPushOptions extends BatchBaseOptions {
  label?: string;
  force?: boolean;
  wait?: boolean;
  access?: string;
  visibility?: string;
  password?: string;
}

export interface RunBatchPullOptions extends BatchBaseOptions {
  force?: boolean;
}

export interface RunBatchSyncOptions extends BatchBaseOptions {
  label?: string;
  force?: boolean;
  wait?: boolean;
  access?: string;
  visibility?: string;
  password?: string;
}

export interface RunBatchDeleteOptions extends BatchBaseOptions {
  yes?: boolean;
  cleanup?: boolean;
  fullCleanup?: boolean;
}

export interface RunBatchUnlinkOptions extends BatchBaseOptions {
  yes?: boolean;
}

function createEmptyCounts(discoveredCount: number): BatchCounts {
  return {
    discovered: discoveredCount,
    created: 0,
    pushed: 0,
    pulled: 0,
    deleted: 0,
    unlinked: 0,
    upToDate: 0,
    skipped: 0,
    conflicts: 0,
    errors: 0,
  };
}

function formatErrorMessage(error: unknown, penId?: string, relPath?: string): string {
  if (isRemotePenNotFoundError(error) && penId) {
    const location = relPath ? ` inside ${relPath}` : '';
    return `Remote Pen (${penId}) not found on CodePen (it may be in Deleted Items — run \`cdpn status\` or \`cdpn restore\`${location}).`;
  }
  if (isCodePenApiError(error)) {
    return error.formatForUser();
  }
  return error instanceof Error ? error.message : String(error);
}

interface BatchAuthResolver {
  resolveForProject: (project: ProjectLocation) => Promise<{ auth: ResolvedAuth; client: CodePenClient }>;
  resolveFallback: () => Promise<{ auth: ResolvedAuth; client: CodePenClient }>;
}

function createBatchAuthResolver(options: {
  explicitProfile?: string;
  interactive: boolean;
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  output: CommandOutput;
  selectProfile?: BatchPromptCallbacks['select'];
}): BatchAuthResolver {
  const clientsByKey = new Map<string, CodePenClient>();
  let cachedFallback: { auth: ResolvedAuth; client: CodePenClient } | null = null;
  const cachedByProfile = new Map<string, { auth: ResolvedAuth; client: CodePenClient }>();

  function getClient(apiKey: string): CodePenClient {
    let client = clientsByKey.get(apiKey);
    if (!client) {
      client = new CodePenClient({ apiKey, baseUrl: options.baseUrl });
      clientsByKey.set(apiKey, client);
    }
    return client;
  }

  async function resolveFallback(): Promise<{ auth: ResolvedAuth; client: CodePenClient }> {
    if (cachedFallback) return cachedFallback;
    const auth = await resolveCommandAuth({
      explicitProfile: options.explicitProfile,
      promptMessage: 'Which CodePen account/profile would you like to use for unlinked Pens?',
      interactive: options.interactive,
      persistProfileToProject: false,
      output: options.output,
      env: options.env,
      homeDir: options.homeDir,
      selectProfile: options.selectProfile,
    });
    cachedFallback = { auth, client: getClient(auth.apiKey) };
    return cachedFallback;
  }

  async function resolveForProject(
    project: ProjectLocation,
  ): Promise<{ auth: ResolvedAuth; client: CodePenClient }> {
    const profileKey = options.explicitProfile ?? project.config.profile;
    if (!profileKey) {
      return resolveFallback();
    }
    const existing = cachedByProfile.get(profileKey);
    if (existing) return existing;

    const auth = await resolveCommandAuth({
      explicitProfile: options.explicitProfile,
      project,
      interactive: false,
      persistProfileToProject: false,
      output: options.output,
      env: options.env,
      homeDir: options.homeDir,
    });
    const resolved = { auth, client: getClient(auth.apiKey) };
    cachedByProfile.set(profileKey, resolved);
    return resolved;
  }

  return { resolveForProject, resolveFallback };
}

/**
 * Performs the upfront two-step confirmation for destructive batch commands (`delete` and `unlink`):
 * 1. First yes/No prompt (defaults to No) — bails out immediately if declined.
 * 2. Second confirmation `"Are you really sure?"` (defaults to No) — proceeds with all Pens only if confirmed.
 */
export async function confirmBatchDestructiveAction(options: {
  action: 'delete' | 'unlink';
  targets: Array<{ relPath: string; penId: string; url: string; title?: string }>;
  cleanup?: boolean;
  fullCleanup?: boolean;
  yes?: boolean;
  interactive: boolean;
  output: CommandOutput;
  confirm?: (question: string, defaultYes?: boolean) => Promise<boolean>;
}): Promise<boolean> {
  const { action, targets, cleanup, fullCleanup, yes, interactive, output } = options;
  if (yes || targets.length === 0) {
    return true;
  }

  if (!interactive) {
    throw new CliError(
      400,
      `Refusing to ${action} ${targets.length} Pen(s) in non-interactive mode without --yes.`,
    );
  }

  const confirmImpl = options.confirm ?? promptConfirm;
  const count = targets.length;
  const plural = count === 1 ? 'Pen' : 'Pens';

  output.log('');
  output.log(
    fmt.yellow(
      action === 'delete'
        ? `About to delete ${count} online ${plural} on CodePen:`
        : `About to unlink ${count} local ${plural} from CodePen:`,
    ),
  );
  for (const target of targets) {
    const titlePart = target.title ? ` — ${target.title}` : '';
    output.log(
      `  ${fmt.cyan(target.relPath)}${titlePart} ${fmt.dim(`(${target.url || target.penId})`)}`,
    );
  }

  if (action === 'delete') {
    output.log(
      fmt.dim(
        fullCleanup
          ? `\nLocal source files will stay untouched; ${PROJECT_CONFIG_FILENAME} and ${CODEPEN_DIR}/ will be removed from each folder after deletion succeeds.`
          : cleanup
            ? `\nLocal source files will stay untouched; ${CODEPEN_DIR}/ will be removed and only "info" will be kept in ${PROJECT_CONFIG_FILENAME} (unlinked) after deletion succeeds.`
            : `\nLocal source files, ${PROJECT_CONFIG_FILENAME}, and ${CODEPEN_DIR}/ will stay untouched so you can restore Pens with \`cdpn restore\`.`,
      ),
    );
  } else {
    output.log(
      fmt.dim(
        `\nOnline Pens on CodePen, ${CODEPEN_DIR}/, and all local source files will stay untouched.\n` +
          `Only the remote link fields in each ${PROJECT_CONFIG_FILENAME} will be cleared (keeping "info").`,
      ),
    );
  }
  output.log('');

  const firstQuestion =
    action === 'delete'
      ? fullCleanup
        ? `Delete ${count} online ${plural} on CodePen (moves to Deleted Items for 3 days) and remove ${PROJECT_CONFIG_FILENAME} and ${CODEPEN_DIR}/?`
        : cleanup
          ? `Delete ${count} online ${plural} on CodePen (moves to Deleted Items for 3 days), remove ${CODEPEN_DIR}/, and keep only "info" in ${PROJECT_CONFIG_FILENAME}?`
          : `Delete ${count} online ${plural} on CodePen (moves to Deleted Items for 3 days)?`
      : `Unlink ${count} local ${plural} from CodePen (keeps online Pens, ${CODEPEN_DIR}/, and "info" in ${PROJECT_CONFIG_FILENAME})?`;

  const firstOk = await confirmImpl(firstQuestion, false);
  if (!firstOk) {
    output.log('Aborted.');
    return false;
  }

  const secondOk = await confirmImpl('Are you really sure?', false);
  if (!secondOk) {
    output.log('Aborted.');
    return false;
  }

  output.log('');
  return true;
}

function buildSummaryMessage(mode: BatchMode, counts: BatchCounts, dryRun: boolean): string {
  const prefix = dryRun ? '[DRY RUN] ' : '';
  const parts: string[] = [];
  if (mode === 'push' || mode === 'sync') {
    parts.push(`${counts.created} created`, `${counts.pushed} pushed`);
  }
  if (mode === 'pull' || mode === 'sync') {
    parts.push(`${counts.pulled} pulled`);
  }
  if (mode === 'delete') {
    parts.push(`${counts.deleted} deleted`);
  }
  if (mode === 'unlink') {
    parts.push(`${counts.unlinked} unlinked`);
  }
  if (mode === 'push' || mode === 'pull' || mode === 'sync') {
    parts.push(`${counts.upToDate} up to date`);
  }
  parts.push(`${counts.skipped} skipped`);
  if (mode === 'push' || mode === 'pull' || mode === 'sync') {
    parts.push(`${counts.conflicts} conflicts`);
  }
  parts.push(`${counts.errors} errors`);
  return `${prefix}Batch ${mode} complete (${counts.discovered} discovered): ${parts.join(', ')}.`;
}

function finalizeBatchResult(options: {
  mode: BatchMode;
  dryRun: boolean;
  rootDir: string;
  counts: BatchCounts;
  results: BatchItemResult[];
  jsonMode: boolean;
  output: CommandOutput;
}): BatchExecutionResult {
  const { mode, dryRun, rootDir, counts, results, jsonMode, output } = options;
  const hasBlockingFailure = counts.errors > 0 || (!dryRun && counts.conflicts > 0);
  const exitCode = hasBlockingFailure ? 1 : undefined;

  if (jsonMode) {
    const statusCode =
      counts.errors > 0 ? 500 : !dryRun && counts.conflicts > 0 ? 409 : 200;
    printJsonResponse(
      statusCode,
      buildSummaryMessage(mode, counts, dryRun),
      {
        batch: true,
        mode,
        dry_run: dryRun,
        root_dir: rootDir,
        counts: {
          discovered: counts.discovered,
          created: counts.created,
          pushed: counts.pushed,
          pulled: counts.pulled,
          deleted: counts.deleted,
          unlinked: counts.unlinked,
          up_to_date: counts.upToDate,
          skipped: counts.skipped,
          conflicts: counts.conflicts,
          errors: counts.errors,
        },
        results: results.map((item) => ({
          path: item.path,
          root_dir: item.rootDir,
          action: item.action,
          dry_run: item.dryRun,
          ...(item.penId ? { pen_id: item.penId } : {}),
          ...(item.url ? { url: item.url } : {}),
          ...(item.title ? { title: item.title } : {}),
          ...(item.versionId !== undefined ? { version_id: item.versionId } : {}),
          ...(item.reason ? { reason: item.reason } : {}),
          ...(item.error ? { error: item.error } : {}),
        })),
      },
      output,
    );
  } else {
    const prefix = dryRun ? '[DRY RUN] ' : '';
    output.log(`\n${fmt.bold(`${prefix}Summary (${mode}):`)}`);
    output.log(`  Found:      ${counts.discovered}`);
    if (mode === 'push' || mode === 'sync') {
      output.log(`  Created:    ${counts.created}`);
      output.log(`  Pushed:     ${counts.pushed}`);
    }
    if (mode === 'pull' || mode === 'sync') {
      output.log(`  Pulled:     ${counts.pulled}`);
    }
    if (mode === 'delete') {
      output.log(`  Deleted:    ${counts.deleted}`);
    }
    if (mode === 'unlink') {
      output.log(`  Unlinked:   ${counts.unlinked}`);
    }
    if (mode === 'push' || mode === 'pull' || mode === 'sync') {
      output.log(`  Up to date: ${counts.upToDate}`);
    }
    output.log(`  Skipped:    ${counts.skipped}`);
    if (mode === 'push' || mode === 'pull' || mode === 'sync') {
      output.log(`  Conflicts:  ${counts.conflicts}`);
    }
    output.log(`  Errors:     ${counts.errors}`);

    if (mode === 'delete' && !dryRun && counts.deleted > 0) {
      output.log(
        `\n${fmt.dim('Deleted Pens move to CodePen Deleted Items (restorable for 3 days):')}`,
      );
      output.log(`  ${fmt.cyan(CODEPEN_DELETED_ITEMS_URL)}`);
    }

    const conflicts = results.filter((r) => r.action === 'conflict');
    if (conflicts.length > 0) {
      output.log(`\n${fmt.yellow('Conflicts requiring manual resolution:')}`);
      for (const c of conflicts) {
        output.log(`  - ${c.path}${c.url ? ` (${c.url})` : ''}`);
      }
    }

    const errors = results.filter((r) => r.action === 'error');
    if (errors.length > 0) {
      output.log(`\n${fmt.red('Errors:')}`);
      for (const e of errors) {
        output.log(`  - ${e.path}: ${e.error ?? 'Unknown error'}`);
      }
    }
  }

  return {
    batch: true,
    mode,
    dryRun,
    rootDir,
    counts,
    results,
    ...(exitCode !== undefined ? { exitCode } : {}),
  };
}

function logBatchHeader(
  mode: BatchMode,
  discoveredCount: number,
  dryRun: boolean,
  jsonMode: boolean,
  output: CommandOutput,
): void {
  if (jsonMode) return;
  const prefix = dryRun ? `${fmt.cyan('[DRY RUN]')} ` : '';
  const plural = discoveredCount === 1 ? 'Pen' : 'Pens';
  output.log(
    `${prefix}Walking directory tree (${fmt.bold(mode)}) — found ${fmt.bold(String(discoveredCount))} ${plural}.\n`,
  );
}

function logConflictDetails(
  relPath: string,
  inspection: Awaited<ReturnType<typeof inspectLinkedPenSyncState>>,
  output: CommandOutput,
): void {
  output.log(`${fmt.yellow('! [CONFLICT]')} ${fmt.bold(relPath)}`);
  output.log(`    Pen:            ${fmt.cyan(inspection.pen.urls.editor || inspection.pen.id)}`);
  if (inspection.remoteVersionChanged) {
    output.log(
      `    Synced version: ${shortId(inspection.localHead)} → Remote head: ${shortId(inspection.remoteHead)}`,
    );
  }
  if (!inspection.hasFileBaseline) {
    output.log(
      `    Local baseline missing in ${PROJECT_CONFIG_FILENAME}; cannot rule out local edits.`,
    );
  }
  if (inspection.diffCount > 0) {
    for (const line of formatFileDiffLines(inspection.diff, 'push', '    ')) {
      output.log(line);
    }
  }
  if (inspection.infoAnalysis.changes.length > 0) {
    const fields = inspection.infoAnalysis.changes.map((c) => c.field).join(', ');
    output.log(`    Pen info differences: ${fields}`);
  }
  output.log(
    fmt.dim(
      `    Resolve in ${relPath}: run \`cdpn status\`, then \`cdpn push --force\` or \`cdpn pull --force\`.`,
    ),
  );
}

async function handleBatchUnlinkedCreate(options: {
  pen: DiscoveredPen;
  retainedInfo: { title?: string; description?: string; tags?: string[]; access?: PenAccess; template?: boolean };
  resolvedAccess?: PenAccess;
  password?: string;
  force?: boolean;
  wait?: boolean;
  dryRun: boolean;
  jsonMode: boolean;
  authResolver: BatchAuthResolver;
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  output: CommandOutput;
  counts: BatchCounts;
  results: BatchItemResult[];
}): Promise<void> {
  const {
    pen,
    retainedInfo,
    resolvedAccess,
    password,
    force,
    wait,
    dryRun,
    jsonMode,
    authResolver,
    output,
    counts,
    results,
  } = options;

  try {
    const effectiveAccess = resolvedAccess ?? normalizeAccess(retainedInfo.access) ?? 'Public';
    if (retainedInfo.tags && retainedInfo.tags.length > MAX_PEN_TAGS) {
      throw new CliError(
        400,
        `CodePen allows at most ${MAX_PEN_TAGS} tags per Pen (found ${retainedInfo.tags.length} in ${PROJECT_CONFIG_FILENAME}).`,
      );
    }
    assertValidProtectedPassword(effectiveAccess, password, false);

    const scanned = await scanLocalFiles(pen.rootDir);
    if (scanned.size === 0) {
      throw new CliError(
        400,
        `No syncable files found in ${pen.relPath} (only an unlinked ${PROJECT_CONFIG_FILENAME} is present).`,
      );
    }

    const indexFile = scanned.get('/index.html');
    if (!indexFile && !force) {
      throw new CliError(
        400,
        `No index.html found in ${pen.relPath}. Pass --force to push without an index.html.`,
      );
    }

    const htmlTitle =
      indexFile && !indexFile.isBinary && indexFile.textContent
        ? extractHtmlTitle(indexFile.textContent)
        : null;
    const title = retainedInfo.title?.trim() || htmlTitle || path.basename(pen.rootDir) || 'Untitled';

    if (dryRun) {
      if (!jsonMode) {
        output.log(
          `${fmt.green('+ [WOULD CREATE]')} ${fmt.bold(pen.relPath)} — new ${effectiveAccess} Pen "${title}" (${scanned.size} file(s))`,
        );
      }
      counts.created++;
      results.push({
        path: pen.relPath,
        rootDir: pen.rootDir,
        action: 'created',
        dryRun: true,
        title,
      });
      return;
    }

    const { auth } = await authResolver.resolveFallback();
    if (!jsonMode) {
      output.log(
        `${fmt.green('+ [CREATING]')} ${fmt.bold(pen.relPath)} — creating new ${effectiveAccess} Pen "${title}"…`,
      );
    }

    const created = await createPenFromDirectory({
      targetDir: pen.rootDir,
      folderDisplay: pen.relPath,
      explicitProfile: auth.profile ?? undefined,
      access: effectiveAccess,
      password,
      force,
      wait,
      silent: true,
      interactive: false,
      baseUrl: options.baseUrl,
      env: options.env,
      homeDir: options.homeDir,
      output,
    });

    if (!created) {
      counts.skipped++;
      results.push({
        path: pen.relPath,
        rootDir: pen.rootDir,
        action: 'skipped',
        dryRun: false,
        reason: 'Canceled',
      });
      return;
    }

    if (created.exitCode) {
      const msg = `Created Pen ${created.pen.urls.editor || created.pen.id}, but the initial build failed.`;
      if (!jsonMode) {
        output.log(`  ${fmt.red('✗')} ${msg}`);
      }
      counts.errors++;
      results.push({
        path: pen.relPath,
        rootDir: pen.rootDir,
        action: 'error',
        dryRun: false,
        penId: created.pen.id,
        url: created.pen.urls.editor,
        title: created.pen.title,
        versionId: created.versionId,
        error: msg,
      });
      return;
    }

    if (!jsonMode) {
      output.log(
        `  ${fmt.green('✓')} Created ${created.pen.access} Pen: ${fmt.cyan(created.pen.urls.editor || created.pen.id)}`,
      );
    }
    counts.created++;
    results.push({
      path: pen.relPath,
      rootDir: pen.rootDir,
      action: 'created',
      dryRun: false,
      penId: created.pen.id,
      url: created.pen.urls.editor,
      title: created.pen.title,
      versionId: created.versionId,
    });
  } catch (error) {
    const message = formatErrorMessage(error);
    if (!jsonMode) {
      output.log(`${fmt.red('✗ [ERROR]')} ${fmt.bold(pen.relPath)}`);
      output.log(`    ${message}`);
    }
    counts.errors++;
    results.push({
      path: pen.relPath,
      rootDir: pen.rootDir,
      action: 'error',
      dryRun,
      error: message,
    });
  }
}

async function runBatchPushOrSync(
  mode: 'push' | 'sync',
  options: RunBatchPushOptions | RunBatchSyncOptions,
): Promise<BatchExecutionResult> {
  const output = options.output ?? defaultOutput;
  const dryRun = Boolean(options.dryRun);
  const jsonMode = Boolean(options.json);
  const interactive = !jsonMode && Boolean(options.interactive);
  const force = Boolean(options.force);
  const resolvedAccess = resolveAccessOrVisibility(options.access, options.visibility);
  assertValidProtectedPassword(resolvedAccess, options.password, false);

  const counts = createEmptyCounts(options.discovered.length);
  const results: BatchItemResult[] = [];

  logBatchHeader(mode, options.discovered.length, dryRun, jsonMode, output);

  const authResolver = createBatchAuthResolver({
    explicitProfile: options.explicitProfile,
    interactive,
    baseUrl: options.baseUrl,
    env: options.env,
    homeDir: options.homeDir,
    output,
    selectProfile: options.prompts?.select,
  });

  // Validate explicit profile early if provided (fail fast on typo or missing key)
  if (options.explicitProfile) {
    await authResolver.resolveFallback();
  }

  for (const pen of options.discovered) {
    if (pen.parseError || !pen.parsed) {
      const message = pen.parseError ?? `Invalid ${PROJECT_CONFIG_FILENAME}`;
      if (!jsonMode) {
        output.log(`${fmt.red('✗ [ERROR]')} ${fmt.bold(pen.relPath)}`);
        output.log(`    ${message}`);
      }
      counts.errors++;
      results.push({
        path: pen.relPath,
        rootDir: pen.rootDir,
        action: 'error',
        dryRun,
        error: message,
      });
      continue;
    }

    if (!pen.parsed.linked) {
      await handleBatchUnlinkedCreate({
        pen,
        retainedInfo: pen.parsed.config.info,
        resolvedAccess,
        password: options.password,
        force,
        wait: options.wait,
        dryRun,
        jsonMode,
        authResolver,
        baseUrl: options.baseUrl,
        env: options.env,
        homeDir: options.homeDir,
        output,
        counts,
        results,
      });
      continue;
    }

    const project: ProjectLocation = {
      rootDir: pen.rootDir,
      configPath: pen.configPath,
      config: pen.parsed.config,
    };

    try {
      const { auth, client } = await authResolver.resolveForProject(project);
      const inspection = await inspectLinkedPenSyncState(client, project);

      if (inspection.state === 'up-to-date') {
        if (!jsonMode) {
          output.log(`${fmt.green('✓ [UP TO DATE]')} ${pen.relPath}`);
        }
        counts.upToDate++;
        results.push({
          path: pen.relPath,
          rootDir: pen.rootDir,
          action: 'up-to-date',
          dryRun,
          penId: inspection.pen.id,
          url: inspection.pen.urls.editor,
          title: inspection.pen.title,
          versionId: inspection.remoteHead,
        });
        continue;
      }

      if (inspection.state === 'conflict' && !(mode === 'push' && force)) {
        if (!jsonMode) {
          logConflictDetails(pen.relPath, inspection, output);
        }
        counts.conflicts++;
        results.push({
          path: pen.relPath,
          rootDir: pen.rootDir,
          action: 'conflict',
          dryRun,
          penId: inspection.pen.id,
          url: inspection.pen.urls.editor,
          title: inspection.pen.title,
          versionId: inspection.remoteHead,
          reason: 'Both local and remote have changed',
        });
        continue;
      }

      const isRemoteAhead =
        inspection.state === 'remote-ahead' || inspection.state === 'remote-metadata-ahead';

      if (isRemoteAhead && mode === 'push' && !force) {
        const remoteSummary = formatSyncChangeSummary(
          inspection.diffCount,
          inspection.infoAnalysis.changes,
        );
        if (!jsonMode) {
          output.log(
            `${fmt.dim('- [SKIP]')} ${pen.relPath} — remote is ahead (${remoteSummary}); run \`cdpn pull\` or \`cdpn sync\``,
          );
        }
        counts.skipped++;
        results.push({
          path: pen.relPath,
          rootDir: pen.rootDir,
          action: 'skipped',
          dryRun,
          penId: inspection.pen.id,
          url: inspection.pen.urls.editor,
          title: inspection.pen.title,
          reason: `Remote is ahead (${remoteSummary})`,
        });
        continue;
      }

      // --- PULL (in sync mode when remote is ahead) ---
      if (isRemoteAhead && mode === 'sync') {
        const remoteSummary = formatSyncChangeSummary(
          inspection.diffCount,
          inspection.infoAnalysis.changes,
        );
        const versionRange =
          inspection.remoteVersionChanged
            ? `${shortId(inspection.localHead)} → ${shortId(inspection.remoteHead)}, `
            : '';

        if (dryRun) {
          if (!jsonMode) {
            output.log(
              `${fmt.cyan('↓ [WOULD PULL]')} ${fmt.bold(pen.relPath)} (${versionRange}${remoteSummary})`,
            );
            for (const line of formatFileDiffLines(inspection.diff, 'pull')) {
              output.log(line);
            }
          }
          counts.pulled++;
          results.push({
            path: pen.relPath,
            rootDir: pen.rootDir,
            action: 'pulled',
            dryRun: true,
            penId: inspection.pen.id,
            url: inspection.pen.urls.editor,
            title: inspection.pen.title,
            versionId: inspection.remoteHead,
          });
          continue;
        }

        if (!jsonMode) {
          output.log(
            `${fmt.cyan('↓ [PULLING]')} ${fmt.bold(pen.relPath)} (${versionRange}${remoteSummary})…`,
          );
        }

        const pullRes = await executePull(client, project, auth, {
          force: inspection.state === 'remote-metadata-ahead',
          dryRun: false,
          silent: true,
          interactive: false,
          prefetchedPen: inspection.pen,
          prefetchedRemoteFiles: inspection.remoteFiles,
          prefetchedLocalFiles: inspection.localFiles,
          handleMissingPen: false,
          output,
        });

        const writtenCount = pullRes?.writtenPaths.length ?? 0;
        const deletedCount = pullRes?.deletedPaths.length ?? 0;
        if (!jsonMode) {
          output.log(
            `  ${fmt.green('✓')} Pulled (version ${shortId(inspection.remoteHead)}, updated ${writtenCount}, removed ${deletedCount})`,
          );
        }
        counts.pulled++;
        results.push({
          path: pen.relPath,
          rootDir: pen.rootDir,
          action: 'pulled',
          dryRun: false,
          penId: inspection.pen.id,
          url: inspection.pen.urls.editor,
          title: inspection.pen.title,
          versionId: inspection.remoteHead,
        });
        continue;
      }

      // --- PUSH (local-ahead, or forced push over remote-ahead / conflict) ---
      if (inspection.classicReadOnly) {
        throw new CliError(
          403,
          'This is a Classic Pen, which is read-only in CodePen API v2. Only CodePen 2.0 Pens can be pushed.',
        );
      }

      const changeSummary = formatSyncChangeSummary(
        inspection.diffCount,
        inspection.infoAnalysis.changes,
        'forced overwrite',
      );
      const isForced = mode === 'push' && force && inspection.state !== 'local-ahead';

      if (dryRun) {
        if (!jsonMode) {
          output.log(
            `${fmt.cyan(isForced ? '↑ [WOULD FORCE PUSH]' : '↑ [WOULD PUSH]')} ${fmt.bold(pen.relPath)} (${changeSummary})`,
          );
          for (const line of formatFileDiffLines(inspection.diff, 'push')) {
            output.log(line);
          }
        }
        counts.pushed++;
        results.push({
          path: pen.relPath,
          rootDir: pen.rootDir,
          action: 'pushed',
          dryRun: true,
          penId: inspection.pen.id,
          url: inspection.pen.urls.editor,
          title: inspection.pen.title,
          versionId: inspection.remoteHead,
        });
        continue;
      }

      if (!jsonMode) {
        output.log(
          `${fmt.cyan(isForced ? '↑ [FORCE PUSHING]' : '↑ [PUSHING]')} ${fmt.bold(pen.relPath)} (${changeSummary})…`,
        );
        for (const line of formatFileDiffLines(inspection.diff, 'push')) {
          output.log(line);
        }
      }

      const pushRes = await executePush(client, project, {
        label: options.label,
        force: mode === 'push' && force,
        dryRun: false,
        wait: options.wait,
        silent: true,
        output,
        prefetchedPen: inspection.pen,
      });

      if (pushRes.exitCode) {
        const msg = `Files were saved as version ${shortId(pushRes.versionId)}, but the build failed.`;
        if (!jsonMode) {
          output.log(`  ${fmt.red('✗')} ${msg}`);
        }
        counts.errors++;
        results.push({
          path: pen.relPath,
          rootDir: pen.rootDir,
          action: 'error',
          dryRun: false,
          penId: pushRes.pen.id,
          url: pushRes.pen.urls.editor,
          title: pushRes.pen.title,
          versionId: pushRes.versionId,
          error: msg,
        });
        continue;
      }

      if (!jsonMode) {
        output.log(`  ${fmt.green('✓')} Pushed (version ${shortId(pushRes.versionId)})`);
      }
      counts.pushed++;
      results.push({
        path: pen.relPath,
        rootDir: pen.rootDir,
        action: 'pushed',
        dryRun: false,
        penId: pushRes.pen.id,
        url: pushRes.pen.urls.editor,
        title: pushRes.pen.title,
        versionId: pushRes.versionId,
      });
    } catch (error) {
      const message = formatErrorMessage(error, project.config.pen_id, pen.relPath);
      if (!jsonMode) {
        output.log(`${fmt.red('✗ [ERROR]')} ${fmt.bold(pen.relPath)}`);
        output.log(`    ${message}`);
      }
      counts.errors++;
      results.push({
        path: pen.relPath,
        rootDir: pen.rootDir,
        action: 'error',
        dryRun,
        penId: project.config.pen_id,
        url: project.config.url,
        error: message,
      });
    }
  }

  return finalizeBatchResult({
    mode,
    dryRun,
    rootDir: options.rootDir,
    counts,
    results,
    jsonMode,
    output,
  });
}

export async function runBatchPush(options: RunBatchPushOptions): Promise<BatchExecutionResult> {
  return runBatchPushOrSync('push', options);
}

export async function runBatchSync(options: RunBatchSyncOptions): Promise<BatchExecutionResult> {
  return runBatchPushOrSync('sync', options);
}

export async function runBatchPull(options: RunBatchPullOptions): Promise<BatchExecutionResult> {
  const output = options.output ?? defaultOutput;
  const dryRun = Boolean(options.dryRun);
  const jsonMode = Boolean(options.json);
  const interactive = !jsonMode && Boolean(options.interactive);
  const force = Boolean(options.force);

  const counts = createEmptyCounts(options.discovered.length);
  const results: BatchItemResult[] = [];

  logBatchHeader('pull', options.discovered.length, dryRun, jsonMode, output);

  const authResolver = createBatchAuthResolver({
    explicitProfile: options.explicitProfile,
    interactive,
    baseUrl: options.baseUrl,
    env: options.env,
    homeDir: options.homeDir,
    output,
    selectProfile: options.prompts?.select,
  });

  if (options.explicitProfile) {
    await authResolver.resolveFallback();
  }

  for (const pen of options.discovered) {
    if (pen.parseError || !pen.parsed) {
      const message = pen.parseError ?? `Invalid ${PROJECT_CONFIG_FILENAME}`;
      if (!jsonMode) {
        output.log(`${fmt.red('✗ [ERROR]')} ${fmt.bold(pen.relPath)}`);
        output.log(`    ${message}`);
      }
      counts.errors++;
      results.push({
        path: pen.relPath,
        rootDir: pen.rootDir,
        action: 'error',
        dryRun,
        error: message,
      });
      continue;
    }

    if (!pen.parsed.linked) {
      if (!jsonMode) {
        output.log(
          `${fmt.dim('- [SKIP]')} ${pen.relPath} — unlinked (info-only ${PROJECT_CONFIG_FILENAME}); nothing to pull`,
        );
      }
      counts.skipped++;
      results.push({
        path: pen.relPath,
        rootDir: pen.rootDir,
        action: 'skipped',
        dryRun,
        reason: `Unlinked (info-only ${PROJECT_CONFIG_FILENAME})`,
      });
      continue;
    }

    const project: ProjectLocation = {
      rootDir: pen.rootDir,
      configPath: pen.configPath,
      config: pen.parsed.config,
    };

    try {
      const { auth, client } = await authResolver.resolveForProject(project);

      if (force) {
        if (dryRun) {
          const preview = await executePull(client, project, auth, {
            force: true,
            dryRun: true,
            silent: true,
            interactive: false,
            handleMissingPen: false,
            output,
          });
          const changeDesc = formatSyncChangeSummary(
            (preview?.writtenPaths.length ?? 0) + (preview?.deletedPaths.length ?? 0),
            preview?.infoChanges ?? [],
            'refresh',
          );
          if (!jsonMode) {
            output.log(
              `${fmt.cyan('↓ [WOULD FORCE PULL]')} ${fmt.bold(pen.relPath)} (${changeDesc})`,
            );
          }
          counts.pulled++;
          results.push({
            path: pen.relPath,
            rootDir: pen.rootDir,
            action: 'pulled',
            dryRun: true,
            penId: preview?.pen.id ?? project.config.pen_id,
            url: preview?.pen.urls.editor ?? project.config.url,
            title: preview?.pen.title,
            versionId: preview?.pen.saved_version?.id ?? null,
          });
          continue;
        }

        if (!jsonMode) {
          output.log(
            `${fmt.cyan('↓ [FORCE PULLING]')} ${fmt.bold(pen.relPath)} (${shortId(project.config.last_synced_version_id)})…`,
          );
        }
        const pullRes = await executePull(client, project, auth, {
          force: true,
          dryRun: false,
          silent: true,
          interactive: false,
          handleMissingPen: false,
          output,
        });
        const writtenCount = pullRes?.writtenPaths.length ?? 0;
        const deletedCount = pullRes?.deletedPaths.length ?? 0;
        const nextVersion = pullRes?.pen.saved_version?.id ?? null;
        if (!jsonMode) {
          output.log(
            `  ${fmt.green('✓')} Pulled (version ${shortId(nextVersion)}, updated ${writtenCount}, removed ${deletedCount})`,
          );
        }
        counts.pulled++;
        results.push({
          path: pen.relPath,
          rootDir: pen.rootDir,
          action: 'pulled',
          dryRun: false,
          penId: pullRes?.pen.id ?? project.config.pen_id,
          url: pullRes?.pen.urls.editor ?? project.config.url,
          title: pullRes?.pen.title,
          versionId: nextVersion,
        });
        continue;
      }

      const inspection = await inspectLinkedPenSyncState(client, project);

      if (inspection.state === 'up-to-date') {
        if (!jsonMode) {
          output.log(`${fmt.green('✓ [UP TO DATE]')} ${pen.relPath}`);
        }
        counts.upToDate++;
        results.push({
          path: pen.relPath,
          rootDir: pen.rootDir,
          action: 'up-to-date',
          dryRun,
          penId: inspection.pen.id,
          url: inspection.pen.urls.editor,
          title: inspection.pen.title,
          versionId: inspection.remoteHead,
        });
        continue;
      }

      if (inspection.state === 'local-ahead') {
        const changeSummary = formatSyncChangeSummary(
          inspection.diffCount,
          inspection.infoAnalysis.changes,
        );
        if (!jsonMode) {
          output.log(
            `${fmt.dim('- [SKIP]')} ${pen.relPath} — local has unpushed changes (${changeSummary}); run \`cdpn push\` or \`cdpn sync\``,
          );
        }
        counts.skipped++;
        results.push({
          path: pen.relPath,
          rootDir: pen.rootDir,
          action: 'skipped',
          dryRun,
          penId: inspection.pen.id,
          url: inspection.pen.urls.editor,
          title: inspection.pen.title,
          reason: `Local has unpushed changes (${changeSummary})`,
        });
        continue;
      }

      if (inspection.state === 'conflict') {
        if (!jsonMode) {
          logConflictDetails(pen.relPath, inspection, output);
        }
        counts.conflicts++;
        results.push({
          path: pen.relPath,
          rootDir: pen.rootDir,
          action: 'conflict',
          dryRun,
          penId: inspection.pen.id,
          url: inspection.pen.urls.editor,
          title: inspection.pen.title,
          versionId: inspection.remoteHead,
          reason: 'Both local and remote have changed',
        });
        continue;
      }

      // remote-ahead or remote-metadata-ahead
      const remoteSummary = formatSyncChangeSummary(
        inspection.diffCount,
        inspection.infoAnalysis.changes,
      );
      const versionRange = inspection.remoteVersionChanged
        ? `${shortId(inspection.localHead)} → ${shortId(inspection.remoteHead)}, `
        : '';

      if (dryRun) {
        if (!jsonMode) {
          output.log(
            `${fmt.cyan('↓ [WOULD PULL]')} ${fmt.bold(pen.relPath)} (${versionRange}${remoteSummary})`,
          );
          for (const line of formatFileDiffLines(inspection.diff, 'pull')) {
            output.log(line);
          }
        }
        counts.pulled++;
        results.push({
          path: pen.relPath,
          rootDir: pen.rootDir,
          action: 'pulled',
          dryRun: true,
          penId: inspection.pen.id,
          url: inspection.pen.urls.editor,
          title: inspection.pen.title,
          versionId: inspection.remoteHead,
        });
        continue;
      }

      if (!jsonMode) {
        output.log(
          `${fmt.cyan('↓ [PULLING]')} ${fmt.bold(pen.relPath)} (${versionRange}${remoteSummary})…`,
        );
      }

      const pullRes = await executePull(client, project, auth, {
        force: inspection.state === 'remote-metadata-ahead',
        dryRun: false,
        silent: true,
        interactive: false,
        prefetchedPen: inspection.pen,
        prefetchedRemoteFiles: inspection.remoteFiles,
        prefetchedLocalFiles: inspection.localFiles,
        handleMissingPen: false,
        output,
      });

      const writtenCount = pullRes?.writtenPaths.length ?? 0;
      const deletedCount = pullRes?.deletedPaths.length ?? 0;
      if (!jsonMode) {
        output.log(
          `  ${fmt.green('✓')} Pulled (version ${shortId(inspection.remoteHead)}, updated ${writtenCount}, removed ${deletedCount})`,
        );
      }
      counts.pulled++;
      results.push({
        path: pen.relPath,
        rootDir: pen.rootDir,
        action: 'pulled',
        dryRun: false,
        penId: inspection.pen.id,
        url: inspection.pen.urls.editor,
        title: inspection.pen.title,
        versionId: inspection.remoteHead,
      });
    } catch (error) {
      const message = formatErrorMessage(error, project.config.pen_id, pen.relPath);
      if (!jsonMode) {
        output.log(`${fmt.red('✗ [ERROR]')} ${fmt.bold(pen.relPath)}`);
        output.log(`    ${message}`);
      }
      counts.errors++;
      results.push({
        path: pen.relPath,
        rootDir: pen.rootDir,
        action: 'error',
        dryRun,
        penId: project.config.pen_id,
        url: project.config.url,
        error: message,
      });
    }
  }

  return finalizeBatchResult({
    mode: 'pull',
    dryRun,
    rootDir: options.rootDir,
    counts,
    results,
    jsonMode,
    output,
  });
}

export async function runBatchDelete(
  options: RunBatchDeleteOptions,
): Promise<BatchExecutionResult | null> {
  const output = options.output ?? defaultOutput;
  const dryRun = Boolean(options.dryRun);
  const jsonMode = Boolean(options.json);
  const interactive = !jsonMode && Boolean(options.interactive);
  const cleanup = Boolean(options.cleanup);
  const fullCleanup = Boolean(options.fullCleanup);

  const linkedTargets = options.discovered
    .filter((pen) => pen.parsed?.linked)
    .map((pen) => {
      const cfg = (pen.parsed as { linked: true; config: ProjectLocation['config'] }).config;
      return {
        relPath: pen.relPath,
        penId: cfg.pen_id,
        url: cfg.url,
        title: cfg.info?.title,
      };
    });

  if (!dryRun && linkedTargets.length > 0) {
    const confirmed = await confirmBatchDestructiveAction({
      action: 'delete',
      targets: linkedTargets,
      cleanup,
      fullCleanup,
      yes: options.yes,
      interactive,
      output,
      confirm: options.prompts?.confirm,
    });
    if (!confirmed) {
      return null;
    }
  }

  const counts = createEmptyCounts(options.discovered.length);
  const results: BatchItemResult[] = [];

  logBatchHeader('delete', options.discovered.length, dryRun, jsonMode, output);

  const authResolver = createBatchAuthResolver({
    explicitProfile: options.explicitProfile,
    interactive,
    baseUrl: options.baseUrl,
    env: options.env,
    homeDir: options.homeDir,
    output,
    selectProfile: options.prompts?.select,
  });

  if (!dryRun && options.explicitProfile && linkedTargets.length > 0) {
    await authResolver.resolveFallback();
  }

  const localActionNote = fullCleanup
    ? `removing ${PROJECT_CONFIG_FILENAME} and ${CODEPEN_DIR}/`
    : cleanup
      ? `removing ${CODEPEN_DIR}/ and retaining info in ${PROJECT_CONFIG_FILENAME}`
      : `keeping ${PROJECT_CONFIG_FILENAME} and ${CODEPEN_DIR}/`;

  for (const pen of options.discovered) {
    if (pen.parseError || !pen.parsed) {
      const message = pen.parseError ?? `Invalid ${PROJECT_CONFIG_FILENAME}`;
      if (!jsonMode) {
        output.log(`${fmt.red('✗ [ERROR]')} ${fmt.bold(pen.relPath)}`);
        output.log(`    ${message}`);
      }
      counts.errors++;
      results.push({
        path: pen.relPath,
        rootDir: pen.rootDir,
        action: 'error',
        dryRun,
        error: message,
      });
      continue;
    }

    if (!pen.parsed.linked) {
      if (!jsonMode) {
        output.log(
          `${fmt.dim('- [SKIP]')} ${pen.relPath} — already unlinked (info-only ${PROJECT_CONFIG_FILENAME}); nothing to delete`,
        );
      }
      counts.skipped++;
      results.push({
        path: pen.relPath,
        rootDir: pen.rootDir,
        action: 'skipped',
        dryRun,
        reason: `Already unlinked (info-only ${PROJECT_CONFIG_FILENAME})`,
      });
      continue;
    }

    const project: ProjectLocation = {
      rootDir: pen.rootDir,
      configPath: pen.configPath,
      config: pen.parsed.config,
    };

    if (dryRun) {
      if (!jsonMode) {
        output.log(
          `${fmt.yellow('× [WOULD DELETE]')} ${fmt.bold(pen.relPath)} (${project.config.url || project.config.pen_id}) — ${localActionNote}`,
        );
      }
      counts.deleted++;
      results.push({
        path: pen.relPath,
        rootDir: pen.rootDir,
        action: 'deleted',
        dryRun: true,
        penId: project.config.pen_id,
        url: project.config.url,
        title: project.config.info?.title,
      });
      continue;
    }

    try {
      const { client } = await authResolver.resolveForProject(project);
      if (!jsonMode) {
        output.log(
          `${fmt.yellow('× [DELETING]')} ${fmt.bold(pen.relPath)} (${project.config.url || project.config.pen_id})…`,
        );
      }

      // When --cleanup is requested, read remote Pen info before deleting so retained info stays complete
      let fetchedPen: Pen | null = null;
      if (cleanup) {
        try {
          fetchedPen = await client.getPen(project.config.pen_id);
        } catch (error) {
          if (!isRemotePenNotFoundError(error)) {
            throw error;
          }
        }
      }

      let alreadyDeletedRemotely = false;
      try {
        await client.deletePen(project.config.pen_id);
      } catch (error) {
        if (isRemotePenNotFoundError(error)) {
          alreadyDeletedRemotely = true;
        } else {
          throw error;
        }
      }

      if (fullCleanup) {
        await fs.unlink(project.configPath);
        await removeCodepenDirSafe(project.rootDir);
      } else if (cleanup) {
        if (fetchedPen) {
          const remoteInfo = extractPenInfo(fetchedPen);
          const infoAnalysis = analyzeInfoSync(
            project.config.info,
            project.config.last_synced_info_hash,
            fetchedPen,
          );
          const retainedInfo =
            infoAnalysis.localChanged && project.config.info
              ? { ...remoteInfo, ...normalizePartialPenInfo(project.config.info) }
              : remoteInfo;
          await writeUnlinkedProjectInfo(project.rootDir, retainedInfo);
        } else {
          await unlinkLinkedProject(project);
        }
        await removeCodepenDirSafe(project.rootDir);
      }

      const displayTitle =
        fetchedPen?.title || project.config.info?.title || path.basename(project.rootDir);
      if (!jsonMode) {
        const note = alreadyDeletedRemotely
          ? `already deleted remotely (${localActionNote})`
          : localActionNote;
        output.log(
          `  ${fmt.green('✓')} Deleted "${displayTitle}" (${shortId(project.config.pen_id)}) — ${note}`,
        );
      }
      counts.deleted++;
      results.push({
        path: pen.relPath,
        rootDir: pen.rootDir,
        action: 'deleted',
        dryRun: false,
        penId: project.config.pen_id,
        url: project.config.url,
        title: displayTitle,
        ...(alreadyDeletedRemotely ? { reason: 'Already deleted remotely' } : {}),
      });
    } catch (error) {
      const message = formatErrorMessage(error, project.config.pen_id, pen.relPath);
      if (!jsonMode) {
        output.log(`  ${fmt.red('✗')} Delete failed: ${message}`);
      }
      counts.errors++;
      results.push({
        path: pen.relPath,
        rootDir: pen.rootDir,
        action: 'error',
        dryRun: false,
        penId: project.config.pen_id,
        url: project.config.url,
        error: message,
      });
    }
  }

  return finalizeBatchResult({
    mode: 'delete',
    dryRun,
    rootDir: options.rootDir,
    counts,
    results,
    jsonMode,
    output,
  });
}

export async function runBatchUnlink(
  options: RunBatchUnlinkOptions,
): Promise<BatchExecutionResult | null> {
  const output = options.output ?? defaultOutput;
  const dryRun = Boolean(options.dryRun);
  const jsonMode = Boolean(options.json);
  const interactive = !jsonMode && Boolean(options.interactive);

  const linkedTargets = options.discovered
    .filter((pen) => pen.parsed?.linked)
    .map((pen) => {
      const cfg = (pen.parsed as { linked: true; config: ProjectLocation['config'] }).config;
      return {
        relPath: pen.relPath,
        penId: cfg.pen_id,
        url: cfg.url,
        title: cfg.info?.title,
      };
    });

  if (!dryRun && linkedTargets.length > 0) {
    const confirmed = await confirmBatchDestructiveAction({
      action: 'unlink',
      targets: linkedTargets,
      yes: options.yes,
      interactive,
      output,
      confirm: options.prompts?.confirm,
    });
    if (!confirmed) {
      return null;
    }
  }

  const counts = createEmptyCounts(options.discovered.length);
  const results: BatchItemResult[] = [];

  logBatchHeader('unlink', options.discovered.length, dryRun, jsonMode, output);

  for (const pen of options.discovered) {
    if (pen.parseError || !pen.parsed) {
      const message = pen.parseError ?? `Invalid ${PROJECT_CONFIG_FILENAME}`;
      if (!jsonMode) {
        output.log(`${fmt.red('✗ [ERROR]')} ${fmt.bold(pen.relPath)}`);
        output.log(`    ${message}`);
      }
      counts.errors++;
      results.push({
        path: pen.relPath,
        rootDir: pen.rootDir,
        action: 'error',
        dryRun,
        error: message,
      });
      continue;
    }

    if (!pen.parsed.linked) {
      if (!jsonMode) {
        output.log(
          `${fmt.dim('- [SKIP]')} ${pen.relPath} — already unlinked (info-only ${PROJECT_CONFIG_FILENAME})`,
        );
      }
      counts.skipped++;
      results.push({
        path: pen.relPath,
        rootDir: pen.rootDir,
        action: 'skipped',
        dryRun,
        reason: `Already unlinked (info-only ${PROJECT_CONFIG_FILENAME})`,
      });
      continue;
    }

    const project: ProjectLocation = {
      rootDir: pen.rootDir,
      configPath: pen.configPath,
      config: pen.parsed.config,
    };

    if (dryRun) {
      if (!jsonMode) {
        output.log(
          `${fmt.yellow('× [WOULD UNLINK]')} ${fmt.bold(pen.relPath)} (${project.config.url || project.config.pen_id}) — keeping ${CODEPEN_DIR}/ and info in ${PROJECT_CONFIG_FILENAME}`,
        );
      }
      counts.unlinked++;
      results.push({
        path: pen.relPath,
        rootDir: pen.rootDir,
        action: 'unlinked',
        dryRun: true,
        penId: project.config.pen_id,
        url: project.config.url,
        title: project.config.info?.title,
      });
      continue;
    }

    try {
      await unlinkLinkedProject(project);
      if (!jsonMode) {
        output.log(
          `${fmt.green('✓ [UNLINKED]')} ${fmt.bold(pen.relPath)} ${fmt.dim(`(${project.config.pen_id})`)}`,
        );
      }
      counts.unlinked++;
      results.push({
        path: pen.relPath,
        rootDir: pen.rootDir,
        action: 'unlinked',
        dryRun: false,
        penId: project.config.pen_id,
        url: project.config.url,
        title: project.config.info?.title,
      });
    } catch (error) {
      const message = formatErrorMessage(error);
      if (!jsonMode) {
        output.log(`${fmt.red('✗ [ERROR]')} ${fmt.bold(pen.relPath)}`);
        output.log(`    ${message}`);
      }
      counts.errors++;
      results.push({
        path: pen.relPath,
        rootDir: pen.rootDir,
        action: 'error',
        dryRun: false,
        penId: project.config.pen_id,
        url: project.config.url,
        error: message,
      });
    }
  }

  return finalizeBatchResult({
    mode: 'unlink',
    dryRun,
    rootDir: options.rootDir,
    counts,
    results,
    jsonMode,
    output,
  });
}

export type BatchStatusState =
  | 'up-to-date'
  | 'local-ahead'
  | 'remote-ahead'
  | 'remote-metadata-ahead'
  | 'conflict'
  | 'unlinked'
  | 'trashed'
  | 'missing'
  | 'error';

export interface BatchStatusCounts {
  discovered: number;
  upToDate: number;
  localAhead: number;
  remoteAhead: number;
  unlinked: number;
  conflicts: number;
  inTrash: number;
  missing: number;
  errors: number;
}

export interface BatchStatusItemResult {
  path: string;
  rootDir: string;
  state: BatchStatusState;
  penId?: string;
  url?: string;
  title?: string;
  localVersionId?: string | null;
  remoteVersionId?: string | null;
  changes?: { added: string[]; modified: string[]; deleted: string[] };
  infoChanges?: InfoDiffItem[];
  fileCount?: number;
  trashItem?: TrashItem;
  error?: string;
}

export interface BatchStatusResult {
  batch: true;
  mode: 'status';
  rootDir: string;
  upToDate: boolean;
  remoteMoved: boolean;
  counts: BatchStatusCounts;
  results: BatchStatusItemResult[];
  exitCode?: number;
}

export type RunBatchStatusOptions = Omit<BatchBaseOptions, 'dryRun'>;

async function loadTrashMapForClient(client: CodePenClient): Promise<Map<string, TrashItem>> {
  const byItemId = new Map<string, TrashItem>();
  try {
    let page = await client.listTrash({ per_page: 100 });
    for (let i = 0; i < 10; i++) {
      for (const item of page.items) {
        if (item.type === 'Pen') {
          byItemId.set(item.item_id.toLowerCase(), item);
          byItemId.set(item.id.toLowerCase(), item);
        }
      }
      if (!page.links.next) break;
      page = await client.listTrashPageByUrl(page.links.next);
    }
  } catch {
    // Gracefully fall back to empty map if Trash endpoint is unavailable
  }
  return byItemId;
}

/**
 * Walks all discovered Pens in a directory tree and reports their read-only sync status
 * (`up-to-date`, `local-ahead`, `remote-ahead`, `conflict`, `unlinked`, `trashed`, `missing`, `error`)
 * along with summary counts and optional `--json` output.
 */
export async function runBatchStatus(
  options: RunBatchStatusOptions,
): Promise<BatchStatusResult> {
  const output = options.output ?? defaultOutput;
  const jsonMode = Boolean(options.json);
  const interactive = !jsonMode && Boolean(options.interactive);

  const counts: BatchStatusCounts = {
    discovered: options.discovered.length,
    upToDate: 0,
    localAhead: 0,
    remoteAhead: 0,
    unlinked: 0,
    conflicts: 0,
    inTrash: 0,
    missing: 0,
    errors: 0,
  };
  const results: BatchStatusItemResult[] = [];

  logBatchHeader('status', options.discovered.length, false, jsonMode, output);

  const authResolver = createBatchAuthResolver({
    explicitProfile: options.explicitProfile,
    interactive,
    baseUrl: options.baseUrl,
    env: options.env,
    homeDir: options.homeDir,
    output,
    selectProfile: options.prompts?.select,
  });

  if (options.explicitProfile) {
    await authResolver.resolveFallback();
  }

  const trashCacheByClient = new Map<CodePenClient, Map<string, TrashItem>>();
  async function findTrashedCached(
    client: CodePenClient,
    project: ProjectLocation,
  ): Promise<TrashItem | null> {
    let trashMap = trashCacheByClient.get(client);
    if (!trashMap) {
      trashMap = await loadTrashMapForClient(client);
      trashCacheByClient.set(client, trashMap);
    }
    const direct = trashMap.get(project.config.pen_id.toLowerCase());
    if (direct) return direct;
    const urlId = extractPenIdFromUrl(project.config.url);
    return urlId ? (trashMap.get(urlId.toLowerCase()) ?? null) : null;
  }

  for (const pen of options.discovered) {
    if (pen.parseError || !pen.parsed) {
      const message = pen.parseError ?? `Invalid ${PROJECT_CONFIG_FILENAME}`;
      if (!jsonMode) {
        output.log(`${fmt.red('✗ [ERROR]')}       ${fmt.bold(pen.relPath)}`);
        output.log(`    ${message}`);
      }
      counts.errors++;
      results.push({
        path: pen.relPath,
        rootDir: pen.rootDir,
        state: 'error',
        error: message,
      });
      continue;
    }

    if (!pen.parsed.linked) {
      const retainedInfo = pen.parsed.config.info;
      const scanned = await scanLocalFiles(pen.rootDir);
      const indexFile = scanned.get('/index.html');
      const htmlTitle =
        indexFile && !indexFile.isBinary && indexFile.textContent
          ? extractHtmlTitle(indexFile.textContent)
          : null;
      const title =
        retainedInfo.title?.trim() || htmlTitle || path.basename(pen.rootDir) || 'Untitled';
      if (!jsonMode) {
        output.log(
          `${fmt.cyan('+ [UNLINKED]')}    ${fmt.bold(pen.relPath)} — "${title}" ${fmt.dim(`(${scanned.size} file(s), not linked to CodePen yet)`)}`,
        );
      }
      counts.unlinked++;
      results.push({
        path: pen.relPath,
        rootDir: pen.rootDir,
        state: 'unlinked',
        title,
        fileCount: scanned.size,
      });
      continue;
    }

    const project: ProjectLocation = {
      rootDir: pen.rootDir,
      configPath: pen.configPath,
      config: pen.parsed.config,
    };

    try {
      const { client } = await authResolver.resolveForProject(project);
      let inspection;
      try {
        inspection = await inspectLinkedPenSyncState(client, project);
      } catch (error) {
        if (isRemotePenNotFoundError(error)) {
          const trashItem = await findTrashedCached(client, project);
          const displayTitle =
            trashItem?.title || project.config.info?.title || path.basename(project.rootDir);
          if (trashItem) {
            if (!jsonMode) {
              output.log(
                `${fmt.yellow('! [IN TRASH]')}    ${fmt.bold(pen.relPath)} ${fmt.dim(`(${project.config.pen_id})`)} — deleted on CodePen ${fmt.dim(`(expires ${formatDate(trashItem.expires_at)})`)}`,
              );
            }
            counts.inTrash++;
            results.push({
              path: pen.relPath,
              rootDir: pen.rootDir,
              state: 'trashed',
              penId: project.config.pen_id,
              url: project.config.url,
              title: displayTitle,
              localVersionId: project.config.last_synced_version_id,
              trashItem,
            });
          } else {
            if (!jsonMode) {
              output.log(
                `${fmt.red('✗ [MISSING]')}     ${fmt.bold(pen.relPath)} ${fmt.dim(`(${project.config.pen_id})`)} — no longer exists on CodePen ${fmt.dim('(or belongs to another profile)')}`,
              );
            }
            counts.missing++;
            results.push({
              path: pen.relPath,
              rootDir: pen.rootDir,
              state: 'missing',
              penId: project.config.pen_id,
              url: project.config.url,
              title: displayTitle,
              localVersionId: project.config.last_synced_version_id,
            });
          }
          continue;
        }
        throw error;
      }

      const changes = {
        added: inspection.diff.added.map((i) => i.path),
        modified: inspection.diff.modified.map((i) => i.path),
        deleted: inspection.diff.deleted.map((i) => i.path),
      };

      if (inspection.state === 'up-to-date') {
        if (!jsonMode) {
          output.log(`${fmt.green('✓ [UP TO DATE]')}  ${pen.relPath}`);
        }
        counts.upToDate++;
        results.push({
          path: pen.relPath,
          rootDir: pen.rootDir,
          state: 'up-to-date',
          penId: inspection.pen.id,
          url: inspection.pen.urls.editor,
          title: inspection.pen.title,
          localVersionId: inspection.localHead,
          remoteVersionId: inspection.remoteHead,
          changes,
          infoChanges: [],
        });
        continue;
      }

      if (inspection.state === 'local-ahead') {
        const changeSummary = formatSyncChangeSummary(
          inspection.diffCount,
          inspection.infoAnalysis.changes,
        );
        if (!jsonMode) {
          output.log(
            `${fmt.cyan('↑ [LOCAL AHEAD]')} ${fmt.bold(pen.relPath)} (${changeSummary})`,
          );
          for (const line of formatFileDiffLines(inspection.diff, 'push')) {
            output.log(line);
          }
          for (const change of inspection.infoAnalysis.changes) {
            output.log(
              `    ${fmt.yellow('~')} info.${change.field}: ${formatInfoValue(change.field, change.remote)} → ${formatInfoValue(change.field, change.local)}`,
            );
          }
        }
        counts.localAhead++;
        results.push({
          path: pen.relPath,
          rootDir: pen.rootDir,
          state: 'local-ahead',
          penId: inspection.pen.id,
          url: inspection.pen.urls.editor,
          title: inspection.pen.title,
          localVersionId: inspection.localHead,
          remoteVersionId: inspection.remoteHead,
          changes,
          infoChanges: inspection.infoAnalysis.changes,
        });
        continue;
      }

      if (inspection.state === 'remote-ahead' || inspection.state === 'remote-metadata-ahead') {
        const remoteSummary = formatSyncChangeSummary(
          inspection.diffCount,
          inspection.infoAnalysis.changes,
        );
        const versionRange = inspection.remoteVersionChanged
          ? `${shortId(inspection.localHead)} → ${shortId(inspection.remoteHead)}, `
          : '';
        if (!jsonMode) {
          output.log(
            `${fmt.cyan('↓ [REMOTE AHEAD]')} ${fmt.bold(pen.relPath)} (${versionRange}${remoteSummary})`,
          );
          for (const line of formatFileDiffLines(inspection.diff, 'pull')) {
            output.log(line);
          }
          for (const change of inspection.infoAnalysis.changes) {
            output.log(
              `    ${fmt.yellow('~')} info.${change.field}: ${formatInfoValue(change.field, change.local)} → ${formatInfoValue(change.field, change.remote)}`,
            );
          }
        }
        counts.remoteAhead++;
        results.push({
          path: pen.relPath,
          rootDir: pen.rootDir,
          state: inspection.state,
          penId: inspection.pen.id,
          url: inspection.pen.urls.editor,
          title: inspection.pen.title,
          localVersionId: inspection.localHead,
          remoteVersionId: inspection.remoteHead,
          changes,
          infoChanges: inspection.infoAnalysis.changes,
        });
        continue;
      }

      // conflict
      if (!jsonMode) {
        logConflictDetails(pen.relPath, inspection, output);
      }
      counts.conflicts++;
      results.push({
        path: pen.relPath,
        rootDir: pen.rootDir,
        state: 'conflict',
        penId: inspection.pen.id,
        url: inspection.pen.urls.editor,
        title: inspection.pen.title,
        localVersionId: inspection.localHead,
        remoteVersionId: inspection.remoteHead,
        changes,
        infoChanges: inspection.infoAnalysis.changes,
      });
    } catch (error) {
      const message = formatErrorMessage(error, project.config.pen_id, pen.relPath);
      if (!jsonMode) {
        output.log(`${fmt.red('✗ [ERROR]')}       ${fmt.bold(pen.relPath)}`);
        output.log(`    ${message}`);
      }
      counts.errors++;
      results.push({
        path: pen.relPath,
        rootDir: pen.rootDir,
        state: 'error',
        penId: project.config.pen_id,
        url: project.config.url,
        error: message,
      });
    }
  }

  const upToDate = counts.discovered > 0 && counts.upToDate === counts.discovered;
  const remoteMoved = counts.remoteAhead > 0 || counts.conflicts > 0;
  const exitCode = counts.errors > 0 ? 1 : undefined;

  if (jsonMode) {
    const summaryParts = [
      `${counts.upToDate} up to date`,
      `${counts.localAhead} local ahead`,
      `${counts.remoteAhead} remote ahead`,
      `${counts.unlinked} unlinked`,
      `${counts.conflicts} conflicts`,
      ...(counts.inTrash > 0 ? [`${counts.inTrash} in trash`] : []),
      ...(counts.missing > 0 ? [`${counts.missing} missing`] : []),
      `${counts.errors} errors`,
    ];
    printJsonResponse(
      counts.errors > 0 ? 500 : 200,
      `Batch status complete (${counts.discovered} discovered): ${summaryParts.join(', ')}.`,
      {
        batch: true,
        mode: 'status',
        root_dir: options.rootDir,
        up_to_date: upToDate,
        remote_ahead: remoteMoved,
        counts: {
          discovered: counts.discovered,
          up_to_date: counts.upToDate,
          local_ahead: counts.localAhead,
          remote_ahead: counts.remoteAhead,
          unlinked: counts.unlinked,
          conflicts: counts.conflicts,
          in_trash: counts.inTrash,
          missing: counts.missing,
          errors: counts.errors,
        },
        results: results.map((item) => ({
          path: item.path,
          root_dir: item.rootDir,
          state: item.state,
          ...(item.penId ? { pen_id: item.penId } : {}),
          ...(item.url ? { url: item.url } : {}),
          ...(item.title ? { title: item.title } : {}),
          ...(item.localVersionId !== undefined ? { local_version_id: item.localVersionId } : {}),
          ...(item.remoteVersionId !== undefined
            ? { remote_version_id: item.remoteVersionId }
            : {}),
          ...(item.changes ? { changes: item.changes } : {}),
          ...(item.infoChanges ? { info_changes: item.infoChanges } : {}),
          ...(item.fileCount !== undefined ? { file_count: item.fileCount } : {}),
          ...(item.trashItem ? { trash_item: item.trashItem } : {}),
          ...(item.error ? { error: item.error } : {}),
        })),
      },
      output,
    );
  } else {
    output.log(`\n${fmt.bold('Summary (status):')}`);
    output.log(`  Found:        ${counts.discovered}`);
    output.log(`  Up to date:   ${counts.upToDate}`);
    output.log(`  Local ahead:  ${counts.localAhead}`);
    output.log(`  Remote ahead: ${counts.remoteAhead}`);
    output.log(`  Unlinked:     ${counts.unlinked}`);
    output.log(`  Conflicts:    ${counts.conflicts}`);
    if (counts.inTrash > 0) {
      output.log(`  In Trash:     ${counts.inTrash}`);
    }
    if (counts.missing > 0) {
      output.log(`  Missing:      ${counts.missing}`);
    }
    output.log(`  Errors:       ${counts.errors}`);

    if (counts.inTrash > 0) {
      output.log(
        `\n${fmt.dim('Trashed Pens can be restored with `cdpn restore` inside each folder (or at Deleted Items):')}`,
      );
      output.log(`  ${fmt.cyan(CODEPEN_DELETED_ITEMS_URL)}`);
    }

    const conflicts = results.filter((r) => r.state === 'conflict');
    if (conflicts.length > 0) {
      output.log(`\n${fmt.yellow('Conflicts requiring manual resolution:')}`);
      for (const c of conflicts) {
        output.log(`  - ${c.path}${c.url ? ` (${c.url})` : ''}`);
      }
    }

    const errors = results.filter((r) => r.state === 'error');
    if (errors.length > 0) {
      output.log(`\n${fmt.red('Errors:')}`);
      for (const e of errors) {
        output.log(`  - ${e.path}: ${e.error ?? 'Unknown error'}`);
      }
    }

    if (counts.localAhead > 0 || counts.remoteAhead > 0 || counts.unlinked > 0) {
      output.log(
        `\n${fmt.dim('Tip: Run `cdpn sync` to synchronize changes (or `cdpn sync --dry-run` to preview).')}`,
      );
    }
  }

  return {
    batch: true,
    mode: 'status',
    rootDir: options.rootDir,
    upToDate,
    remoteMoved,
    counts,
    results,
    ...(exitCode !== undefined ? { exitCode } : {}),
  };
}
