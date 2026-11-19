import path from 'node:path';
import type { Command } from 'commander';
import { CodePenClient } from '../api/client.js';
import { requireAuth } from '../config/auth.js';
import {
  buildSyncedFileMap,
  findProject,
  hasProjectConfigInDir,
  normalizePenReference,
  PROJECT_CONFIG_FILENAME,
  suggestFolderName,
  writeProjectConfig,
} from '../config/project.js';
import { detectLocalChangesFromBaseline } from '../sync/diff.js';
import { isDirectoryNonEmpty, scanLocalFiles } from '../sync/fs.js';
import { syncRemoteFilesToDisk } from '../sync/materialize.js';
import { fmt, shortId } from '../utils/format.js';
import { isInteractive, promptConfirm, promptText } from '../utils/prompts.js';

export interface PullOptions {
  force?: boolean;
}

export function registerPullCommand(program: Command): void {
  program
    .command('pull [url] [folder]')
    .description('Download a CodePen Pen to a local folder, or update an existing synced folder')
    .option('-f, --force', 'Overwrite local changes without prompting')
    .action(async (urlArg: string | undefined, folderArg: string | undefined, options: PullOptions) => {
      const auth = await requireAuth();
      const client = new CodePenClient({ apiKey: auth.apiKey });

      // Mode 1: `cdpn pull` with no URL inside an existing synced folder -> update current Pen
      if (!urlArg && !folderArg) {
        const existingProject = await findProject(process.cwd());
        if (existingProject) {
          await pullIntoExistingProject(client, existingProject.rootDir, existingProject.config, options);
          return;
        }
      }

      // Mode 2: Download a new Pen into a target folder
      let rawUrl = urlArg;
      if (!rawUrl) {
        if (!isInteractive()) {
          throw new Error(
            'Missing Pen URL or ID. Usage: `cdpn pull <url> [folder]` (or run `cdpn pull` inside an existing synced folder).',
          );
        }
        rawUrl = await promptText('CodePen URL or Pen ID');
      }

      const { apiIdentifier, originalUrl } = normalizePenReference(rawUrl);

      console.log(`Fetching Pen ${fmt.cyan(apiIdentifier)}…`);
      const pen = await client.getPen(apiIdentifier);
      const defaultFolder = suggestFolderName(pen);

      let targetFolderInput = folderArg;
      if (!targetFolderInput) {
        if (isInteractive()) {
          targetFolderInput = await promptText('Target folder', defaultFolder);
        } else {
          targetFolderInput = defaultFolder;
        }
      }

      const targetDir = path.resolve(process.cwd(), targetFolderInput);

      // Guard against accidentally overwriting an existing non-empty folder
      const hasExistingConfig = await hasProjectConfigInDir(targetDir);
      const nonEmpty = await isDirectoryNonEmpty(targetDir);
      if ((nonEmpty || hasExistingConfig) && !options.force) {
        if (!isInteractive()) {
          throw new Error(
            `Target directory ${targetDir} is not empty. Pass --force to overwrite.`,
          );
        }
        const ok = await promptConfirm(
          `Directory ${fmt.bold(targetFolderInput)} already exists and is not empty. Continue and overwrite matching files?`,
          false,
        );
        if (!ok) {
          console.log('Aborted.');
          return;
        }
      }

      const remoteFiles = await client.getPenFiles(pen.id);
      const result = await syncRemoteFilesToDisk({
        client,
        rootDir: targetDir,
        remoteFiles,
        pruneRemoved: false,
      });

      const syncedFiles = buildSyncedFileMap(remoteFiles, result.localSha256ByPath);
      await writeProjectConfig(targetDir, {
        url: originalUrl ?? pen.urls.editor,
        pen_id: pen.id,
        last_synced_version_id: pen.saved_version?.id ?? null,
        editor: pen.editor,
        files: syncedFiles,
      });

      console.log(
        `\n${fmt.green('✓')} Pulled ${fmt.bold(pen.title || 'Untitled')} ${fmt.dim(`(${pen.id})`)} into ${fmt.cyan(targetFolderInput)}`,
      );
      console.log(`  Files:   ${result.writtenPaths.length} downloaded`);
      if (pen.saved_version) {
        console.log(`  Version: ${fmt.dim(shortId(pen.saved_version.id))}`);
      }
      console.log(`  Config:  ${fmt.dim(path.join(targetFolderInput, PROJECT_CONFIG_FILENAME))}`);

      if (pen.editor === 'Classic') {
        console.log(
          fmt.yellow(
            '\nNote: This is a Classic Pen (read-only through CodePen API v2). You can pull files, but pushing and deploying require a CodePen 2.0 Pen.',
          ),
        );
      }
    });
}

async function pullIntoExistingProject(
  client: CodePenClient,
  rootDir: string,
  config: {
    url: string;
    pen_id: string;
    last_synced_version_id: string | null;
    files?: Record<string, { id: string; content_hash: string; local_sha256: string; is_binary: boolean }>;
  },
  options: PullOptions,
): Promise<void> {
  console.log(`Pulling latest changes for ${fmt.cyan(config.pen_id)}…`);

  const localFiles = await scanLocalFiles(rootDir);
  const localDirty = detectLocalChangesFromBaseline(localFiles, config.files);
  const dirtyCount =
    localDirty.added.length + localDirty.modified.length + localDirty.deleted.length;

  if (dirtyCount > 0 && !options.force) {
    console.log(fmt.yellow('\nWarning: You have uncommitted local changes that will be overwritten:'));
    for (const p of localDirty.added) console.log(`  ${fmt.green('+')} ${p} ${fmt.dim('(will be removed)')}`);
    for (const p of localDirty.modified) console.log(`  ${fmt.yellow('~')} ${p} ${fmt.dim('(will be overwritten)')}`);
    for (const p of localDirty.deleted) console.log(`  ${fmt.red('-')} ${p} ${fmt.dim('(will be restored)')}`);

    if (!isInteractive()) {
      throw new Error('Local changes detected. Commit/push them first, or re-run with --force.');
    }

    const ok = await promptConfirm('\nOverwrite local changes with remote version?', false);
    if (!ok) {
      console.log('Aborted.');
      return;
    }
  }

  const [pen, remoteFiles] = await Promise.all([
    client.getPen(config.pen_id),
    client.getPenFiles(config.pen_id),
  ]);

  const result = await syncRemoteFilesToDisk({
    client,
    rootDir,
    remoteFiles,
    existingLocalPaths: localFiles.keys(),
    pruneRemoved: true,
  });

  const syncedFiles = buildSyncedFileMap(remoteFiles, result.localSha256ByPath);
  await writeProjectConfig(rootDir, {
    url: config.url || pen.urls.editor,
    pen_id: pen.id,
    last_synced_version_id: pen.saved_version?.id ?? null,
    editor: pen.editor,
    files: syncedFiles,
  });

  console.log(`\n${fmt.green('✓')} Synced ${fmt.bold(pen.title || 'Untitled')} ${fmt.dim(`(${pen.id})`)}`);
  console.log(
    `  Updated: ${result.writtenPaths.length} file(s)` +
      (result.deletedPaths.length > 0 ? `, removed ${result.deletedPaths.length} deleted file(s)` : ''),
  );
  if (pen.saved_version) {
    console.log(`  Version: ${fmt.dim(shortId(pen.saved_version.id))}`);
  }
}
