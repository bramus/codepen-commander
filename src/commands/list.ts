import type { Command } from 'commander';
import { CodePenClient } from '../api/client.js';
import type { Pen, PenEditor, PenSortField, SortDirection } from '../api/types.js';
import { CliError } from '../errors.js';
import { fmt, formatDate, formatTable } from '../utils/format.js';
import { printJsonResponse } from '../utils/json.js';
import { defaultOutput, type CommandOutput } from '../utils/output.js';
import type { SelectOption } from '../utils/prompts/index.js';
import { getGlobalProfileOption, resolveCommandAuth } from '../workflows/auth-context.js';

export interface ListCliOptions {
  search?: string;
  access?: string;
  deployed?: boolean;
  notDeployed?: boolean;
  templates?: boolean;
  tags?: string;
  editor?: string;
  sort?: string;
  direction?: string;
  limit?: string;
  json?: boolean;
}

export interface RunListCommandOptions extends Omit<ListCliOptions, 'limit'> {
  limit?: string | number;
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
}

export interface ListCommandResult {
  pens: Pen[];
  hasMore: boolean;
}

const VALID_SORTS = new Set(['created', 'updated', 'popularity', 'title']);
const VALID_DIRECTIONS = new Set(['asc', 'desc']);

export async function runListCommand(
  options: RunListCommandOptions = {},
): Promise<ListCommandResult> {
  const output = options.output ?? defaultOutput;

  if (options.deployed && options.notDeployed) {
    throw new CliError(400, 'Cannot combine --deployed and --not-deployed.');
  }

  const limit =
    typeof options.limit === 'number'
      ? options.limit
      : Number.parseInt(options.limit ?? '20', 10);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new CliError(400, '--limit must be a positive integer.');
  }

  const sort = (options.sort ?? 'updated').toLowerCase();
  if (!VALID_SORTS.has(sort)) {
    throw new CliError(
      400,
      `Invalid --sort value "${options.sort}". Use: created, updated, popularity, or title.`,
    );
  }

  const direction = (options.direction ?? 'desc').toLowerCase();
  if (!VALID_DIRECTIONS.has(direction)) {
    throw new CliError(
      400,
      `Invalid --direction value "${options.direction}". Use: asc or desc.`,
    );
  }

  let editor: PenEditor | undefined;
  if (options.editor) {
    const lower = options.editor.trim().toLowerCase();
    if (lower === 'v2') editor = 'V2';
    else if (lower === 'classic') editor = 'Classic';
    else throw new CliError(400, `Invalid --editor value "${options.editor}". Use: V2 or Classic.`);
  }

  const deployed = options.deployed ? true : options.notDeployed ? false : undefined;
  const template = options.templates ? true : undefined;

  const auth = await resolveCommandAuth({
    explicitProfile: options.explicitProfile,
    interactive: options.json ? false : options.interactive,
    promptMessage: 'Which CodePen profile would you like to list Pens for?',
    output,
    env: options.env,
    homeDir: options.homeDir,
    selectProfile: options.selectProfile,
  });
  const client = new CodePenClient({ apiKey: auth.apiKey, baseUrl: options.baseUrl });

  const pens: Pen[] = [];
  let pageResult = await client.listPens({
    per_page: Math.min(limit, 100),
    sort: sort as PenSortField,
    direction: direction as SortDirection,
    search_term: options.search,
    access: options.access,
    deployed,
    template,
    tags: options.tags,
    editor,
  });

  pens.push(...pageResult.items);
  while (pens.length < limit && pageResult.links.next) {
    pageResult = await client.listPensPageByUrl(pageResult.links.next);
    pens.push(...pageResult.items);
  }

  const sliced = pens.slice(0, limit);
  const hasMore = Boolean(pageResult.links.next) || pens.length > limit;

  if (options.json) {
    const message =
      sliced.length === 0 ? 'No matching Pens found.' : `Found ${sliced.length} Pen(s).`;
    printJsonResponse(200, message, sliced, output);
    return { pens: sliced, hasMore };
  }

  if (sliced.length === 0) {
    output.log(fmt.dim('No matching Pens found.'));
    return { pens: sliced, hasMore };
  }

  const rows = sliced.map((pen) => {
    const editorBadge = pen.editor === 'V2' ? fmt.green('V2') : fmt.dim('Classic');
    const deployBadge = pen.deployment ? fmt.cyan('live') : fmt.dim('—');
    const accessLabel = pen.template ? `${pen.access} ${fmt.dim('(template)')}` : pen.access;
    const title = (pen.title || 'Untitled').slice(0, 36);
    return [
      fmt.bold(title),
      editorBadge,
      accessLabel,
      deployBadge,
      fmt.dim(formatDate(pen.updated_at)),
      fmt.cyan(pen.urls.editor),
    ];
  });

  output.log(formatTable(['Title', 'Editor', 'Access', 'Live', 'Updated', 'URL'], rows));
  if (hasMore) {
    output.log(fmt.dim(`\nShowing ${sliced.length} Pen(s). Pass --limit <n> to see more.`));
  }

  return { pens: sliced, hasMore };
}

export function registerListCommand(program: Command): void {
  program
    .command('list')
    .alias('ls')
    .description('List and search your Pens on CodePen')
    .option('-s, --search <term>', 'Filter by title or description')
    .option(
      '--access <levels>',
      'Comma-separated access levels: Public,Private,Protected,Collaborators',
    )
    .option('--deployed', 'Show only deployed Pens')
    .option('--not-deployed', 'Show only non-deployed Pens')
    .option('--templates', 'Show only Pens marked as templates')
    .option('--tags <tags>', 'Comma-separated tags (up to 3)')
    .option('--editor <type>', 'Filter by editor: V2 or Classic')
    .option('--sort <field>', 'Sort by: created, updated, popularity, or title', 'updated')
    .option('--direction <dir>', 'Sort direction: asc or desc', 'desc')
    .option('-n, --limit <count>', 'Maximum number of Pens to show', '20')
    .option('--json', 'Output Pens as JSON')
    .action(async (options: ListCliOptions, command: Command) => {
      await runListCommand({
        ...options,
        explicitProfile: getGlobalProfileOption(command),
      });
    });
}
