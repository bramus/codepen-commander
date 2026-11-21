import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Pen } from '../../src/api/types.js';
import { runListCommand } from '../../src/commands/list.js';
import { saveProfileToFile } from '../../src/config/user-store.js';
import { CliError } from '../../src/errors.js';
import { stripAnsi } from '../../src/utils/format.js';
import {
  makeDeployment,
  makePen,
  startMockCodePenServer,
  type MockApiServer,
} from '../helpers/mock-codepen-api.js';
import { createBufferedOutput, parseJsonOutput } from '../helpers/output.js';
import { withTempDir } from '../helpers/temp-dir.js';

const API_KEY = 'cp_user_bramus_list_test_1234';

describe('cdpn list command', () => {
  let mock: MockApiServer;
  let lastQuery: Record<string, string> = {};
  let paginateMode = false;
  let emptyMode = false;

  before(async () => {
    mock = await startMockCodePenServer((ctx) => {
      if (ctx.headers.authorization !== `Bearer ${API_KEY}`) {
        return { status: 401, body: { code: 'UNAUTHENTICATED', message: 'Invalid key' } };
      }

      if (ctx.method === 'GET' && ctx.pathname === '/v2/pens') {
        lastQuery = Object.fromEntries(ctx.searchParams.entries());
        if (emptyMode) {
          return { status: 200, body: [] };
        }
        const page = ctx.searchParams.get('page') ?? '1';
        if (paginateMode) {
          if (page === '1') {
            return {
              status: 200,
              body: [
                makePen({ id: 'pen-1', title: 'First Pen', deployment: makeDeployment() }),
                makePen({ id: 'pen-2', title: 'Second Pen', template: true, access: 'Private' }),
              ],
              headers: {
                Link: `<${mock.baseUrl}/v2/pens?page=2&per_page=2>; rel="next"`,
              },
            };
          }
          return {
            status: 200,
            body: [
              makePen({ id: 'pen-3', title: 'Third Pen', editor: 'Classic' }),
              makePen({ id: 'pen-4', title: 'Fourth Pen' }),
            ],
          };
        }
        return {
          status: 200,
          body: [
            makePen({ id: 'pen-1', title: 'CSS Scroll Demo', deployment: makeDeployment() }),
          ],
        };
      }
    });
  });

  after(async () => {
    await mock.close();
  });

  it('forwards filters, follows pagination up to --limit, and formats both table and --json output', async () => {
    await withTempDir(async (tmpHome) => {
      await saveProfileToFile('bramus', API_KEY, { homeDir: tmpHome, setAsDefault: true });

      // 1. Filters forwarded as query params
      paginateMode = false;
      emptyMode = false;
      const filterOut = createBufferedOutput();
      const filterRes = await runListCommand({
        search: 'scroll',
        access: 'Public,Private',
        deployed: true,
        templates: true,
        tags: 'css,view-transitions',
        editor: 'v2',
        sort: 'popularity',
        direction: 'asc',
        limit: 10,
        baseUrl: mock.baseUrl,
        homeDir: tmpHome,
        env: {},
        interactive: false,
        output: filterOut,
      });
      assert.equal(filterRes.pens.length, 1);
      assert.equal(filterRes.hasMore, false);
      assert.equal(lastQuery.search_term, 'scroll');
      assert.equal(lastQuery.access, 'Public,Private');
      assert.equal(lastQuery.deployed, 'true');
      assert.equal(lastQuery.template, 'true');
      assert.equal(lastQuery.tags, 'css,view-transitions');
      assert.equal(lastQuery.editor, 'V2');
      assert.equal(lastQuery.sort, 'popularity');
      assert.equal(lastQuery.direction, 'asc');
      const tableText = stripAnsi(filterOut.stdout());
      assert.match(tableText, /CSS Scroll Demo/);
      assert.match(tableText, /live/);

      // 2. Pagination follows Link rel="next" and slices cleanly at --limit with hasMore: true
      paginateMode = true;
      const pageOut = createBufferedOutput();
      const pageRes = await runListCommand({
        limit: 3,
        notDeployed: true,
        baseUrl: mock.baseUrl,
        homeDir: tmpHome,
        env: {},
        interactive: false,
        output: pageOut,
      });
      assert.deepEqual(
        pageRes.pens.map((p) => p.id),
        ['pen-1', 'pen-2', 'pen-3'],
      );
      assert.equal(pageRes.hasMore, true);
      assert.match(stripAnsi(pageOut.stdout()), /Pass --limit <n> to see more/);

      // 3. --json envelope output
      const jsonOut = createBufferedOutput();
      await runListCommand({
        limit: 3,
        json: true,
        baseUrl: mock.baseUrl,
        homeDir: tmpHome,
        env: {},
        interactive: false,
        output: jsonOut,
      });
      const env = parseJsonOutput<Pen[]>(jsonOut);
      assert.equal(env.status.code, 200);
      assert.equal(env.contents.length, 3);

      // 4. Empty result
      emptyMode = true;
      const emptyOut = createBufferedOutput();
      const emptyRes = await runListCommand({
        baseUrl: mock.baseUrl,
        homeDir: tmpHome,
        env: {},
        interactive: false,
        output: emptyOut,
      });
      assert.deepEqual(emptyRes.pens, []);
      assert.match(stripAnsi(emptyOut.stdout()), /No matching Pens found/);
    }, 'cdpn-list-');
  });

  it('rejects invalid flag combinations and option values with CliError(400)', async () => {
    const cases = [
      { deployed: true, notDeployed: true },
      { limit: 0 },
      { limit: 'abc' },
      { sort: 'random' },
      { direction: 'sideways' },
      { editor: 'V3' },
    ];

    for (const opts of cases) {
      await assert.rejects(
        () => runListCommand({ ...opts, interactive: false, output: createBufferedOutput() }),
        (err: unknown) => err instanceof CliError && err.statusCode === 400,
      );
    }
  });
});
