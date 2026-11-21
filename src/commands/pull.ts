import type { Command } from 'commander';
import { CodePenClient } from '../api/client.js';
import type { Pen } from '../api/types.js';
import type { ResolvedAuth } from '../config/auth.js';
import {
  buildSyncedFileMap,
  requireProject,
  writeProjectConfig,
  type ProjectLocation,
} from '../config/project.js';
import { PROJECT_CONFIG_FILENAME } from '../constants.js';
import { CliError } from '../errors.js';
import { detectLocalChangesFromBaseline } from '../sync/diff.js';
import { scanLocalFiles } from '../sync/fs.js';
import {
  analyzeInfoSync,
  buildPenInfoConfigFields,
  hasAnyPenInfoFields,
  isLocalInfoDirty,
} from '../sync/info.js';
import { syncRemoteFilesToDisk } from '../sync/materialize.js';
import { fmt, shortId } from '../utils/format.js';
import { printJsonResponse } from '../utils/json.js';
import { defaultOutput, type CommandOutput } from '../utils/output.js';
import {
  isInteractive,
  promptConfirm,
  promptSelect,
  type SelectOption,
} from '../utils/prompts/index.js';
import { getGlobalProfileOption, resolveCommandAuth } from '../workflows/auth-context.js';
import { fetchLinkedPenOrHandleMissing } from '../workflows/missing-pen.js';

export interface PullCliOptions {
  force?: boolean;
  json?: boolean;
}

export interface RunPullCommandOptions {
  /** Overwrite local changes without prompting. */
  force?: boolean;
  /** Output pull result as JSON. */
  json?: boolean;
  /** Working directory inside an existing clone (defaults to `process.cwd()`). */
  cwd?: string;
  /** Explicit `--profile <name>` flag value. */
  explicitProfile?: string;
  /** Injectable output sink (defaults to stdout/stderr). */
  output?: CommandOutput;
  /** Injectable API base URL (for testing). */
  baseUrl?: string;
  /** Injectable interactivity flag (for testing). */
  interactive?: boolean;
  /** Injectable env map (for testing). */
  env?: NodeJS.ProcessEnv;
  /** Injectable home dir (for testing). */
  homeDir?: string;
  /** Injectable prompts (for testing). */
  prompts?: {
    confirm?: (question: string, defaultYes?: boolean) => Promise<boolean>;
    select?: <T extends string>(
      question: string,
      options: SelectOption<T>[],
      defaultIndex?: number,
    ) => Promise<T>;
  };
}

export interface PullCommandResult {
  pen: Pen;
  writtenPaths: string[];
  deletedPaths: string[];
  auth: ResolvedAuth;
  project: ProjectLocation;
}

/**
 * Pulls the latest remote files and Pen metadata from CodePen into an existing cloned folder
 * containing `.cdpn.json`.
 * Returns `null` if the user cancels interactively when uncommitted local changes are present.
 */
