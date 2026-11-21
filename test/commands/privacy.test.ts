import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { Pen, PenAccess } from '../../src/api/types.js';
import { runPrivacyCommand } from '../../src/commands/privacy.js';
import { writeProjectConfig } from '../../src/config/project.js';
import { saveProfileToFile } from '../../src/config/user-store.js';

const KEY_BRAMUS = 'cp_user_bramus_privacy1234';

describe('cdpn privacy command', () => {
  let server: http.Server;
  let baseUrl = '';
  let currentAccess: PenAccess = 'Public';
  let patchCalls: Array<Record<string, unknown>> = [];

  const PEN_ID = 'pen-privacy-1';

  const makePen = (access: PenAccess): Pen => ({
    id: PEN_ID,
    title: 'Privacy Test Pen',
    description: '',
    tags: [],
    access,
    password: null,
    template: false,
    popularity: 0,
    views_count: 0,
    loves_count: 0,
    editor: 'V2',
    created_at: '2026-09-01T12:00:00Z',
    updated_at: '2026-09-10T12:00:00Z',
    urls: {
      editor: `https://codepen.io/bramus/pen/${PEN_ID}`,
      preview: `https://${PEN_ID}.codepen.dev/`,
    },
    screenshot_urls: null,
    saved_version: null,
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
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const rawBody = Buffer.concat(chunks).toString('utf8');

      const sendJson = (status: number, body: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };

      if (req.headers.authorization !== `Bearer ${KEY_BRAMUS}`) {
        return sendJson(401, { code: 'UNAUTHENTICATED', message: 'invalid key' });
      }

      if (req.method === 'GET' && url.pathname === `/v2/pens/${PEN_ID}`) {
        return sendJson(200, makePen(currentAccess));
      }

      if (req.method === 'PATCH' && url.pathname === `/v2/pens/${PEN_ID}`) {
        const parsed = JSON.parse(rawBody) as Record<string, unknown>;
        patchCalls.push(parsed);
        if (typeof parsed.access === 'string') {
          currentAccess = parsed.access as PenAccess;
        }
        return sendJson(200, makePen(currentAccess));
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
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-priv-home-'));
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-priv-root-'));
    const subDir = path.join(tmpRoot, 'src');
    await fs.mkdir(subDir, { recursive: true });
    patchCalls = [];

    try {
      await saveProfileToFile('bramus', KEY_BRAMUS, { homeDir: tmpHome, setAsDefault: true });

      // Neither root nor subdir has .cdpn.json
      await assert.rejects(
        () =>
          runPrivacyCommand({
            cwd: tmpRoot,
            levelArg: 'private',
            baseUrl,
            env: {},
            homeDir: tmpHome,
            interactive: false,
          }),
        /only works in a folder with a \.cdpn\.json file/,
      );

      // Add .cdpn.json to root, then run inside child `src/` -> must still refuse!
      await writeProjectConfig(tmpRoot, {
        url: `https://codepen.io/bramus/pen/${PEN_ID}`,
        pen_id: PEN_ID,
        profile: 'bramus',
        last_synced_version_id: null,
      });

      await assert.rejects(
        () =>
          runPrivacyCommand({
            cwd: subDir,
            levelArg: 'private',
            baseUrl,
            env: {},
            homeDir: tmpHome,
            interactive: false,
          }),
        /only works directly inside a folder containing \.cdpn\.json[\s\S]*parent folder/,
      );

      assert.equal(patchCalls.length, 0);
    } finally {
      await fs.rm(tmpHome, { recursive: true, force: true });
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('supports viewing, interactive selection, direct updates, Protected passwords, and no-op detection', async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-priv-home-'));
    const tmpPen = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-priv-pen-'));
    currentAccess = 'Public';
    patchCalls = [];

    try {
      await saveProfileToFile('bramus', KEY_BRAMUS, { homeDir: tmpHome, setAsDefault: true });
      await writeProjectConfig(tmpPen, {
        url: `https://codepen.io/bramus/pen/${PEN_ID}`,
        pen_id: PEN_ID,
        profile: 'bramus',
        last_synced_version_id: null,
      });

      // 1. --show reads current privacy without calling PATCH
      const shown = await runPrivacyCommand({
        cwd: tmpPen,
        show: true,
        baseUrl,
        env: {},
        homeDir: tmpHome,
        interactive: true,
      });
      assert.ok(shown);
      assert.equal(shown.access, 'Public');
      assert.equal(shown.updated, false);
      assert.equal(patchCalls.length, 0);

      // 2. Direct non-interactive update: Public -> Private
      const toPrivate = await runPrivacyCommand({
        cwd: tmpPen,
        levelArg: 'private',
        baseUrl,
        env: {},
        homeDir: tmpHome,
        interactive: false,
      });
      assert.ok(toPrivate);
      assert.equal(toPrivate.previousAccess, 'Public');
      assert.equal(toPrivate.access, 'Private');
      assert.equal(toPrivate.updated, true);
      assert.deepEqual(patchCalls[0], { access: 'Private' });

      // 3. Re-applying Private is a no-op (no PATCH call)
      const noop = await runPrivacyCommand({
        cwd: tmpPen,
        levelArg: 'private',
        baseUrl,
        env: {},
        homeDir: tmpHome,
        interactive: false,
      });
      assert.ok(noop);
      assert.equal(noop.updated, false);
      assert.equal(patchCalls.length, 1);

      // 4. Interactive picker pre-selects current level (Private -> index 1) and handles Protected password prompt
      let seenDefaultIndex: number | undefined;
      let secretPrompted = false;
      const toProtected = await runPrivacyCommand({
        cwd: tmpPen,
        baseUrl,
        env: {},
        homeDir: tmpHome,
        interactive: true,
        prompts: {
          select: async (_q, _opts, defIdx) => {
            seenDefaultIndex = defIdx;
            return 'Protected' as never;
          },
          secret: async () => {
            secretPrompted = true;
            return 'secretpass99';
          },
        },
      });
      assert.equal(seenDefaultIndex, 1, 'Expected Private (index 1) to be pre-selected');
      assert.equal(secretPrompted, true);
      assert.ok(toProtected);
      assert.equal(toProtected.access, 'Protected');
      assert.equal(toProtected.passwordUpdated, true);
      assert.deepEqual(patchCalls[1], { access: 'Protected', password: 'secretpass99' });

      // 5. Rotating password on an already-Protected Pen sends { password } only
      const rotated = await runPrivacyCommand({
        cwd: tmpPen,
        password: 'newpassword123',
        baseUrl,
        env: {},
        homeDir: tmpHome,
        interactive: false,
      });
      assert.ok(rotated);
      assert.equal(rotated.updated, true);
      assert.equal(rotated.passwordUpdated, true);
      assert.deepEqual(patchCalls[2], { password: 'newpassword123' });

      // 6. Changing to Collaborators and rejecting --password with non-Protected level
      await assert.rejects(
        () =>
          runPrivacyCommand({
            cwd: tmpPen,
            levelArg: 'public',
            password: 'somepassword',
            baseUrl,
            env: {},
            homeDir: tmpHome,
            interactive: false,
          }),
        /--password can only be used with Protected/,
      );

      const toCollab = await runPrivacyCommand({
        cwd: tmpPen,
        levelArg: 'collaborators',
        baseUrl,
        env: {},
        homeDir: tmpHome,
        interactive: false,
      });
      assert.ok(toCollab);
      assert.equal(toCollab.access, 'Collaborators');
      assert.deepEqual(patchCalls[3], { access: 'Collaborators' });
    } finally {
      await fs.rm(tmpHome, { recursive: true, force: true });
      await fs.rm(tmpPen, { recursive: true, force: true });
    }
  });
});
