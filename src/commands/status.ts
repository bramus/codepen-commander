import type { Command } from 'commander';
import { CodePenClient } from '../api/client.js';
import { requireAuth } from '../config/auth.js';
import { requireProject } from '../config/project.js';
import { computeSyncDiff, detectLocalChangesFromBaseline, hasDiffChanges } from '../sync/diff.js';
import { scanLocalFiles } from '../sync/fs.js';
import { fmt, shortId } from '../utils/format.js';

export function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .description('Compare local files with the online version on CodePen')
    .option('--json', 'Output status as JSON')
    .action(async (options: { json?: boolean }) => {
      const auth = await requireAuth();
      const project = await requireProject();
      const client = new CodePenClient({ apiKey: auth.apiKey });

      const [pen, remoteFiles, localFiles] = await Promise.all([
        client.getPen(project.config.pen_id),
        client.getPenFiles(project.config.pen_id),
        scanLocalFiles(project.rootDir),
      ]);

      const diff = await computeSyncDiff({
        localFiles,
        remoteFiles,
        baseline: project.config.files,
        downloadFile: (url) => client.downloadFile(url),
      });

      const localHead = project.config.last_synced_version_id;
      const remoteHead = pen.saved_version?.id ?? null;
      const remoteMoved = Boolean(remoteHead && localHead && remoteHead !== localHead);
      const localBaselineChanges = detectLocalChangesFromBaseline(localFiles, project.config.files);

      if (options.json) {
        console.log(
          JSON.stringify(
            {
              pen_id: pen.id,
              title: pen.title,
              editor: pen.editor,
              url: project.config.url,
              local_version_id: localHead,
              remote_version_id: remoteHead,
              remote_ahead: remoteMoved,
              build_status: pen.saved_version?.build?.status ?? null,
              deployment: pen.deployment,
              changes: {
                added: diff.added.map((i) => i.path),
                modified: diff.modified.map((i) => i.path),
                deleted: diff.deleted.map((i) => i.path),
                unchanged: diff.unchanged.map((i) => i.path),
              },
            },
            null,
            2,
          ),
        );
        return;
      }

      console.log(`${fmt.bold(pen.title || 'Untitled')} ${fmt.dim(`(${pen.id}, ${pen.editor})`)}`);
      console.log(`URL:      ${fmt.cyan(project.config.url)}`);
      console.log(`Synced:   ${fmt.dim(shortId(localHead))}`);
      console.log(
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
        console.log(`Build:    ${colored}`);
      }

      if (pen.deployment) {
        const deployedIsHead = pen.deployment.version_id === remoteHead;
        const deployNote = deployedIsHead
          ? fmt.green('up to date')
          : fmt.yellow(`older version ${shortId(pen.deployment.version_id)}`);
        console.log(`Deployed: ${fmt.cyan(pen.deployment.url)} ${fmt.dim(`(${deployNote})`)}`);
        if (pen.deployment.custom_domains.length > 0) {
          console.log(`Domains:  ${pen.deployment.custom_domains.join(', ')}`);
        }
      } else {
        console.log(`Deployed: ${fmt.dim('not deployed')}`);
      }

      console.log('');

      if (!hasDiffChanges(diff)) {
        if (remoteMoved) {
          console.log(
            `${fmt.yellow('!')} Local files match remote content, but version metadata is behind. Run \`cdpn pull\` to update ${fmt.dim('.cdpn.json')}.`,
          );
        } else {
          console.log(`${fmt.green('✓')} Up to date with CodePen (${diff.unchanged.length} file(s)).`);
        }
        return;
      }

      const localModifiedSet = new Set([
        ...localBaselineChanges.added,
        ...localBaselineChanges.modified,
        ...localBaselineChanges.deleted,
      ]);

      console.log('Differences between local folder and remote head:');
      for (const item of diff.added) {
        const hint = remoteMoved && !localModifiedSet.has(item.path) ? fmt.dim(' (deleted remotely)') : '';
        console.log(`  ${fmt.green('+')} ${item.path}${hint}`);
      }
      for (const item of diff.modified) {
        const hint = remoteMoved && !localModifiedSet.has(item.path) ? fmt.dim(' (changed remotely)') : '';
        console.log(`  ${fmt.yellow('~')} ${item.path}${hint}`);
      }
      for (const item of diff.deleted) {
        const hint = remoteMoved && !localModifiedSet.has(item.path) ? fmt.dim(' (added remotely)') : '';
        console.log(`  ${fmt.red('-')} ${item.path}${hint}`);
      }

      console.log('');
      if (remoteMoved) {
        console.log(
          fmt.yellow(
            'Remote has newer commits. Run `cdpn pull` to sync remote changes, or `cdpn push --force` to overwrite remote with local.',
          ),
        );
      } else {
        console.log(fmt.dim('Run `cdpn push` to upload these changes, or `cdpn pull` to discard local changes.'));
      }
    });
}
