import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  extractCodePenOwnerFromUrl,
  findProject,
  normalizePenReference,
  readProjectConfig,
  suggestFolderName,
  writeProjectConfig,
} from '../src/config/project.js';

describe('project config (.cdpn.json)', () => {
  it('writes, reads (including profile), and walks upward to find .cdpn.json', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-project-test-'));
    try {
      const nestedDir = path.join(tmpDir, 'src', 'components');
      await fs.mkdir(nestedDir, { recursive: true });

      await writeProjectConfig(tmpDir, {
        url: 'https://codepen.io/username/pen/abcde',
        pen_id: '01a08738-73f0-7847-b6a8-5789d289c158',
        profile: 'username',
        last_synced_version_id: '01a08738-73f0-7848-b8bf-e8e7e91b1ae2',
        editor: 'V2',
        files: {
          '/style.css': {
            id: 'f2',
            content_hash: 'bbb',
            local_sha256: 'bbb',
            is_binary: false,
          },
          '/index.html': {
            id: 'f1',
            content_hash: 'aaa',
            local_sha256: 'aaa',
            is_binary: false,
          },
        },
      });

      const readBack = await readProjectConfig(tmpDir);
      assert.equal(readBack.url, 'https://codepen.io/username/pen/abcde');
      assert.equal(readBack.pen_id, '01a08738-73f0-7847-b6a8-5789d289c158');
      assert.equal(readBack.profile, 'username');
      assert.equal(readBack.last_synced_version_id, '01a08738-73f0-7848-b8bf-e8e7e91b1ae2');
      assert.deepEqual(Object.keys(readBack.files ?? {}), ['/index.html', '/style.css']);

      const discovered = await findProject(nestedDir);
      assert.ok(discovered);
      assert.equal(discovered.rootDir, path.resolve(tmpDir));
      assert.equal(discovered.config.pen_id, '01a08738-73f0-7847-b6a8-5789d289c158');
      assert.equal(discovered.config.profile, 'username');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('normalizes valid CodePen URLs and IDs and rejects foreign hosts', () => {
    const fromPenUrl = normalizePenReference('https://codepen.io/bramus/pen/abcde');
    assert.equal(fromPenUrl.apiIdentifier, 'https://codepen.io/bramus/pen/abcde');
    assert.equal(fromPenUrl.originalUrl, 'https://codepen.io/bramus/pen/abcde');

    const fromPreview = normalizePenReference('https://89bb1234.codepen.dev/');
    assert.equal(fromPreview.apiIdentifier, 'https://89bb1234.codepen.dev/');

    const fromCpid = normalizePenReference('01a08738-73f0-7847-b6a8-5789d289c158');
    assert.equal(fromCpid.apiIdentifier, '01a08738-73f0-7847-b6a8-5789d289c158');
    assert.equal(fromCpid.originalUrl, undefined);

    assert.throws(() => normalizePenReference('https://evil.example.com/pen/123'), /CodePen URL/);
    assert.throws(() => normalizePenReference('bad/id/with/slashes'), /Invalid Pen ID/);
  });

  it('extracts user and team owners from CodePen URLs', () => {
    assert.equal(extractCodePenOwnerFromUrl('https://codepen.io/bramus/pen/abcde'), 'bramus');
    assert.equal(extractCodePenOwnerFromUrl('https://codepen.io/username/editor/xyz12'), 'username');
    assert.equal(extractCodePenOwnerFromUrl('https://codepen.io/team/username/pen/xyz12'), 'username');
    assert.equal(extractCodePenOwnerFromUrl('https://codepen.io/pen/abcde'), null);
    assert.equal(extractCodePenOwnerFromUrl('https://89bb1234.codepen.dev/'), null);
    assert.equal(extractCodePenOwnerFromUrl('not-a-url'), null);
  });

  it('suggests safe folder names from Pen titles', () => {
    assert.equal(
      suggestFolderName({ id: '01a0-1234', title: 'CSS Scroll-Driven Animations!' }),
      'css-scroll-driven-animations',
    );
    assert.equal(suggestFolderName({ id: '01a0-1234', title: 'Untitled' }), '01a0-1234');
    assert.equal(suggestFolderName({ id: '01a0-1234', title: '' }), '01a0-1234');
  });
});
