import path from 'node:path';
import type { Command } from 'commander';
import { CodePenClient } from '../api/client.js';
import type { Pen } from '../api/types.js';
import { API_KEY_ENV_VAR, type ResolvedAuth } from '../config/auth.js';
import {
  createUnlinkedProjectError,
  findNearestConfig,
  type ProjectLocation,
} from '../config/project.js';
import { PROJECT_CONFIG_FILENAME } from '../constants.js';
import { CliError } from '../errors.js';
import {
  computeSyncDiff,
  detectLocalChangesFromBaseline,
  hasDiffChanges,
  type SyncDiff,
} from '../sync/diff.js';
import { isDirectoryNonEmpty, scanLocalFiles } from '../sync/fs.js';
import { analyzeInfoSync, formatInfoValue, type InfoSyncAnalysis } from '../sync/info.js';
import { fmt, shortId } from '../utils/format.js';
import { printJsonResponse } from '../utils/json.js';
import { defaultOutput, type CommandOutput } from '../utils/output.js';
import { isInteractive, type SelectOption } from '../utils/prompts/index.js';
import { getGlobalProfileOption, resolveCommandAuth } from '../workflows/auth-context.js';
import { runBatchStatus, type BatchStatusResult } from '../workflows/batch-pens.js';
import {
  offerBatchAllFallback,
  resolveBatchCommandTarget,
} from '../workflows/batch-target.js';
import type { DiscoveredPen } from '../workflows/discover-pens.js';
import {
  fetchLinkedPenOrHandleMissing,
  type MissingPenPrompts,
} from '../workflows/missing-pen.js';

export interface RunStatusCommandOptions {
  /** Optional target directory path or `"all"` to walk subdirectories in batch mode. */
  target?: string;
  json?: boolean;
  cwd?: string;
  explicitProfile?: string;
  baseUrl?: string;
  interactive?: boolean;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  output?: CommandOutput;
  selectProfile?: (
    question: string,
    options: SelectOption<string>[],
    defaultIndex: number,
  ) => Promise<string>;
  prompts?: MissingPenPrompts;
}

export interface StatusCommandResult {
  pen?: Pen;
  auth?: ResolvedAuth;
  project?: ProjectLocation;
  diff?: SyncDiff;
  infoAnalysis?: InfoSyncAnalysis;
  remoteMoved: boolean;
  upToDate: boolean;
  batch?: BatchStatusResult;
  exitCode?: number;
}

