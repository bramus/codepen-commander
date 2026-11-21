import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { PenSettings } from '../../src/api/types.js';
import { runSettingsCommand } from '../../src/commands/settings.js';
import { writeProjectConfig } from '../../src/config/project.js';
import { saveProfileToFile } from '../../src/config/user-store.js';
import { CliError } from '../../src/errors.js';
import { stripAnsi } from '../../src/utils/format.js';
import {
  makePen,
  makeSettings,
  startMockCodePenServer,
  type MockApiServer,
} from '../helpers/mock-codepen-api.js';
import { createBufferedOutput, parseJsonOutput } from '../helpers/output.js';
import { withTempDir } from '../helpers/temp-dir.js';

const API_KEY = 'cp_user_bramus_settings_test_1';
const PEN_ID = 'pen-settings-1';

describe('cdpn settings command', () => {
  let mock: MockApiServer;
  let currentSettings: PenSettings = makeSettings();
  let patchBodies: Array<Record<string, unknown>> = [];

  before(async () => {
    mock = await startMockCodePenServer((ctx) => {
      if (ctx.headers.authorization !== `Bearer ${API_KEY}`) {
        return { status: 401, body: { code: 'UNAUTHENTICATED', message: 'Invalid key' } };
      }

      if (ctx.method === 'GET' && ctx.pathname === `/v2/pens/${PEN_ID}`) {
        return {
          status: 200,
          body: makePen({ id: PEN_ID, settings: currentSettings }),
        };
      }

      if (ctx.method === 'PATCH' && ctx.pathname === `/v2/pens/${PEN_ID}/settings`) {
        const body = ctx.jsonBody();
        patchBodies.push(body);
        currentSettings = {
          ...currentSettings,
          ...(body as Partial<PenSettings>),
        };
        return { status: 200, body: currentSettings };
      }
    });
  });

  after(async () => {
    await mock.close();
  });

  it('reads current settings, applies PATCH updates, and validates inputs before calling the API', async () => {
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
        last_synced_version_id: 'ver-1',
      });

      currentSettings = makeSettings({
        auto_deploy: false,
        auto_run: true,
        auto_save: true,
        indent_with: 'spaces',
        tab_size: 2,
      });
      patchBodies = [];

      // 1. Read-only human output
      const viewOut = createBufferedOutput();
      const viewRes = await runSettingsCommand({
        cwd: tmpProj,
        baseUrl: mock.baseUrl,
        homeDir: tmpHome,
        env: {},
        interactive: false,
        output: viewOut,
      });
      assert.ok(viewRes);
      assert.equal(viewRes.updated, false);
      assert.equal(patchBodies.length, 0);
      const viewText = stripAnsi(viewOut.stdout());
      assert.match(viewText, /auto_deploy:\s+false/);
      assert.match(viewText, /indent_with:\s+spaces/);
      assert.match(viewText, /tab_size:\s+2/);

      // 2. PATCH update + --json output
      const updOut = createBufferedOutput();
      const updRes = await runSettingsCommand({
        cwd: tmpProj,
        autoDeploy: 'true',
        autoRun: 'false',
        autoSave: 'no',
        indentWith: 'TABS',
        tabSize: '4',
        json: true,
        baseUrl: mock.baseUrl,
        homeDir: tmpHome,
        env: {},
        interactive: false,
        output: updOut,
      });
      assert.ok(updRes);
      assert.equal(updRes.updated, true);
      assert.deepEqual(patchBodies, [
        {
          auto_deploy: true,
          auto_run: false,
          auto_save: false,
          indent_with: 'tabs',
          tab_size: 4,
        },
      ]);
      const updEnv = parseJsonOutput<PenSettings>(updOut);
      assert.equal(updEnv.status.code, 200);
      assert.equal(updEnv.contents.auto_deploy, true);
      assert.equal(updEnv.contents.indent_with, 'tabs');
      assert.equal(updEnv.contents.tab_size, 4);

      // 3. Invalid inputs throw CliError(400) before calling PATCH
      const countBefore = patchBodies.length;
      for (const badOpts of [
        { autoDeploy: 'maybe' },
        { indentWith: 'mixed' },
        { tabSize: '0' },
        { tabSize: '9' },
        { tabSize: 'abc' },
      ]) {
        await assert.rejects(
          () =>
            runSettingsCommand({
              cwd: tmpProj,
              baseUrl: mock.baseUrl,
              homeDir: tmpHome,
              env: {},
              interactive: false,
              output: createBufferedOutput(),
              ...badOpts,
            }),
          (err: unknown) => err instanceof CliError && err.statusCode === 400,
        );
      }
      assert.equal(patchBodies.length, countBefore);
    }, 'cdpn-settings-');
  });
});
