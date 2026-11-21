import type { Command } from 'commander';
import { CodePenClient } from '../api/client.js';
import type { Version } from '../api/types.js';
import { requireProject } from '../config/project.js';
import { CliError } from '../errors.js';
import { fmt, formatDate, formatTable } from '../utils/format.js';
import { printJsonResponse } from '../utils/json.js';
import { defaultOutput, type CommandOutput } from '../utils/output.js';
import { isInteractive, type SelectOption } from '../utils/prompts/index.js';
import { getGlobalProfileOption, resolveCommandAuth } from '../workflows/auth-context.js';
import { fetchLinkedPenOrHandleMissing, type MissingPenPrompts } from '../workflows/missing-pen.js';

export interface RunVersionsCommandOptions {
  limit?: string | number;
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

export interface VersionsCommandResult {
  versions: Version[];
  isClassic: boolean;
}

export async function runVersionsCommand(
  options: RunVersionsCommandOptions = {},
): Promise<VersionsCommandResult | null> {
  const output = options.output ?? defaultOutput;
  const limit =
    typeof options.limit === 'number'
      ? options.limit
      : Number.parseInt(options.limit ?? '15', 10);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new CliError(400, '--limit must be a positive integer.');
  }

  const interactive = !options.json && (options.interactive ?? isInteractive());
  const project = await requireProject(options.cwd ?? process.cwd());
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
    commandName: 'versions',
    interactive,
    json: options.json,
    output,
    prompts: options.prompts,
  });
  if (!penLookup.found) {
    return null;
  }

  const pen = penLookup.pen;
  const versionsPage = await client.listVersions(project.config.pen_id, {
    per_page: Math.min(limit, 100),
    sort: 'created',
    direction: 'desc',
  });

  if (pen.editor === 'Classic') {
    if (options.json) {
      printJsonResponse(
        200,
        'Classic Pens do not have saved versions in CodePen API v2.',
        [],
        output,
      );
    } else {
      output.log(fmt.yellow('Classic Pens do not have saved versions in CodePen API v2.'));
    }
    return { versions: [], isClassic: true };
  }

  const versions = versionsPage.items.slice(0, limit);
  if (options.json) {
    const message =
      versions.length === 0
        ? 'No saved versions found.'
        : `Found ${versions.length} saved version(s).`;
    printJsonResponse(200, message, versions, output);
    return { versions, isClassic: false };
  }

  if (versions.length === 0) {
    output.log(fmt.dim('No saved versions found.'));
    return { versions, isClassic: false };
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

  output.log(formatTable(['Version ID', 'Build', 'Label', 'Markers', 'Created'], rows));
  return { versions, isClassic: false };
}

export function registerVersionsCommand(program: Command): void {
  program
    .command('versions')
    .description('List saved versions of this Pen')
    .option('-n, --limit <count>', 'Maximum number of versions to show', '15')
    .option('--json', 'Output versions as JSON')
    .action(async (options: { limit?: string; json?: boolean }, command: Command) => {
      await runVersionsCommand({
        limit: options.limit,
        json: options.json,
        explicitProfile: getGlobalProfileOption(command),
      });
    });
}