export async function runStatusCommand(
  options: RunStatusCommandOptions = {},
): Promise<StatusCommandResult | null> {
  const output = options.output ?? defaultOutput;
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const interactive = (options.interactive ?? isInteractive()) && !options.json;
  const combinedPrompts: MissingPenPrompts = {
    confirm: options.prompts?.confirm,
    select: options.prompts?.select ?? (options.selectProfile as MissingPenPrompts['select']),
  };

  const executeBatch = async (
    rootDir: string,
    discovered: DiscoveredPen[],
  ): Promise<StatusCommandResult> => {
    const batch = await runBatchStatus({
      rootDir,
      discovered,
      json: options.json,
      interactive,
      explicitProfile: options.explicitProfile,
      baseUrl: options.baseUrl,
      env: options.env,
      homeDir: options.homeDir,
      output,
      prompts: combinedPrompts,
    });
    return {
      remoteMoved: batch.remoteMoved,
      upToDate: batch.upToDate,
      batch,
      ...(batch.exitCode !== undefined ? { exitCode: batch.exitCode } : {}),
    };
  };

  const resolvedTarget = await resolveBatchCommandTarget({
    commandName: 'status',
    cwd,
    target: options.target,
    interactive,
    output,
    prompts: combinedPrompts,
  });

  if (resolvedTarget.mode === 'batch') {
    return executeBatch(resolvedTarget.rootDir, resolvedTarget.discovered);
  }

  const nearest = await findNearestConfig(resolvedTarget.targetDir);
  if (!nearest) {
    const fallback = await offerBatchAllFallback({
      commandName: 'status',
      targetDir: resolvedTarget.targetDir,
      fromExplicitDir: resolvedTarget.fromExplicitDir,
      displayDir: resolvedTarget.displayDir,
      interactive,
      output,
      prompts: combinedPrompts,
    });
    if (fallback.action === 'batch') {
      return executeBatch(resolvedTarget.targetDir, fallback.discovered);
    }
    if (fallback.action === 'canceled') {
      return null;
    }

    const hint = (await isDirectoryNonEmpty(resolvedTarget.targetDir))
      ? 'Run `cdpn init` to initialize this folder as a CodePen demo.'
      : 'Run `cdpn clone <url>` to clone a Pen or `cdpn new` to create one.';
    throw new CliError(
      404,
      `No ${PROJECT_CONFIG_FILENAME} found in this directory or any parent directory.\n${hint}`,
    );
  }
  if (!nearest.linked) {
    throw createUnlinkedProjectError(nearest.rootDir);
  }
  const project: ProjectLocation = {
    rootDir: nearest.rootDir,
    configPath: nearest.configPath,
    config: nearest.config,
  };
  const auth = await resolveCommandAuth({
    explicitProfile: options.explicitProfile,
    project,
    interactive,
    persistProfileToProject: !options.json,
    output,
    env: options.env,
    homeDir: options.homeDir,
    selectProfile: options.selectProfile,
  });
  const client = new CodePenClient({ apiKey: auth.apiKey, baseUrl: options.baseUrl });

  const penLookup = await fetchLinkedPenOrHandleMissing({
    client,
    project,
    auth,
    commandName: 'status',
    interactive,
    json: options.json,
    output,
    prompts: options.prompts,
  });
  if (!penLookup.found) {
    return null;
  }

  const pen = penLookup.pen;
  const [remoteFiles, localFiles] = await Promise.all([
    client.getPenFiles(project.config.pen_id),
    scanLocalFiles(project.rootDir),
  ]);

  const diff = await computeSyncDiff({
    localFiles,
    remoteFiles,
    baseline: project.config.files,
    downloadFile: (url) => client.downloadFile(url),
  });

  const infoAnalysis = analyzeInfoSync(
    project.config.info,
    project.config.last_synced_info_hash,
    pen,
  );

  const localHead = project.config.last_synced_version_id;
  const remoteHead = pen.saved_version?.id ?? null;
  const remoteMoved = Boolean(remoteHead && localHead && remoteHead !== localHead);
  const localBaselineChanges = detectLocalChangesFromBaseline(localFiles, project.config.files);

  const fileChangeCount = diff.added.length + diff.modified.length + diff.deleted.length;
  const infoChangeCount = infoAnalysis.changes.length;
  const totalChanges = fileChangeCount + infoChangeCount;
  const upToDate = totalChanges === 0 && !remoteMoved;

  if (options.json) {
    let message: string;
    if (totalChanges === 0) {
      message = remoteMoved
        ? 'Local files match remote content, but version metadata is behind.'
        : `Up to date with CodePen (${diff.unchanged.length} file(s)).`;
    } else if (fileChangeCount > 0 && infoChangeCount > 0) {
      message = `Found ${fileChangeCount} file difference(s) and ${infoChangeCount} Pen info difference(s).`;
    } else if (fileChangeCount > 0) {
      message = `Found ${fileChangeCount} difference(s) between local folder and remote head.`;
    } else {
      message = `Found ${infoChangeCount} Pen info difference(s) between ${PROJECT_CONFIG_FILENAME} and CodePen.`;
    }

    printJsonResponse(
      200,
      message,
      {
        pen_id: pen.id,
        title: pen.title,
        editor: pen.editor,
        profile: auth.profile ?? project.config.profile ?? null,
        auth_source: auth.source,
        url: project.config.url,
        local_version_id: localHead,
        remote_version_id: remoteHead,
        remote_ahead: remoteMoved,
        up_to_date: upToDate,
        build_status: pen.saved_version?.build?.status ?? null,
        deployment: pen.deployment,
        changes: {
          added: diff.added.map((i) => i.path),
          modified: diff.modified.map((i) => i.path),
          deleted: diff.deleted.map((i) => i.path),
          unchanged: diff.unchanged.map((i) => i.path),
        },
        info_tracked: infoAnalysis.tracked,
        info_local_changed: infoAnalysis.localChanged,
        info_remote_changed: infoAnalysis.remoteChanged,
        info_changes: infoAnalysis.changes,
      },
      output,
    );
    return { pen, auth, project, diff, infoAnalysis, remoteMoved, upToDate };
  }

  output.log(`${fmt.bold(pen.title || 'Untitled')} ${fmt.dim(`(${pen.id}, ${pen.editor})`)}`);
  output.log(
    `Profile:  ${auth.profile ? fmt.cyan(auth.profile) : fmt.dim(`env (${API_KEY_ENV_VAR})`)}`,
  );
  output.log(`URL:      ${fmt.cyan(project.config.url)}`);
  output.log(`Synced:   ${fmt.dim(shortId(localHead))}`);
  output.log(
    `Remote:   ${fmt.dim(shortId(remoteHead))}` +
      (remoteMoved ? ` ${fmt.yellow('(remote head has moved since last sync!)')}` : ''),
  );

  const buildStatus = pen.saved_version?.build?.status;
  if (buildStatus) {
    const colored =
      buildStatus === 'Success'
        ? fmt.green(buildStatus)
        : buildStatus === 'Failed'
          ? fmt.red(buildStatus)
          : fmt.yellow(buildStatus);
    output.log(`Build:    ${colored}`);
  }

  if (pen.deployment) {
    const deployedIsHead = pen.deployment.version_id === remoteHead;
    const deployNote = deployedIsHead
      ? fmt.green('up to date')
      : fmt.yellow(`older version ${shortId(pen.deployment.version_id)}`);
    output.log(`Deployed: ${fmt.cyan(pen.deployment.url)} ${fmt.dim(`(${deployNote})`)}`);
    if (pen.deployment.custom_domains.length > 0) {
      output.log(`Domains:  ${pen.deployment.custom_domains.join(', ')}`);
    }
  } else {
    output.log(`Deployed: ${fmt.dim('not deployed')}`);
  }

  output.log('');

  const hasFileChanges = hasDiffChanges(diff);
  const hasInfoChanges = infoAnalysis.changes.length > 0;

  if (!hasFileChanges && !hasInfoChanges) {
    if (remoteMoved) {
      output.log(
        `${fmt.yellow('!')} Local files match remote content, but version metadata is behind. Run \`cdpn pull\` to update ${fmt.dim(PROJECT_CONFIG_FILENAME)}.`,
      );
    } else {
      output.log(`${fmt.green('✓')} Up to date with CodePen (${diff.unchanged.length} file(s)).`);
    }
    if (!infoAnalysis.tracked) {
      output.log(
        fmt.dim(
          `Note: ${PROJECT_CONFIG_FILENAME} does not include Pen info yet. Run \`cdpn pull\` or \`cdpn push\` to add it.`,
        ),
      );
    }
    return { pen, auth, project, diff, infoAnalysis, remoteMoved, upToDate };
  }

  if (hasFileChanges) {
    const localModifiedSet = new Set([
      ...localBaselineChanges.added,
      ...localBaselineChanges.modified,
      ...localBaselineChanges.deleted,
    ]);

    output.log('Differences between local folder and remote head:');
    for (const item of diff.added) {
      const hint =
        remoteMoved && !localModifiedSet.has(item.path) ? fmt.dim(' (deleted remotely)') : '';
      output.log(`  ${fmt.green('+')} ${item.path}${hint}`);
    }
    for (const item of diff.modified) {
      const hint =
        remoteMoved && !localModifiedSet.has(item.path) ? fmt.dim(' (changed remotely)') : '';
      output.log(`  ${fmt.yellow('~')} ${item.path}${hint}`);
    }
    for (const item of diff.deleted) {
      const hint =
        remoteMoved && !localModifiedSet.has(item.path) ? fmt.dim(' (added remotely)') : '';
      output.log(`  ${fmt.red('-')} ${item.path}${hint}`);
    }
  }

  if (hasInfoChanges) {
    if (hasFileChanges) {
      output.log('');
    }
    output.log(`Differences in Pen info (${PROJECT_CONFIG_FILENAME}):`);
    for (const change of infoAnalysis.changes) {
      const localVal = formatInfoValue(change.field, change.local);
      const remoteVal = formatInfoValue(change.field, change.remote);
      if (infoAnalysis.localChanged && infoAnalysis.remoteChanged) {
        output.log(
          `  ${fmt.yellow('~')} info.${change.field}: local ${localVal} vs remote ${remoteVal}${fmt.yellow(' (conflict)')}`,
        );
      } else if (!infoAnalysis.localChanged && infoAnalysis.remoteChanged) {
        output.log(
          `  ${fmt.yellow('~')} info.${change.field}: ${localVal} → ${remoteVal}${fmt.dim(' (changed remotely)')}`,
        );
      } else {
        output.log(`  ${fmt.yellow('~')} info.${change.field}: ${remoteVal} → ${localVal}`);
      }
    }
  }

  output.log('');
  if (remoteMoved || (infoAnalysis.localChanged && infoAnalysis.remoteChanged)) {
    output.log(
      fmt.yellow(
        'Remote has newer changes. Run `cdpn pull` to sync remote changes, or `cdpn push --force` to overwrite remote with local.',
      ),
    );
  } else if (!hasFileChanges && !infoAnalysis.localChanged && infoAnalysis.remoteChanged) {
    output.log(
      fmt.yellow(
        `Remote Pen info has changed. Run \`cdpn pull\` to update ${PROJECT_CONFIG_FILENAME}, or \`cdpn push --force\` to overwrite remote with local.`,
      ),
    );
  } else {
    output.log(
      fmt.dim('Run `cdpn push` to upload these changes, or `cdpn pull` to discard local changes.'),
    );
  }

  return { pen, auth, project, diff, infoAnalysis, remoteMoved, upToDate };
}

export function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .argument(
      '[target]',
      'Directory path to inspect, or "all" to check all Pens in subdirectories',
    )
    .allowExcessArguments(false)
    .description(
      'Compare local files and Pen info with the online version on CodePen (or pass "all" to walk subdirectories)',
    )
    .option('--json', 'Output status as JSON')
    .action(async (target: string | undefined, options: { json?: boolean }, command: Command) => {
      const result = await runStatusCommand({
        target,
        json: options.json,
        explicitProfile: getGlobalProfileOption(command),
      });
      if (result?.exitCode !== undefined) {
        process.exitCode = result.exitCode;
      }
    });
}
