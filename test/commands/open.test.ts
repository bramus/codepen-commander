import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { Deployment, Pen, PenDomain } from '../../src/api/types.js';
import { buildDeployedDomainChoices, runOpenCommand } from '../../src/commands/open.js';
import { writeProjectConfig } from '../../src/config/project.js';
import { saveProfileToFile } from '../../src/config/user-store.js';
import { stripAnsi } from '../../src/utils/format.js';
import type { SelectOption } from '../../src/utils/prompts/index.js';
import { createBufferedOutput, createSilentOutput } from '../helpers/output.js';

const TEST_KEY = 'cp_user_username_opentest12345';
const PEN_ID = '01a1f42c-34ee-7d73-8a48-96cae50b78a3';
const DEFAULT_DEPLOY_URL = 'https://relieved-block-eel.codepen.app/';

describe('cdpn open command', () => {
  let server: http.Server;
  let baseUrl = '';
  let requestLog: string[] = [];
  let deploymentState: Deployment | null = null;
  let domainsState: PenDomain[] = [];
  let domainsEndpointFails = false;

  const makePen = (): Pen => ({
    id: PEN_ID,
    title: 'Open Test Pen',
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
    deployment: deploymentState,
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

      if (req.headers.authorization !== `Bearer ${TEST_KEY}`) {
        return sendJson(401, { code: 'UNAUTHENTICATED', message: 'invalid key' });
      }

      if (req.method === 'GET' && url.pathname === `/v2/pens/${PEN_ID}`) {
        return sendJson(200, makePen());
      }

      if (req.method === 'GET' && url.pathname === `/v2/pens/${PEN_ID}/domains`) {
        if (domainsEndpointFails) {
          return sendJson(500, { code: 'INTERNAL', message: 'domains unavailable' });
        }
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

  async function setupProject(): Promise<{
    tmpHome: string;
    tmpDir: string;
    cleanup: () => Promise<void>;
  }> {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-open-home-'));
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-open-proj-'));
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

  it('deduplicates default and custom domains with status labels in buildDeployedDomainChoices', () => {
    const deployment: Deployment = {
      id: 'dep-1',
      version_id: 'ver-1',
      url: DEFAULT_DEPLOY_URL,
      custom_domains: ['demo.example.com', 'https://relieved-block-eel.codepen.app/', 'DEMO.example.com'],
      created_at: '2026-09-10T12:00:00Z',
      updated_at: '2026-09-10T12:00:00Z',
    };
    const domains: PenDomain[] = [
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
        dns: [],
        created_at: '2026-09-10T12:01:00Z',
      },
    ];

    const choices = buildDeployedDomainChoices(deployment, domains);
    assert.deepEqual(
      choices.map((c) => ({ url: c.url, isDefault: c.isDefault, description: c.description })),
      [
        { url: DEFAULT_DEPLOY_URL, isDefault: true, description: 'default' },
        { url: 'https://demo.example.com/', isDefault: false, description: 'custom domain · Verified' },
        { url: 'https://staging.example.com/', isDefault: false, description: 'custom domain · Pending' },
      ],
    );
  });

  it('opens editor or preview without fetching domains, and rejects --preview with --deploy/--live', async () => {
    const { tmpHome, tmpDir, cleanup } = await setupProject();
    deploymentState = null;
    domainsState = [];
    domainsEndpointFails = false;

    try {
      await assert.rejects(
        () =>
          runOpenCommand({
            cwd: tmpDir,
            baseUrl,
            homeDir: tmpHome,
            env: {},
            preview: true,
            deploy: true,
            output: createSilentOutput(),
          }),
        /Specify at most one of --preview or --deploy \/ --live/,
      );
      await assert.rejects(
        () =>
          runOpenCommand({
            cwd: tmpDir,
            baseUrl,
            homeDir: tmpHome,
            env: {},
            preview: true,
            live: true,
            output: createSilentOutput(),
          }),
        /Specify at most one of --preview or --deploy \/ --live/,
      );

      requestLog = [];
      const openedUrls: string[] = [];
      const editorRes = await runOpenCommand({
        cwd: tmpDir,
        baseUrl,
        homeDir: tmpHome,
        env: {},
        interactive: false,
        output: createSilentOutput(),
        openBrowserImpl: async (url) => {
          openedUrls.push(url);
          return true;
        },
      });
      assert.ok(editorRes);
      assert.equal(editorRes.url, `https://codepen.io/editor/username/pen/${PEN_ID}`);
      assert.deepEqual(requestLog, [`GET /v2/pens/${PEN_ID}`]);

      requestLog = [];
      const previewRes = await runOpenCommand({
        cwd: tmpDir,
        baseUrl,
        homeDir: tmpHome,
        env: {},
        preview: true,
        interactive: false,
        output: createSilentOutput(),
        openBrowserImpl: async (url) => {
          openedUrls.push(url);
          return true;
        },
      });
      assert.ok(previewRes);
      assert.equal(previewRes.url, `https://${PEN_ID}.codepen.dev/`);
      assert.deepEqual(requestLog, [`GET /v2/pens/${PEN_ID}`]);
      assert.deepEqual(openedUrls, [
        `https://codepen.io/editor/username/pen/${PEN_ID}`,
        `https://${PEN_ID}.codepen.dev/`,
      ]);
    } finally {
      await cleanup();
    }
  });

  it('errors on --deploy when Pen is not deployed', async () => {
    const { tmpHome, tmpDir, cleanup } = await setupProject();
    deploymentState = null;
    domainsState = [];
    domainsEndpointFails = false;

    try {
      await assert.rejects(
        () =>
          runOpenCommand({
            cwd: tmpDir,
            baseUrl,
            homeDir: tmpHome,
            env: {},
            deploy: true,
            interactive: true,
            output: createSilentOutput(),
            openBrowserImpl: async () => true,
          }),
        /This Pen is not deployed yet\. Run `cdpn deploy` first\./,
      );
    } finally {
      await cleanup();
    }
  });

  it('opens the default deployed URL immediately without prompting when only one domain exists', async () => {
    const { tmpHome, tmpDir, cleanup } = await setupProject();
    deploymentState = {
      id: 'dep-1',
      version_id: 'ver-1',
      url: DEFAULT_DEPLOY_URL,
      custom_domains: [],
      created_at: '2026-09-10T12:00:00Z',
      updated_at: '2026-09-10T12:00:00Z',
    };
    domainsState = [];
    domainsEndpointFails = false;

    try {
      let promptCalled = false;
      const openedUrls: string[] = [];
      const buf = createBufferedOutput();

      const result = await runOpenCommand({
        cwd: tmpDir,
        baseUrl,
        homeDir: tmpHome,
        env: {},
        deploy: true,
        interactive: true,
        output: buf,
        select: async () => {
          promptCalled = true;
          throw new Error('Should not prompt when only one domain exists');
        },
        openBrowserImpl: async (url) => {
          openedUrls.push(url);
          return true;
        },
      });

      const output = stripAnsi(buf.stdout());
      assert.equal(promptCalled, false);
      assert.ok(result);
      assert.equal(result.url, DEFAULT_DEPLOY_URL);
      assert.deepEqual(openedUrls, [DEFAULT_DEPLOY_URL]);
      assert.ok(
        output.includes(`Opening deployed site: ${DEFAULT_DEPLOY_URL}`),
        `Unexpected output:\n${output}`,
      );
    } finally {
      await cleanup();
    }
  });

  it('prompts to choose when deployed to multiple domains and opens the chosen domain', async () => {
    const { tmpHome, tmpDir, cleanup } = await setupProject();
    deploymentState = {
      id: 'dep-1',
      version_id: 'ver-1',
      url: DEFAULT_DEPLOY_URL,
      custom_domains: ['demo.example.com'],
      created_at: '2026-09-10T12:00:00Z',
      updated_at: '2026-09-10T12:00:00Z',
    };
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
        host: 'beta.example.com',
        status: 'Pending',
        cname_record: 'relieved-block-eel.codepen.app',
        a_record: '198.51.100.1',
        dns: [],
        created_at: '2026-09-10T12:01:00Z',
      },
    ];
    domainsEndpointFails = false;

    try {
      let seenOptions: SelectOption<string>[] = [];
      const openedUrls: string[] = [];

      const result = await runOpenCommand({
        cwd: tmpDir,
        baseUrl,
        homeDir: tmpHome,
        env: {},
        deploy: true,
        interactive: true,
        output: createSilentOutput(),
        select: async <T extends string>(_q: string, opts: SelectOption<T>[]) => {
          seenOptions = opts;
          return opts[1]!.value;
        },
        openBrowserImpl: async (url) => {
          openedUrls.push(url);
          return true;
        },
      });

      assert.equal(seenOptions.length, 3);
      assert.equal(seenOptions[0]!.value, DEFAULT_DEPLOY_URL);
      assert.equal(seenOptions[0]!.description, 'default');
      assert.equal(seenOptions[1]!.value, 'https://demo.example.com/');
      assert.equal(seenOptions[1]!.description, 'custom domain · Verified');
      assert.equal(seenOptions[2]!.value, 'https://beta.example.com/');
      assert.equal(seenOptions[2]!.description, 'custom domain · Pending');
      assert.ok(result);
      assert.equal(result.url, 'https://demo.example.com/');
      assert.deepEqual(openedUrls, ['https://demo.example.com/']);
    } finally {
      await cleanup();
    }
  });

  it('falls back to deployment.custom_domains if listDomains fails and opens default URL non-interactively', async () => {
    const { tmpHome, tmpDir, cleanup } = await setupProject();
    deploymentState = {
      id: 'dep-1',
      version_id: 'ver-1',
      url: DEFAULT_DEPLOY_URL,
      custom_domains: ['demo.example.com'],
      created_at: '2026-09-10T12:00:00Z',
      updated_at: '2026-09-10T12:00:00Z',
    };
    domainsState = [];
    domainsEndpointFails = true;

    try {
      const openedUrls: string[] = [];
      const buf = createBufferedOutput();

      const result = await runOpenCommand({
        cwd: tmpDir,
        baseUrl,
        homeDir: tmpHome,
        env: {},
        live: true,
        interactive: false,
        output: buf,
        openBrowserImpl: async (url) => {
          openedUrls.push(url);
          return true;
        },
      });

      const output = stripAnsi(buf.stdout());
      assert.ok(result);
      assert.equal(result.url, DEFAULT_DEPLOY_URL);
      assert.deepEqual(openedUrls, [DEFAULT_DEPLOY_URL]);
      assert.ok(
        output.includes('https://demo.example.com/'),
        `Expected other domains note in output:\n${output}`,
      );
      assert.ok(
        output.includes(`Opening deployed site: ${DEFAULT_DEPLOY_URL}`),
        `Unexpected output:\n${output}`,
      );
    } finally {
      await cleanup();
    }
  });
});
