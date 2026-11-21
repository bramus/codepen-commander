import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { promisify } from 'node:util';
import {
  runAuthDefaultCommand,
  runAuthListCommand,
  runAuthLogoutCommand,
  runAuthStatusCommand,
} from '../../src/commands/auth/index.js';
import { writeProjectConfig } from '../../src/config/project.js';
import {
  getConfiguredShellDir,
  readAuthStore,
  saveProfileToFile,
  setConfiguredShellDir,
} from '../../src/config/user-store.js';
import { CliError } from '../../src/errors.js';
import { stripAnsi } from '../../src/utils/format.js';
import { makePen, startMockCodePenServer, type MockApiServer } from '../helpers/mock-codepen-api.js';
import { createBufferedOutput, parseJsonOutput } from '../helpers/output.js';
import { withTempDir } from '../helpers/temp-dir.js';

const execFileAsync = promisify(execFile);

const VALID_KEY_BRAMUS = 'cp_user_bramus_auth_test_1234';
const VALID_KEY_TEAM = 'cp_team_acme_auth_test_5678';
const INVALID_KEY = 'cp_user_revoked_key_00000000';

describe('cdpn auth commands', () => {
  let mock: MockApiServer;

  before(async () => {
    mock = await startMockCodePenServer((ctx) => {
      if (ctx.method === 'GET' && ctx.pathname === '/v2/pens') {
        const auth = ctx.headers.authorization;
        if (auth === `Bearer ${VALID_KEY_BRAMUS}` || auth === `Bearer ${VALID_KEY_TEAM}`) {
          return { status: 200, body: [makePen({ id: 'pen-auth-1' })] };
        }
        return {
          status: 401,
          body: { code: 'UNAUTHENTICATED', message: 'Invalid or revoked API key' },
        };
      }
    });
  });

  after(async () => {
    await mock.close();
  });

  it('runAuthStatusCommand reports unauthenticated, offline, online valid/invalid, and missing --profile without mutating process.exitCode', async () => {
    await withTempDir(async (tmpRoot) => {
      const tmpHome = path.join(tmpRoot, 'home');
      const tmpWork = path.join(tmpRoot, 'work');
      await fs.mkdir(tmpHome, { recursive: true });
      await fs.mkdir(tmpWork, { recursive: true });

      // 1. Unauthenticated human + JSON -> returns exitCode 1 and never mutates process.exitCode
      const prevExitCode = process.exitCode;
      const unauthOut = createBufferedOutput();
      const unauthRes = await runAuthStatusCommand({
        offline: true,
        cwd: tmpWork,
        homeDir: tmpHome,
        env: {},
        output: unauthOut,
      });
      assert.equal(unauthRes.authenticated, false);
      assert.equal(unauthRes.exitCode, 1);
      assert.equal(process.exitCode, prevExitCode);
      assert.match(stripAnsi(unauthOut.stdout()), /Not authenticated/);

      const unauthJsonOut = createBufferedOutput();
      const unauthJsonRes = await runAuthStatusCommand({
        offline: true,
        json: true,
        cwd: tmpWork,
        homeDir: tmpHome,
        env: {},
        output: unauthJsonOut,
      });
      assert.equal(unauthJsonRes.exitCode, 1);
      const unauthEnv = parseJsonOutput<{ authenticated: boolean; profiles: unknown[] }>(
        unauthJsonOut,
      );
      assert.equal(unauthEnv.status.code, 401);
      assert.equal(unauthEnv.contents.authenticated, false);

      // 2. Online verification with valid profiles succeeds without leaking raw keys
      await saveProfileToFile('bramus', VALID_KEY_BRAMUS, { homeDir: tmpHome, setAsDefault: true });
      await saveProfileToFile('team', VALID_KEY_TEAM, { homeDir: tmpHome });

      const onlineOut = createBufferedOutput();
      const onlineRes = await runAuthStatusCommand({
        cwd: tmpWork,
        homeDir: tmpHome,
        baseUrl: mock.baseUrl,
        env: {},
        output: onlineOut,
      });
      assert.equal(onlineRes.authenticated, true);
      assert.equal(onlineRes.exitCode, undefined);
      const onlineText = stripAnsi(onlineOut.stdout());
      assert.match(onlineText, /bramus/);
      assert.match(onlineText, /Valid/);
      assert.equal(onlineText.includes(VALID_KEY_BRAMUS), false);
      assert.equal(onlineText.includes(VALID_KEY_TEAM), false);

      // 3. Invalid key fails online verification with exitCode 1 and 401 JSON
      await saveProfileToFile('revoked', INVALID_KEY, { homeDir: tmpHome });
      const badJsonOut = createBufferedOutput();
      const badJsonRes = await runAuthStatusCommand({
        json: true,
        cwd: tmpWork,
        homeDir: tmpHome,
        baseUrl: mock.baseUrl,
        env: {},
        output: badJsonOut,
      });
      assert.equal(badJsonRes.authenticated, false);
      assert.equal(badJsonRes.exitCode, 1);
      const badEnv = parseJsonOutput<{
        authenticated: boolean;
        profiles: Array<{ name: string; verified: boolean }>;
      }>(badJsonOut);
      assert.equal(badEnv.status.code, 401);
      assert.equal(badEnv.contents.authenticated, false);
      assert.equal(
        badEnv.contents.profiles.find((p) => p.name === 'revoked')?.verified,
        false,
      );
      assert.equal(badJsonOut.stdout().includes(INVALID_KEY), false);

      // 4. Unknown --profile returns exitCode 1 and 404 JSON
      const missingOut = createBufferedOutput();
      const missingRes = await runAuthStatusCommand({
        requestedProfile: 'nonexistent',
        offline: true,
        json: true,
        cwd: tmpWork,
        homeDir: tmpHome,
        env: {},
        output: missingOut,
      });
      assert.equal(missingRes.authenticated, false);
      assert.equal(missingRes.exitCode, 1);
      const missingEnv = parseJsonOutput<{ requested_profile: string }>(missingOut);
      assert.equal(missingEnv.status.code, 404);
      assert.equal(missingEnv.contents.requested_profile, 'nonexistent');
    }, 'cdpn-auth-status-');
  });

  it('runAuthListCommand and runAuthDefaultCommand list markers and switch default profile', async () => {
    await withTempDir(async (tmpRoot) => {
      const tmpHome = path.join(tmpRoot, 'home');
      const tmpWork = path.join(tmpRoot, 'work');
      await fs.mkdir(tmpHome, { recursive: true });
      await fs.mkdir(tmpWork, { recursive: true });

      // Empty list
      const emptyOut = createBufferedOutput();
      const emptyRes = await runAuthListCommand({
        cwd: tmpWork,
        homeDir: tmpHome,
        env: {},
        output: emptyOut,
      });
      assert.deepEqual(emptyRes.profiles, []);
      assert.match(stripAnsi(emptyOut.stdout()), /No profiles stored/);

      // Save 2 profiles + link project to `team`
      await saveProfileToFile('bramus', VALID_KEY_BRAMUS, { homeDir: tmpHome, setAsDefault: true });
      await saveProfileToFile('team', VALID_KEY_TEAM, { homeDir: tmpHome });
      await writeProjectConfig(tmpWork, {
        url: 'https://codepen.io/team/pen/pen-1',
        pen_id: 'pen-1',
        profile: 'team',
        last_synced_version_id: null,
      });

      const tableOut = createBufferedOutput();
      const listRes = await runAuthListCommand({
        cwd: tmpWork,
        homeDir: tmpHome,
        env: {},
        output: tableOut,
      });
      assert.deepEqual(listRes.profiles, ['bramus', 'team']);
      assert.equal(listRes.defaultProfile, 'bramus');
      assert.equal(listRes.projectProfile, 'team');
      const tableText = stripAnsi(tableOut.stdout());
      assert.match(tableText, /default/);
      assert.match(tableText, /current folder/);

      // Non-interactive `auth default` without profile throws CliError(400)
      await assert.rejects(
        () =>
          runAuthDefaultCommand({
            homeDir: tmpHome,
            interactive: false,
            output: createBufferedOutput(),
          }),
        (err: unknown) => err instanceof CliError && err.statusCode === 400,
      );

      // Switch default via explicit arg + --json
      const defOut = createBufferedOutput();
      const defRes = await runAuthDefaultCommand({
        profileArg: 'team',
        json: true,
        homeDir: tmpHome,
        output: defOut,
      });
      assert.equal(defRes.defaultProfile, 'team');
      const defEnv = parseJsonOutput<{ default_profile: string; profiles: string[] }>(defOut);
      assert.equal(defEnv.status.code, 200);
      assert.equal(defEnv.contents.default_profile, 'team');

      // Switch default back interactively
      const interactiveDefOut = createBufferedOutput();
      const interactiveRes = await runAuthDefaultCommand({
        homeDir: tmpHome,
        interactive: true,
        output: interactiveDefOut,
        selectProfile: async () => 'bramus',
      });
      assert.equal(interactiveRes.defaultProfile, 'bramus');
      assert.equal((await readAuthStore({ homeDir: tmpHome })).store.defaultProfile, 'bramus');
    }, 'cdpn-auth-list-');
  });

  it('runAuthLogoutCommand removes profiles, handles unknown profiles, and preserves global config.shell', async () => {
    await withTempDir(async (tmpRoot) => {
      const tmpHome = path.join(tmpRoot, 'home');
      await fs.mkdir(tmpHome, { recursive: true });
      await setConfiguredShellDir('/custom/shell', { homeDir: tmpHome });
      await saveProfileToFile('bramus', VALID_KEY_BRAMUS, { homeDir: tmpHome, setAsDefault: true });
      await saveProfileToFile('team', VALID_KEY_TEAM, { homeDir: tmpHome });

      // Unknown profile in --json returns exitCode 1 and 404
      const ghostOut = createBufferedOutput();
      const ghostRes = await runAuthLogoutCommand({
        profileArg: 'ghost',
        json: true,
        homeDir: tmpHome,
        env: {},
        output: ghostOut,
      });
      assert.equal(ghostRes.removed, false);
      assert.equal(ghostRes.exitCode, 1);
      assert.equal(parseJsonOutput(ghostOut).status.code, 404);

      // Remove one profile
      const oneOut = createBufferedOutput();
      const oneRes = await runAuthLogoutCommand({
        profileArg: 'team',
        json: true,
        homeDir: tmpHome,
        env: {},
        output: oneOut,
      });
      assert.equal(oneRes.removed, true);
      assert.deepEqual(oneRes.removedProfiles, ['team']);
      assert.deepEqual(oneRes.remainingProfiles, ['bramus']);

      // Remove all remaining profiles -> keeps ~/.cdpn because config.shell is set!
      const allOut = createBufferedOutput();
      const allRes = await runAuthLogoutCommand({
        all: true,
        json: true,
        homeDir: tmpHome,
        env: {},
        output: allOut,
      });
      assert.equal(allRes.removed, true);
      assert.deepEqual(allRes.remainingProfiles, []);
      const allEnv = parseJsonOutput<{ file_deleted: boolean }>(allOut);
      assert.equal(allEnv.status.code, 200);
      assert.equal(allEnv.contents.file_deleted, false);
      assert.equal(await getConfiguredShellDir({ homeDir: tmpHome }), '/custom/shell');
    }, 'cdpn-auth-logout-');
  });

  it('inherits parent `cdpn auth --json` flag on auth subcommands', async () => {
    await withTempDir(async (tmpRoot) => {
      const tmpHome = path.join(tmpRoot, 'home');
      await fs.mkdir(tmpHome, { recursive: true });
      await saveProfileToFile('bramus', VALID_KEY_BRAMUS, { homeDir: tmpHome, setAsDefault: true });

      const cliPath = path.resolve(process.cwd(), 'dist', 'cli.js');
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: tmpHome,
        USERPROFILE: tmpHome,
        NO_COLOR: '1',
      };
      delete env.CODEPEN_API_KEY;

      const listProc = await execFileAsync(process.execPath, [cliPath, 'auth', '--json', 'list'], {
        cwd: tmpRoot,
        env,
      });
      const listJson = JSON.parse(listProc.stdout) as {
        status: { code: number };
        contents: { profiles: Array<{ name: string }> };
      };
      assert.equal(listJson.status.code, 200);
      assert.deepEqual(
        listJson.contents.profiles.map((p) => p.name),
        ['bramus'],
      );

      const statusProc = await execFileAsync(
        process.execPath,
        [cliPath, 'auth', '--json', 'status', '--offline'],
        { cwd: tmpRoot, env },
      );
      const statusJson = JSON.parse(statusProc.stdout) as {
        status: { code: number };
        contents: { authenticated: boolean };
      };
      assert.equal(statusJson.status.code, 200);
      assert.equal(statusJson.contents.authenticated, true);
    }, 'cdpn-auth-parent-json-');
  });
});
