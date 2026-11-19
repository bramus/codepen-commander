import fs from 'node:fs/promises';
import path from 'node:path';
import type { Command } from 'commander';
import { CodePenClient } from '../api/client.js';
import {
  buildSyncedFileMap,
  hasProjectConfigInDir,
  PROJECT_CONFIG_FILENAME,
  suggestFolderName,
  writeProjectConfig,
} from '../config/project.js';
import { isDirectoryNonEmpty, scanLocalFiles } from '../sync/fs.js';
import { syncRemoteFilesToDisk } from '../sync/materialize.js';
import type { BinaryUploadPart, PenAccess, PenFileRequest } from '../types.js';
import { fmt, printBuildSummary, shortId } from '../utils/format.js';
import { isInteractive, promptText } from '../utils/prompts.js';
import { getGlobalProfileOption, resolveCommandAuth } from './auth-context.js';

export interface NewPenOptions {
  title?: string;
  description?: string;
  tags?: string;
  access?: string;
  password?: string;
  template?: boolean;
  starter?: boolean;
}

const VALID_ACCESS = new Set(['public', 'private', 'protected', 'collaborators']);

function normalizeAccess(raw?: string): PenAccess | undefined {
  if (!raw) return undefined;
  const lower = raw.trim().toLowerCase();
  if (!VALID_ACCESS.has(lower)) {
    throw new Error(`Invalid access level "${raw}". Use: Public, Private, Protected, or Collaborators.`);
  }
  return (lower[0]!.toUpperCase() + lower.slice(1)) as PenAccess;
}

export function registerNewCommand(program: Command): void {
  program
    .command('new [folder]')
    .description('Create a new CodePen 2.0 Pen (from local folder files or CodePen starter files)')
    .option('-t, --title <title>', 'Title for the new Pen')
    .option('-d, --description <text>', 'Description for the new Pen')
    .option('--tags <tags>', 'Comma-separated tags (up to 5)')
    .option('--access <level>', 'Privacy: Public, Private, Protected, or Collaborators')
    .option('--password <password>', 'Password (min 8 chars; required with --access Protected)')
    .option('--template', 'Mark the Pen as a template')
    .option('--starter', 'Create with CodePen starter files instead of uploading local files')
    .action(async (folderArg: string | undefined, options: NewPenOptions, command: Command) => {
      const access = normalizeAccess(options.access);
      if (access === 'Protected' && (!options.password || options.password.length < 8)) {
        throw new Error('Protected Pens require --password with at least 8 characters.');
      }

      const tags = options.tags
        ? options.tags
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean)
        : undefined;

      // Determine target directory and whether we are uploading existing local files
      let targetDir: string;
      let folderDisplay: string;
      let uploadLocalFiles = false;

      if (folderArg) {
        targetDir = path.resolve(process.cwd(), folderArg);
        folderDisplay = folderArg;
      } else {
        targetDir = process.cwd();
        folderDisplay = '.';
      }

      if (await hasProjectConfigInDir(targetDir)) {
        throw new Error(
          `${targetDir} already contains ${PROJECT_CONFIG_FILENAME}. Use \`cdpn push\` to update the existing Pen or specify a different folder.`,
        );
      }

      const auth = await resolveCommandAuth({
        explicitProfile: getGlobalProfileOption(command),
        promptMessage: 'Which CodePen profile should own this new Pen?',
      });
      const client = new CodePenClient({ apiKey: auth.apiKey });

      const hasExistingFiles = await isDirectoryNonEmpty(targetDir);
      if (hasExistingFiles && !options.starter) {
        uploadLocalFiles = true;
      }

      let title = options.title;
      if (!title && isInteractive()) {
        const defaultTitle =
          folderArg && folderArg !== '.' ? path.basename(targetDir) : path.basename(targetDir) || 'Untitled';
        title = await promptText('Pen title', defaultTitle);
      }

      const textFiles: PenFileRequest[] = [];
      const binaryFiles: BinaryUploadPart[] = [];

      if (uploadLocalFiles) {
        const scanned = await scanLocalFiles(targetDir);
        for (const [filePath, lf] of scanned) {
          if (lf.isBinary && lf.buffer.length > 0) {
            binaryFiles.push({ path: filePath, content: lf.buffer });
          } else {
            textFiles.push({ path: filePath, content: lf.textContent ?? '' });
          }
        }
      }

      console.log(
        uploadLocalFiles
          ? `Creating new Pen from ${textFiles.length + binaryFiles.length} local file(s)…`
          : 'Creating new CodePen 2.0 Pen with starter files…',
      );

      const created = await client.createPen(
        {
          ...(title ? { title } : {}),
          ...(options.description ? { description: options.description } : {}),
          ...(tags && tags.length > 0 ? { tags } : {}),
          ...(access ? { access } : {}),
          ...(options.password ? { password: options.password } : {}),
          ...(options.template ? { template: true } : {}),
          ...(uploadLocalFiles ? { files: textFiles } : {}),
          wait: 45,
        },
        binaryFiles,
      );

      let finalBuild = created.build ?? null;
      if (finalBuild) {
        finalBuild = await client.settleBuild(finalBuild);
        printBuildSummary(finalBuild);
      }

      // If no folder was specified and cwd was empty, optionally create a subfolder or use cwd
      if (!folderArg && !uploadLocalFiles && isInteractive()) {
        const defaultName = suggestFolderName(created);
        const chosen = await promptText('Local folder to save Pen into', defaultName);
        if (chosen && chosen !== '.') {
          targetDir = path.resolve(process.cwd(), chosen);
          folderDisplay = chosen;
        }
      }

      await fs.mkdir(targetDir, { recursive: true });

      const finalVersionId = finalBuild?.version_id ?? created.saved_version?.id ?? null;
      const remoteFiles = finalVersionId
        ? (await client.getVersion(finalVersionId)).files ?? (await client.getPenFiles(created.id))
        : await client.getPenFiles(created.id);

      const materialized = await syncRemoteFilesToDisk({
        client,
        rootDir: targetDir,
        remoteFiles,
        pruneRemoved: false,
      });

      await writeProjectConfig(targetDir, {
        url: created.urls.editor,
        pen_id: created.id,
        ...(auth.profile ? { profile: auth.profile } : {}),
        last_synced_version_id: finalVersionId,
        editor: created.editor,
        files: buildSyncedFileMap(remoteFiles, materialized.localSha256ByPath),
      });

      console.log(`\n${fmt.green('✓')} Created Pen ${fmt.bold(created.title || 'Untitled')} ${fmt.dim(`(${created.id})`)}`);
      if (auth.profile) {
        console.log(`  Profile: ${fmt.cyan(auth.profile)}`);
      }
      console.log(`  Folder:  ${fmt.cyan(folderDisplay)}`);
      console.log(`  Editor:  ${fmt.cyan(created.urls.editor)}`);
      console.log(`  Preview: ${fmt.cyan(created.urls.preview)}`);
      console.log(`  Version: ${fmt.dim(shortId(finalVersionId))}`);
    });
}