export async function runPullCommand(
  options: RunPullCommandOptions = {},
): Promise<PullCommandResult | null> {
  const output = options.output ?? defaultOutput;
  const cwd = options.cwd ?? process.cwd();
  const jsonMode = Boolean(options.json);
  const interactive = (options.interactive ?? isInteractive()) && !jsonMode;
  const force = Boolean(options.force);
  const confirmImpl = options.prompts?.confirm ?? promptConfirm;
  const selectImpl = options.prompts?.select ?? promptSelect;

  const project = await requireProject(cwd);
  const auth = await resolveCommandAuth({
    explicitProfile: options.explicitProfile,
    project,
    interactive,
    persistProfileToProject: !jsonMode,
    output,
    env: options.env,
    homeDir: options.homeDir,
    selectProfile: selectImpl,
  });
  const client = new CodePenClient({ apiKey: auth.apiKey, baseUrl: options.baseUrl });

  const { rootDir, config } = project;
  if (!jsonMode) {
    output.log(`Pulling latest changes for ${fmt.cyan(config.pen_id)}…`);
  }

  const localFiles = await scanLocalFiles(rootDir);
  const localDirty = detectLocalChangesFromBaseline(localFiles, config.files);
  const dirtyCount =
    localDirty.added.length + localDirty.modified.length + localDirty.deleted.length;
  const localInfoDirty = isLocalInfoDirty(config.info, config.last_synced_info_hash);

  if ((dirtyCount > 0 || localInfoDirty) && !force) {
    if (!jsonMode) {
      output.log(
        fmt.yellow('\nWarning: You have uncommitted local changes that will be overwritten:'),
      );
      for (const p of localDirty.added) {
        output.log(`  ${fmt.green('+')} ${p} ${fmt.dim('(will be removed)')}`);
      }
      for (const p of localDirty.modified) {
        output.log(`  ${fmt.yellow('~')} ${p} ${fmt.dim('(will be overwritten)')}`);
      }
      for (const p of localDirty.deleted) {
        output.log(`  ${fmt.red('-')} ${p} ${fmt.dim('(will be restored)')}`);
      }
      if (localInfoDirty) {
        output.log(
          `  ${fmt.yellow('~')} ${PROJECT_CONFIG_FILENAME} (info) ${fmt.dim('(will be overwritten)')}`,
        );
      }
    }

    if (!interactive) {
      throw new CliError(
        409,
        'Local changes detected. Commit/push them first, or re-run with --force.',
        {
          dirty_files: localDirty,
          ...(localInfoDirty ? { dirty_info: true } : {}),
        },
      );
    }

    const ok = await confirmImpl('\nOverwrite local changes with remote version?', false);
    if (!ok) {
      output.log('Aborted.');
      return null;
    }
  }

  const penLookup = await fetchLinkedPenOrHandleMissing({
    client,
    project,
    auth,
    commandName: 'pull',
    interactive,
    json: jsonMode,
    output,
    prompts: options.prompts,
  });
  if (!penLookup.found) {
    return null;
  }

  const pen = penLookup.pen;
  const remoteFiles = await client.getPenFiles(config.pen_id);

  const hadInfoBefore = hasAnyPenInfoFields(config.info);
  const infoAnalysis = analyzeInfoSync(config.info, config.last_synced_info_hash, pen);

  const result = await syncRemoteFilesToDisk({
    client,
    rootDir,
    remoteFiles,
    existingLocalPaths: localFiles.keys(),
    pruneRemoved: true,
  });

  const syncedFiles = buildSyncedFileMap(remoteFiles, result.localSha256ByPath);
  const profileToPersist = config.profile ?? auth.profile ?? undefined;
  const nextConfig = {
    url: config.url || pen.urls.editor,
    pen_id: pen.id,
    ...(profileToPersist ? { profile: profileToPersist } : {}),
    last_synced_version_id: pen.saved_version?.id ?? null,
    editor: pen.editor,
    ...buildPenInfoConfigFields(pen),
    files: syncedFiles,
  };
  const configPath = await writeProjectConfig(rootDir, nextConfig);

  if (jsonMode) {
    printJsonResponse(
      200,
      `Synced ${pen.title || 'Untitled'}.`,
      {
        pen,
        profile: profileToPersist ?? null,
        root_dir: rootDir,
        config_path: configPath,
        version_id: pen.saved_version?.id ?? null,
        written_paths: result.writtenPaths,
        deleted_paths: result.deletedPaths,
      },
      output,
    );
  } else {
    output.log(
      `\n${fmt.green('✓')} Synced ${fmt.bold(pen.title || 'Untitled')} ${fmt.dim(`(${pen.id})`)}`,
    );
    if (auth.profile) {
      output.log(`  Profile: ${fmt.cyan(auth.profile)}`);
    }
    output.log(
      `  Updated: ${result.writtenPaths.length} file(s)` +
        (result.deletedPaths.length > 0
          ? `, removed ${result.deletedPaths.length} deleted file(s)`
          : ''),
    );
    if (!hadInfoBefore) {
      output.log(`  Info:    ${fmt.dim(`added to ${PROJECT_CONFIG_FILENAME}`)}`);
    } else if (infoAnalysis.changes.length > 0) {
      output.log(
        `  Info:    ${fmt.dim(`updated ${infoAnalysis.changes.map((c) => c.field).join(', ')} in ${PROJECT_CONFIG_FILENAME}`)}`,
      );
    }
    if (pen.saved_version) {
      output.log(`  Version: ${fmt.dim(shortId(pen.saved_version.id))}`);
    }
  }

  return {
    pen,
    writtenPaths: result.writtenPaths,
    deletedPaths: result.deletedPaths,
    auth,
    project: {
      rootDir,
      configPath,
      config: nextConfig,
    },
  };
}

export function registerPullCommand(program: Command): void {
  program
    .command('pull')
    .allowExcessArguments(false)
    .description(
      'Pull latest changes from CodePen into an existing cloned folder (requires .cdpn.json)',
    )
    .option('-f, --force', 'Overwrite local changes without prompting')
    .option('--json', 'Output pull result as JSON')
    .action(async (options: PullCliOptions, command: Command) => {
      await runPullCommand({
        force: options.force,
        json: options.json,
        explicitProfile: getGlobalProfileOption(command),
      });
    });
}
