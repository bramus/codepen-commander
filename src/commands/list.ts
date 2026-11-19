import type { Command } from 'commander';
import { CodePenClient } from '../api/client.js';
import type { Pen, PenEditor, PenSortField, SortDirection } from '../types.js';
import { fmt, formatDate, formatTable } from '../utils/format.js';
import { getGlobalProfileOption, resolveCommandAuth } from './auth-context.js';

export interface ListOptions {
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

const VALID_SORTS = new Set(['created', 'updated', 'popularity', 'title']);
const VALID_DIRECTIONS = new Set(['asc', 'desc']);

export function registerListCommand(program: Command): void {
  program
    .command('list')
    .alias('ls')
    .description('List and search your Pens on CodePen')
    .option('-s, --search <term>', 'Filter by title or description')
    .option('--access <levels>', 'Comma-separated access levels: Public,Private,Protected,Collaborators')
    .option('--deployed', 'Show only deployed Pens')
    .option('--not-deployed', 'Show only non-deployed Pens')
    .option('--templates', 'Show only Pens marked as templates')
    .option('--tags <tags>', 'Comma-separated tags (up to 3)')
    .option('--editor <type>', 'Filter by editor: V2 or Classic')
    .option('--sort <field>', 'Sort by: created, updated, popularity, or title', 'updated')
    .option('--direction <dir>', 'Sort direction: asc or desc', 'desc')
    .option('-n, --limit <count>', 'Maximum number of Pens to show', '20')
    .option('--json', 'Output Pens as JSON')
    .action(async (options: ListOptions, command: Command) => {
      if (options.deployed && options.notDeployed) {
        throw new Error('Cannot combine --deployed and --not-deployed.');
      }

      const limit = Number.parseInt(options.limit ?? '20', 10);
      if (Number.isNaN(limit) || limit < 1) {
        throw new Error('--limit must be a positive integer.');
      }

      const sort = (options.sort ?? 'updated').toLowerCase();
      if (!VALID_SORTS.has(sort)) {
        throw new Error(`Invalid --sort value "${options.sort}". Use: created, updated, popularity, or title.`);
      }

      const direction = (options.direction ?? 'desc').toLowerCase();
      if (!VALID_DIRECTIONS.has(direction)) {
        throw new Error(`Invalid --direction value "${options.direction}". Use: asc or desc.`);
      }

      let editor: PenEditor | undefined;
      if (options.editor) {
        const lower = options.editor.trim().toLowerCase();
        if (lower === 'v2') editor = 'V2';
        else if (lower === 'classic') editor = 'Classic';
        else throw new Error(`Invalid --editor value "${options.editor}". Use: V2 or Classic.`);
      }

      const deployed = options.deployed ? true : options.notDeployed ? false : undefined;
      const template = options.templates ? true : undefined;

      const auth = await resolveCommandAuth({
        explicitProfile: getGlobalProfileOption(command),
        interactive: !options.json,
        promptMessage: 'Which CodePen profile would you like to list Pens for?',
      });
      const client = new CodePenClient({ apiKey: auth.apiKey });

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

      if (options.json) {
        console.log(JSON.stringify(sliced, null, 2));
        return;
      }

      if (sliced.length === 0) {
        console.log(fmt.dim('No matching Pens found.'));
        return;
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

      console.log(formatTable(['Title', 'Editor', 'Access', 'Live', 'Updated', 'URL'], rows));
      if (pageResult.links.next || pens.length > limit) {
        console.log(fmt.dim(`\nShowing ${sliced.length} Pen(s). Pass --limit <n> to see more.`));
      }
    });
}
