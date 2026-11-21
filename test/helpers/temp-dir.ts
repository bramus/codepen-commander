import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export async function createTempDir(prefix = 'cdpn-test-'): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function withTempDir<T>(
  fn: (dir: string) => Promise<T>,
  prefix = 'cdpn-test-',
): Promise<T> {
  const dir = await createTempDir(prefix);
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
