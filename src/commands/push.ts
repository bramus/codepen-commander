import type { Command } from 'commander';
import { CodePenClient } from '../api/client.js';
import {
  buildSyncedFileMap,
  findProject,
  PROJECT_CONFIG_FILENAME,
  writeProjectConfig,
  type ProjectLocation,
} from '../config/project.js';
import { getGlobalProfileOption, resolveCommandAuth } from './auth-context.js';
import { createPenFromDirectory } from './create-pen.js';
import { computeSyncDiff, hasDiffChanges } from '../sync/diff.js';
import { scanLocalFiles } from '../sync/fs.js';
import { applyCompilerPatchesToDisk } from '../sync/materialize.js';
import type { BinaryUploadPart, Build, BuildPatch, FileChange, Pen } from '../types.js';
import { fmt, printBuildSummary, shortId } from '../utils/format.js';
import { CliError, printJsonResponse } from '../utils/json.js';
import { isInteractive } from '../utils/prompts.js';

export interface PushOptions {
  label?: string;
  force?: boolean;
  dryRun?: boolean;
  wait?: boolean;
  title?: string;
  access?: string;
  password?: string;
  json?: boolean;
  silent?: boolean;
}

export interface PushExecutionResult {
  pushed: boolean;
  dryRun: boolean;
  pen: Pen;
  versionId: string | null;
  build: Build | null;
  changes: {
    added: string[];
    modified: string[];
    deleted: string[];
  };
  appliedPatches: BuildPatch[];
}

