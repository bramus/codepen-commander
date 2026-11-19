import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { CodePenClient } from '../src/api/client.js';
import { CodePenApiError } from '../src/api/errors.js';
import { applyCompilerPatchesToDisk, syncRemoteFilesToDisk } from '../src/sync/materialize.js';
import type { Build, Deployment, Pen, PenDomain, PenFile, Version } from '../src/types.js';

describe('CodePenClient & sync integration against local 127.0.0.1 mock API', () => {
  let server: http.Server;
  let baseUrl: string;
  let lastDownloadAuthHeader: string | undefined;
  let lastMultipartBody = '';
  let buildPollCount = 0;

  const VALID_KEY = 'cp_user_testkey1234567890';
  const PEN_ID = '01a08738-73f0-7847-b6a8-5789d289c158';
  const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const samplePen = (): Pen => ({
    id: PEN_ID,
    title: 'Demo Pen',
    description: 'Test description',
    tags: ['css', 'demo'],
    access: 'Private',
    password: null,
    template: false,
    popularity: 10,
    views_count: 42,
    loves_count: 5,
    editor: 'V2',
    created_at: '2026-10-01T10:00:00Z',
    updated_at: '2026-10-02T10:00:00Z',
    urls: {
      editor: `https://codepen.io/editor/bramus/pen/${PEN_ID}/abcd`,
      preview: 'https://abcd.codepen.dev/',
    },
    screenshot_urls: null,
    saved_version: {
      id: 'v_001',
      pen_id: PEN_ID,
      hash: 'hash_001',
      created_at: '2026-10-02T10:00:00Z',
      deployed: false,
      saved: true,
      label: 'Initial',
      build: {
        id: 'v_001',
        status: 'Success',
        started_at: '2026-10-02T10:00:00Z',
        ended_at: '2026-10-02T10:00:02Z',
        rounds: 1,
        diagnostics: [],
        errors: [],
        applied_patches: [],
        patches: [],
        version_id: 'v_001',
        next_id: null,
        previous_id: null,
      },
      preview_url: 'https://pv-v001.codepen.dev/',
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

  before(async () => {
    server = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');

      // Signed download route does NOT require API key
      if (req.method === 'GET' && url.pathname === `/v2/pens/${PEN_ID}/download/img/logo.png`) {
        lastDownloadAuthHeader = req.headers.authorization;
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(PNG_BYTES);
        return;
      }

      // Auth check for all other endpoints
      if (req.headers.authorization !== `Bearer ${VALID_KEY}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 'UNAUTHENTICATED', message: 'invalid or missing API key' }));
        return;
      }

      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const rawBody = Buffer.concat(chunks);

      if (req.method === 'GET' && url.pathname === '/v2/pens') {
        const page = Number(url.searchParams.get('page') ?? '1');
        const link =
          page === 1
            ? `<${baseUrl}/v2/pens?page=2&per_page=1>; rel="next", <${baseUrl}/v2/pens?page=1&per_page=1>; rel="first", <${baseUrl}/v2/pens?page=2&per_page=1>; rel="last"`
            : `<${baseUrl}/v2/pens?page=1&per_page=1>; rel="prev", <${baseUrl}/v2/pens?page=1&per_page=1>; rel="first", <${baseUrl}/v2/pens?page=2&per_page=1>; rel="last"`;
        res.writeHead(200, { 'Content-Type': 'application/json', Link: link });
        res.end(JSON.stringify([samplePen()]));
        return;
      }

      if (req.method === 'GET' && url.pathname === `/v2/pens/${PEN_ID}`) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(samplePen()));
        return;
      }

      if (req.method === 'GET' && url.pathname === `/v2/pens/${PEN_ID}/files`) {
        const files: PenFile[] = [
          {
            id: 'f_html',
            path: '/index.html',
            name: 'index.html',
            content_hash: 'h_html',
            is_binary: false,
            bytes: 11,
            content_type: 'text/html',
            content: '<h1>Hi</h1>',
            url: null,
            download_url: null,
          },
          {
            id: 'f_cfg',
            path: '/.codepen/pen.config.json',
            name: 'pen.config.json',
            content_hash: 'h_cfg',
            is_binary: false,
            bytes: 2,
            content_type: 'application/json',
            content: '{}',
            url: null,
            download_url: null,
          },
          {
            id: 'f_png',
            path: '/img/logo.png',
            name: 'logo.png',
            content_hash: 'h_png',
            is_binary: true,
            bytes: PNG_BYTES.length,
            content_type: 'image/png',
            content: null,
            url: null,
            download_url: `${baseUrl}/v2/pens/${PEN_ID}/download/img/logo.png?sig=ok`,
          },
        ];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(files));
        return;
      }

      if (req.method === 'PUT' && url.pathname === `/v2/pens/${PEN_ID}/files`) {
        const contentType = req.headers['content-type'] ?? '';
        if (contentType.includes('multipart/form-data')) {
          lastMultipartBody = rawBody.toString('utf8');
          const build: Build = {
            id: 'v_003',
            status: 'Success',
            started_at: '2026-10-02T10:01:00Z',
            ended_at: '2026-10-02T10:01:01Z',
            rounds: 1,
            diagnostics: [],
            errors: [],
            applied_patches: [],
            patches: [],
            version_id: 'v_003',
            next_id: null,
            previous_id: null,
          };
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ pen: samplePen(), version: { ...samplePen().saved_version, id: 'v_003', files: [] }, build }));
          return;
        }

        const body = JSON.parse(rawBody.toString('utf8')) as { expected_version_id?: string };
        if (body.expected_version_id === 'v_stale') {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              code: 'CONFLICT',
              message: 'head moved',
              expected_version_id: 'v_stale',
              current_version_id: 'v_001',
            }),
          );
          return;
        }

        const initialBuild: Build = {
          id: 'v_002a',
          status: 'Queued',
          started_at: null,
          ended_at: null,
          rounds: 1,
          diagnostics: [],
          errors: [],
          applied_patches: [],
          patches: [],
          version_id: 'v_002a',
          next_id: null,
          previous_id: null,
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            pen: samplePen(),
            version: { ...samplePen().saved_version, id: 'v_002a' },
            build: initialBuild,
          }),
        );
        return;
      }

      if (req.method === 'GET' && url.pathname === '/v2/builds/v_002a') {
        buildPollCount++;
        const build: Build = {
          id: 'v_002a',
          status: 'Canceled',
          started_at: '2026-10-02T10:01:00Z',
          ended_at: '2026-10-02T10:01:01Z',
          rounds: 1,
          diagnostics: [],
          errors: [],
          applied_patches: [],
          patches: [{ type: 'create', path: '/tsconfig.json', file_id: null, content: '{"strict":true}' }],
          version_id: 'v_002a',
          next_id: 'v_002b',
          previous_id: null,
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(build));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/v2/builds/v_002b') {
        buildPollCount++;
        const build: Build = {
          id: 'v_002b',
          status: 'Success',
          started_at: '2026-10-02T10:01:02Z',
          ended_at: '2026-10-02T10:01:03Z',
          rounds: 2,
          diagnostics: [],
          errors: [],
          applied_patches: [{ type: 'create', path: '/tsconfig.json', file_id: null, content: '{"strict":true}' }],
          patches: [],
          version_id: 'v_002b',
          next_id: null,
          previous_id: 'v_002a',
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(build));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/v2/versions/v_002b') {
        const version: Version = {
          ...samplePen().saved_version!,
          id: 'v_002b',
          files: [
            {
              id: 'f_ts',
              path: '/tsconfig.json',
              name: 'tsconfig.json',
              content_hash: 'h_ts',
              is_binary: false,
              bytes: 15,
              content_type: 'application/json',
              content: '{"strict":true}',
              url: null,
              download_url: null,
            },
          ],
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(version));
        return;
      }

      if (req.method === 'PUT' && url.pathname === `/v2/pens/${PEN_ID}/deployment`) {
        const deployment: Deployment = {
          id: 'dep_1',
          version_id: 'v_002b',
          url: 'https://demo-pen.codepen.app/',
          custom_domains: ['demo.bram.us'],
          created_at: '2026-10-02T10:02:00Z',
          updated_at: '2026-10-02T10:02:00Z',
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(deployment));
        return;
      }

      if (req.method === 'DELETE' && url.pathname === `/v2/pens/${PEN_ID}/deployment`) {
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.method === 'POST' && url.pathname === `/v2/pens/${PEN_ID}/domains`) {
        const body = JSON.parse(rawBody.toString('utf8')) as { host: string };
        const domains: PenDomain[] = [
          {
            id: 'dom_1',
            host: body.host,
            status: 'Pending',
            dns: [{ type: 'CNAME', name: 'demo', value: 'custom.codepen.app' }],
            cname_record: 'None',
            a_record: 'None',
            created_at: '2026-10-02T10:03:00Z',
          },
        ];
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(domains));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address();
    assert.ok(addr && typeof addr === 'object');
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('enforces HTTPS for non-loopback hosts', () => {
    assert.throws(
      () => new CodePenClient({ apiKey: VALID_KEY, baseUrl: 'http://api.codepen.io' }),
      /non-HTTPS/i,
    );
  });

  it('validates auth and throws typed CodePenApiError on 401', async () => {
    const validClient = new CodePenClient({ apiKey: VALID_KEY, baseUrl });
    await validClient.verifyAuth();

    const invalidClient = new CodePenClient({ apiKey: 'cp_user_wrong', baseUrl });
    await assert.rejects(
      () => invalidClient.verifyAuth(),
      (err: unknown) => err instanceof CodePenApiError && err.status === 401 && err.code === 'UNAUTHENTICATED',
    );
  });

  it('materializes text, .codepen/pen.config.json, and binary files without leaking API key to download_url', async () => {
    const client = new CodePenClient({ apiKey: VALID_KEY, baseUrl });
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-pull-test-'));
    try {
      const files = await client.getPenFiles(PEN_ID);
      const result = await syncRemoteFilesToDisk({ client, rootDir: tmpDir, remoteFiles: files });
      assert.deepEqual(result.writtenPaths, ['/.codepen/pen.config.json', '/img/logo.png', '/index.html']);

      // Verify signed download did NOT receive Authorization header
      assert.equal(lastDownloadAuthHeader, undefined);

      assert.equal(await fs.readFile(path.join(tmpDir, 'index.html'), 'utf8'), '<h1>Hi</h1>');
      assert.equal(await fs.readFile(path.join(tmpDir, '.codepen', 'pen.config.json'), 'utf8'), '{}');
      assert.deepEqual(await fs.readFile(path.join(tmpDir, 'img', 'logo.png')), PNG_BYTES);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('handles 409 CONFLICT, build polling with next_id, and compiler patch write-back', async () => {
    const client = new CodePenClient({ apiKey: VALID_KEY, baseUrl });

    await assert.rejects(
      () =>
        client.writePenFiles(PEN_ID, {
          expected_version_id: 'v_stale',
          files: [{ path: '/index.html', content: 'x' }],
        }),
      (err: unknown) =>
        err instanceof CodePenApiError &&
        err.status === 409 &&
        err.code === 'CONFLICT' &&
        err.currentVersionId === 'v_001',
    );

    buildPollCount = 0;
    const writeRes = await client.writePenFiles(PEN_ID, {
      expected_version_id: 'v_001',
      files: [{ path: '/app.ts', content: 'const n: number = 1;' }],
    });
    assert.ok(writeRes.build);

    const settled = await client.settleBuild(writeRes.build, { pollIntervalMs: 10 });
    assert.equal(settled.status, 'Success');
    assert.equal(settled.version_id, 'v_002b');
    assert.equal(settled.rounds, 2);
    assert.equal(buildPollCount, 2);

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-patch-test-'));
    try {
      const convergedVersion = await client.getVersion(settled.version_id!);
      const touched = await applyCompilerPatchesToDisk({
        client,
        rootDir: tmpDir,
        patches: settled.applied_patches,
        convergedFiles: convergedVersion.files,
      });
      assert.deepEqual(touched, ['/tsconfig.json']);
      assert.equal(await fs.readFile(path.join(tmpDir, 'tsconfig.json'), 'utf8'), '{"strict":true}');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('uploads binary files via multipart/form-data', async () => {
    const client = new CodePenClient({ apiKey: VALID_KEY, baseUrl });
    const res = await client.writePenFiles(
      PEN_ID,
      {
        expected_version_id: 'v_001',
        files: [{ path: '/old.css', delete: true }],
      },
      [{ path: '/img/logo.png', content: PNG_BYTES }],
    );
    assert.equal(res.build?.status, 'Success');
    assert.ok(lastMultipartBody.includes('name="changes"'));
    assert.ok(lastMultipartBody.includes('name="/img/logo.png"'));
    assert.ok(lastMultipartBody.includes('"delete":true'));
  });

  it('supports deploy, undeploy, domains, and Link pagination', async () => {
    const client = new CodePenClient({ apiKey: VALID_KEY, baseUrl });

    const page1 = await client.listPens({ per_page: 1 });
    assert.equal(page1.items.length, 1);
    assert.ok(page1.links.next?.includes('page=2'));

    const dep = await client.deployPen(PEN_ID, 'v_002b');
    assert.equal(dep.url, 'https://demo-pen.codepen.app/');

    const domains = await client.addDomain(PEN_ID, 'demo.bram.us');
    assert.equal(domains[0]?.host, 'demo.bram.us');
    assert.equal(domains[0]?.dns[0]?.value, 'custom.codepen.app');

    await client.undeployPen(PEN_ID);
  });
});
