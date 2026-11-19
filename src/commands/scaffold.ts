import fs from 'node:fs/promises';
import path from 'node:path';
import type { CodePenClient } from '../api/client.js';
import { isCodePenApiError } from '../api/errors.js';
import {
  hasProjectConfigInDir,
  normalizePenReference,
  PROJECT_CONFIG_FILENAME,
} from '../config/project.js';
import { isDirectoryNonEmpty, normalizePenPath } from '../sync/fs.js';
import type { BinaryUploadPart, Pen, PenFileRequest } from '../types.js';
import { CliError } from '../utils/json.js';

/**
 * Ensures a local target directory either does not exist yet or is completely empty
 * (and does not already contain `.cdpn.json`).
 */
export async function assertEmptyTargetDirectory(
  targetDir: string,
  folderDisplay: string,
  options: {
    commandName: 'new' | 'fork';
    nonEmptyHint: string;
  },
): Promise<void> {
  try {
    const stat = await fs.lstat(targetDir);
    if (!stat.isDirectory()) {
      throw new CliError(409, `Target path ${folderDisplay} already exists and is not a directory.`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw error;
  }

  if (await hasProjectConfigInDir(targetDir)) {
    throw new CliError(
      409,
      `${folderDisplay} already contains ${PROJECT_CONFIG_FILENAME}. ${options.nonEmptyHint}`,
    );
  }

  if (await isDirectoryNonEmpty(targetDir)) {
    throw new CliError(
      409,
      `Folder ${folderDisplay} is not empty. \`cdpn ${options.commandName}\` requires a new or empty target folder.\n` +
        options.nonEmptyHint,
    );
  }
}

/**
 * Lists the authenticated account's CodePen Templates (`template=true`), newest updated first.
 */
export async function listAccountTemplates(
  client: CodePenClient,
  maxItems = 50,
): Promise<Pen[]> {
  const templates: Pen[] = [];
  let page = await client.listPens({
    template: true,
    sort: 'updated',
    direction: 'desc',
    per_page: Math.min(maxItems, 100),
  });
  templates.push(...page.items);

  while (templates.length < maxItems && page.links.next) {
    page = await client.listPensPageByUrl(page.links.next);
    templates.push(...page.items);
  }

  return templates.slice(0, maxItems);
}

/**
 * Resolves a CodePen Template reference passed via `--template <id|url|title>`.
 */
export async function resolveTemplatePen(
  client: CodePenClient,
  rawQuery: string,
  cachedTemplates?: Pen[],
): Promise<Pen> {
  const query = rawQuery.trim();
  if (!query) {
    throw new CliError(400, '--template requires a CodePen template ID, URL, or title.');
  }

  if (/^https?:\/\//i.test(query)) {
    const ref = normalizePenReference(query);
    return client.getPen(ref.apiIdentifier);
  }

  const templates = cachedTemplates ?? (await listAccountTemplates(client));

  const byId = templates.find((t) => t.id === query);
  if (byId) {
    return byId;
  }

  const lower = query.toLowerCase();
  const byTitle = templates.filter((t) => (t.title || '').trim().toLowerCase() === lower);
  if (byTitle.length === 1) {
    return byTitle[0]!;
  }
  if (byTitle.length > 1) {
    const choices = byTitle.map((t) => `  - ${t.title} (${t.id})`).join('\n');
    throw new CliError(
      409,
      `Multiple CodePen templates match "${query}":\n${choices}\nPass the template ID or URL to pick one.`,
      { matches: byTitle.map((t) => ({ id: t.id, title: t.title })) },
    );
  }

  // Fallback: if the value looks like a Pen ID (cpid or hashid), try fetching directly
  if (/^[A-Za-z0-9_-]{3,64}$/.test(query)) {
    try {
      return await client.getPen(query);
    } catch (error) {
      if (!isCodePenApiError(error) || error.status !== 404) {
        throw error;
      }
    }
  }

  if (templates.length === 0) {
    throw new CliError(
      404,
      `No CodePen template found matching "${query}" (and your account has no Pens marked as templates yet).\n` +
        'Mark any Pen as a template on CodePen or run `cdpn info --template true` in a synced Pen folder.',
    );
  }

  const available = templates
    .slice(0, 10)
    .map((t) => `  - ${t.title || 'Untitled'} (${t.id})`)
    .join('\n');
  throw new CliError(
    404,
    `No CodePen template found matching "${query}".\nAvailable templates on this account:\n${available}`,
    { available_templates: templates.slice(0, 10).map((t) => ({ id: t.id, title: t.title })) },
  );
}

/**
 * Downloads all text and binary files from a CodePen Template Pen so they can be
 * used to create a brand-new independent CodePen 2.0 Pen.
 */
export async function fetchPenFilesAsUploadPayload(
  client: CodePenClient,
  penId: string,
): Promise<{ textFiles: PenFileRequest[]; binaryFiles: BinaryUploadPart[] }> {
  const remoteFiles = await client.getPenFiles(penId);
  const textFiles: PenFileRequest[] = [];
  const binaryFiles: BinaryUploadPart[] = [];

  for (const file of remoteFiles) {
    const normalizedPath = normalizePenPath(file.path);
    if (file.is_binary) {
      if (file.bytes === 0) {
        textFiles.push({ path: normalizedPath, content: '' });
      } else if (file.download_url) {
        const buffer = await client.downloadFile(file.download_url);
        binaryFiles.push({ path: normalizedPath, content: buffer });
      } else {
        throw new Error(
          `Cannot copy binary file ${normalizedPath} from Pen ${penId}: no download_url returned by CodePen.`,
        );
      }
    } else {
      textFiles.push({
        path: normalizedPath,
        content: file.content ?? '',
      });
    }
  }

  return { textFiles, binaryFiles };
}
