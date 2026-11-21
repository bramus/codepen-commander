import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { Pen, Version } from '../../src/api/types.js';
import { runRollbackCommand } from '../../src/commands/rollback.js';
import { runVersionsCommand } from '../../src/commands/versions.js';
import { readProjectConfig, writeProjectConfig } from '../../src/config/project.js';
import { saveProfileToFile } from '../../src/config/user-store.js';
import { CliError } from '../../src/errors.js';
import { stripAnsi } from '../../src/utils/format.js';
import {
  makeBuild,
  makePen,
  makePenFile,
  makeVersion,
  startMockCodePenServer,
  type MockApiServer,
} from '../helpers/mock-codepen-api.js';
import { createBufferedOutput, parseJsonOutput } from '../helpers/output.js';
import { withTempDir } from '../helpers/temp-dir.js';

const API_KEY = 'cp_user_bramus_versions_test_1';
const PEN_ID = 'pen-versions-1';

describe('cdpn versions and cdpn rollback commands', () => {
  let mock: MockApiServer;
  let editorMode: 'V2' | 'Classic' = 'V2';
  let restoreCalls: Array<{ versionId: string; label: string | null }> = [];

  const versionsList: Version[] = [
    makeVersion({
      id: 'ver-3',
      pen_id: PEN_ID,
      label: 'Latest polish',
      deployed: false,
      build: makeBuild({ status: 'Success', version_id: 'ver-3' }),
    }),
    makeVersion({
      id: 'ver-2',
      pen_id: PEN_ID,
      label: 'Production release',
      deployed: true,
      build: makeBuild({ status: 'Success', version_id: 'ver-2' }),
    }),
    makeVersion({
      id: 'ver-1',
      pen_id: PEN_ID,
      label: null,
      deployed: false,
      build: makeBuild({ status: 'Failed', version_id: 'ver-1' }),
    }),
  ];

  before(async () => {
    mock = await startMockCodePenServer((ctx) => {
      if (ctx.headers.authorization !== `Bearer ${API_KEY}`) {
        return { status: 401, body: { code: 'UNAUTHENTICATED', message: 'Invalid key' } };
      }

      if (ctx.method === 'GET' && ctx.pathname === `/v2/pens/${PEN_ID}`) {
        return {
          status: 200,
          body: makePen({
            id: PEN_ID,
            title: 'Versions Demo',
            editor: editorMode,
            saved_version: editorMode === 'V2' ? versionsList[0]! : null,
          }),
        };
      }

      if (ctx.method === 'GET' && ctx.pathname === `/v2/pens/${PEN_ID}/versions`) {
        return {
          status: 200,
          body: editorMode === 'Classic' ? [] : versionsList,
        };
      }

      const restoreMatch = ctx.pathname.match(
        new RegExp(`^/v2/pens/${PEN_ID}/versions/([^/]+)/restore$`),
      );
      if (ctx.method === 'POST' && restoreMatch?.[1]) {
        const restoredId = decodeURIComponent(restoreMatch[1]);
        const label = ctx.searchParams.get('label');
        restoreCalls.push({ versionId: restoredId, label });
        return {
          status: 200,
          body: makePen({
            id: PEN_ID,
            title: 'Versions Demo',
            saved_version: makeVersion({ id: 'ver-4-restored', pen_id: PEN_ID, label }),
          }),
        };
      }

      if (ctx.method === 'GET' && ctx.pathname === `/v2/pens/${PEN_ID}/files`) {
        return {
          status: 200,
          body: [makePenFile('/index.html', '<h1>Restored v2</h1>\n')],
        };
      }
    });
  });

  after(async () => {
    await mock.close();
  });

  it('lists versions with head/local/deployed markers, handles Classic Pens, and validates --limit', async () => {
    await withTempDir(async (tmpRoot) => {
      const tmpHome = path.join(tmpRoot, 'home');
      const tmpProj = path.join(tmpRoot, 'proj');
      await fs.mkdir(tmpHome, { recursive: true });
      await saveProfileToFile('bramus', API_KEY, { homeDir: tmpHome, setAsDefault: true });
      await fs.mkdir(tmpProj, { recursive: true });
      await writeProjectConfig(tmpProj, {
        url: `https://codepen.io/bramus/pen/${PEN_ID}`,
        pen_id: PEN_ID,
        profile: 'bramus',
        last_synced_version_id: 'ver-2',
      });

      // 1. Human table includes head, local, deployed markers
      editorMode = 'V2';
      const tableOut = createBufferedOutput();
      const res = await runVersionsCommand({
        cwd: tmpProj,
        baseUrl: mock.baseUrl,
        homeDir: tmpHome,
        env: {},
        interactive: false,
        output: tableOut,
      });
      assert.ok(res);
      assert.equal(res.isClassic, false);
      assert.equal(res.versions.length, 3);
      const tableText = stripAnsi(tableOut.stdout());
      assert.match(tableText, /ver-3[\s\S]*head/);
      assert.match(tableText, /ver-2[\s\S]*local, deployed/);
      assert.match(tableText, /Failed/);

      // 2. --json returns array of versions respecting --limit
      const jsonOut = createBufferedOutput();
      await runVersionsCommand({
        cwd: tmpProj,
        limit: 2,
        json: true,
        baseUrl: mock.baseUrl,
        homeDir: tmpHome,
        env: {},
        interactive: false,
        output: jsonOut,
      });
      const env = parseJsonOutput<Version[]>(jsonOut);
      assert.equal(env.status.code, 200);
      assert.equal(env.contents.length, 2);

      // 3. Classic Pen reports empty versions cleanly
      editorMode = 'Classic';
      const classicOut = createBufferedOutput();
      const classicRes = await runVersionsCommand({
        cwd: tmpProj,
        baseUrl: mock.baseUrl,
        homeDir: tmpHome,
        env: {},
        interactive: false,
        output: classicOut,
      });
      assert.ok(classicRes);
      assert.equal(classicRes.isClassic, true);
      assert.deepEqual(classicRes.versions, []);
      assert.match(stripAnsi(classicOut.stdout()), /Classic Pens do not have saved versions/);

      // 4. Invalid --limit throws CliError(400)
      await assert.rejects(
        () =>
          runVersionsCommand({
            cwd: tmpProj,
            limit: '0',
            interactive: false,
            output: createBufferedOutput(),
          }),
        (err: unknown) => err instanceof CliError && err.statusCode === 400,
      );
      editorMode = 'V2';
    }, 'cdpn-versions-');
  });

  it('guards rollback non-interactively, supports interactive decline, and restores + syncs files on confirm/--yes', async () => {
    await withTempDir(async (tmpRoot) => {
      const tmpHome = path.join(tmpRoot, 'home');
      const tmpProj = path.join(tmpRoot, 'proj');
      await fs.mkdir(tmpHome, { recursive: true });
      await saveProfileToFile('bramus', API_KEY, { homeDir: tmpHome, setAsDefault: true });
      await fs.mkdir(tmpProj, { recursive: true });
      await fs.writeFile(path.join(tmpProj, 'index.html'), '<h1>Broken v3</h1>\n', 'utf8');
      await fs.writeFile(path.join(tmpProj, 'extra.css'), 'body {}\n', 'utf8');
      await writeProjectConfig(tmpProj, {
        url: `https://codepen.io/bramus/pen/${PEN_ID}`,
        pen_id: PEN_ID,
        profile: 'bramus',
        last_synced_version_id: 'ver-3',
      });

      editorMode = 'V2';
      restoreCalls = [];

      // 1. Missing version ID in non-interactive mode throws CliError(400)
      await assert.rejects(
        () =>
          runRollbackCommand({
            cwd: tmpProj,
            yes: true,
            baseUrl: mock.baseUrl,
            homeDir: tmpHome,
            env: {},
            interactive: false,
            output: createBufferedOutput(),
          }),
        (err: unknown) => err instanceof CliError && err.statusCode === 400,
      );

      // 2. Missing --yes in non-interactive mode throws CliError(400)
      await assert.rejects(
        () =>
          runRollbackCommand({
            cwd: tmpProj,
            versionIdArg: 'ver-2',
            baseUrl: mock.baseUrl,
            homeDir: tmpHome,
            env: {},
            interactive: false,
            output: createBufferedOutput(),
          }),
        (err: unknown) => err instanceof CliError && err.statusCode === 400,
      );

      // 3. Interactive picker + decline aborts without calling restore API
      const declined = await runRollbackCommand({
        cwd: tmpProj,
        baseUrl: mock.baseUrl,
        homeDir: tmpHome,
        env: {},
        interactive: true,
        output: createBufferedOutput(),
        prompts: {
          select: async () => 'ver-2' as never,
          confirm: async () => false,
        },
      });
      assert.equal(declined, null);
      assert.equal(restoreCalls.length, 0);

      // 4. Rollback with --yes, --label, and --json restores version, prunes extra.css, and updates .cdpn.json
      const out = createBufferedOutput();
      const restored = await runRollbackCommand({
        cwd: tmpProj,
        versionIdArg: 'ver-2',
        label: 'Rollback to production',
        yes: true,
        json: true,
        baseUrl: mock.baseUrl,
        homeDir: tmpHome,
        env: {},
        interactive: false,
        output: out,
      });
      assert.ok(restored);
      assert.equal(restored.restoredVersionId, 'ver-2');
      assert.equal(restored.newVersionId, 'ver-4-restored');
      assert.deepEqual(restored.writtenPaths, ['/index.html']);
      assert.deepEqual(restored.deletedPaths, ['/extra.css']);
      assert.deepEqual(restoreCalls, [{ versionId: 'ver-2', label: 'Rollback to production' }]);

      assert.equal(await fs.readFile(path.join(tmpProj, 'index.html'), 'utf8'), '<h1>Restored v2</h1>\n');
      await assert.rejects(() => fs.stat(path.join(tmpProj, 'extra.css')), /ENOENT/);

      const updatedCfg = await readProjectConfig(tmpProj);
      assert.equal(updatedCfg.last_synced_version_id, 'ver-4-restored');

      const env = parseJsonOutput<{
        pen: Pen;
        restored_version_id: string;
        new_version_id: string;
        written_paths: string[];
        deleted_paths: string[];
      }>(out);
      assert.equal(env.status.code, 200);
      assert.equal(env.contents.restored_version_id, 'ver-2');
      assert.equal(env.contents.new_version_id, 'ver-4-restored');
      assert.deepEqual(env.contents.deleted_paths, ['/extra.css']);
    }, 'cdpn-rollback-');
  });
});
