import type { Command } from 'commander';
import { CodePenClient } from '../api/client.js';
import { buildSyncedFileMap, requireProject, writeProjectConfig } from '../config/project.js';
import { scanLocalFiles } from '../sync/fs.js';
import { buildPenInfoConfigFields } from '../sync/info.js';
import { syncRemoteFilesToDisk } from '../sync/materialize.js';
import { fmt, formatDate, formatTable, shortId } from '../utils/format.js';
import { CliError, printJsonResponse } from '../utils/json.js';
import { isInteractive, promptConfirm, promptSelect } from '../utils/prompts.js';
import { getGlobalProfileOption, resolveCommandAuth } from './auth-context.js';

export function registerVersionCommands(program: Command): void {
  program
    .command('versions')
    .description('List saved versions of this Pen')
    .option('-n, --limit <count>', 'Maximum number of versions to show', '15')
    .option('--json', 'Output versions as JSON')
    .action(async (options: { limit?: string; json?: boolean }, command: Command) => {
      const limit = Number.parseInt(options.limit ?? '15', 10);
      if (Number.isNaN(limit) || limit < 1) {
        throw new CliError(400, '--limit must be a positive integer.');
      }

      const project = await requireProject();
      const auth = await resolveCommandAuth({
        explicitProfile: getGlobalProfileOption(command),
        project,
        interactive: options.json ? false : undefined,
        persistProfileToProject: !options.json,
      });
      const client = new CodePenClient({ apiKey: auth.apiKey });

      const [pen, versionsPage] = await Promise.all([
        client.getPen(project.config.pen_id),
        client.listVersions(project.config.pen_id, {
          per_page: Math.min(limit, 100),
          sort: 'created',
          direction: 'desc',
        }),
      ]);

      if (pen.editor === 'Classic') {
        if (options.json) {
          printJsonResponse(200, 'Classic Pens do not have saved versions in CodePen API v2.', []);
        } else {
          console.log(fmt.yellow('Classic Pens do not have saved versions in CodePen API v2.'));
        }
        return;
      }

      const versions = versionsPage.items.slice(0, limit);
      if (options.json) {
        const message =
          versions.length === 0
            ? 'No saved versions found.'
            : `Found ${versions.length} saved version(s).`;
        printJsonResponse(200, message, versions);
        return;
      }

      if (versions.length === 0) {
        console.log(fmt.dim('No saved versions found.'));
        return;
      }

      const headId = pen.saved_version?.id ?? null;
      const syncedId = project.config.last_synced_version_id;

      const rows = versions.map((v) => {
        const status = v.build?.status ?? '—';
        const coloredStatus =
          status === 'Success'
            ? fmt.green(status)
            : status === 'Failed'
              ? fmt.red(status)
              : fmt.yellow(status);

        const markers: string[] = [];
        if (v.id === headId) markers.push(fmt.cyan('head'));
        if (v.id === syncedId) markers.push(fmt.green('local'));
        if (v.deployed) markers.push(fmt.magenta('deployed'));

        return [
          v.id,
          coloredStatus,
          v.label ? v.label : fmt.dim('—'),
          markers.length > 0 ? markers.join(', ') : fmt.dim('—'),
          fmt.dim(formatDate(v.created_at)),
        ];
      });

      console.log(formatTable(['Version ID', 'Build', 'Label', 'Markers', 'Created'], rows));
    });

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
        if (options.label && options.label.length > 80) {
          throw new CliError(400, 'Version label must be at most 80 characters.');
        }

        const interactive = isInteractive() && !options.json;
        const project = await requireProject();
        const auth = await resolveCommandAuth({
          explicitProfile: getGlobalProfileOption(command),
          project,
          interactive,
          persistProfileToProject: !options.json,
        });
        const client = new CodePenClient({ apiKey: auth.apiKey });

        let targetVersionId = versionIdArg?.trim();

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

          targetVersionId = await promptSelect(
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
          const ok = await promptConfirm(
            `Restore version ${fmt.cyan(targetVersionId)} as the new head and overwrite local files?`,
            false,
          );
          if (!ok) {
            console.log('Aborted.');
            return;
          }
        }

        if (!options.json) {
          console.log(`Restoring version ${fmt.cyan(shortId(targetVersionId))}…`);
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

        if (options.json) {
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
          );
          return;
        }

        console.log(
          `\n${fmt.green('✓')} Restored version ${fmt.dim(shortId(targetVersionId))} → new head ${fmt.dim(shortId(newHeadId))}`,
        );
        console.log(
          `  Synced ${materialized.writtenPaths.length} file(s)` +
            (materialized.deletedPaths.length > 0
              ? `, removed ${materialized.deletedPaths.length} file(s)`
              : ''),
        );
      },
    );
}
