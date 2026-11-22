import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { Pen, PenFile, TrashItem } from '../../src/api/types.js';
import { runDeleteCommand } from '../../src/commands/delete.js';
import { runDomainsListCommand } from '../../src/commands/domains.js';
import { runInfoCommand } from '../../src/commands/info.js';
import { runOpenCommand } from '../../src/commands/open.js';
import { runPrivacyCommand } from '../../src/commands/privacy.js';
import { runPullCommand } from '../../src/commands/pull.js';
import { runStatusCommand } from '../../src/commands/status.js';
import { readProjectConfigFile, writeProjectConfig } from '../../src/config/project.js';
import { saveProfileToFile } from '../../src/config/user-store.js';
import { PROJECT_CONFIG_FILENAME } from '../../src/constants.js';
import { CliError } from '../../src/errors.js';

const API_KEY = 'cp_user_bramus_missingpen123';
const PEN_ID = 'pen-missing-1';

describe('missing / trashed remote Pen handling across commands', () => {
  let server: http.Server;
  let baseUrl = '';
  let penState: 'active' | 'trashed' | 'purged' = 'trashed';
  let penTitle = 'Deleted Demo';
  let requestLog: string[] = [];
  let paginateTrash = false;

  const makePen = (): Pen => ({
    id: PEN_ID,
    title: penTitle,
    description: 'Synced demo description',
    tags: ['css'],
    access: 'Public',
    password: null,
    template: false,
    popularity: 0,
    views_count: 0,
    loves_count: 0,
    editor: 'V2',
    created_at: '2026-11-01T12:00:00Z',
    updated_at: '2026-11-20T12:00:00Z',
    urls: {
      editor: `https://codepen.io/editor/bramus/pen/${PEN_ID}`,
      preview: `https://${PEN_ID}.codepen.dev/`,
    },
    screenshot_urls: null,
    saved_version: {
      id: 'ver-1',
      pen_id: PEN_ID,
      hash: 'h1',
      created_at: '2026-11-20T12:00:00Z',
      deployed: false,
      saved: true,
      label: null,
      build: null,
      preview_url: `https://pv-${PEN_ID}.codepen.dev/`,
    },
    deployment: null,
    settings: {
      auto_deploy: false,
      auto_run: true,
      auto_save: true,
      indent_with: 'spaces',
      tab_size: 2,
    },
  });

  const makeTrashItem = (): TrashItem => ({
    id: 'trash-entry-1',
    type: 'Pen',
    item_id: PEN_ID,
    title: penTitle,
    deleted_at: '2026-11-20T15:00:00Z',
    expires_at: '2026-11-23T15:00:00Z',
  });

  const makeFiles = (): PenFile[] => [
    {
      id: 'f-1',
      path: '/index.html',
      name: 'index.html',
      content_hash: 'h-html',
      is_binary: false,
      bytes: 18,
      content_type: 'text/html',
      content: '<h1>Recovered!</h1>',
      url: null,
      download_url: null,
    },
  ];

  before(async () => {
    server = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      requestLog.push(`${req.method} ${url.pathname}${url.search}`);

      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const rawBody = Buffer.concat(chunks).toString('utf8');

      const sendJson = (status: number, body: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
        res.end(JSON.stringify(body));
      };

      if (req.headers.authorization !== `Bearer ${API_KEY}`) {
        return sendJson(401, { code: 'UNAUTHENTICATED', message: 'invalid key' });
      }

      if (req.method === 'GET' && url.pathname === `/v2/pens/${PEN_ID}`) {
        if (penState !== 'active') {
          return sendJson(404, { code: 'NOT_FOUND', message: 'not found' });
        }
        return sendJson(200, makePen());
      }

      if (req.method === 'PATCH' && url.pathname === `/v2/pens/${PEN_ID}`) {
        if (penState !== 'active') {
          return sendJson(404, { code: 'NOT_FOUND', message: 'not found' });
        }
        const patch = JSON.parse(rawBody) as { title?: string };
        if (patch.title !== undefined) {
          penTitle = patch.title;
        }
        return sendJson(200, makePen());
      }

      if (req.method === 'GET' && url.pathname === `/v2/pens/${PEN_ID}/files`) {
        if (penState !== 'active') {
          return sendJson(404, { code: 'NOT_FOUND', message: 'not found' });
        }
        return sendJson(200, makeFiles());
      }

      if (req.method === 'GET' && url.pathname === `/v2/pens/${PEN_ID}/domains`) {
        if (penState !== 'active') {
          return sendJson(404, { code: 'NOT_FOUND', message: 'not found' });
        }
        return sendJson(200, []);
      }

      if (req.method === 'GET' && url.pathname === '/v2/trash') {
        const pageNum = Number(url.searchParams.get('page') ?? '1');
        if (paginateTrash && pageNum === 1) {
          return sendJson(
            200,
            [
              {
                id: 'trash-other',
                type: 'Pen',
                item_id: 'other-pen-99',
                title: 'Other Deleted Pen',
                deleted_at: '2026-11-20T14:00:00Z',
                expires_at: '2026-11-23T14:00:00Z',
              },
            ],
            { Link: `<${baseUrl}/v2/trash?page=2&per_page=100>; rel="next"` },
          );
        }
        return sendJson(200, penState === 'trashed' ? [makeTrashItem()] : []);
      }

      if (req.method === 'POST' && url.pathname === `/v2/pens/${PEN_ID}/restore`) {
        if (penState !== 'trashed') {
          return sendJson(404, { code: 'NOT_FOUND', message: 'not in trash' });
        }
        penState = 'active';
        return sendJson(200, makePen());
      }

      if (req.method === 'DELETE' && url.pathname === `/v2/trash/pens/${PEN_ID}`) {
        if (penState !== 'trashed') {
          return sendJson(404, { code: 'NOT_FOUND', message: 'not in trash' });
        }
        const item = makeTrashItem();
        penState = 'purged';
        return sendJson(200, item);
      }

      sendJson(404, { code: 'NOT_FOUND', message: 'not found' });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  });

  async function setupLinkedDemo(): Promise<{ tmpHome: string; tmpDemo: string; cleanup: () => Promise<void> }> {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-missing-home-'));
    const tmpDemo = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-missing-demo-'));
    await saveProfileToFile('bramus', API_KEY, { homeDir: tmpHome, setAsDefault: true });
    await fs.writeFile(path.join(tmpDemo, 'index.html'), '<h1>Local Demo</h1>', 'utf8');
    await writeProjectConfig(tmpDemo, {
      url: `https://codepen.io/editor/bramus/pen/${PEN_ID}`,
      pen_id: PEN_ID,
      profile: 'bramus',
      last_synced_version_id: 'ver-1',
      last_synced_info_hash: 'info-hash-1',
      editor: 'V2',
      info: {
        title: 'Deleted Demo',
        description: 'Synced demo description',
        tags: ['css'],
        access: 'Public',
        template: false,
      },
      files: {},
    });
    return {
      tmpHome,
      tmpDemo,
      cleanup: async () => {
        await fs.rm(tmpHome, { recursive: true, force: true });
        await fs.rm(tmpDemo, { recursive: true, force: true });
      },
    };
  }

  it('offers Trash recovery, permanent deletion, and local unlink on cdpn status when Pen is in Trash (including pagination)', async () => {
    const { tmpHome, tmpDemo, cleanup } = await setupLinkedDemo();

    try {
      // 1. Non-interactive / JSON mode reports rich 404 with in_trash: true (follows Trash pagination)
      penState = 'trashed';
      paginateTrash = true;
      requestLog = [];
      await assert.rejects(
        () =>
          runStatusCommand({
            cwd: tmpDemo,
            json: true,
            baseUrl,
            env: {},
            homeDir: tmpHome,
            interactive: false,
          }),
        (err: unknown) =>
          err instanceof CliError &&
          err.statusCode === 404 &&
          /Deleted Items \(Trash/i.test(err.message) &&
          (err.contents as { in_trash?: boolean } | undefined)?.in_trash === true,
      );
      assert.ok(requestLog.some((r) => r.includes('/v2/trash?page=2')));
      paginateTrash = false;

      // 2. Interactive choice: Recover from Trash -> restores Pen and completes `cdpn status`!
      penState = 'trashed';
      requestLog = [];
      let seenChoices: string[] = [];
      const recoveredStatus = await runStatusCommand({
        cwd: tmpDemo,
        baseUrl,
        env: {},
        homeDir: tmpHome,
        interactive: true,
        prompts: {
          select: async (_q, opts) => {
            seenChoices = opts.map((o) => o.value);
            return 'recover' as never;
          },
        },
      });
      assert.deepEqual(seenChoices, ['recover', 'purge', 'unlink', 'cancel']);
      assert.ok(recoveredStatus);
      assert.equal(recoveredStatus.pen?.id, PEN_ID);
      assert.equal(penState, 'active');
      assert.ok(requestLog.includes(`POST /v2/pens/${PEN_ID}/restore`));

      // 3. Interactive choice: Unlink local copy -> clears remote link in .cdpn.json, leaves Trash intact
      penState = 'trashed';
      requestLog = [];
      const unlinkedRes = await runStatusCommand({
        cwd: tmpDemo,
        baseUrl,
        env: {},
        homeDir: tmpHome,
        interactive: true,
        prompts: {
          select: async () => 'unlink' as never,
        },
      });
      assert.equal(unlinkedRes, null);
      assert.equal(penState, 'trashed');
      const unlinkedCfg = await readProjectConfigFile(tmpDemo);
      assert.equal(unlinkedCfg.linked, false);
      assert.equal(unlinkedCfg.config.info.title, 'Deleted Demo');
      assert.deepEqual(unlinkedCfg.config.info.tags, ['css']);
      assert.equal(await fs.readFile(path.join(tmpDemo, 'index.html'), 'utf8'), '<h1>Local Demo</h1>');

      // 4. Interactive choice: Delete permanently -> confirms (default No), purges Trash, unlinks .cdpn.json
      await writeProjectConfig(tmpDemo, {
        url: `https://codepen.io/editor/bramus/pen/${PEN_ID}`,
        pen_id: PEN_ID,
        profile: 'bramus',
        last_synced_version_id: 'ver-1',
        info: { title: 'Deleted Demo', access: 'Public' },
      });
      penState = 'trashed';
      requestLog = [];
      let confirmDefault: boolean | undefined;
      const purgedRes = await runStatusCommand({
        cwd: tmpDemo,
        baseUrl,
        env: {},
        homeDir: tmpHome,
        interactive: true,
        prompts: {
          select: async () => 'purge' as never,
          confirm: async (_q, def) => {
            confirmDefault = def;
            return true;
          },
        },
      });
      assert.equal(purgedRes, null);
      assert.equal(confirmDefault, false, 'Permanent purge confirmation must default to No');
      assert.equal(penState, 'purged');
      assert.ok(requestLog.includes(`DELETE /v2/trash/pens/${PEN_ID}`));
      const afterPurgeCfg = await readProjectConfigFile(tmpDemo);
      assert.equal(afterPurgeCfg.linked, false);
    } finally {
      await cleanup();
    }
  });

  it('handles permanently deleted Pens (not in Trash) on cdpn status with friendly message and unlink offer', async () => {
    const { tmpHome, tmpDemo, cleanup } = await setupLinkedDemo();

    try {
      penState = 'purged';

      // 1. Non-interactive throws friendly 404 (not raw API Error 404)
      await assert.rejects(
        () =>
          runStatusCommand({
            cwd: tmpDemo,
            baseUrl,
            env: {},
            homeDir: tmpHome,
            interactive: false,
          }),
        (err: unknown) =>
          err instanceof CliError &&
          err.statusCode === 404 &&
          /no longer exists on CodePen/i.test(err.message) &&
          (err.contents as { in_trash?: boolean } | undefined)?.in_trash === false,
      );

      // 2. Interactive decline keeps .cdpn.json linked
      const declined = await runStatusCommand({
        cwd: tmpDemo,
        baseUrl,
        env: {},
        homeDir: tmpHome,
        interactive: true,
        prompts: { confirm: async () => false },
      });
      assert.equal(declined, null);
      assert.equal((await readProjectConfigFile(tmpDemo)).linked, true);

      // 3. Interactive confirm unlinks .cdpn.json while preserving info & local files
      const unlinked = await runStatusCommand({
        cwd: tmpDemo,
        baseUrl,
        env: {},
        homeDir: tmpHome,
        interactive: true,
        prompts: { confirm: async () => true },
      });
      assert.equal(unlinked, null);
      const parsed = await readProjectConfigFile(tmpDemo);
      assert.equal(parsed.linked, false);
      assert.equal(parsed.config.info.title, 'Deleted Demo');
      assert.equal(parsed.config.info.description, 'Synced demo description');
    } finally {
      await cleanup();
    }
  });

  it('does not fail in cdpn delete when the Pen is already trashed or permanently deleted on CodePen', async () => {
    const { tmpHome, tmpDemo, cleanup } = await setupLinkedDemo();

    try {
      const relink = async () => {
        await fs.mkdir(path.join(tmpDemo, '.codepen'), { recursive: true });
        await fs.writeFile(
          path.join(tmpDemo, '.codepen', 'pen.config.json'),
          JSON.stringify({ blocks: ['classic-1', 'fingerprint-1', 'validate-1'] }, null, 2),
          'utf8',
        );
        await writeProjectConfig(tmpDemo, {
          url: `https://codepen.io/editor/bramus/pen/${PEN_ID}`,
          pen_id: PEN_ID,
          profile: 'bramus',
          last_synced_version_id: 'ver-1',
          info: { title: 'Deleted Demo', description: 'Keep me', tags: ['css'], access: 'Private' },
        });
      };

      // 1. Already in Trash + interactive purge with --full-cleanup -> purges Trash and removes .cdpn.json and .codepen/
      await relink();
      penState = 'trashed';
      const purged = await runDeleteCommand({
        cwd: tmpDemo,
        fullCleanup: true,
        baseUrl,
        env: {},
        homeDir: tmpHome,
        interactive: true,
        prompts: {
          select: async () => 'purge' as never,
          confirm: async () => true,
        },
      });
      assert.ok(purged);
      assert.equal(purged.alreadyDeletedRemotely, true);
      assert.equal(purged.purgedFromTrash, true);
      assert.equal(purged.configRemoved, true);
      assert.equal(purged.codepenDirRemoved, true);
      assert.equal(penState, 'purged');
      await assert.rejects(() => fs.stat(path.join(tmpDemo, PROJECT_CONFIG_FILENAME)), /ENOENT/);
      await assert.rejects(() => fs.stat(path.join(tmpDemo, '.codepen')), /ENOENT/);

      // 1b. Already in Trash + interactive purge (default, no cleanup flags) -> purges Trash and unlinks .cdpn.json (keeping .codepen/ & info)
      await relink();
      penState = 'trashed';
      const purgedKeepLocal = await runDeleteCommand({
        cwd: tmpDemo,
        baseUrl,
        env: {},
        homeDir: tmpHome,
        interactive: true,
        prompts: {
          select: async () => 'purge' as never,
          confirm: async () => true,
        },
      });
      assert.ok(purgedKeepLocal);
      assert.equal(purgedKeepLocal.purgedFromTrash, true);
      assert.equal(purgedKeepLocal.configRemoved, false);
      assert.equal(purgedKeepLocal.codepenDirRemoved, false);
      assert.equal(purgedKeepLocal.infoRetained, true);
      assert.equal(penState, 'purged');
      assert.equal((await readProjectConfigFile(tmpDemo)).linked, false);
      assert.ok((await fs.stat(path.join(tmpDemo, '.codepen', 'pen.config.json'))).isFile());

      // 2. Already in Trash + --yes --cleanup --json -> does NOT fail or purge Trash, removes .codepen/ & retains unlinked info
      await relink();
      penState = 'trashed';
      const cleaned = await runDeleteCommand({
        cwd: tmpDemo,
        yes: true,
        cleanup: true,
        json: true,
        baseUrl,
        env: {},
        homeDir: tmpHome,
        interactive: false,
      });
      assert.ok(cleaned);
      assert.equal(cleaned.alreadyDeletedRemotely, true);
      assert.equal(cleaned.purgedFromTrash, false);
      assert.equal(cleaned.configRemoved, false);
      assert.equal(cleaned.codepenDirRemoved, true);
      assert.equal(cleaned.infoRetained, true);
      assert.equal(penState, 'trashed', '--yes must not silently permanently purge Trash');
      await assert.rejects(() => fs.stat(path.join(tmpDemo, '.codepen')), /ENOENT/);
      const keptCfg = await readProjectConfigFile(tmpDemo);
      assert.equal(keptCfg.linked, false);
      assert.equal(keptCfg.config.info.title, 'Deleted Demo');
      assert.equal(keptCfg.config.info.access, 'Private');

      // 2b. Already in Trash + default --yes -> does NOT purge Trash and keeps .cdpn.json linked & .codepen/ intact
      await relink();
      penState = 'trashed';
      const keptLinkedTrashed = await runDeleteCommand({
        cwd: tmpDemo,
        yes: true,
        baseUrl,
        env: {},
        homeDir: tmpHome,
        interactive: false,
      });
      assert.ok(keptLinkedTrashed);
      assert.equal(keptLinkedTrashed.alreadyDeletedRemotely, true);
      assert.equal(keptLinkedTrashed.purgedFromTrash, false);
      assert.equal(keptLinkedTrashed.configRemoved, false);
      assert.equal(keptLinkedTrashed.configKeptLinked, true);
      assert.equal(penState, 'trashed');
      assert.equal((await readProjectConfigFile(tmpDemo)).linked, true);
      assert.ok((await fs.stat(path.join(tmpDemo, '.codepen', 'pen.config.json'))).isFile());

      // 3. Already in Trash + interactive recover -> restores Pen and keeps .cdpn.json linked
      await relink();
      penState = 'trashed';
      const recovered = await runDeleteCommand({
        cwd: tmpDemo,
        baseUrl,
        env: {},
        homeDir: tmpHome,
        interactive: true,
        prompts: {
          select: async () => 'recover' as never,
        },
      });
      assert.ok(recovered);
      assert.equal(recovered.recoveredFromTrash, true);
      assert.equal(recovered.codepenDirRemoved, false);
      assert.equal(recovered.pen?.id, PEN_ID);
      assert.equal(penState, 'active');
      assert.equal((await readProjectConfigFile(tmpDemo)).linked, true);
      assert.ok((await fs.stat(path.join(tmpDemo, '.codepen', 'pen.config.json'))).isFile());

      // 4. Permanently deleted (not in Trash) + --full-cleanup --yes -> removes .cdpn.json and .codepen/ cleanly instead of 404
      await relink();
      penState = 'purged';
      const cleanedPurged = await runDeleteCommand({
        cwd: tmpDemo,
        fullCleanup: true,
        yes: true,
        baseUrl,
        env: {},
        homeDir: tmpHome,
        interactive: false,
      });
      assert.ok(cleanedPurged);
      assert.equal(cleanedPurged.alreadyDeletedRemotely, true);
      assert.equal(cleanedPurged.configRemoved, true);
      assert.equal(cleanedPurged.codepenDirRemoved, true);
      await assert.rejects(() => fs.stat(path.join(tmpDemo, PROJECT_CONFIG_FILENAME)), /ENOENT/);
      await assert.rejects(() => fs.stat(path.join(tmpDemo, '.codepen')), /ENOENT/);

      // 4b. Permanently deleted (not in Trash) + default --yes -> unlinks .cdpn.json while keeping .codepen/ & info
      await relink();
      penState = 'purged';
      const unlinkedPurged = await runDeleteCommand({
        cwd: tmpDemo,
        yes: true,
        baseUrl,
        env: {},
        homeDir: tmpHome,
        interactive: false,
      });
      assert.ok(unlinkedPurged);
      assert.equal(unlinkedPurged.alreadyDeletedRemotely, true);
      assert.equal(unlinkedPurged.configRemoved, false);
      assert.equal(unlinkedPurged.infoRetained, true);
      assert.equal((await readProjectConfigFile(tmpDemo)).linked, false);
      assert.ok((await fs.stat(path.join(tmpDemo, '.codepen', 'pen.config.json'))).isFile());

      // 5. Permanently deleted without --yes non-interactively still refuses safely with 400
      await relink();
      penState = 'purged';
      await assert.rejects(
        () =>
          runDeleteCommand({
            cwd: tmpDemo,
            baseUrl,
            env: {},
            homeDir: tmpHome,
            interactive: false,
          }),
        (err: unknown) => err instanceof CliError && err.statusCode === 400,
      );
    } finally {
      await cleanup();
    }
  });

  it('handles missing/trashed Pens seamlessly in pull, info, privacy, open, and domains commands', async () => {
    const { tmpHome, tmpDemo, cleanup } = await setupLinkedDemo();

    try {
      const relink = async () => {
        await writeProjectConfig(tmpDemo, {
          url: `https://codepen.io/editor/bramus/pen/${PEN_ID}`,
          pen_id: PEN_ID,
          profile: 'bramus',
          last_synced_version_id: 'ver-1',
          info: { title: 'Deleted Demo', access: 'Public' },
        });
      };

      // 1. `cdpn pull` recovers from Trash and syncs remote files immediately
      penState = 'trashed';
      const pulled = await runPullCommand({
        cwd: tmpDemo,
        force: true,
        baseUrl,
        env: {},
        homeDir: tmpHome,
        interactive: true,
        prompts: { select: async () => 'recover' as never },
      });
      assert.ok(pulled);
      assert.equal(await fs.readFile(path.join(tmpDemo, 'index.html'), 'utf8'), '<h1>Recovered!</h1>');

      // 2. `cdpn info --title` recovers from Trash and completes PATCH update
      penState = 'trashed';
      const infoRes = await runInfoCommand({
        cwd: tmpDemo,
        title: 'Recovered & Renamed',
        baseUrl,
        env: {},
        homeDir: tmpHome,
        interactive: true,
        prompts: { select: async () => 'recover' as never },
      });
      assert.ok(infoRes);
      assert.equal(infoRes.pen.title, 'Recovered & Renamed');
      assert.equal(penTitle, 'Recovered & Renamed');

      // 3. `cdpn privacy`, `cdpn open`, and `cdpn domains` all unlink cleanly on permanently deleted Pen
      for (const run of [
        () =>
          runPrivacyCommand({
            cwd: tmpDemo,
            show: true,
            baseUrl,
            env: {},
            homeDir: tmpHome,
            interactive: true,
            prompts: { confirm: async () => true },
          }),
        () =>
          runOpenCommand({
            cwd: tmpDemo,
            baseUrl,
            env: {},
            homeDir: tmpHome,
            interactive: true,
            prompts: { confirm: async () => true },
            openBrowserImpl: async () => true,
          }),
        () =>
          runDomainsListCommand({
            cwd: tmpDemo,
            baseUrl,
            env: {},
            homeDir: tmpHome,
            interactive: true,
            prompts: { confirm: async () => true },
          }),
      ]) {
        await relink();
        penState = 'purged';
        const out = await run();
        assert.equal(out, null);
        assert.equal((await readProjectConfigFile(tmpDemo)).linked, false);
      }
    } finally {
      await cleanup();
    }
  });
});
