import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';
import { validateBrowserUrl } from '../src/utils/browser.js';

const execFileAsync = promisify(execFile);

describe('dist subfolder packaging & CLI smoke tests', () => {
  const rootDir = path.resolve(process.cwd());
  const distDir = path.join(rootDir, 'dist');

  it('prepares a clean publishable ./dist folder with rewritten package.json', async () => {
    const distPkgRaw = await fs.readFile(path.join(distDir, 'package.json'), 'utf8');
    const distPkg = JSON.parse(distPkgRaw) as Record<string, unknown>;

    assert.equal(distPkg.name, 'cdpn');
    assert.equal(distPkg.main, './index.js');
    assert.equal(distPkg.types, './index.d.ts');
    assert.deepEqual(distPkg.bin, { cdpn: 'cli.js' });
    assert.equal('scripts' in distPkg, false);
    assert.equal('devDependencies' in distPkg, false);
    assert.equal(distPkgRaw.includes('./dist/'), false);

    // Essential files copied into ./dist
    assert.ok((await fs.stat(path.join(distDir, 'README.md'))).isFile());
    assert.ok((await fs.stat(path.join(distDir, 'LICENSE'))).isFile());
    assert.ok((await fs.stat(path.join(distDir, 'index.js'))).isFile());
    assert.ok((await fs.stat(path.join(distDir, 'index.d.ts'))).isFile());

    const cliStat = await fs.stat(path.join(distDir, 'cli.js'));
    assert.ok(cliStat.isFile());
    if (process.platform !== 'win32') {
      assert.ok((cliStat.mode & 0o111) !== 0, 'dist/cli.js should be executable');
    }

    // Verify npm publish from ./dist produces no bin auto-correction warnings
    const { stderr } = await execFileAsync('npm', ['publish', '--dry-run'], { cwd: distDir });
    assert.equal(stderr.includes('auto-corrected'), false, `Unexpected npm publish warning: ${stderr}`);
    assert.equal(stderr.includes('was invalid and removed'), false, `npm removed bin entry: ${stderr}`);
  });

  it('executes compiled dist/cli.js --help with all registered commands', async () => {
    const { stdout } = await execFileAsync(process.execPath, [path.join(distDir, 'cli.js'), '--help']);
    for (const cmd of [
      'auth',
      'pull',
      'status',
      'push',
      'deploy',
      'undeploy',
      'domains',
      'new',
      'open',
      'list',
      'versions',
      'rollback',
      'info',
      'settings',
    ]) {
      assert.ok(stdout.includes(cmd), `Expected CLI help to list command "${cmd}"`);
    }
  });

  it('validates browser URLs strictly (HTTPS only, no control chars)', () => {
    assert.equal(
      validateBrowserUrl('https://codepen.io/settings/api'),
      'https://codepen.io/settings/api',
    );
    assert.throws(() => validateBrowserUrl('http://codepen.io/settings/api'), /non-HTTPS/i);
    assert.throws(() => validateBrowserUrl('javascript:alert(1)'), /non-HTTPS/i);
    assert.throws(() => validateBrowserUrl('file:///etc/passwd'), /non-HTTPS/i);
    assert.throws(() => validateBrowserUrl('https://codepen.io/\nfoo'), /control characters/i);
  });
});
