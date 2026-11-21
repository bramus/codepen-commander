import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { promisify } from 'node:util';
import { CommanderError } from 'commander';
import { CodePenApiError } from '../../src/api/errors.js';
import type { Build, Pen, PenAccess, PenFile } from '../../src/api/types.js';
import { runCloneCommand } from '../../src/commands/clone.js';
import { runDeleteCommand } from '../../src/commands/delete.js';
import { runForkCommand } from '../../src/commands/fork.js';
import { runNewCommand } from '../../src/commands/new.js';
import { runPrivacyCommand } from '../../src/commands/privacy.js';
import { runPullCommand } from '../../src/commands/pull.js';
import {
  buildSyncedFileMap,
  writeProjectConfig,
  writeUnlinkedProjectInfo,
} from '../../src/config/project.js';
import { saveProfileToFile } from '../../src/config/user-store.js';
import { CliError } from '../../src/errors.js';
import {
  createJsonResponse,
  errorToJsonEnvelope,
  wantsJsonOutput,
  type JsonEnvelope,
} from '../../src/utils/json.js';
import { createBufferedOutput, parseJsonOutput } from '../helpers/output.js';

const execFileAsync = promisify(execFile);

const TEST_API_KEY = 'cp_user_json_secret_1234567890';
const TEST_PASSWORD = 'super-secret-password';

function sha256(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

async function runCliJson(
  args: string[],
  options: { cwd: string; homeDir: string; env?: Record<string, string | undefined> },
): Promise<{ exitCode: number; stdout: string; stderr: string; json: JsonEnvelope }> {
  const cliPath = path.resolve(process.cwd(), 'dist', 'cli.js');
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: options.homeDir,
    USERPROFILE: options.homeDir,
    NO_COLOR: '1',
    CODEPEN_API_KEY: '',
    ...options.env,
  };
  if (!options.env?.CODEPEN_API_KEY) {
    delete childEnv.CODEPEN_API_KEY;
  }

  let exitCode = 0;
  let stdout = '';
  let stderr = '';
  try {
    const res = await execFileAsync(process.execPath, [cliPath, ...args], {
      cwd: options.cwd,
      env: childEnv,
    });
    stdout = res.stdout;
    stderr = res.stderr;
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    exitCode = typeof e.code === 'number' ? e.code : 1;
    stdout = e.stdout ?? '';
    stderr = e.stderr ?? '';
  }

  const parsed = JSON.parse(stdout) as JsonEnvelope;
  assert.equal(typeof parsed.status?.code, 'number', `Missing status.code in:\n${stdout}`);
  assert.equal(typeof parsed.status?.message, 'string', `Missing status.message in:\n${stdout}`);
  assert.ok('contents' in parsed, `Missing contents key in:\n${stdout}`);
  return { exitCode, stdout, stderr, json: parsed };
}

describe('JSON envelope helpers', () => {
  it('detects --json in argv and stops scanning at --', () => {
    assert.equal(wantsJsonOutput(['node', 'cdpn', 'status', '--json']), true);
    assert.equal(wantsJsonOutput(['node', 'cdpn', 'status']), false);
    assert.equal(wantsJsonOutput(['node', 'cdpn', 'push', '--', '--json']), false);
  });

  it('strips ANSI codes from status messages', () => {
    const env = createJsonResponse(200, '\x1b[32m✓ Done\x1b[0m', { ok: true });
    assert.deepEqual(env, {
      status: { code: 200, message: '✓ Done' },
      contents: { ok: true },
    });
  });

  it('maps CodePenApiError, CliError, CommanderError, and generic errors to HTTP status codes', () => {
    const apiErr = new CodePenApiError(404, { code: 'NOT_FOUND', message: 'Pen not found' });
    const apiEnv = errorToJsonEnvelope(apiErr);
    assert.equal(apiEnv.status.code, 404);
    assert.match(apiEnv.status.message, /Pen not found/);
    assert.deepEqual(apiEnv.contents, {
      error_code: 'NOT_FOUND',
    });

    const rateErr = new CodePenApiError(429, {
      code: 'RATE_LIMITED',
      message: 'Slow down',
      retry_after_seconds: 60,
    });
    const rateEnv = errorToJsonEnvelope(rateErr);
    assert.equal(rateEnv.status.code, 429);
    assert.deepEqual(rateEnv.contents, {
      error_code: 'RATE_LIMITED',
      retry_after_seconds: 60,
    });

    const cliErr = new CliError(409, 'Conflict detected', { dirty_files: ['/index.html'] });
    const cliEnv = errorToJsonEnvelope(cliErr);
    assert.equal(cliEnv.status.code, 409);
    assert.equal(cliEnv.status.message, 'Conflict detected');
    assert.deepEqual(cliEnv.contents, { dirty_files: ['/index.html'] });

    const cmdErr = new CommanderError(
      1,
      'commander.missingArgument',
      "error: missing required argument 'url'",
    );
    const cmdEnv = errorToJsonEnvelope(cmdErr);
    assert.equal(cmdEnv.status.code, 400);
    assert.equal(cmdEnv.status.message, "missing required argument 'url'");
    assert.deepEqual(cmdEnv.contents, { error_code: 'commander.missingArgument' });

    const genericEnv = errorToJsonEnvelope(new Error('Something went wrong'));
    assert.equal(genericEnv.status.code, 500);
    assert.equal(genericEnv.status.message, 'Something went wrong');
    assert.equal(genericEnv.contents, null);
  });
});

