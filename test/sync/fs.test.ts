import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  deleteLocalFile,
  isBinaryBuffer,
  normalizePenPath,
  resolveSafeLocalPath,
  scanLocalFiles,
  writeLocalFile,
} from '../../src/sync/fs.js';

describe('filesystem safety and scanning', () => {
  it('blocks path traversal, backslashes, null bytes, drive prefixes, and reserved files', () => {
    assert.equal(normalizePenPath('src/app.js'), '/src/app.js');
    assert.equal(normalizePenPath('/.codepen/pen.config.json'), '/.codepen/pen.config.json');

    const dangerous = [
      '../outside.txt',
      '/src/../../etc/passwd',
      'src\\app.js',
      'C:\\Windows\\win.ini',
      '/foo\0bar.txt',
      '/.cdpn.json',
      '/.git/config',
      '/./index.html',
      '',
      '/',
    ];

    for (const p of dangerous) {
      assert.throws(() => normalizePenPath(p), `Expected normalizePenPath to reject: ${JSON.stringify(p)}`);
    }

    assert.throws(() => resolveSafeLocalPath('/tmp/pen', '../pen-evil/file.txt'));
    assert.equal(
      resolveSafeLocalPath('/tmp/pen', '/src/app.js'),
      path.resolve('/tmp/pen', 'src', 'app.js'),
    );
  });

  it('distinguishes UTF-8 text from binary buffers', () => {
    assert.equal(isBinaryBuffer(Buffer.from('<h1>Hello 🚀 café</h1>', 'utf8')), false);
    assert.equal(isBinaryBuffer(Buffer.alloc(0)), false);
    assert.equal(isBinaryBuffer(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])), true);
    assert.equal(isBinaryBuffer(Buffer.from([0xff, 0xfe, 0xfd])), true);
  });

  it('scans local Pen files, preserves .codepen/pen.config.json, respects ignores, and skips symlinks', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-fs-test-'));
    const outsideFile = path.join(os.tmpdir(), `cdpn-secret-${Date.now()}.txt`);
    try {
      await fs.writeFile(outsideFile, 'TOP SECRET', 'utf8');

      await writeLocalFile(tmpDir, '/index.html', '<h1>Hi</h1>');
      await writeLocalFile(tmpDir, '/.codepen/pen.config.json', '{"blocks":[]}');
      await fs.writeFile(path.join(tmpDir, '.cdpn.json'), '{"pen_id":"x","url":"https://codepen.io/a/pen/x"}');
      await fs.writeFile(path.join(tmpDir, '.DS_Store'), 'junk');
      await fs.writeFile(path.join(tmpDir, '.cdpnignore'), 'scratch/\n*.log\n');
      await writeLocalFile(tmpDir, '/scratch/notes.txt', 'ignore me');
      await writeLocalFile(tmpDir, '/debug.log', 'ignore me too');

      // Symlink pointing outside project root must be skipped on scan AND rejected on write
      await fs.symlink(outsideFile, path.join(tmpDir, 'leak.txt'));

      const scanned = await scanLocalFiles(tmpDir);
      const paths = [...scanned.keys()].sort();
      assert.deepEqual(paths, ['/.codepen/pen.config.json', '/index.html']);

      await assert.rejects(() => writeLocalFile(tmpDir, '/leak.txt', 'overwrite'), /symlink/i);

      // Deleting nested file prunes empty parent directory without removing tmpDir
      await writeLocalFile(tmpDir, '/nested/deep/file.js', 'console.log(1);');
      await deleteLocalFile(tmpDir, '/nested/deep/file.js');
      await assert.rejects(() => fs.stat(path.join(tmpDir, 'nested')));
      assert.ok((await fs.stat(tmpDir)).isDirectory());
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
      await fs.rm(outsideFile, { force: true });
    }
  });
});
