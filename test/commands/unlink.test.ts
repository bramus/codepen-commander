import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { runUnlinkCommand } from '../../src/commands/unlink.js';
import {
  readProjectConfigFile,
  writeProjectConfig,
  writeUnlinkedProjectInfo,
} from '../../src/config/project.js';
import { PROJECT_CONFIG_FILENAME } from '../../src/constants.js';
import { CliError } from '../../src/errors.js';
import { createBufferedOutput, createSilentOutput, parseJsonOutput } from '../helpers/output.js';

const PEN_ID = '019c97a9-7f2b-7773-8421-c21c074a0009';
const PEN_URL = `https://codepen.io/editor/bramus/pen/${PEN_ID}`;

describe('cdpn unlink command', () => {
  it('strictly requires a linked .cdpn.json in the current directory (never walks up to parent)', async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-unlink-strict-'));
    const childDir = path.join(tmpRoot, 'sub');
    const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-unlink-empty-'));

    try {
      await fs.mkdir(childDir, { recursive: true });
      await writeProjectConfig(tmpRoot, {
        url: PEN_URL,
        pen_id: PEN_ID,
        profile: 'bramus',
        last_synced_version_id: 'ver-1',
        info: { title: 'Parent Pen', access: 'Public' },
      });

      // Missing `.cdpn.json` altogether
      await assert.rejects(
        () =>
          runUnlinkCommand({
            cwd: emptyDir,
            yes: true,
            interactive: false,
            output: createSilentOutput(),
          }),
        /No \.cdpn\.json found in /i,
      );

      // Child directory must NOT unlink parent directory's `.cdpn.json`
      await assert.rejects(
        () =>
          runUnlinkCommand({
            cwd: childDir,
            yes: true,
            interactive: false,
            output: createSilentOutput(),
          }),
        /found one in parent folder/i,
      );
      assert.equal((await readProjectConfigFile(tmpRoot)).linked, true);

      // Already unlinked `.cdpn.json` fails cleanly
      await writeUnlinkedProjectInfo(emptyDir, { title: 'Already Unlinked', access: 'Private' });
      await assert.rejects(
        () =>
          runUnlinkCommand({
            cwd: emptyDir,
            yes: true,
            interactive: false,
            output: createSilentOutput(),
          }),
        /not linked to an online Pen/i,
      );
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
      await fs.rm(emptyDir, { recursive: true, force: true });
    }
  });

  it('unlinks locally without making any API requests while preserving info, .codepen/, and source files', async () => {
    const tmpPen = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-unlink-pen-'));

    try {
      await fs.writeFile(path.join(tmpPen, 'index.html'), '<h1>Stay Local</h1>\n', 'utf8');
      await fs.mkdir(path.join(tmpPen, '.codepen'), { recursive: true });
      await fs.writeFile(
        path.join(tmpPen, '.codepen', 'pen.config.json'),
        JSON.stringify({ blocks: ['classic-1', 'fingerprint-1', 'validate-1'] }, null, 2),
        'utf8',
      );

      const writeLinked = async () =>
        writeProjectConfig(tmpPen, {
          url: PEN_URL,
          pen_id: PEN_ID,
          profile: 'bramus',
          last_synced_version_id: 'ver-1',
          last_synced_info_hash: 'hash-123',
          editor: 'V2',
          info: {
            title: 'Local Unlink Pen',
            description: 'Keep this metadata',
            tags: ['css', 'demo'],
            access: 'Private',
            template: true,
          },
          files: {
            'index.html': {
              id: 'file-1',
              content_hash: 'hash-1',
              local_sha256: 'abc',
              is_binary: false,
            },
          },
        });

      await writeLinked();

      // 1. Non-interactive without --yes refuses safely with CliError(400)
      await assert.rejects(
        () => runUnlinkCommand({ cwd: tmpPen, interactive: false, output: createSilentOutput() }),
        (err: unknown) =>
          err instanceof CliError &&
          err.statusCode === 400 &&
          /non-interactive mode without --yes/i.test(err.message),
      );
      assert.equal((await readProjectConfigFile(tmpPen)).linked, true);

      // 2. Interactive decline (defaultYes must be false) aborts without modifying anything
      let seenDefaultYes: boolean | undefined;
      let seenQuestion = '';
      const aborted = await runUnlinkCommand({
        cwd: tmpPen,
        interactive: true,
        output: createSilentOutput(),
        prompts: {
          confirm: async (question, defaultYes) => {
            seenQuestion = question;
            seenDefaultYes = defaultYes;
            return false;
          },
        },
      });
      assert.equal(aborted, null);
      assert.equal(seenDefaultYes, false, 'unlink confirmation must default to No');
      assert.match(seenQuestion, /\.codepen/i);
      assert.equal((await readProjectConfigFile(tmpPen)).linked, true);

      // 3. Interactive confirm unlinks `.cdpn.json` locally (no auth/network required)
      const res = await runUnlinkCommand({
        cwd: tmpPen,
        interactive: true,
        output: createSilentOutput(),
        prompts: {
          confirm: async () => true,
        },
      });
      assert.ok(res);
      assert.equal(res.unlinked, true);
      assert.equal(res.previousPenId, PEN_ID);
      assert.equal(res.previousUrl, PEN_URL);
      assert.equal(res.previousProfile, 'bramus');
      assert.deepEqual(res.retainedInfo, {
        title: 'Local Unlink Pen',
        description: 'Keep this metadata',
        tags: ['css', 'demo'],
        access: 'Private',
        template: true,
      });

      const rawAfter = JSON.parse(
        await fs.readFile(path.join(tmpPen, PROJECT_CONFIG_FILENAME), 'utf8'),
      ) as Record<string, unknown>;
      assert.deepEqual(Object.keys(rawAfter), ['info']);
      assert.deepEqual(rawAfter.info, res.retainedInfo);
      assert.equal('pen_id' in rawAfter, false);
      assert.equal('url' in rawAfter, false);
      assert.equal('profile' in rawAfter, false);
      assert.equal('last_synced_version_id' in rawAfter, false);
      assert.equal('last_synced_info_hash' in rawAfter, false);
      assert.equal('editor' in rawAfter, false);
      assert.equal('files' in rawAfter, false);

      // `.codepen/` and source files must remain untouched
      assert.ok((await fs.stat(path.join(tmpPen, '.codepen', 'pen.config.json'))).isFile());
      assert.equal(await fs.readFile(path.join(tmpPen, 'index.html'), 'utf8'), '<h1>Stay Local</h1>\n');

      // 4. Non-interactive `--yes --json` emits structured 200 JSON envelope
      await writeLinked();
      const jsonBuf = createBufferedOutput();
      const jsonRes = await runUnlinkCommand({
        cwd: tmpPen,
        yes: true,
        json: true,
        interactive: false,
        output: jsonBuf,
      });

      assert.ok(jsonRes);
      const envelope = parseJsonOutput<{
        unlinked: boolean;
        previous_pen_id: string;
        previous_url: string;
        previous_profile: string | null;
        info: Record<string, unknown>;
      }>(jsonBuf);
      assert.equal(envelope.status.code, 200);
      assert.match(envelope.status.message, /online Pen left untouched/i);
      assert.equal(envelope.contents.unlinked, true);
      assert.equal(envelope.contents.previous_pen_id, PEN_ID);
      assert.equal(envelope.contents.previous_url, PEN_URL);
      assert.equal(envelope.contents.previous_profile, 'bramus');
      assert.deepEqual(envelope.contents.info, jsonRes.retainedInfo);
      assert.ok((await fs.stat(path.join(tmpPen, '.codepen', 'pen.config.json'))).isFile());

      // 5. Legacy `.cdpn.json` without `info` unlinks cleanly to `{ info: {} }`
      await writeProjectConfig(tmpPen, {
        url: PEN_URL,
        pen_id: PEN_ID,
        last_synced_version_id: 'ver-1',
      });
      const legacyRes = await runUnlinkCommand({
        cwd: tmpPen,
        yes: true,
        interactive: false,
        output: createSilentOutput(),
      });
      assert.ok(legacyRes);
      assert.equal(legacyRes.previousProfile, null);
      assert.deepEqual(legacyRes.retainedInfo, {});
      const legacyRaw = JSON.parse(
        await fs.readFile(path.join(tmpPen, PROJECT_CONFIG_FILENAME), 'utf8'),
      ) as Record<string, unknown>;
      assert.deepEqual(legacyRaw, { info: {} });
    } finally {
      await fs.rm(tmpPen, { recursive: true, force: true });
    }
  });
});
