import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PenFile } from '../../src/api/types.js';
import type { SyncedFileEntry } from '../../src/config/project.js';
import { computeSyncDiff, detectLocalChangesFromBaseline, hasDiffChanges } from '../../src/sync/diff.js';
import { sha256Hex, type LocalFile } from '../../src/sync/fs.js';

function makeLocalText(penPath: string, content: string): LocalFile {
  const buffer = Buffer.from(content, 'utf8');
  return {
    path: penPath,
    absolutePath: `/tmp${penPath}`,
    buffer,
    isBinary: false,
    sha256: sha256Hex(buffer),
    textContent: content,
  };
}

function makeLocalBinary(penPath: string, bytes: Uint8Array): LocalFile {
  const buffer = Buffer.from(bytes);
  return {
    path: penPath,
    absolutePath: `/tmp${penPath}`,
    buffer,
    isBinary: true,
    sha256: sha256Hex(buffer),
    textContent: null,
  };
}

function makeRemoteFile(partial: Partial<PenFile> & Pick<PenFile, 'id' | 'path'>): PenFile {
  const content = partial.content ?? '';
  return {
    id: partial.id,
    path: partial.path,
    name: partial.path.split('/').pop() ?? 'file',
    content_hash: partial.content_hash ?? sha256Hex(content ?? ''),
    is_binary: partial.is_binary ?? false,
    bytes: partial.bytes ?? Buffer.byteLength(content ?? '', 'utf8'),
    content_type: partial.content_type ?? 'text/plain',
    content: partial.is_binary ? null : content,
    url: partial.url ?? null,
    download_url: partial.download_url ?? null,
  };
}

describe('sync diff engine', () => {
  it('computes added, modified, deleted, and unchanged text files', async () => {
    const localFiles = new Map<string, LocalFile>([
      ['/index.html', makeLocalText('/index.html', '<h1>Updated</h1>')],
      ['/style.css', makeLocalText('/style.css', 'body { color: red; }')],
      ['/new.js', makeLocalText('/new.js', 'console.log("hi");')],
    ]);

    const remoteFiles: PenFile[] = [
      makeRemoteFile({ id: '1', path: '/index.html', content: '<h1>Old</h1>' }),
      makeRemoteFile({ id: '2', path: '/style.css', content: 'body { color: red; }' }),
      makeRemoteFile({ id: '3', path: '/removed.txt', content: 'bye' }),
    ];

    const diff = await computeSyncDiff({ localFiles, remoteFiles });
    assert.equal(hasDiffChanges(diff), true);
    assert.deepEqual(diff.added.map((i) => i.path), ['/new.js']);
    assert.deepEqual(diff.modified.map((i) => i.path), ['/index.html']);
    assert.deepEqual(diff.deleted.map((i) => i.path), ['/removed.txt']);
    assert.deepEqual(diff.unchanged.map((i) => i.path), ['/style.css']);
  });

  it('compares binary files using content_hash, baseline, size, and download fallback', async () => {
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]);
    const modifiedSameLength = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x09, 0x09]);

    const localUnchangedByBaseline = makeLocalBinary('/img/a.png', pngBytes);
    const localChangedSameLen = makeLocalBinary('/img/b.png', modifiedSameLength);

    const localFiles = new Map<string, LocalFile>([
      ['/img/a.png', localUnchangedByBaseline],
      ['/img/b.png', localChangedSameLen],
    ]);

    const remoteFiles: PenFile[] = [
      makeRemoteFile({
        id: 'b1',
        path: '/img/a.png',
        is_binary: true,
        content_hash: 'custom-remote-hash-a',
        bytes: pngBytes.length,
        download_url: 'https://api.codepen.io/v2/pens/p1/download/img/a.png?sig=1',
      }),
      makeRemoteFile({
        id: 'b2',
        path: '/img/b.png',
        is_binary: true,
        content_hash: 'custom-remote-hash-b',
        bytes: pngBytes.length,
        download_url: 'https://api.codepen.io/v2/pens/p1/download/img/b.png?sig=2',
      }),
    ];

    const baseline: Record<string, SyncedFileEntry> = {
      '/img/a.png': {
        id: 'b1',
        content_hash: 'custom-remote-hash-a',
        local_sha256: localUnchangedByBaseline.sha256,
        is_binary: true,
      },
    };

    const downloadedUrls: string[] = [];
    const diff = await computeSyncDiff({
      localFiles,
      remoteFiles,
      baseline,
      downloadFile: async (url) => {
        downloadedUrls.push(url);
        return Buffer.from(pngBytes);
      },
    });

    // a.png matched via baseline without needing download; b.png fell back to download & saw mismatch
    assert.deepEqual(downloadedUrls, ['https://api.codepen.io/v2/pens/p1/download/img/b.png?sig=2']);
    assert.deepEqual(diff.unchanged.map((i) => i.path), ['/img/a.png']);
    assert.deepEqual(diff.modified.map((i) => i.path), ['/img/b.png']);
  });

  it('detects dirty local files against baseline', () => {
    const idx = makeLocalText('/index.html', '<h1>Edited</h1>');
    const added = makeLocalText('/extra.css', 'a{}');
    const localFiles = new Map<string, LocalFile>([
      ['/index.html', idx],
      ['/extra.css', added],
    ]);

    const baseline: Record<string, SyncedFileEntry> = {
      '/index.html': { id: '1', content_hash: 'h1', local_sha256: sha256Hex('<h1>Original</h1>'), is_binary: false },
      '/gone.js': { id: '2', content_hash: 'h2', local_sha256: sha256Hex('1'), is_binary: false },
    };

    const dirty = detectLocalChangesFromBaseline(localFiles, baseline);
    assert.deepEqual(dirty, {
      added: ['/extra.css'],
      modified: ['/index.html'],
      deleted: ['/gone.js'],
    });
  });
});