describe('command --json output against mock CodePen API', () => {
  let server: http.Server;
  let baseUrl: string;
  let failNextBuild = false;
  let penAccess: PenAccess = 'Public';
  let penCounter = 0;

  const indexContent = '<h1>Hello JSON</h1>\n';
  const sampleFiles: PenFile[] = [
    {
      id: 'file-1',
      path: '/index.html',
      name: 'index.html',
      content_hash: sha256(indexContent),
      is_binary: false,
      bytes: Buffer.byteLength(indexContent, 'utf8'),
      content_type: 'text/html',
      content: indexContent,
      url: null,
      download_url: null,
    },
  ];

  function makeBuild(versionId: string, status: Build['status'] = 'Success'): Build {
    return {
      id: `bld-${versionId}`,
      status,
      started_at: '2026-09-10T12:00:00Z',
      ended_at: '2026-09-10T12:00:01Z',
      rounds: 1,
      diagnostics: [],
      errors:
        status === 'Failed'
          ? [
              {
                type: 'Error',
                scope: 'File',
                message: 'Syntax error in /index.html',
                code: 'SYNTAX_ERROR',
                url: null,
                block_name: null,
                path: '/index.html',
                file_id: 'file-1',
                range: null,
              },
            ]
          : [],
      applied_patches: [],
      patches: [],
      version_id: versionId,
      next_id: null,
      previous_id: null,
    };
  }

  function makePen(
    id: string,
    title: string,
    versionId: string,
    access: PenAccess = 'Public',
    buildStatus: Build['status'] = 'Success',
  ): Pen {
    return {
      id,
      title,
      description: 'JSON test pen',
      tags: ['json'],
      access,
      password: null,
      template: false,
      popularity: 0,
      views_count: 1,
      loves_count: 0,
      editor: 'V2',
      created_at: '2026-09-10T12:00:00Z',
      updated_at: '2026-09-10T12:00:00Z',
      urls: {
        editor: `https://codepen.io/bramus/pen/${id}`,
        preview: `https://${id}.codepen.dev/`,
      },
      screenshot_urls: null,
      settings: {
        auto_deploy: false,
        auto_run: true,
        auto_save: true,
        indent_with: 'spaces',
        tab_size: 2,
      },
      saved_version: {
        id: versionId,
        pen_id: id,
        hash: `hash-${versionId}`,
        created_at: '2026-09-10T12:00:00Z',
        deployed: false,
        saved: true,
        label: null,
        build: makeBuild(versionId, buildStatus),
        preview_url: `https://${id}.codepen.dev/`,
      },
      deployment: null,
    };
  }

  before(async () => {
    server = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const rawBody = Buffer.concat(chunks).toString('utf8');

      const sendJson = (status: number, body: unknown) => {
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(body));
      };

      if (req.method === 'GET' && url.pathname === '/v2/pens/pen-json-1') {
        sendJson(200, makePen('pen-json-1', 'JSON Demo', 'ver-json-1', penAccess));
        return;
      }

      if (req.method === 'PATCH' && url.pathname === '/v2/pens/pen-json-1') {
        const body = JSON.parse(rawBody) as { access?: PenAccess };
        if (body.access) penAccess = body.access;
        sendJson(200, makePen('pen-json-1', 'JSON Demo', 'ver-json-1', penAccess));
        return;
      }

      if (req.method === 'DELETE' && url.pathname === '/v2/pens/pen-json-1') {
        res.statusCode = 204;
        res.end();
        return;
      }

      if (req.method === 'GET' && /^\/v2\/pens\/[^/]+\/files$/.test(url.pathname)) {
        sendJson(200, sampleFiles);
        return;
      }

      if (req.method === 'GET' && /^\/v2\/versions\/[^/]+$/.test(url.pathname)) {
        const id = url.pathname.split('/').pop()!;
        sendJson(200, {
          id,
          pen_id: 'pen-json-1',
          hash: `hash-${id}`,
          created_at: '2026-09-10T12:00:00Z',
          deployed: false,
          saved: true,
          label: null,
          build: makeBuild(id, failNextBuild ? 'Failed' : 'Success'),
          preview_url: 'https://pen-json-1.codepen.dev/',
          files: sampleFiles,
        });
        return;
      }

      if (req.method === 'POST' && /^\/v2\/pens\/[^/]+\/fork$/.test(url.pathname)) {
        const body = rawBody ? (JSON.parse(rawBody) as { title?: string; access?: PenAccess }) : {};
        penCounter += 1;
        const id = `forked-pen-${penCounter}`;
        const verId = `ver-${id}`;
        const buildStatus: Build['status'] = failNextBuild ? 'Failed' : 'Success';
        const pen = makePen(id, body.title ?? 'JSON Demo', verId, body.access ?? 'Public', buildStatus);
        sendJson(201, {
          ...pen,
          build: makeBuild(verId, buildStatus),
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/v2/pens') {
        const body = JSON.parse(rawBody) as { title?: string; access?: PenAccess };
        penCounter += 1;
        const id = `created-pen-${penCounter}`;
        const verId = `ver-${id}`;
        const buildStatus: Build['status'] = failNextBuild ? 'Failed' : 'Success';
        const pen = makePen(id, body.title ?? 'Created Pen', verId, body.access ?? 'Public', buildStatus);
        sendJson(201, {
          ...pen,
          build: makeBuild(verId, buildStatus),
        });
        return;
      }

      sendJson(404, { code: 'NOT_FOUND', message: `Unhandled ${req.method} ${url.pathname}` });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it('emits valid JSON envelopes for clone, pull, privacy, delete, fork, and new without leaking secrets', async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-json-home-'));
    const tmpWork = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-json-work-'));
    await saveProfileToFile('bramus', TEST_API_KEY, { homeDir: tmpHome, setAsDefault: true });

    try {
      // 1. clone --json
      const cloneDir = path.join(tmpWork, 'cloned');
      const cloneOut = createBufferedOutput();
      await runCloneCommand({
        urlArg: 'https://codepen.io/bramus/pen/pen-json-1',
        folderArg: cloneDir,
        cwd: tmpWork,
        baseUrl,
        homeDir: tmpHome,
        env: {},
        json: true,
        interactive: false,
        output: cloneOut,
      });
      const cloneJson = parseJsonOutput<{
        pen: Pen;
        linked: boolean;
        profile: string | null;
        written_paths: string[];
      }>(cloneOut);
      assert.equal(cloneJson.status.code, 200);
      assert.equal(cloneJson.contents.pen.id, 'pen-json-1');
      assert.equal(cloneJson.contents.linked, true);
      assert.equal(cloneJson.contents.profile, 'bramus');
      assert.deepEqual(cloneJson.contents.written_paths, ['/index.html']);
      assert.equal(cloneOut.stdout().includes(TEST_API_KEY), false);

      // 2. pull --json (clean)
      const pullOut = createBufferedOutput();
      await runPullCommand({
        cwd: cloneDir,
        baseUrl,
        homeDir: tmpHome,
        env: {},
        json: true,
        interactive: false,
        output: pullOut,
      });
      const pullJson = parseJsonOutput<{ pen: Pen; written_paths: string[] }>(pullOut);
      assert.equal(pullJson.status.code, 200);
      assert.equal(pullJson.contents.pen.id, 'pen-json-1');
      assert.deepEqual(pullJson.contents.written_paths, ['/index.html']);

      // 3. pull --json with dirty local file -> CliError 409 with dirty_files
      await fs.writeFile(path.join(cloneDir, 'index.html'), '<h1>Locally modified</h1>\n', 'utf8');
      await assert.rejects(
        () =>
          runPullCommand({
            cwd: cloneDir,
            baseUrl,
            homeDir: tmpHome,
            env: {},
            json: true,
            interactive: false,
            output: createBufferedOutput(),
          }),
        (err: unknown) => {
          assert.ok(err instanceof CliError);
          assert.equal(err.statusCode, 409);
          assert.deepEqual(err.contents, {
            dirty_files: { added: [], modified: ['/index.html'], deleted: [] },
          });
          return true;
        },
      );

      // 4. privacy --json (read, update, Protected without leaking password)
      penAccess = 'Public';
      const privReadOut = createBufferedOutput();
      await runPrivacyCommand({
        cwd: cloneDir,
        baseUrl,
        homeDir: tmpHome,
        env: {},
        json: true,
        interactive: false,
        output: privReadOut,
      });
      const privRead = parseJsonOutput<{ access: PenAccess; updated: boolean }>(privReadOut);
      assert.equal(privRead.status.code, 200);
      assert.equal(privRead.contents.access, 'Public');
      assert.equal(privRead.contents.updated, false);

      const privUpdOut = createBufferedOutput();
      await runPrivacyCommand({
        cwd: cloneDir,
        baseUrl,
        homeDir: tmpHome,
        env: {},
        levelArg: 'Protected',
        password: TEST_PASSWORD,
        json: true,
        interactive: false,
        output: privUpdOut,
      });
      const privUpd = parseJsonOutput<{
        access: PenAccess;
        previous_access: PenAccess;
        updated: boolean;
      }>(privUpdOut);
      assert.equal(privUpd.status.code, 200);
      assert.equal(privUpd.contents.previous_access, 'Public');
      assert.equal(privUpd.contents.access, 'Protected');
      assert.equal(privUpd.contents.updated, true);
      assert.equal(
        privUpdOut.stdout().includes(TEST_PASSWORD),
        false,
        'Password must never appear in JSON output',
      );

      // 5. delete --json without --yes -> CliError 400; default --yes keeps .cdpn.json linked; --cleanup removes it
      await assert.rejects(
        () =>
          runDeleteCommand({
            cwd: cloneDir,
            baseUrl,
            homeDir: tmpHome,
            env: {},
            json: true,
            output: createBufferedOutput(),
          }),
        (err: unknown) => err instanceof CliError && err.statusCode === 400,
      );

      const delDefaultOut = createBufferedOutput();
      await runDeleteCommand({
        cwd: cloneDir,
        baseUrl,
        homeDir: tmpHome,
        env: {},
        yes: true,
        json: true,
        output: delDefaultOut,
      });
      const delDefaultJson = parseJsonOutput<{
        pen_id: string;
        deleted: boolean;
        config_removed: boolean;
        config_kept_linked: boolean;
      }>(delDefaultOut);
      assert.equal(delDefaultJson.status.code, 200);
      assert.equal(delDefaultJson.contents.pen_id, 'pen-json-1');
      assert.equal(delDefaultJson.contents.deleted, true);
      assert.equal(delDefaultJson.contents.config_removed, false);
      assert.equal(delDefaultJson.contents.config_kept_linked, true);

      const delCleanupOut = createBufferedOutput();
      await runDeleteCommand({
        cwd: cloneDir,
        baseUrl,
        homeDir: tmpHome,
        env: {},
        fullCleanup: true,
        yes: true,
        json: true,
        output: delCleanupOut,
      });
      const delCleanupJson = parseJsonOutput<{
        pen_id: string;
        deleted: boolean;
        config_removed: boolean;
        config_kept_linked: boolean;
      }>(delCleanupOut);
      assert.equal(delCleanupJson.status.code, 200);
      assert.equal(delCleanupJson.contents.pen_id, 'pen-json-1');
      assert.equal(delCleanupJson.contents.deleted, true);
      assert.equal(delCleanupJson.contents.config_removed, true);
      assert.equal(delCleanupJson.contents.config_kept_linked, false);

      // 6. fork --json (400 on Protected without --password; 201 on success; 422 on build failure)
      await assert.rejects(
        () =>
          runForkCommand({
            urlArg: 'https://codepen.io/bramus/pen/pen-json-1',
            folderArg: path.join(tmpWork, 'forked-protected-fail'),
            cwd: tmpWork,
            baseUrl,
            homeDir: tmpHome,
            env: {},
            json: true,
            interactive: false,
            output: createBufferedOutput(),
          }),
        (err: unknown) => err instanceof CliError && err.statusCode === 400,
      );

      penAccess = 'Public';
      failNextBuild = false;
      const forkDir = path.join(tmpWork, 'forked-ok');
      const forkOut = createBufferedOutput();
      await runForkCommand({
        urlArg: 'https://codepen.io/bramus/pen/pen-json-1',
        folderArg: forkDir,
        cwd: tmpWork,
        baseUrl,
        homeDir: tmpHome,
        env: {},
        json: true,
        interactive: false,
        output: forkOut,
      });
      const forkJson = parseJsonOutput<{
        pen: Pen;
        source_pen: { id: string };
        build: Build | null;
      }>(forkOut);
      assert.equal(forkJson.status.code, 201);
      assert.equal(forkJson.contents.source_pen.id, 'pen-json-1');
      assert.equal(forkJson.contents.build?.status, 'Success');

      failNextBuild = true;
      const forkFailDir = path.join(tmpWork, 'forked-fail');
      const forkFailOut = createBufferedOutput();
      const forkFailRes = await runForkCommand({
        urlArg: 'https://codepen.io/bramus/pen/pen-json-1',
        folderArg: forkFailDir,
        cwd: tmpWork,
        baseUrl,
        homeDir: tmpHome,
        env: {},
        json: true,
        interactive: false,
        output: forkFailOut,
      });
      assert.equal(forkFailRes?.exitCode, 1);
      const forkFailJson = parseJsonOutput<{ build: Build | null }>(forkFailOut);
      assert.equal(forkFailJson.status.code, 422);
      assert.equal(forkFailJson.contents.build?.status, 'Failed');

      // 7. new --json (201)
      failNextBuild = false;
      const newDir = path.join(tmpWork, 'scaffolded');
      const newOut = createBufferedOutput();
      await runNewCommand({
        folderArg: newDir,
        title: 'Fresh JSON Pen',
        cwd: tmpWork,
        baseUrl,
        homeDir: tmpHome,
        env: {},
        json: true,
        interactive: false,
        output: newOut,
      });
      const newJson = parseJsonOutput<{ pen: Pen; template: string }>(newOut);
      assert.equal(newJson.status.code, 201);
      assert.equal(newJson.contents.pen.title, 'Fresh JSON Pen');
      assert.equal(newJson.contents.template, 'CodePen default starter');
      assert.equal(newOut.stdout().includes(TEST_API_KEY), false);
    } finally {
      failNextBuild = false;
      await fs.rm(tmpHome, { recursive: true, force: true });
      await fs.rm(tmpWork, { recursive: true, force: true });
    }
  });
});

describe('end-to-end compiled CLI --json envelopes', () => {
  it('returns consistent JSON envelopes for auth, validation, project errors, and Commander parse errors', async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-cli-json-home-'));
    const tmpWork = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-cli-json-work-'));

    try {
      // 1. Unauthenticated auth status --offline --json -> 401
      const unauth = await runCliJson(['auth', 'status', '--offline', '--json'], {
        cwd: tmpWork,
        homeDir: tmpHome,
      });
      assert.equal(unauth.exitCode, 1);
      assert.equal(unauth.stderr, '');
      assert.equal(unauth.json.status.code, 401);
      assert.equal((unauth.json.contents as { authenticated: boolean }).authenticated, false);

      // 2. Empty auth list --json -> 200
      const emptyList = await runCliJson(['auth', 'list', '--json'], {
        cwd: tmpWork,
        homeDir: tmpHome,
      });
      assert.equal(emptyList.exitCode, 0);
      assert.equal(emptyList.json.status.code, 200);
      assert.deepEqual((emptyList.json.contents as { profiles: unknown[] }).profiles, []);

      // 3. Save two profiles and inspect auth status / auth list / auth default / auth logout
      await saveProfileToFile('bramus', TEST_API_KEY, { homeDir: tmpHome, setAsDefault: true });
      await saveProfileToFile('team', 'cp_team_another_secret_9876543210', { homeDir: tmpHome });

      const authed = await runCliJson(['auth', 'status', '--offline', '--json'], {
        cwd: tmpWork,
        homeDir: tmpHome,
      });
      assert.equal(authed.exitCode, 0);
      assert.equal(authed.json.status.code, 200);
      assert.equal(authed.stdout.includes(TEST_API_KEY), false, 'Raw API key must never appear');
      assert.equal(
        authed.stdout.includes('cp_team_another_secret'),
        false,
        'Raw API key must never appear',
      );
      const authedContents = authed.json.contents as {
        authenticated: boolean;
        default_profile: string;
        profiles: Array<{ name: string; masked_key: string; is_default: boolean }>;
      };
      assert.equal(authedContents.authenticated, true);
      assert.equal(authedContents.default_profile, 'bramus');
      assert.equal(authedContents.profiles.length, 2);

      // Unknown profile -> 404
      const missingProf = await runCliJson(
        ['auth', 'status', '--profile', 'ghost', '--offline', '--json'],
        {
          cwd: tmpWork,
          homeDir: tmpHome,
        },
      );
      assert.equal(missingProf.exitCode, 1);
      assert.equal(missingProf.json.status.code, 404);

      // auth default -> 200, missing arg -> 400, unknown -> 404
      const defOk = await runCliJson(['auth', 'default', 'team', '--json'], {
        cwd: tmpWork,
        homeDir: tmpHome,
      });
      assert.equal(defOk.exitCode, 0);
      assert.equal(defOk.json.status.code, 200);
      assert.equal((defOk.json.contents as { default_profile: string }).default_profile, 'team');

      const defMissing = await runCliJson(['auth', 'default', '--json'], {
        cwd: tmpWork,
        homeDir: tmpHome,
      });
      assert.equal(defMissing.exitCode, 1);
      assert.equal(defMissing.json.status.code, 400);

      const defUnknown = await runCliJson(['auth', 'default', 'nope', '--json'], {
        cwd: tmpWork,
        homeDir: tmpHome,
      });
      assert.equal(defUnknown.exitCode, 1);
      assert.equal(defUnknown.json.status.code, 404);

      // auth logout with multiple profiles & no target -> 400
      const logoutAmbig = await runCliJson(['auth', 'logout', '--json'], {
        cwd: tmpWork,
        homeDir: tmpHome,
      });
      assert.equal(logoutAmbig.exitCode, 1);
      assert.equal(logoutAmbig.json.status.code, 400);

      // auth logout unknown profile -> 404
      const logoutMissing = await runCliJson(['auth', 'logout', 'ghost', '--json'], {
        cwd: tmpWork,
        homeDir: tmpHome,
      });
      assert.equal(logoutMissing.exitCode, 1);
      assert.equal(logoutMissing.json.status.code, 404);

      // auth logout specific profile -> 200
      const logoutOne = await runCliJson(['auth', 'logout', 'team', '--json'], {
        cwd: tmpWork,
        homeDir: tmpHome,
      });
      assert.equal(logoutOne.exitCode, 0);
      assert.equal(logoutOne.json.status.code, 200);
      assert.deepEqual(logoutOne.json.contents, {
        removed: true,
        removed_profiles: ['team'],
        remaining_profiles: ['bramus'],
        default_profile: 'bramus',
        file_deleted: false,
        env_var_still_set: false,
      });

      // auth logout --all -> 200
      const logoutAll = await runCliJson(['auth', 'logout', '--all', '--json'], {
        cwd: tmpWork,
        homeDir: tmpHome,
      });
      assert.equal(logoutAll.exitCode, 0);
      assert.equal(logoutAll.json.status.code, 200);
      assert.equal((logoutAll.json.contents as { file_deleted: boolean }).file_deleted, true);

      // 4. Missing .cdpn.json -> 404
      const noProj = await runCliJson(['status', '--json'], {
        cwd: tmpWork,
        homeDir: tmpHome,
      });
      assert.equal(noProj.exitCode, 1);
      assert.equal(noProj.stderr, '');
      assert.equal(noProj.json.status.code, 404);

      // 5. Validation errors -> 400 / 404
      const badLimit = await runCliJson(['list', '--limit', 'abc', '--json'], {
        cwd: tmpWork,
        homeDir: tmpHome,
      });
      assert.equal(badLimit.exitCode, 1);
      assert.equal(badLimit.json.status.code, 400);

      const dryRunUnlinked = await runCliJson(['push', '--dry-run', '--json'], {
        cwd: tmpWork,
        homeDir: tmpHome,
      });
      assert.equal(dryRunUnlinked.exitCode, 1);
      assert.equal(dryRunUnlinked.json.status.code, 400);

      const deployNoPushUnlinked = await runCliJson(['deploy', '--no-push', '--json'], {
        cwd: tmpWork,
        homeDir: tmpHome,
      });
      assert.equal(deployNoPushUnlinked.exitCode, 1);
      assert.equal(deployNoPushUnlinked.json.status.code, 404);

      // 6. Commander parse errors in --json mode -> 400 with empty stderr
      const missingUrl = await runCliJson(['clone', '--json'], {
        cwd: tmpWork,
        homeDir: tmpHome,
      });
      assert.equal(missingUrl.exitCode, 1);
      assert.equal(missingUrl.stderr, '');
      assert.equal(missingUrl.json.status.code, 400);
      assert.match(missingUrl.json.status.message, /missing required argument 'url'/i);

      // Passing --json to excluded command `open` -> clean 400 JSON error, empty stderr
      const openJson = await runCliJson(['open', '--json'], {
        cwd: tmpWork,
        homeDir: tmpHome,
      });
      assert.equal(openJson.exitCode, 1);
      assert.equal(openJson.stderr, '');
      assert.equal(openJson.json.status.code, 400);
      assert.match(openJson.json.status.message, /unknown option '--json'/i);

      // 7. Unlinked info-only .cdpn.json -> linked commands return 404, push --dry-run returns 400, auth status returns 200 with project_profile null
      const unlinkedInfoDir = path.join(tmpWork, 'retained-info');
      await fs.mkdir(unlinkedInfoDir, { recursive: true });
      await writeUnlinkedProjectInfo(unlinkedInfoDir, {
        title: 'Saved Title',
        description: 'Saved description',
        tags: ['css'],
        access: 'Private',
        template: false,
      });

      const unlinkedStatus = await runCliJson(['status', '--json'], {
        cwd: unlinkedInfoDir,
        homeDir: tmpHome,
      });
      assert.equal(unlinkedStatus.exitCode, 1);
      assert.equal(unlinkedStatus.stderr, '');
      assert.equal(unlinkedStatus.json.status.code, 404);
      assert.match(unlinkedStatus.json.status.message, /not linked to an online Pen/i);

      const unlinkedDelete = await runCliJson(['delete', '--yes', '--json'], {
        cwd: unlinkedInfoDir,
        homeDir: tmpHome,
      });
      assert.equal(unlinkedDelete.exitCode, 1);
      assert.equal(unlinkedDelete.json.status.code, 404);
      assert.match(unlinkedDelete.json.status.message, /not linked to an online Pen/i);

      const unlinkedDryPush = await runCliJson(['push', '--dry-run', '--json'], {
        cwd: unlinkedInfoDir,
        homeDir: tmpHome,
      });
      assert.equal(unlinkedDryPush.exitCode, 1);
      assert.equal(unlinkedDryPush.json.status.code, 400);
      assert.match(unlinkedDryPush.json.status.message, /not linked to an online Pen/i);

      const unlinkedDeployNoPush = await runCliJson(['deploy', '--no-push', '--json'], {
        cwd: unlinkedInfoDir,
        homeDir: tmpHome,
      });
      assert.equal(unlinkedDeployNoPush.exitCode, 1);
      assert.equal(unlinkedDeployNoPush.json.status.code, 404);
      assert.match(unlinkedDeployNoPush.json.status.message, /not linked to an online Pen/i);

      // 8. Linked project with no auth -> 401
      await writeProjectConfig(tmpWork, {
        url: 'https://codepen.io/bramus/pen/pen-json-1',
        pen_id: 'pen-json-1',
        last_synced_version_id: 'ver-1',
        editor: 'V2',
        files: buildSyncedFileMap([], new Map([['/index.html', sha256('<p>hi</p>')]])),
      });
      const noAuthStatus = await runCliJson(['status', '--json'], {
        cwd: tmpWork,
        homeDir: tmpHome,
      });
      assert.equal(noAuthStatus.exitCode, 1);
      assert.equal(noAuthStatus.json.status.code, 401);
    } finally {
      await fs.rm(tmpHome, { recursive: true, force: true });
      await fs.rm(tmpWork, { recursive: true, force: true });
    }
  });
});
