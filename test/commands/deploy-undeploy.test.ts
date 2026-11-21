import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { runDeployCommand } from '../../src/commands/deploy.js';
import { runUndeployCommand } from '../../src/commands/undeploy.js';
import { buildSyncedFileMap, writeProjectConfig } from '../../src/config/project.js';
import { saveProfileToFile } from '../../src/config/user-store.js';
import { CliError } from '../../src/errors.js';
import { sha256Hex } from '../../src/sync/fs.js';
import { buildPenInfoConfigFields } from '../../src/sync/info.js';
import {
  makeBuild,
  makeDeployment,
  makePen,
  makePenFile,
  makeVersion,
  startMockCodePenServer,
  type MockApiServer,
} from '../helpers/mock-codepen-api.js';
import { createBufferedOutput, parseJsonOutput } from '../helpers/output.js';
import { withTempDir } from '../helpers/temp-dir.js';

const API_KEY = 'cp_user_bramus_deploy_test_123';
const PEN_ID = 'pen-deploy-1';

describe('cdpn deploy and cdpn undeploy commands', () => {
  let mock: MockApiServer;
  let currentDeployment: ReturnType<typeof makeDeployment> | null = null;
  let failNextBuild = false;
  let deployBodies: Array<Record<string, unknown>> = [];
  let putFileCount = 0;
  let createBodies: Array<Record<string, unknown>> = [];
  let deleteDeploymentCount = 0;

  const initialHtml = '<h1>Initial Deploy</h1>\n';

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
            title: 'Deploy Demo',
            saved_version: makeVersion({ id: 'ver-1', pen_id: PEN_ID }),
            deployment: currentDeployment,
          }),
        };
      }

      if (ctx.method === 'GET' && ctx.pathname === `/v2/pens/${PEN_ID}/files`) {
        return {
          status: 200,
          body: [
            makePenFile('/index.html', initialHtml, {
              id: 'file-html',
              content_hash: sha256Hex(initialHtml),
            }),
          ],
        };
      }

      if (ctx.method === 'PUT' && ctx.pathname === `/v2/pens/${PEN_ID}/files`) {
        putFileCount++;
        const buildStatus = failNextBuild ? 'Failed' : 'Success';
        const verId = 'ver-2';
        return {
          status: 200,
          body: {
            pen: null,
            version: makeVersion({ id: verId, pen_id: PEN_ID }),
            build: makeBuild({
              id: 'bld-2',
              status: buildStatus,
              version_id: verId,
              errors: failNextBuild
                ? [
                    {
                      type: 'Error',
                      scope: 'File',
                      message: 'Broken CSS syntax',
                      code: 'CSS_SYNTAX',
                      url: null,
                      block_name: null,
                      path: '/style.css',
                      file_id: null,
                      range: null,
                    },
                  ]
                : [],
            }),
          },
        };
      }

      if (ctx.method === 'POST' && ctx.pathname === '/v2/pens') {
        const body = ctx.jsonBody();
        createBodies.push(body);
        const createdId = 'pen-created-deploy';
        const createdVer = 'ver-created-1';
        return {
          status: 201,
          body: makePen({
            id: createdId,
            title: (body.title as string) || 'Created Deploy',
            access: (body.access as 'Public' | 'Private') || 'Public',
            saved_version: makeVersion({ id: createdVer, pen_id: createdId }),
            build: makeBuild({ id: 'bld-created-1', status: 'Success', version_id: createdVer }),
          }),
        };
      }

      if (ctx.method === 'GET' && ctx.pathname === '/v2/versions/ver-2') {
        return {
          status: 200,
          body: makeVersion({
            id: 'ver-2',
            pen_id: PEN_ID,
            files: [makePenFile('/index.html', '<h1>Updated Deploy</h1>\n')],
          }),
        };
      }

      if (ctx.method === 'GET' && ctx.pathname === '/v2/versions/ver-created-1') {
        return {
          status: 200,
          body: makeVersion({
            id: 'ver-created-1',
            pen_id: 'pen-created-deploy',
            files: [makePenFile('/index.html', '<h1>Fresh</h1>\n')],
          }),
        };
      }

      const deployMatch = ctx.pathname.match(/^\/v2\/pens\/([^/]+)\/deployment$/);
      if (ctx.method === 'PUT' && deployMatch?.[1]) {
        const penId = decodeURIComponent(deployMatch[1]);
        const body = ctx.jsonBody();
        deployBodies.push(body);
        const deployedVersion = (body.version_id as string | undefined) ?? 'ver-1';
        currentDeployment = makeDeployment({
          url: `https://${penId}.codepen.app/`,
          version_id: deployedVersion,
          custom_domains: ['demo.example.com'],
        });
        return { status: 200, body: currentDeployment };
      }

      if (ctx.method === 'DELETE' && deployMatch?.[1]) {
        deleteDeploymentCount++;
        currentDeployment = null;
        return { status: 204 };
      }
    });
  });

  after(async () => {
    await mock.close();
  });

  async function setupLinkedDir(dir: string, homeDir: string): Promise<void> {
    await fs.mkdir(homeDir, { recursive: true });
    await saveProfileToFile('bramus', API_KEY, { homeDir, setAsDefault: true });
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'index.html'), initialHtml, 'utf8');
    const pen = makePen({ id: PEN_ID, title: 'Deploy Demo' });
    const remoteFile = makePenFile('/index.html', initialHtml, {
      id: 'file-html',
      content_hash: sha256Hex(initialHtml),
    });
    await writeProjectConfig(dir, {
      url: pen.urls.editor,
      pen_id: PEN_ID,
      profile: 'bramus',
      last_synced_version_id: 'ver-1',
      editor: 'V2',
      ...buildPenInfoConfigFields(pen),
      files: buildSyncedFileMap([remoteFile], new Map([['/index.html', sha256Hex(initialHtml)]])),
    });
  }

  it('deploys linked changes, supports --no-push and --version, and aborts with 422 on build failure', async () => {
    await withTempDir(async (tmpRoot) => {
      const tmpHome = path.join(tmpRoot, 'home');
      const tmpProj = path.join(tmpRoot, 'linked');
      await setupLinkedDir(tmpProj, tmpHome);

      // 1. Push + deploy when local file changed
      putFileCount = 0;
      deployBodies = [];
      failNextBuild = false;
      await fs.writeFile(path.join(tmpProj, 'index.html'), '<h1>Updated Deploy</h1>\n', 'utf8');

      const out1 = createBufferedOutput();
      const res1 = await runDeployCommand({
        cwd: tmpProj,
        baseUrl: mock.baseUrl,
        homeDir: tmpHome,
        env: {},
        interactive: false,
        json: true,
        output: out1,
      });
      assert.ok(res1);
      assert.equal(res1.pushed, true);
      assert.equal(res1.created, false);
      assert.equal(putFileCount, 1);
      assert.deepEqual(deployBodies, [{ version_id: 'ver-2' }]);
      const env1 = parseJsonOutput<{ pushed: boolean; version_id: string }>(out1);
      assert.equal(env1.status.code, 200);
      assert.equal(env1.contents.pushed, true);
      assert.equal(env1.contents.version_id, 'ver-2');

      // 2. --no-push skips PUT /files and deploys remote saved head
      putFileCount = 0;
      deployBodies = [];
      const resNoPush = await runDeployCommand({
        cwd: tmpProj,
        push: false,
        baseUrl: mock.baseUrl,
        homeDir: tmpHome,
        env: {},
        interactive: false,
        output: createBufferedOutput(),
      });
      assert.ok(resNoPush);
      assert.equal(resNoPush.pushed, false);
      assert.equal(putFileCount, 0);
      assert.deepEqual(deployBodies, [{}]);

      // 3. --version deploys specific version without pushing
      putFileCount = 0;
      deployBodies = [];
      const resVer = await runDeployCommand({
        cwd: tmpProj,
        version: 'ver-pinned-99',
        baseUrl: mock.baseUrl,
        homeDir: tmpHome,
        env: {},
        interactive: false,
        output: createBufferedOutput(),
      });
      assert.ok(resVer);
      assert.equal(putFileCount, 0);
      assert.deepEqual(deployBodies, [{ version_id: 'ver-pinned-99' }]);

      // 4. Build failure aborts deploy with CliError(422) and does not call PUT /deployment
      await setupLinkedDir(tmpProj, tmpHome);
      await fs.writeFile(path.join(tmpProj, 'index.html'), '<h1>Broken</h1>\n', 'utf8');
      failNextBuild = true;
      deployBodies = [];
      await assert.rejects(
        () =>
          runDeployCommand({
            cwd: tmpProj,
            baseUrl: mock.baseUrl,
            homeDir: tmpHome,
            env: {},
            interactive: false,
            output: createBufferedOutput(),
          }),
        (err: unknown) => err instanceof CliError && err.statusCode === 422,
      );
      assert.equal(deployBodies.length, 0);
      failNextBuild = false;
    }, 'cdpn-deploy-linked-');
  });

  it('creates and deploys an unlinked folder using --visibility alias', async () => {
    await withTempDir(async (tmpRoot) => {
      const tmpHome = path.join(tmpRoot, 'home');
      const unlinkedDir = path.join(tmpRoot, 'fresh-demo');
      await fs.mkdir(tmpHome, { recursive: true });
      await saveProfileToFile('bramus', API_KEY, { homeDir: tmpHome, setAsDefault: true });
      await fs.mkdir(unlinkedDir, { recursive: true });
      await fs.writeFile(path.join(unlinkedDir, 'index.html'), '<h1>Fresh</h1>\n', 'utf8');

      createBodies = [];
      deployBodies = [];
      const out = createBufferedOutput();
      const res = await runDeployCommand({
        cwd: unlinkedDir,
        title: 'Fresh Deploy',
        visibility: 'Private',
        baseUrl: mock.baseUrl,
        homeDir: tmpHome,
        env: {},
        interactive: false,
        json: true,
        output: out,
      });
      assert.ok(res);
      assert.equal(res.created, true);
      assert.equal(res.pushed, true);
      assert.equal(createBodies[0]?.access, 'Private');
      assert.deepEqual(deployBodies, [{ version_id: 'ver-created-1' }]);
      assert.equal(parseJsonOutput<{ created: boolean }>(out).contents.created, true);
    }, 'cdpn-deploy-unlinked-');
  });

  it('undeploys with confirmation, --yes, and handles already-undeployed Pens cleanly', async () => {
    await withTempDir(async (tmpRoot) => {
      const tmpHome = path.join(tmpRoot, 'home');
      const tmpProj = path.join(tmpRoot, 'undeploy');
      await setupLinkedDir(tmpProj, tmpHome);

      // 1. Not currently deployed -> no-op
      currentDeployment = null;
      deleteDeploymentCount = 0;
      const noopOut = createBufferedOutput();
      const noopRes = await runUndeployCommand({
        cwd: tmpProj,
        baseUrl: mock.baseUrl,
        homeDir: tmpHome,
        env: {},
        interactive: false,
        json: true,
        output: noopOut,
      });
      assert.ok(noopRes);
      assert.equal(noopRes.undeployed, false);
      assert.equal(deleteDeploymentCount, 0);
      assert.equal(parseJsonOutput<{ undeployed: boolean }>(noopOut).contents.undeployed, false);

      // 2. Deployed, non-interactive without --yes -> throws CliError(400)
      currentDeployment = makeDeployment({ url: `https://${PEN_ID}.codepen.app/` });
      await assert.rejects(
        () =>
          runUndeployCommand({
            cwd: tmpProj,
            baseUrl: mock.baseUrl,
            homeDir: tmpHome,
            env: {},
            interactive: false,
            output: createBufferedOutput(),
          }),
        (err: unknown) => err instanceof CliError && err.statusCode === 400,
      );
      assert.equal(deleteDeploymentCount, 0);

      // 3. Interactive decline returns null and leaves deployment intact
      const declined = await runUndeployCommand({
        cwd: tmpProj,
        baseUrl: mock.baseUrl,
        homeDir: tmpHome,
        env: {},
        interactive: true,
        output: createBufferedOutput(),
        prompts: { confirm: async () => false },
      });
      assert.equal(declined, null);
      assert.equal(deleteDeploymentCount, 0);

      // 4. --yes + --json takes down live deployment
      const okOut = createBufferedOutput();
      const okRes = await runUndeployCommand({
        cwd: tmpProj,
        yes: true,
        json: true,
        baseUrl: mock.baseUrl,
        homeDir: tmpHome,
        env: {},
        interactive: false,
        output: okOut,
      });
      assert.ok(okRes);
      assert.equal(okRes.undeployed, true);
      assert.equal(deleteDeploymentCount, 1);
      const env = parseJsonOutput<{ undeployed: boolean; pen_id: string }>(okOut);
      assert.equal(env.status.code, 200);
      assert.equal(env.contents.undeployed, true);
      assert.equal(env.contents.pen_id, PEN_ID);
    }, 'cdpn-undeploy-');
  });
});
