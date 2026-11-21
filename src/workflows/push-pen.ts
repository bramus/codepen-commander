import type { CodePenClient } from '../api/client.js';
import type { BinaryUploadPart, Build, BuildPatch, FileChange, Pen, PenFile } from '../api/types.js';
import {
  buildSyncedFileMap,
  writeProjectConfig,
  type ProjectLocation,
} from '../config/project.js';
import { PROJECT_CONFIG_FILENAME } from '../constants.js';
import { CliError } from '../errors.js';
import { computeSyncDiff, hasDiffChanges } from '../sync/diff.js';
import { scanLocalFiles } from '../sync/fs.js';
import {
  analyzeInfoSync,
  buildInfoUpdatePatch,
  buildPenInfoConfigFields,
  formatInfoValue,
  hashPenInfo,
  isCompletePenInfo,
  type InfoDiffItem,
} from '../sync/info.js';
import { applyCompilerPatchesToDisk } from '../sync/materialize.js';
import { fmt, printBuildSummary, shortId } from '../utils/format.js';
import { defaultOutput, type CommandOutput } from '../utils/output.js';
import { handleMissingRemotePen, isRemotePenNotFoundError } from './missing-pen.js';

export interface PushOptions {
  label?: string;
  force?: boolean;
  dryRun?: boolean;
  wait?: boolean;
  title?: string;
  access?: string;
  visibility?: string;
  password?: string;
  json?: boolean;
  silent?: boolean;
  output?: CommandOutput;
  prefetchedPen?: Pen;
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
  infoChanges: InfoDiffItem[];
  appliedPatches: BuildPatch[];
  remoteInfoChanged?: boolean;
  exitCode?: number;
}

/**
 * Executes a push of local file and `.cdpn.json` metadata changes to an already-linked
 * CodePen 2.0 Pen, handling build convergence, compiler patch sync-back, and conflict detection.
 */
