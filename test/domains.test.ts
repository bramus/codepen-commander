import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { addPenDomain, deletePenDomain, listPenDomains } from '../src/commands/domains.js';
import { saveProfileToFile } from '../src/config/auth.js';
import { writeProjectConfig } from '../src/config/project.js';
import type { Pen, PenDomain } from '../src/types.js';
import { stripAnsi } from '../src/utils/format.js';

const TEST_KEY = 'cp_user_username_domainstest1234';
const PEN_ID = '01a1f42c-34ee-7d73-8a48-96cae50b78a3';
const DEFAULT_DEPLOY_URL = 'https://relieved-block-eel.codepen.app/';

async function captureLogs<T>(fn: () => Promise<T>): Promise<{ result: T; output: string }> {
  const lines: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(' '));
  };
  try {
    const result = await fn();
    return { result, output: stripAnsi(lines.join('\n')) };
  } finally {
    console.log = origLog;
  }
}

describe('cdpn domains command', () => {
  let server: http.Server;
  let baseUrl = '';
  let deploymentUrl: string | null = DEFAULT_DEPLOY_URL;
  let domainsState: PenDomain[] = [];

  const makePen = (): Pen => ({
    id: PEN_ID,
    title: 'Domains Test Pen',
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
      editor: `https://codepen.io/editor/username/pen/${PEN_ID}`,
      preview: `https://${PEN_ID}.codepen.dev/`,
    },
    screenshot_urls: null,
    saved_version: null,
    deployment: deploymentUrl
      ? {
          id: 'dep-1',
          version_id: 'ver-1',
          url: deploymentUrl,
          custom_domains: domainsState.map((d) => d.host),
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
    server = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');

      const sendJson = (status: number, body: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };

      if (req.headers.authorization !== `Bearer ${TEST_KEY}`) {
        return sendJson(401, { code: 'UNAUTHENTICATED', message: 'invalid key' });
      }

      if (req.method === 'GET' && url.pathname === `/v2/pens/${PEN_ID}`) {
        return sendJson(200, makePen());
      }

      if (req.method === 'GET' && url.pathname === `/v2/pens/${PEN_ID}/domains`) {
        return sendJson(200, domainsState);
      }

      if (req.method === 'POST' && url.pathname === `/v2/pens/${PEN_ID}/domains`) {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { host: string };
        const added: PenDomain = {
          id: `dom-${domainsState.length + 1}`,
          host: body.host,
          status: 'Pending',
          cname_record: 'relieved-block-eel.codepen.app',
          a_record: '198.51.100.1',
          dns: [{ type: 'CNAME', name: body.host, value: 'relieved-block-eel.codepen.app' }],
          created_at: '2026-09-10T12:05:00Z',
        };
        domainsState = [...domainsState, added];
        return sendJson(200, domainsState);
      }

      if (req.method === 'DELETE' && url.pathname.startsWith(`/v2/pens/${PEN_ID}/domains/`)) {
        const host = decodeURIComponent(url.pathname.slice(`/v2/pens/${PEN_ID}/domains/`.length));
        domainsState = domainsState.filter((d) => d.host !== host);
        return sendJson(200, domainsState);
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

  async function setupProject(): Promise<{ tmpHome: string; tmpDir: string; cleanup: () => Promise<void> }> {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-dom-home-'));
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-dom-proj-'));
    await saveProfileToFile('username', TEST_KEY, { homeDir: tmpHome, setAsDefault: true });
    await writeProjectConfig(tmpDir, {
      url: `https://codepen.io/editor/username/pen/${PEN_ID}`,
      pen_id: PEN_ID,
      profile: 'username',
      last_synced_version_id: null,
    });

    return {
      tmpHome,
      tmpDir,
      cleanup: async () => {
        await fs.rm(tmpHome, { recursive: true, force: true });
        await fs.rm(tmpDir, { recursive: true, force: true });
      },
    };
  }

  it('shows the default deployed URL even when no custom domains are configured', async () => {
    const { tmpHome, tmpDir, cleanup } = await setupProject();
    deploymentUrl = DEFAULT_DEPLOY_URL;
    domainsState = [];

    try {
      const { result, output } = await captureLogs(() =>
        listPenDomains({
          cwd: tmpDir,
          baseUrl,
          homeDir: tmpHome,
          env: {},
          interactive: false,
        }),
      );

      assert.equal(result.defaultUrl, DEFAULT_DEPLOY_URL);
      assert.deepEqual(result.domains, []);
      assert.ok(output.includes(`Default URL: ${DEFAULT_DEPLOY_URL}`), `Unexpected output:\n${output}`);
      assert.ok(output.includes('No custom domains configured for this Pen.'), `Unexpected output:\n${output}`);
    } finally {
      await cleanup();
    }
  });

  it('shows both the default deployed URL and custom domains table with DNS records', async () => {
    const { tmpHome, tmpDir, cleanup } = await setupProject();
    deploymentUrl = DEFAULT_DEPLOY_URL;
    domainsState = [
      {
        id: 'dom-1',
        host: 'demo.example.com',
        status: 'Verified',
        cname_record: 'relieved-block-eel.codepen.app',
        a_record: '198.51.100.1',
        dns: [],
        created_at: '2026-09-10T12:00:00Z',
      },
      {
        id: 'dom-2',
        host: 'staging.example.com',
        status: 'Pending',
        cname_record: 'relieved-block-eel.codepen.app',
        a_record: '198.51.100.1',
        dns: [{ type: 'CNAME', name: 'staging.example.com', value: 'relieved-block-eel.codepen.app' }],
        created_at: '2026-09-10T12:01:00Z',
      },
    ];

    try {
      const { output } = await captureLogs(() =>
        listPenDomains({
          cwd: tmpDir,
          baseUrl,
          homeDir: tmpHome,
          env: {},
          interactive: false,
        }),
      );

      assert.ok(output.includes(`Default URL: ${DEFAULT_DEPLOY_URL}`), `Unexpected output:\n${output}`);
      assert.ok(output.includes('demo.example.com'), `Unexpected output:\n${output}`);
      assert.ok(output.includes('staging.example.com'), `Unexpected output:\n${output}`);
      assert.ok(output.includes('Required DNS records:'), `Unexpected output:\n${output}`);
    } finally {
      await cleanup();
    }
  });

  it('indicates when the Pen is not deployed', async () => {
    const { tmpHome, tmpDir, cleanup } = await setupProject();
    deploymentUrl = null;
    domainsState = [];

    try {
      const { result, output } = await captureLogs(() =>
        listPenDomains({
          cwd: tmpDir,
          baseUrl,
          homeDir: tmpHome,
          env: {},
          interactive: false,
        }),
      );

      assert.equal(result.defaultUrl, null);
      assert.ok(output.includes('Default URL: not deployed'), `Unexpected output:\n${output}`);
      assert.ok(output.includes('cdpn deploy'), `Unexpected output:\n${output}`);
    } finally {
      await cleanup();
    }
  });

  it('includes default_url alongside domains in --json output', async () => {
    const { tmpHome, tmpDir, cleanup } = await setupProject();
    deploymentUrl = DEFAULT_DEPLOY_URL;
    domainsState = [];

    try {
      const { output } = await captureLogs(() =>
        listPenDomains({
          cwd: tmpDir,
          baseUrl,
          homeDir: tmpHome,
          env: {},
          json: true,
          interactive: false,
        }),
      );

      const parsed = JSON.parse(output) as { default_url: string | null; domains: PenDomain[] };
      assert.equal(parsed.default_url, DEFAULT_DEPLOY_URL);
      assert.deepEqual(parsed.domains, []);
    } finally {
      await cleanup();
    }
  });

  it('shows default deployed URL after adding and removing a custom domain', async () => {
    const { tmpHome, tmpDir, cleanup } = await setupProject();
    deploymentUrl = DEFAULT_DEPLOY_URL;
    domainsState = [];

    try {
      const { output: addOut } = await captureLogs(() =>
        addPenDomain('www.example.com', {
          cwd: tmpDir,
          baseUrl,
          homeDir: tmpHome,
          env: {},
          interactive: false,
        }),
      );

      assert.ok(addOut.includes('Added custom domain www.example.com'), `Unexpected add output:\n${addOut}`);
      assert.ok(addOut.includes(`Default URL: ${DEFAULT_DEPLOY_URL}`), `Unexpected add output:\n${addOut}`);
      assert.ok(addOut.includes('www.example.com'), `Unexpected add output:\n${addOut}`);

      const { output: delOut } = await captureLogs(() =>
        deletePenDomain('www.example.com', {
          cwd: tmpDir,
          baseUrl,
          homeDir: tmpHome,
          env: {},
          yes: true,
          interactive: false,
        }),
      );

      assert.ok(delOut.includes('Deleted custom domain www.example.com'), `Unexpected delete output:\n${delOut}`);
      assert.ok(delOut.includes(`Default URL: ${DEFAULT_DEPLOY_URL}`), `Unexpected delete output:\n${delOut}`);
      assert.ok(delOut.includes('No custom domains configured for this Pen.'), `Unexpected delete output:\n${delOut}`);
    } finally {
      await cleanup();
    }
  });
});