export async function executePush(
  client: CodePenClient,
  project: ProjectLocation,
  options: PushOptions = {},
): Promise<PushExecutionResult> {
  const silent = Boolean(options.silent);
  const [pen, remoteFiles, localFiles] = await Promise.all([
    client.getPen(project.config.pen_id),
    client.getPenFiles(project.config.pen_id),
    scanLocalFiles(project.rootDir),
  ]);

  if (pen.editor === 'Classic') {
    throw new CliError(
      403,
      'This is a Classic Pen, which is read-only in CodePen API v2. Only CodePen 2.0 Pens can be pushed.',
    );
  }

  const localHead = project.config.last_synced_version_id;
  const remoteHead = pen.saved_version?.id ?? null;

  if (remoteHead && localHead && remoteHead !== localHead && !options.force) {
    throw new CliError(
      409,
      `Remote Pen head (${shortId(remoteHead)}) has moved ahead of your last synced version (${shortId(localHead)}).\n` +
        'Run `cdpn status` to inspect differences, `cdpn pull` to sync remote changes, or `cdpn push --force` to overwrite.',
      {
        local_head: localHead,
        remote_head: remoteHead,
      },
    );
  }

  const diff = await computeSyncDiff({
    localFiles,
    remoteFiles,
    baseline: project.config.files,
    downloadFile: (url) => client.downloadFile(url),
  });

  if (!hasDiffChanges(diff)) {
    if (!silent) {
      console.log(`${fmt.green('✓')} Everything is up to date — nothing to push.`);
    }
    return {
      pushed: false,
      dryRun: Boolean(options.dryRun),
      pen,
      versionId: remoteHead,
      build: pen.saved_version?.build ?? null,
      changes: { added: [], modified: [], deleted: [] },
      appliedPatches: [],
    };
  }

  const changes = {
    added: diff.added.map((item) => item.path),
    modified: diff.modified.map((item) => item.path),
    deleted: diff.deleted.map((item) => item.path),
  };

  if (!silent) {
    console.log(
      `${options.dryRun ? 'Dry-run pushing' : 'Pushing'} changes to ${fmt.bold(pen.title || 'Untitled')} ${fmt.dim(`(${pen.id})`)}:`,
    );
    for (const item of diff.added) console.log(`  ${fmt.green('+')} ${item.path}`);
    for (const item of diff.modified) console.log(`  ${fmt.yellow('~')} ${item.path}`);
    for (const item of diff.deleted) console.log(`  ${fmt.red('-')} ${item.path}`);
  }

  const fileChanges: FileChange[] = [];
  const binaryUploads: BinaryUploadPart[] = [];

  for (const item of [...diff.added, ...diff.modified]) {
    const local = item.local!;
    // Note: CodePen API returns 400 on empty multipart parts, so 0-byte files always go as text JSON
    if (local.isBinary && local.buffer.length > 0) {
      binaryUploads.push({ path: item.path, content: local.buffer });
    } else {
      fileChanges.push({
        path: item.path,
        content: local.textContent ?? '',
      });
    }
  }

  for (const item of diff.deleted) {
    fileChanges.push({
      path: item.path,
      delete: true,
    });
  }

  const expectedVersionId = options.force ? undefined : (localHead ?? remoteHead ?? undefined);
  const shouldWait = options.wait !== false;

  if (!silent) {
    console.log(shouldWait ? '\nUploading and building on CodePen…' : '\nUploading to CodePen…');
  }

  const writeResult = await client.writePenFiles(
    pen.id,
    {
      files: fileChanges,
      ...(options.label ? { label: options.label } : {}),
      ...(expectedVersionId ? { expected_version_id: expectedVersionId } : {}),
      ...(options.dryRun ? { dry_run: true } : {}),
      wait: shouldWait ? 45 : 0,
    },
    binaryUploads,
  );

  let finalBuild = writeResult.build;
  if (finalBuild && shouldWait) {
    let lastStatus = `${finalBuild.status}:${finalBuild.id}`;
    finalBuild = await client.settleBuild(finalBuild, {
      onUpdate: (b) => {
        if (silent) return;
        const key = `${b.status}:${b.id}`;
        if (key !== lastStatus) {
          lastStatus = key;
          if (b.status === 'Running' || b.status === 'Queued') {
            console.log(fmt.dim(`  Build ${shortId(b.id)}: ${b.status}…`));
          } else if (b.status === 'Canceled' && b.next_id) {
            console.log(fmt.dim('  Compiler requested patches — waiting for converged rebuild…'));
          }
        }
      },
    });
  }

  if (finalBuild && !silent) {
    printBuildSummary(finalBuild);
  }

  const finalVersionId = finalBuild?.version_id ?? writeResult.version?.id ?? null;
  const appliedPatches = finalBuild?.applied_patches ?? [];

  if (options.dryRun) {
    if (!silent) {
      console.log(
        `\n${fmt.cyan('ℹ')} Dry run complete — no changes were saved to CodePen head` +
          (finalVersionId ? ` ${fmt.dim(`(ephemeral version ${shortId(finalVersionId)})`)}.` : '.'),
      );
    }
    return {
      pushed: false,
      dryRun: true,
      pen: writeResult.pen ?? pen,
      versionId: finalVersionId,
      build: finalBuild,
      changes,
      appliedPatches,
    };
  }

  // Re-read the converged version's source files so we write back any compiler patches
  let convergedFiles = writeResult.version?.files;
  if (finalVersionId && (appliedPatches.length > 0 || !convergedFiles)) {
    const version = await client.getVersion(finalVersionId);
    convergedFiles = version.files;
  }

  if (finalBuild && appliedPatches.length > 0) {
    await applyCompilerPatchesToDisk({
      client,
      rootDir: project.rootDir,
      patches: appliedPatches,
      convergedFiles,
    });
    if (!silent) {
      console.log(fmt.cyan('✓ Synced compiler patches back to local folder.'));
    }
  }

  // Re-scan local hashes so .cdpn.json reflects exact post-patch local state
  const postPushLocalFiles = await scanLocalFiles(project.rootDir);
  const localShaByPath = new Map<string, string>();
  for (const [p, lf] of postPushLocalFiles) {
    localShaByPath.set(p, lf.sha256);
  }

  const finalRemoteFiles = convergedFiles ?? (await client.getPenFiles(pen.id));
  const updatedPen = writeResult.pen ?? pen;

  await writeProjectConfig(project.rootDir, {
    url: project.config.url || updatedPen.urls.editor,
    pen_id: updatedPen.id,
    ...(project.config.profile ? { profile: project.config.profile } : {}),
    last_synced_version_id: finalVersionId,
    editor: updatedPen.editor,
    files: buildSyncedFileMap(finalRemoteFiles, localShaByPath),
  });

  if (finalBuild?.status === 'Failed') {
    if (!silent) {
      console.log(
        `\n${fmt.yellow('!')} Files were saved as version ${fmt.dim(shortId(finalVersionId))}, but the build failed.`,
      );
    }
    process.exitCode = 1;
  } else if (!silent) {
    console.log(
      `\n${fmt.green('✓')} Pushed successfully ${fmt.dim(`(version ${shortId(finalVersionId)})`)}`,
    );
    console.log(`  Preview: ${fmt.cyan(updatedPen.urls.preview)}`);
  }

  return {
    pushed: true,
    dryRun: false,
    pen: updatedPen,
    versionId: finalVersionId,
    build: finalBuild,
    changes,
    appliedPatches,
  };
}