export async function executePush(
  client: CodePenClient,
  project: ProjectLocation,
  options: PushOptions = {},
): Promise<PushExecutionResult> {
  const output = options.output ?? defaultOutput;
  const silent = Boolean(options.silent);
  let pen = options.prefetchedPen;
  if (!pen) {
    try {
      pen = await client.getPen(project.config.pen_id);
    } catch (error) {
      if (isRemotePenNotFoundError(error)) {
        await handleMissingRemotePen({
          client,
          project,
          auth: { profile: project.config.profile ?? null },
          commandName: 'push',
          interactive: false,
          json: options.json,
          output,
        });
      }
      throw error;
    }
  }
  const [remoteFiles, localFiles] = await Promise.all([
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

  const infoAnalysis = analyzeInfoSync(
    project.config.info,
    project.config.last_synced_info_hash,
    pen,
  );

  if (infoAnalysis.localChanged && infoAnalysis.remoteChanged && !options.force) {
    const fields = infoAnalysis.changes.map((c) => c.field).join(', ');
    throw new CliError(
      409,
      `Remote Pen info has changed since your last sync, and you also have local info edits in ${PROJECT_CONFIG_FILENAME} (${fields}).\n` +
        'Run `cdpn status` to inspect differences, `cdpn pull` to sync remote changes, or `cdpn push --force` to overwrite.',
      {
        info_changes: infoAnalysis.changes,
      },
    );
  }

  const hasFileChanges = hasDiffChanges(diff);
  const shouldPushInfo =
    infoAnalysis.changes.length > 0 && (infoAnalysis.localChanged || Boolean(options.force));
  const infoChangesToPush = shouldPushInfo ? infoAnalysis.changes : [];
  // Validate info patch constraints up-front before making any write API calls
  const infoPatch = shouldPushInfo ? buildInfoUpdatePatch(infoChangesToPush) : null;

  if (!hasFileChanges && !shouldPushInfo) {
    let backfilledLegacyInfo = false;
    if (!options.dryRun && infoAnalysis.changes.length === 0) {
      const remoteHash = hashPenInfo(infoAnalysis.remoteInfo);
      const needsInfoUpgrade =
        !infoAnalysis.tracked ||
        !isCompletePenInfo(project.config.info) ||
        project.config.last_synced_info_hash !== remoteHash;
      if (needsInfoUpgrade) {
        backfilledLegacyInfo = !infoAnalysis.tracked;
        const nextConfig = {
          ...project.config,
          ...buildPenInfoConfigFields(pen),
        };
        await writeProjectConfig(project.rootDir, nextConfig);
        project.config = nextConfig;
      }
    }

    if (!silent) {
      if (infoAnalysis.remoteChanged) {
        output.log(
          `${fmt.cyan('ℹ')} No local changes to push. Remote Pen info has changed on CodePen — run \`cdpn pull\` to update ${PROJECT_CONFIG_FILENAME}, or \`cdpn push --force\` to overwrite.`,
        );
      } else {
        output.log(`${fmt.green('✓')} Everything is up to date — nothing to push.`);
        if (backfilledLegacyInfo) {
          output.log(fmt.dim(`  Added Pen info to ${PROJECT_CONFIG_FILENAME}.`));
        }
      }
    }

    return {
      pushed: false,
      dryRun: Boolean(options.dryRun),
      pen,
      versionId: remoteHead,
      build: pen.saved_version?.build ?? null,
      changes: { added: [], modified: [], deleted: [] },
      infoChanges: [],
      appliedPatches: [],
      remoteInfoChanged: infoAnalysis.remoteChanged,
    };
  }

  const changes = {
    added: diff.added.map((item) => item.path),
    modified: diff.modified.map((item) => item.path),
    deleted: diff.deleted.map((item) => item.path),
  };

  if (!silent) {
    output.log(
      `${options.dryRun ? 'Dry-run pushing' : 'Pushing'} changes to ${fmt.bold(pen.title || 'Untitled')} ${fmt.dim(`(${pen.id})`)}:`,
    );
    for (const item of diff.added) output.log(`  ${fmt.green('+')} ${item.path}`);
    for (const item of diff.modified) output.log(`  ${fmt.yellow('~')} ${item.path}`);
    for (const item of diff.deleted) output.log(`  ${fmt.red('-')} ${item.path}`);
    for (const change of infoChangesToPush) {
      output.log(
        `  ${fmt.yellow('~')} info.${change.field}: ${formatInfoValue(change.field, change.remote)} → ${formatInfoValue(change.field, change.local)}`,
      );
    }
  }

  let finalBuild: Build | null = pen.saved_version?.build ?? null;
  let finalVersionId: string | null = remoteHead;
  let appliedPatches: BuildPatch[] = [];
  let updatedPen: Pen = pen;
  let finalRemoteFiles: PenFile[] | undefined;
  let localShaByPath: Map<string, string> | undefined;

  if (hasFileChanges) {
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
      output.log(shouldWait ? '\nUploading and building on CodePen…' : '\nUploading to CodePen…');
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

    finalBuild = writeResult.build;
    if (finalBuild && shouldWait) {
      let lastStatus = `${finalBuild.status}:${finalBuild.id}`;
      finalBuild = await client.settleBuild(finalBuild, {
        onUpdate: (b) => {
          if (silent) return;
          const key = `${b.status}:${b.id}`;
          if (key !== lastStatus) {
            lastStatus = key;
            if (b.status === 'Running' || b.status === 'Queued') {
              output.log(fmt.dim(`  Build ${shortId(b.id)}: ${b.status}…`));
            } else if (b.status === 'Canceled' && b.next_id) {
              output.log(fmt.dim('  Compiler requested patches — waiting for converged rebuild…'));
            }
          }
        },
      });
    }

    if (finalBuild && !silent) {
      printBuildSummary(finalBuild, output);
    }

    finalVersionId = finalBuild?.version_id ?? writeResult.version?.id ?? null;
    appliedPatches = finalBuild?.applied_patches ?? [];
    updatedPen = writeResult.pen ?? pen;

    if (!options.dryRun) {
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
          output.log(fmt.cyan('✓ Synced compiler patches back to local folder.'));
        }
      }

      // Re-scan local hashes so .cdpn.json reflects exact post-patch local state
      const postPushLocalFiles = await scanLocalFiles(project.rootDir);
      localShaByPath = new Map<string, string>();
      for (const [p, lf] of postPushLocalFiles) {
        localShaByPath.set(p, lf.sha256);
      }

      finalRemoteFiles = convergedFiles ?? (await client.getPenFiles(pen.id));

      // If an info PATCH is still pending, persist the synced file manifest now while preserving
      // unpushed local `info` so a subsequent info validation error never leaves version metadata stale.
      if (shouldPushInfo) {
        const intermediateConfig = {
          url: project.config.url || updatedPen.urls.editor,
          pen_id: updatedPen.id,
          ...(project.config.profile ? { profile: project.config.profile } : {}),
          last_synced_version_id: finalVersionId,
          ...(project.config.last_synced_info_hash
            ? { last_synced_info_hash: project.config.last_synced_info_hash }
            : {}),
          editor: updatedPen.editor,
          ...(project.config.info !== undefined ? { info: project.config.info } : {}),
          files: buildSyncedFileMap(finalRemoteFiles, localShaByPath),
        };
        await writeProjectConfig(project.rootDir, intermediateConfig);
        project.config = intermediateConfig;
      }
    }
  }

  if (options.dryRun) {
    const dryRunBuildFailed = hasFileChanges && finalBuild?.status === 'Failed';
    if (!silent) {
      output.log(
        `\n${fmt.cyan('ℹ')} Dry run complete — no changes were saved to CodePen` +
          (hasFileChanges && finalVersionId
            ? ` ${fmt.dim(`(ephemeral version ${shortId(finalVersionId)})`)}.`
            : '.'),
      );
    }
    return {
      pushed: false,
      dryRun: true,
      pen: updatedPen,
      versionId: hasFileChanges ? finalVersionId : remoteHead,
      build: hasFileChanges ? finalBuild : null,
      changes,
      infoChanges: infoChangesToPush,
      appliedPatches,
      ...(dryRunBuildFailed ? { exitCode: 1 } : {}),
    };
  }

  if (shouldPushInfo && infoPatch) {
    if (!silent) {
      output.log('\nUpdating Pen info on CodePen…');
    }
    updatedPen = await client.updatePen(pen.id, infoPatch);
  }

  const nextConfig = {
    url: project.config.url || updatedPen.urls.editor,
    pen_id: updatedPen.id,
    ...(project.config.profile ? { profile: project.config.profile } : {}),
    last_synced_version_id: hasFileChanges ? finalVersionId : project.config.last_synced_version_id,
    editor: updatedPen.editor,
    ...buildPenInfoConfigFields(updatedPen),
    ...(hasFileChanges && finalRemoteFiles && localShaByPath
      ? { files: buildSyncedFileMap(finalRemoteFiles, localShaByPath) }
      : project.config.files
        ? { files: project.config.files }
        : {}),
  };
  await writeProjectConfig(project.rootDir, nextConfig);
  project.config = nextConfig;

  if (!silent) {
    if (hasFileChanges && !shouldPushInfo && infoAnalysis.remoteChanged) {
      output.log(fmt.cyan(`ℹ Synced remote Pen info into ${PROJECT_CONFIG_FILENAME}.`));
    } else if (hasFileChanges && !infoAnalysis.tracked) {
      output.log(fmt.dim(`Added Pen info to ${PROJECT_CONFIG_FILENAME}.`));
    }
  }

  const buildFailed = hasFileChanges && finalBuild?.status === 'Failed';
  if (buildFailed) {
    if (!silent) {
      output.log(
        `\n${fmt.yellow('!')} Files were saved as version ${fmt.dim(shortId(finalVersionId))}, but the build failed.`,
      );
    }
  } else if (!silent) {
    if (hasFileChanges) {
      output.log(
        `\n${fmt.green('✓')} Pushed successfully ${fmt.dim(`(version ${shortId(finalVersionId)})`)}`,
      );
      output.log(`  Preview: ${fmt.cyan(updatedPen.urls.preview)}`);
    } else {
      output.log(`\n${fmt.green('✓')} Updated Pen info successfully.`);
      output.log(`  Editor:  ${fmt.cyan(updatedPen.urls.editor)}`);
      output.log(`  Preview: ${fmt.cyan(updatedPen.urls.preview)}`);
    }
  }

  return {
    pushed: true,
    dryRun: false,
    pen: updatedPen,
    versionId: finalVersionId,
    build: finalBuild,
    changes,
    infoChanges: infoChangesToPush,
    appliedPatches,
    ...(buildFailed ? { exitCode: 1 } : {}),
  };
}
