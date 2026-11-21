import type { Command } from 'commander';
import { CodePenClient } from '../api/client.js';
import type { Pen } from '../api/types.js';
import { buildSyncedFileMap, requireProject, writeProjectConfig } from '../config/project.js';
import { CliError } from '../errors.js';
import { scanLocalFiles } from '../sync/fs.js';
import { buildPenInfoConfigFields } from '../sync/info.js';
import { syncRemoteFilesToDisk } from '../sync/materialize.js';
import { assertValidVersionLabel } from '../utils/cli-options.js';
import { fmt, formatDate, shortId } from '../utils/format.js';
import { printJsonResponse } from '../utils/json.js';
import { defaultOutput, type CommandOutput } from '../utils/output.js';
import {
  isInteractive,
  promptConfirm,
  promptSelect,
  type SelectOption,
} from '../utils/prompts/index.js';
import { getGlobalProfileOption, resolveCommandAuth } from '../workflows/auth-context.js';
import { fetchLinkedPenOrHandleMissing, type MissingPenPrompts } from '../workflows/missing-pen.js';

export interface RunRollbackCommandOptions {
  versionIdArg?: string;
  label?: string;
  yes?: boolean;
  json?: boolean;
  cwd?: string;
  explicitProfile?: string;
  baseUrl?: string;
  interactive?: boolean;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  output?: CommandOutput;
  prompts?: MissingPenPrompts & {
    selectProfile?: (
      question: string,
      options: SelectOption<string>[],
      defaultIndex: number,
    ) => Promise<string>;
  };
}

export interface RollbackCommandResult {
  pen: Pen;
  restoredVersionId: string;
  newVersionId: string | null;
  writtenPaths: string[];
  deletedPaths: string[];
}

export async function runRollbackCommand(
  options: RunRollbackCommandOptions = {},
): Promise<RollbackCommandResult | null> {
  const output = options.output ?? defaultOutput;
  const jsonMode = Boolean(options.json);
  const interactive = !jsonMode && (options.interactive ?? isInteractive());
  const selectImpl = options.prompts?.select ?? promptSelect;
  const confirmImpl = options.prompts?.confirm ?? promptConfirm;

  assertValidVersionLabel(options.label);

  const project = await requireProject(options.cwd ?? process.cwd());
  const auth = await resolveCommandAuth({
    explicitProfile: options.explicitProfile,
    project,
    interactive,
    persistProfileToProject: !jsonMode,
    output,
    env: options.env,
    homeDir: options.homeDir,
    selectProfile: options.prompts?.selectProfile,
  });
  const client = new CodePenClient({ apiKey: auth.apiKey, baseUrl: options.baseUrl });

  const penLookup = await fetchLinkedPenOrHandleMissing({
    client,
    project,
    auth,
    commandName: 'rollback',
    interactive,
    json: jsonMode,
    output,
    prompts: options.prompts,
  });
  if (!penLookup.found) {
    return null;
  }

  let targetVersionId = options.versionIdArg?.trim();

  if (!targetVersionId) {
    if (!interactive) {
      throw new CliError(
        400,
        'Missing <version-id>. Run `cdpn versions` to list available version IDs.',
      );
    }

    const page = await client.listVersions(project.config.pen_id, {
      per_page: 10,
      sort: 'created',
      direction: 'desc',
    });

    if (page.items.length === 0) {
      throw new CliError(404, 'No saved versions available to restore.');
    }

    targetVersionId = await selectImpl(
      'Select a version to restore to head:',
      page.items.map((v) => ({
        value: v.id,
        label: `${shortId(v.id)}${v.label ? ` — ${v.label}` : ''}`,
        description: `${v.build?.status ?? 'Unknown'} · ${formatDate(v.created_at)}${v.deployed ? ' · deployed' : ''}`,
      })),
      0,
    );
  }

  if (!options.yes) {
    if (!interactive) {
      throw new CliError(400, 'Refusing to rollback in non-interactive mode without --yes.');
    }
    const ok = await confirmImpl(
      `Restore version ${fmt.cyan(targetVersionId)} as the new head and overwrite local files?`,
      false,
    );
    if (!ok) {
      output.log('Aborted.');
      return null;
    }
  }

  if (!jsonMode) {
    output.log(`Restoring version ${fmt.cyan(shortId(targetVersionId))}…`);
  }
  const updatedPen = await client.restoreVersion(
    project.config.pen_id,
    targetVersionId,
    options.label,
  );

  const newHeadId = updatedPen.saved_version?.id ?? null;
  const [localFiles, remoteFiles] = await Promise.all([
    scanLocalFiles(project.rootDir),
    client.getPenFiles(updatedPen.id),
  ]);

  const materialized = await syncRemoteFilesToDisk({
    client,
    rootDir: project.rootDir,
    remoteFiles,
    existingLocalPaths: localFiles.keys(),
    pruneRemoved: true,
  });

  await writeProjectConfig(project.rootDir, {
    url: project.config.url || updatedPen.urls.editor,
    pen_id: updatedPen.id,
    ...(project.config.profile ? { profile: project.config.profile } : {}),
    last_synced_version_id: newHeadId,
    editor: updatedPen.editor,
    ...buildPenInfoConfigFields(updatedPen),
    files: buildSyncedFileMap(remoteFiles, materialized.localSha256ByPath),
  });

  if (jsonMode) {
    printJsonResponse(
      200,
      `Restored version ${targetVersionId} to head.`,
      {
        pen: updatedPen,
        profile: auth.profile ?? project.config.profile ?? null,
        restored_version_id: targetVersionId,
        new_version_id: newHeadId,
        written_paths: materialized.writtenPaths,
        deleted_paths: materialized.deletedPaths,
      },
      output,
    );
  } else {
    output.log(
      `\n${fmt.green('✓')} Restored version ${fmt.dim(shortId(targetVersionId))} → new head ${fmt.dim(shortId(newHeadId))}`,
    );
    output.log(
      `  Synced ${materialized.writtenPaths.length} file(s)` +
        (materialized.deletedPaths.length > 0
          ? `, removed ${materialized.deletedPaths.length} file(s)`
          : ''),
    );
  }

  return {
    pen: updatedPen,
    restoredVersionId: targetVersionId,
    newVersionId: newHeadId,
    writtenPaths: materialized.writtenPaths,
    deletedPaths: materialized.deletedPaths,
  };
}

export function registerRollbackCommand(program: Command): void {
  program
    .command('rollback [version-id]')
    .description('Restore an older saved version to head and sync files locally')
    .option('-m, --label <label>', 'Optional label for the restored version (max 80 chars)')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--json', 'Output rollback result as JSON')
    .action(
      async (
        versionIdArg: string | undefined,
        options: { label?: string; yes?: boolean; json?: boolean },
        command: Command,
      ) => {
        await runRollbackCommand({
          versionIdArg,
          label: options.label,
          yes: options.yes,
          json: options.json,
          explicitProfile: getGlobalProfileOption(command),
        });
      },
    );
}