export function registerPushCommand(program: Command): void {
  program
    .command('push')
    .description('Push local file changes to CodePen (or push an unlinked demo folder as a new Pen)')
    .option('-m, --label <label>', 'Label for the saved version (max 80 chars)')
    .option('-f, --force', 'Overwrite remote head if moved (or skip missing index.html prompt on first push)')
    .option('--dry-run', 'Build proposed changes without saving them to the Pen head')
    .option('--no-wait', 'Return as soon as files are saved without waiting for the build')
    .option('-t, --title <title>', 'Title for the new Pen when pushing an unlinked folder for the first time')
    .option('--access <level>', 'Privacy for a new Pen: Public, Private, Protected, or Collaborators')
    .option('--password <password>', 'Password for a new Protected Pen (min 8 chars)')
    .option('--json', 'Output push result as JSON')
    .action(async (options: PushOptions, command: Command) => {
      if (options.label && options.label.length > 80) {
        throw new CliError(400, 'Version label must be at most 80 characters.');
      }

      const explicitProfile = getGlobalProfileOption(command);
      const project = await findProject(process.cwd());

      // First-time push: no .cdpn.json found -> push local folder as a brand-new CodePen 2.0 Pen
      if (!project) {
        if (options.dryRun) {
          throw new CliError(
            400,
            `No ${PROJECT_CONFIG_FILENAME} found. --dry-run is only supported for an existing synced Pen.`,
          );
        }

        if (!options.json) {
          console.log(
            fmt.dim(`No ${PROJECT_CONFIG_FILENAME} found — pushing this local folder as a new CodePen 2.0 Pen.`),
          );
        }
        const created = await createPenFromDirectory({
          targetDir: process.cwd(),
          folderDisplay: '.',
          explicitProfile,
          title: options.title,
          access: options.access,
          password: options.password,
          force: options.force,
          wait: options.wait,
          silent: Boolean(options.json),
          interactive: !options.json && isInteractive(),
        });

        if (created && options.json) {
          const buildFailed = created.build?.status === 'Failed';
          if (buildFailed) {
            process.exitCode = 1;
          }
          printJsonResponse(
            buildFailed ? 422 : 201,
            buildFailed
              ? `Created Pen ${created.pen.title || 'Untitled'} (${created.pen.id}), but the initial build failed.`
              : `Created Pen ${created.pen.title || 'Untitled'} (${created.pen.id}).`,
            {
              pushed: true,
              created: true,
              dry_run: false,
              pen: created.pen,
              profile: created.auth.profile,
              folder: '.',
              root_dir: created.project.rootDir,
              config_path: created.project.configPath,
              version_id: created.versionId,
              build: created.build,
            },
          );
        }
        return;
      }

      const auth = await resolveCommandAuth({
        explicitProfile,
        project,
        interactive: !options.json && isInteractive(),
        persistProfileToProject: !options.json,
      });
      const client = new CodePenClient({ apiKey: auth.apiKey });

      const result = await executePush(client, project, {
        ...options,
        silent: Boolean(options.json),
      });

      if (options.json) {
        const buildFailed = result.build?.status === 'Failed';
        const payload = {
          pushed: result.pushed,
          created: false,
          dry_run: result.dryRun,
          pen: result.pen,
          profile: auth.profile,
          version_id: result.versionId,
          build: result.build,
          changes: result.changes,
          applied_patches: result.appliedPatches,
        };

        if (result.dryRun) {
          if (buildFailed) {
            process.exitCode = 1;
          }
          printJsonResponse(
            buildFailed ? 422 : 200,
            buildFailed
              ? 'Dry run completed, but the build failed.'
              : 'Dry run complete — no changes were saved to CodePen head.',
            payload,
          );
        } else if (!result.pushed) {
          printJsonResponse(200, 'Everything is up to date — nothing to push.', payload);
        } else if (buildFailed) {
          process.exitCode = 1;
          printJsonResponse(
            422,
            `Files were saved as version ${shortId(result.versionId)}, but the build failed.`,
            payload,
          );
        } else {
          printJsonResponse(
            200,
            `Pushed successfully (version ${shortId(result.versionId)}).`,
            payload,
          );
        }
      }
    });
}
