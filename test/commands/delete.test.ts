import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { Pen } from '../../src/api/types.js';
import { runDeleteCommand } from '../../src/commands/delete.js';
import { writeProjectConfig } from '../../src/config/project.js';
import { saveProfileToFile } from '../../src/config/user-store.js';
import { PROJECT_CONFIG_FILENAME } from '../../src/constants.js';
import { hashPenInfo } from '../../src/sync/info.js';
import { createBufferedOutput, parseJsonOutput } from '../helpers/output.js';

const KEY_BRAMUS = 'cp_user_bramus_deletetest1234';

describe('cdpn delete command', () => {
  let server: http.Server;
  let baseUrl = '';
  let requestLog: string[] = [];
  let deleteMode: 'ok' | 'forbidden' | 'server-error' = 'ok';
  let penDeploymentUrl: string | null = null;

  const PEN_ID = 'pen-delete-1';

  const makePen = (): Pen => ({
    id: PEN_ID,
    title: 'Delete Test Pen',
    description: '',
    tags: [],
    access: 'Public',
    password: null,
    template: false,
    popularity: 0,
    views_count: 0,
    loves_count: 0,
    editor: 'V2',
    created_at: '2026-09-01T12:00:00Z',
    updated_at: '2026-09-10T12:00:00Z',
    urls: {
      editor: `https://codepen.io/editor/bramus/pen/${PEN_ID}`,
      preview: `https://${PEN_ID}.codepen.dev/`,
    },
    screenshot_urls: null,
    saved_version: null,
    deployment: penDeploymentUrl
      ? {
          id: 'dep-1',
          version_id: 'ver-1',
          url: penDeploymentUrl,
          custom_domains: [],
          created_at: '2026-09-10T12:00:00Z',
          updated_at: '2026-09-10T12:00:00Z',
        }
      : null,
    settings: {
      auto_deploy: false,
      auto_run: true,
      auto_save: true,
      indent_with: 'spaces',
      tab_size: 2,
    },
  });

  before(async () => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      requestLog.push(`${req.method} ${url.pathname}`);

      const sendJson = (status: number, body: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };

      if (req.headers.authorization !== `Bearer ${KEY_BRAMUS}`) {
        return sendJson(401, { code: 'UNAUTHENTICATED', message: 'invalid key' });
      }

      if (req.method === 'GET' && url.pathname === `/v2/pens/${PEN_ID}`) {
        return sendJson(200, makePen());
      }

      if (req.method === 'DELETE' && url.pathname === `/v2/pens/${PEN_ID}`) {
        if (deleteMode === 'forbidden') {
          return sendJson(403, { code: 'FORBIDDEN', message: 'Classic Pens cannot be deleted via API' });
        }
        if (deleteMode === 'server-error') {
          return sendJson(500, { code: 'INTERNAL', message: 'Something went wrong' });
        }
        res.writeHead(204);
        res.end();
        return;
      }

      sendJson(404, { code: 'NOT_FOUND', message: 'Not found' });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  });

  it('refuses to run when .cdpn.json is missing from the current folder (even if present in a parent folder)', async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-del-home-'));
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-del-root-'));

    try {
      await saveProfileToFile('bramus', KEY_BRAMUS, { homeDir: tmpHome, setAsDefault: true });

      const subDir = path.join(tmpRoot, 'nested');
      await fs.mkdir(subDir, { recursive: true });

      // No .cdpn.json anywhere
      requestLog = [];
      await assert.rejects(
        () =>
          runDeleteCommand({
            cwd: tmpRoot,
            yes: true,
            baseUrl,
            interactive: false,
            env: {},
            homeDir: tmpHome,
          }),
        /No \.cdpn\.json found/,
      );
      assert.equal(requestLog.length, 0);

      // .cdpn.json in parent folder only -> must still refuse inside nested/
      await writeProjectConfig(tmpRoot, {
        url: `https://codepen.io/editor/bramus/pen/${PEN_ID}`,
        pen_id: PEN_ID,
        profile: 'bramus',
        last_synced_version_id: null,
      });

      requestLog = [];
      await assert.rejects(
        () =>
          runDeleteCommand({
            cwd: subDir,
            yes: true,
            baseUrl,
            interactive: false,
            env: {},
            homeDir: tmpHome,
          }),
        /only works directly inside a folder containing \.cdpn\.json/i,
      );
      assert.equal(requestLog.length, 0);
      // Parent .cdpn.json must remain untouched
      await fs.stat(path.join(tmpRoot, PROJECT_CONFIG_FILENAME));
    } finally {
      await fs.rm(tmpHome, { recursive: true, force: true });
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('requires confirmation, keeps .cdpn.json on cancel or API error, and removes .cdpn.json after successful deletion while preserving local files', async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-del-home-'));
    const tmpPen = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-del-pen-'));

    try {
      await saveProfileToFile('bramus', KEY_BRAMUS, { homeDir: tmpHome, setAsDefault: true });

      const writeLinkedPen = async () => {
        await fs.writeFile(path.join(tmpPen, 'index.html'), '<h1>Keep Me</h1>\n', 'utf8');
        await fs.mkdir(path.join(tmpPen, '.codepen'), { recursive: true });
        await fs.writeFile(
          path.join(tmpPen, '.codepen', 'pen.config.json'),
          JSON.stringify({ blocks: {} }),
          'utf8',
        );
        await writeProjectConfig(tmpPen, {
          url: `https://codepen.io/editor/bramus/pen/${PEN_ID}`,
          pen_id: PEN_ID,
          profile: 'bramus',
          last_synced_version_id: null,
        });
      };

      await writeLinkedPen();

      // 1. Non-interactive without --yes -> refuses without calling DELETE, keeps .cdpn.json & .codepen/
      requestLog = [];
      await assert.rejects(
        () =>
          runDeleteCommand({
            cwd: tmpPen,
            baseUrl,
            interactive: false,
            env: {},
            homeDir: tmpHome,
          }),
        /non-interactive mode without --yes/i,
      );
      assert.deepEqual(requestLog, [`GET /v2/pens/${PEN_ID}`]);
      await fs.stat(path.join(tmpPen, PROJECT_CONFIG_FILENAME));
      await fs.stat(path.join(tmpPen, '.codepen', 'pen.config.json'));

      // 2. Interactive decline -> aborts without calling DELETE, defaults confirm to false, keeps .cdpn.json & .codepen/
      requestLog = [];
      let confirmDefault: boolean | undefined;
      penDeploymentUrl = 'https://live-demo.codepen.app/';
      const aborted = await runDeleteCommand({
        cwd: tmpPen,
        baseUrl,
        interactive: true,
        env: {},
        homeDir: tmpHome,
        prompts: {
          confirm: async (_q, defaultYes) => {
            confirmDefault = defaultYes;
            return false;
          },
        },
      });
      assert.equal(aborted, null);
      assert.equal(confirmDefault, false, 'Destructive delete confirmation must default to No');
      assert.deepEqual(requestLog, [`GET /v2/pens/${PEN_ID}`]);
      await fs.stat(path.join(tmpPen, PROJECT_CONFIG_FILENAME));
      await fs.stat(path.join(tmpPen, '.codepen', 'pen.config.json'));

      // 3. Remote DELETE fails (403 FORBIDDEN) -> throws and MUST keep .cdpn.json & .codepen/ intact
      deleteMode = 'forbidden';
      requestLog = [];
      await assert.rejects(
        () =>
          runDeleteCommand({
            cwd: tmpPen,
            yes: true,
            baseUrl,
            interactive: false,
            env: {},
            homeDir: tmpHome,
          }),
        (err: unknown) =>
          err instanceof Error &&
          'code' in err &&
          (err as { code?: string }).code === 'FORBIDDEN' &&
          /Classic Pens cannot be deleted/i.test(err.message),
      );
      assert.deepEqual(requestLog, [`GET /v2/pens/${PEN_ID}`, `DELETE /v2/pens/${PEN_ID}`]);
      await fs.stat(path.join(tmpPen, PROJECT_CONFIG_FILENAME));
      await fs.stat(path.join(tmpPen, '.codepen', 'pen.config.json'));

      // 4. Interactive confirm with succeeding DELETE -> removes .cdpn.json & .codepen/, keeps local source files untouched
      deleteMode = 'ok';
      penDeploymentUrl = null;
      requestLog = [];
      const deletedInteractive = await runDeleteCommand({
        cwd: tmpPen,
        baseUrl,
        interactive: true,
        env: {},
        homeDir: tmpHome,
        prompts: {
          confirm: async () => true,
        },
      });
      assert.ok(deletedInteractive);
      assert.equal(deletedInteractive.configRemoved, true);
      assert.equal(deletedInteractive.codepenDirRemoved, true);
      assert.equal(deletedInteractive.pen?.id, PEN_ID);
      assert.deepEqual(requestLog, [`GET /v2/pens/${PEN_ID}`, `DELETE /v2/pens/${PEN_ID}`]);
      await assert.rejects(
        () => fs.stat(path.join(tmpPen, PROJECT_CONFIG_FILENAME)),
        /ENOENT/,
        '.cdpn.json must be removed after deletion succeeds',
      );
      await assert.rejects(
        () => fs.stat(path.join(tmpPen, '.codepen')),
        /ENOENT/,
        '.codepen/ must be removed after deletion succeeds',
      );
      assert.equal(await fs.readFile(path.join(tmpPen, 'index.html'), 'utf8'), '<h1>Keep Me</h1>\n');

      // 5. Non-interactive with --yes -> deletes online Pen and removes .cdpn.json & .codepen/ without prompting
      await writeLinkedPen();
      requestLog = [];
      const deletedNonInteractive = await runDeleteCommand({
        cwd: tmpPen,
        yes: true,
        baseUrl,
        interactive: false,
        env: {},
        homeDir: tmpHome,
      });
      assert.ok(deletedNonInteractive);
      assert.equal(deletedNonInteractive.configRemoved, true);
      assert.equal(deletedNonInteractive.codepenDirRemoved, true);
      assert.equal(deletedNonInteractive.infoRetained, false);
      assert.deepEqual(requestLog, [`GET /v2/pens/${PEN_ID}`, `DELETE /v2/pens/${PEN_ID}`]);
      await assert.rejects(() => fs.stat(path.join(tmpPen, PROJECT_CONFIG_FILENAME)), /ENOENT/);
      await assert.rejects(() => fs.stat(path.join(tmpPen, '.codepen')), /ENOENT/);
      assert.equal(await fs.readFile(path.join(tmpPen, 'index.html'), 'utf8'), '<h1>Keep Me</h1>\n');

      // 6. Symlinked .codepen/ outside Pen folder is never followed or deleted
      const outsideTarget = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-del-outside-'));
      try {
        await fs.writeFile(path.join(outsideTarget, 'precious.txt'), 'do not delete', 'utf8');
        await fs.symlink(outsideTarget, path.join(tmpPen, '.codepen'));
        await writeProjectConfig(tmpPen, {
          url: `https://codepen.io/editor/bramus/pen/${PEN_ID}`,
          pen_id: PEN_ID,
          profile: 'bramus',
          last_synced_version_id: null,
        });
        const symlinkDel = await runDeleteCommand({
          cwd: tmpPen,
          yes: true,
          baseUrl,
          interactive: false,
          env: {},
          homeDir: tmpHome,
        });
        assert.ok(symlinkDel);
        assert.equal(symlinkDel.codepenDirRemoved, false);
        assert.equal(await fs.readFile(path.join(outsideTarget, 'precious.txt'), 'utf8'), 'do not delete');
      } finally {
        await fs.rm(outsideTarget, { recursive: true, force: true });
      }
    } finally {
      await fs.rm(tmpHome, { recursive: true, force: true });
      await fs.rm(tmpPen, { recursive: true, force: true });
    }
  });

  it('retains .codepen/ and only the info section in .cdpn.json when --keep-config (or --keep-info) is passed', async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-del-keep-home-'));
    const tmpPen = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-del-keep-pen-'));

    try {
      await saveProfileToFile('bramus', KEY_BRAMUS, { homeDir: tmpHome, setAsDefault: true });
      await fs.writeFile(path.join(tmpPen, 'index.html'), '<h1>Keep Info</h1>\n', 'utf8');
      await fs.mkdir(path.join(tmpPen, '.codepen'), { recursive: true });
      await fs.writeFile(
        path.join(tmpPen, '.codepen', 'pen.config.json'),
        JSON.stringify({ blocks: ['classic-1', 'fingerprint-1', 'validate-1'] }, null, 2),
        'utf8',
      );

      // 1. Legacy .cdpn.json without `info` -> still retains Pen metadata fetched from CodePen & keeps `.codepen/`
      await writeProjectConfig(tmpPen, {
        url: `https://codepen.io/editor/bramus/pen/${PEN_ID}`,
        pen_id: PEN_ID,
        profile: 'bramus',
        last_synced_version_id: 'ver-1',
        editor: 'V2',
      });

      // Cancel at confirmation prompt -> .cdpn.json and .codepen/ stay fully linked & untouched
      let promptQuestion = '';
      requestLog = [];
      const cancelled = await runDeleteCommand({
        cwd: tmpPen,
        keepConfig: true,
        baseUrl,
        interactive: true,
        env: {},
        homeDir: tmpHome,
        prompts: {
          confirm: async (question) => {
            promptQuestion = question;
            return false;
          },
        },
      });
      assert.equal(cancelled, null);
      assert.match(promptQuestion, /keep only "info"/i);
      assert.match(promptQuestion, /\.codepen/i);
      assert.deepEqual(requestLog, [`GET /v2/pens/${PEN_ID}`]);
      const stillLinkedRaw = JSON.parse(
        await fs.readFile(path.join(tmpPen, PROJECT_CONFIG_FILENAME), 'utf8'),
      ) as Record<string, unknown>;
      assert.equal(stillLinkedRaw.pen_id, PEN_ID);
      assert.ok((await fs.stat(path.join(tmpPen, '.codepen', 'pen.config.json'))).isFile());

      // Remote DELETE fails -> .cdpn.json and .codepen/ stay linked & untouched
      deleteMode = 'server-error';
      await assert.rejects(
        () =>
          runDeleteCommand({
            cwd: tmpPen,
            keepConfig: true,
            yes: true,
            baseUrl,
            interactive: false,
            env: {},
            homeDir: tmpHome,
          }),
        /Something went wrong/,
      );
      const afterErrRaw = JSON.parse(
        await fs.readFile(path.join(tmpPen, PROJECT_CONFIG_FILENAME), 'utf8'),
      ) as Record<string, unknown>;
      assert.equal(afterErrRaw.pen_id, PEN_ID);
      assert.ok((await fs.stat(path.join(tmpPen, '.codepen', 'pen.config.json'))).isFile());

      // Succeeding delete with --keep-config -> keeps .codepen/ and rewrites .cdpn.json with ONLY `info`
      deleteMode = 'ok';
      requestLog = [];
      const keptLegacy = await runDeleteCommand({
        cwd: tmpPen,
        keepConfig: true,
        yes: true,
        baseUrl,
        interactive: false,
        env: {},
        homeDir: tmpHome,
      });
      assert.ok(keptLegacy);
      assert.equal(keptLegacy.configRemoved, false);
      assert.equal(keptLegacy.codepenDirRemoved, false);
      assert.equal(keptLegacy.infoRetained, true);
      assert.deepEqual(keptLegacy.retainedInfo, {
        title: 'Delete Test Pen',
        description: '',
        tags: [],
        access: 'Public',
        template: false,
      });
      assert.deepEqual(requestLog, [`GET /v2/pens/${PEN_ID}`, `DELETE /v2/pens/${PEN_ID}`]);

      const rawLegacyAfter = JSON.parse(
        await fs.readFile(path.join(tmpPen, PROJECT_CONFIG_FILENAME), 'utf8'),
      ) as Record<string, unknown>;
      assert.deepEqual(Object.keys(rawLegacyAfter), ['info']);
      assert.deepEqual(rawLegacyAfter.info, keptLegacy.retainedInfo);
      assert.equal('profile' in rawLegacyAfter, false, 'profile must not be retained');
      assert.equal('pen_id' in rawLegacyAfter, false, 'pen_id must not be retained');
      assert.equal('url' in rawLegacyAfter, false, 'url must not be retained');
      assert.equal(await fs.readFile(path.join(tmpPen, 'index.html'), 'utf8'), '<h1>Keep Info</h1>\n');
      assert.ok(
        (await fs.stat(path.join(tmpPen, '.codepen', 'pen.config.json'))).isFile(),
        '--keep-config must keep .codepen/ intact',
      );

      // Running delete again on the now-unlinked info-only .cdpn.json fails cleanly without calling API
      requestLog = [];
      await assert.rejects(
        () =>
          runDeleteCommand({
            cwd: tmpPen,
            keepConfig: true,
            yes: true,
            baseUrl,
            interactive: false,
            env: {},
            homeDir: tmpHome,
          }),
        /not linked to an online Pen/i,
      );
      assert.equal(requestLog.length, 0);

      // 2. Backwards-compatible `--keep-info` alias also preserves local edits in `.cdpn.json` `info` AND `.codepen/` + JSON output
      await writeProjectConfig(tmpPen, {
        url: `https://codepen.io/editor/bramus/pen/${PEN_ID}`,
        pen_id: PEN_ID,
        profile: 'bramus',
        last_synced_version_id: 'ver-1',
        last_synced_info_hash: 'stale-different-hash',
        editor: 'V2',
        info: {
          title: 'Locally Edited Title',
          description: 'Local description to preserve',
          tags: ['css', 'demo'],
          access: 'Private',
          template: true,
        },
      });

      const output = createBufferedOutput();
      const keptLocal = await runDeleteCommand({
        cwd: tmpPen,
        keepInfo: true,
        yes: true,
        json: true,
        baseUrl,
        interactive: false,
        env: {},
        homeDir: tmpHome,
        output,
      });

      assert.ok(keptLocal);
      assert.equal(keptLocal.configRemoved, false);
      assert.equal(keptLocal.codepenDirRemoved, false);
      assert.equal(keptLocal.infoRetained, true);
      assert.deepEqual(keptLocal.retainedInfo, {
        title: 'Locally Edited Title',
        description: 'Local description to preserve',
        tags: ['css', 'demo'],
        access: 'Private',
        template: true,
      });

      const jsonEnvelope = parseJsonOutput<{
        deleted: boolean;
        config_removed: boolean;
        codepen_dir_removed: boolean;
        info_retained: boolean;
        info: Record<string, unknown>;
      }>(output);
      assert.equal(jsonEnvelope.status.code, 200);
      assert.match(jsonEnvelope.status.message, /retained info/i);
      assert.equal(jsonEnvelope.contents.deleted, true);
      assert.equal(jsonEnvelope.contents.config_removed, false);
      assert.equal(jsonEnvelope.contents.codepen_dir_removed, false);
      assert.equal(jsonEnvelope.contents.info_retained, true);
      assert.deepEqual(jsonEnvelope.contents.info, keptLocal.retainedInfo);

      const rawLocalAfter = JSON.parse(
        await fs.readFile(path.join(tmpPen, PROJECT_CONFIG_FILENAME), 'utf8'),
      ) as Record<string, unknown>;
      assert.deepEqual(rawLocalAfter, { info: keptLocal.retainedInfo });
      assert.ok(
        (await fs.stat(path.join(tmpPen, '.codepen', 'pen.config.json'))).isFile(),
        '--keep-info alias must also keep .codepen/ intact',
      );

      // 3. When local `.cdpn.json` info was NOT edited (matches baseline hash) and remote Pen metadata
      //    changed on CodePen, `--keep-config` retains the fresher remote metadata and keeps `.codepen/`
      const oldSyncedInfo = {
        title: 'Old Synced Title',
        description: 'Old description',
        tags: ['old'],
        access: 'Private' as const,
        template: false,
      };
      await writeProjectConfig(tmpPen, {
        url: `https://codepen.io/editor/bramus/pen/${PEN_ID}`,
        pen_id: PEN_ID,
        profile: 'bramus',
        last_synced_version_id: 'ver-1',
        last_synced_info_hash: hashPenInfo(oldSyncedInfo),
        editor: 'V2',
        info: oldSyncedInfo,
      });

      const keptRemote = await runDeleteCommand({
        cwd: tmpPen,
        keepConfig: true,
        yes: true,
        baseUrl,
        interactive: false,
        env: {},
        homeDir: tmpHome,
      });
      assert.ok(keptRemote);
      assert.equal(keptRemote.codepenDirRemoved, false);
      assert.deepEqual(keptRemote.retainedInfo, {
        title: 'Delete Test Pen',
        description: '',
        tags: [],
        access: 'Public',
        template: false,
      });
      assert.ok((await fs.stat(path.join(tmpPen, '.codepen', 'pen.config.json'))).isFile());
    } finally {
      await fs.rm(tmpHome, { recursive: true, force: true });
      await fs.rm(tmpPen, { recursive: true, force: true });
    }
  });
});
