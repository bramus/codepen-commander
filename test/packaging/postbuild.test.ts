import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';
import { validateBrowserUrl } from '../../src/utils/browser.js';

const execFileAsync = promisify(execFile);

describe('dist subfolder packaging & CLI smoke tests', () => {
  const rootDir = path.resolve(process.cwd());
  const distDir = path.join(rootDir, 'dist');

  it('prepares a clean publishable ./dist folder with rewritten package.json', async () => {
    const distPkgRaw = await fs.readFile(path.join(distDir, 'package.json'), 'utf8');
    const distPkg = JSON.parse(distPkgRaw) as Record<string, unknown>;

    assert.equal(distPkg.name, 'codepen-commander');
    assert.equal('main' in distPkg, false);
    assert.equal('types' in distPkg, false);
    assert.equal('exports' in distPkg, false);
    assert.deepEqual(distPkg.bin, { cdpn: 'cli.js' });
    assert.equal('scripts' in distPkg, false);
    assert.equal('devDependencies' in distPkg, false);
    assert.equal(distPkgRaw.includes('./dist/'), false);

    // Essential files copied into ./dist
    assert.ok((await fs.stat(path.join(distDir, 'README.md'))).isFile());
    assert.ok((await fs.stat(path.join(distDir, 'LICENSE'))).isFile());

    const cliStat = await fs.stat(path.join(distDir, 'cli.js'));
    assert.ok(cliStat.isFile());
    if (process.platform !== 'win32') {
      assert.ok((cliStat.mode & 0o111) !== 0, 'dist/cli.js should be executable');
    }

    // Verify ./dist stays lightweight: only compiled .js files + package.json, README.md, LICENSE
    async function walkDist(dir: string): Promise<string[]> {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const files: string[] = [];
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          files.push(...(await walkDist(full)));
        } else {
          files.push(path.relative(distDir, full));
        }
      }
      return files;
    }
    const distFiles = await walkDist(distDir);
    assert.deepEqual(
      distFiles.filter((f) => f.endsWith('.map')),
      [],
      'dist/ should not contain .map files',
    );
    assert.deepEqual(
      distFiles.filter((f) => f.endsWith('.ts')),
      [],
      'dist/ should not contain .ts or .d.ts files',
    );
    const allowedNonJs = new Set([
      'package.json',
      'README.md',
      'LICENSE',
      path.join('shell', 'index.html'),
      path.join('shell', 'styles.css'),
    ]);
    assert.ok((await fs.stat(path.join(distDir, 'shell', 'index.html'))).isFile());
    assert.ok((await fs.stat(path.join(distDir, 'shell', 'styles.css'))).isFile());
    assert.ok((await fs.stat(path.join(distDir, 'shell', 'scripts.js'))).isFile());
    assert.deepEqual(
      distFiles.filter((f) => !f.endsWith('.js') && !allowedNonJs.has(f)),
      [],
      'dist/ should only contain .js files plus package.json, README.md, LICENSE, and shell/ assets',
    );

    // Verify npm packaging from ./dist succeeds cleanly and produces no bin auto-correction warnings
    const { stderr } = await execFileAsync('npm', ['pack', '--dry-run'], { cwd: distDir });
    assert.equal(stderr.includes('auto-corrected'), false, `Unexpected npm pack warning: ${stderr}`);
    assert.equal(stderr.includes('was invalid and removed'), false, `npm removed bin entry: ${stderr}`);
  });

  it('executes compiled dist/cli.js --help with all registered commands and global --profile flag', async () => {
    const { stdout } = await execFileAsync(process.execPath, [path.join(distDir, 'cli.js'), '--help']);
    assert.ok(stdout.includes('--profile'), 'Expected CLI help to list global --profile option');
    for (const cmd of [
      'auth',
      'clone',
      'fork',
      'pull',
      'status',
      'push',
      'sync',
      'deploy',
      'undeploy',
      'domains',
      'init',
      'new',
      'privacy',
      'delete',
      'restore',
      'unlink',
      'open',
      'list',
      'versions',
      'rollback',
      'info',
      'settings',
      'serve',
      'build',
      'shell',
    ]) {
      assert.ok(stdout.includes(cmd), `Expected CLI help to list command "${cmd}"`);
    }

    const { stdout: newHelp } = await execFileAsync(process.execPath, [
      path.join(distDir, 'cli.js'),
      'new',
      '--help',
    ]);
    assert.ok(newHelp.includes('--title'));
    assert.ok(newHelp.includes('--description'));
    assert.ok(newHelp.includes('--tags'));
    assert.ok(newHelp.includes('--access'));
    assert.ok(newHelp.includes('--visibility'));
    assert.ok(newHelp.includes('--blocks'));
    assert.ok(newHelp.includes('--template'));
    assert.ok(newHelp.includes('--as-template'));
    assert.equal(newHelp.includes('--scaffold'), false);
    assert.equal(newHelp.includes('--files'), false);
    assert.equal(newHelp.includes('--from'), false);

    const { stdout: initHelp } = await execFileAsync(process.execPath, [
      path.join(distDir, 'cli.js'),
      'init',
      '--help',
    ]);
    for (const flag of [
      '--title',
      '--access',
      '--visibility',
      '--blocks',
      '--description',
      '--tags',
      '--template',
      '--as-template',
      '--force',
      '--yes',
      '--json',
    ]) {
      assert.ok(initHelp.includes(flag), `Expected init --help to include ${flag}`);
    }

    // Verify `cdpn serve`, `cdpn build`, and `cdpn shell` expose expected options & subcommands
    const { stdout: serveHelp } = await execFileAsync(process.execPath, [
      path.join(distDir, 'cli.js'),
      'serve',
      '--help',
    ]);
    assert.ok(serveHelp.includes('--port'));
    assert.ok(serveHelp.includes('--open'));
    assert.ok(serveHelp.includes('--shell'));
    assert.ok(serveHelp.includes('--title'));
    assert.ok(serveHelp.includes('--subtitle'));
    assert.ok(serveHelp.includes('--footer'));

    const { stdout: buildHelp } = await execFileAsync(process.execPath, [
      path.join(distDir, 'cli.js'),
      'build',
      '--help',
    ]);
    assert.ok(buildHelp.includes('--out'));
    assert.ok(buildHelp.includes('--yes'));
    assert.ok(buildHelp.includes('--force'));
    assert.ok(buildHelp.includes('--watch'));
    assert.ok(buildHelp.includes('--shell'));
    assert.ok(buildHelp.includes('--title'));
    assert.ok(buildHelp.includes('--json'));

    const { stdout: shellHelp } = await execFileAsync(process.execPath, [
      path.join(distDir, 'cli.js'),
      'shell',
      '--help',
    ]);
    for (const sub of ['show', 'export', 'set', 'reset']) {
      assert.ok(shellHelp.includes(sub), `Expected shell help to list subcommand "${sub}"`);
    }

    // `cdpn clone` without mandatory <url> must fail
    await assert.rejects(
      () => execFileAsync(process.execPath, [path.join(distDir, 'cli.js'), 'clone']),
      /missing required argument 'url'/i,
    );

    // `cdpn pull` takes no positional arguments (rejects passing a URL)
    await assert.rejects(
      () =>
        execFileAsync(process.execPath, [
          path.join(distDir, 'cli.js'),
          'pull',
          'https://codepen.io/username/pen/abcde',
        ]),
      /too many arguments/i,
    );

    // `cdpn delete` takes no positional arguments (rejects passing a URL) and supports `del` / `rm` aliases
    await assert.rejects(
      () =>
        execFileAsync(process.execPath, [
          path.join(distDir, 'cli.js'),
          'delete',
          'https://codepen.io/username/pen/abcde',
        ]),
      /too many arguments/i,
    );
    for (const alias of ['delete', 'del', 'rm']) {
      const { stdout: aliasHelp } = await execFileAsync(process.execPath, [
        path.join(distDir, 'cli.js'),
        alias,
        '--help',
      ]);
      assert.ok(aliasHelp.includes('Usage: cdpn delete'), `Expected "${alias}" to alias "delete"`);
      assert.ok(aliasHelp.includes('--cleanup'), `Expected "${alias} --help" to include --cleanup`);
      assert.ok(
        aliasHelp.includes('--full-cleanup'),
        `Expected "${alias} --help" to include --full-cleanup`,
      );
      assert.equal(
        aliasHelp.includes('--keep-info'),
        false,
        `Expected "${alias} --help" NOT to include --keep-info`,
      );
      assert.equal(
        aliasHelp.includes('--keep-config'),
        false,
        `Expected "${alias} --help" NOT to include --keep-config`,
      );
    }

    const { stdout: restoreHelp } = await execFileAsync(process.execPath, [
      path.join(distDir, 'cli.js'),
      'restore',
      '--help',
    ]);
    assert.ok(restoreHelp.includes('Usage: cdpn restore'));
    assert.ok(restoreHelp.includes('--json'));

    // `cdpn unlink` takes no positional arguments and exposes --yes and --json
    await assert.rejects(
      () =>
        execFileAsync(process.execPath, [
          path.join(distDir, 'cli.js'),
          'unlink',
          'https://codepen.io/username/pen/abcde',
        ]),
      /too many arguments/i,
    );
    const { stdout: unlinkHelp } = await execFileAsync(process.execPath, [
      path.join(distDir, 'cli.js'),
      'unlink',
      '--help',
    ]);
    assert.ok(unlinkHelp.includes('Usage: cdpn unlink'));
    assert.ok(unlinkHelp.includes('--yes'));
    assert.ok(unlinkHelp.includes('--json'));

    // `cdpn fork` without mandatory <url> must fail
    await assert.rejects(
      () => execFileAsync(process.execPath, [path.join(distDir, 'cli.js'), 'fork']),
      /missing required argument 'url'/i,
    );

    const { stdout: domainsHelp } = await execFileAsync(process.execPath, [
      path.join(distDir, 'cli.js'),
      'domains',
      '--help',
    ]);
    assert.ok(domainsHelp.includes('delete'), 'Expected domains help to list delete subcommand');
    assert.equal(domainsHelp.includes('remove'), false, 'Expected domains help not to list remove subcommand');
    for (const sub of ['delete', 'del', 'rm']) {
      const { stdout: subHelp } = await execFileAsync(process.execPath, [
        path.join(distDir, 'cli.js'),
        'domains',
        sub,
        '--help',
      ]);
      assert.ok(
        subHelp.includes('Usage: cdpn domains delete'),
        `Expected "domains ${sub}" to resolve to "domains delete"`,
      );
    }

    const { stdout: openHelp } = await execFileAsync(process.execPath, [
      path.join(distDir, 'cli.js'),
      'open',
      '--help',
    ]);
    assert.ok(openHelp.includes('--deploy'), 'Expected open help to include --deploy');
    assert.ok(openHelp.includes('--live'), 'Expected open help to include --live');
    assert.ok(openHelp.includes('--preview'), 'Expected open help to include --preview');

    const { stdout: authHelp } = await execFileAsync(process.execPath, [
      path.join(distDir, 'cli.js'),
      'auth',
      '--help',
    ]);
    for (const sub of ['status', 'list', 'default', 'login', 'logout']) {
      assert.ok(authHelp.includes(sub), `Expected auth help to list subcommand "${sub}"`);
    }
    assert.ok(authHelp.includes('~/.cdpn'), 'Expected auth help to reference ~/.cdpn');

    // Verify --json is exposed on all applicable commands (including parent `auth`) and excluded from interactive/server/browser-only commands
    const commandsWithJson: string[][] = [
      ['auth'],
      ['auth', 'status'],
      ['auth', 'list'],
      ['auth', 'default'],
      ['auth', 'logout'],
      ['clone'],
      ['fork'],
      ['init'],
      ['new'],
      ['pull'],
      ['status'],
      ['push'],
      ['sync'],
      ['deploy'],
      ['undeploy'],
      ['domains'],
      ['domains', 'list'],
      ['domains', 'add'],
      ['domains', 'delete'],
      ['privacy'],
      ['delete'],
      ['restore'],
      ['unlink'],
      ['list'],
      ['versions'],
      ['rollback'],
      ['info'],
      ['settings'],
      ['build'],
      ['shell'],
      ['shell', 'show'],
      ['shell', 'export'],
      ['shell', 'set'],
      ['shell', 'reset'],
    ];

    for (const args of commandsWithJson) {
      const { stdout: cmdHelp } = await execFileAsync(process.execPath, [
        path.join(distDir, 'cli.js'),
        ...args,
        '--help',
      ]);
      assert.ok(
        cmdHelp.includes('--json'),
        `Expected "cdpn ${args.join(' ')} --help" to include --json`,
      );
    }

    // Verify --visibility alias is exposed consistently alongside --access
    for (const cmd of ['init', 'new', 'push', 'sync', 'deploy', 'fork', 'info']) {
      const { stdout: cmdHelp } = await execFileAsync(process.execPath, [
        path.join(distDir, 'cli.js'),
        cmd,
        '--help',
      ]);
      assert.ok(cmdHelp.includes('--access'), `Expected "cdpn ${cmd} --help" to include --access`);
      assert.ok(
        cmdHelp.includes('--visibility'),
        `Expected "cdpn ${cmd} --help" to include --visibility`,
      );
    }

    // Verify --dry-run is exposed on all 5 tree-walking commands (push|pull|sync|delete|unlink)
    for (const cmd of ['push', 'pull', 'sync', 'delete', 'unlink']) {
      const { stdout: cmdHelp } = await execFileAsync(process.execPath, [
        path.join(distDir, 'cli.js'),
        cmd,
        '--help',
      ]);
      assert.ok(
        cmdHelp.includes('--dry-run'),
        `Expected "cdpn ${cmd} --help" to include --dry-run`,
      );
    }

    // `cdpn sync` rejects excess positional arguments
    await assert.rejects(
      () =>
        execFileAsync(process.execPath, [
          path.join(distDir, 'cli.js'),
          'sync',
          'https://codepen.io/username/pen/abcde',
        ]),
      /too many arguments/i,
    );

    const commandsWithoutJson: string[][] = [['open'], ['auth', 'login'], ['serve']];
    for (const args of commandsWithoutJson) {
      const { stdout: cmdHelp } = await execFileAsync(process.execPath, [
        path.join(distDir, 'cli.js'),
        ...args,
        '--help',
      ]);
      assert.equal(
        cmdHelp.includes('--json'),
        false,
        `Expected "cdpn ${args.join(' ')} --help" NOT to include --json`,
      );
    }
  });

  it('validates browser URLs strictly (HTTPS only by default, localhost HTTP only when opted in)', () => {
    assert.equal(
      validateBrowserUrl('https://codepen.io/settings/api'),
      'https://codepen.io/settings/api',
    );
    assert.throws(() => validateBrowserUrl('http://codepen.io/settings/api'), /non-HTTPS/i);
    assert.throws(() => validateBrowserUrl('http://127.0.0.1:3000'), /non-HTTPS/i);
    assert.equal(
      validateBrowserUrl('http://127.0.0.1:3000', { allowLocalhostHttp: true }),
      'http://127.0.0.1:3000/',
    );
    assert.throws(
      () => validateBrowserUrl('http://codepen.io/settings/api', { allowLocalhostHttp: true }),
      /non-HTTPS/i,
    );
    assert.throws(() => validateBrowserUrl('javascript:alert(1)'), /non-HTTPS/i);
    assert.throws(() => validateBrowserUrl('file:///etc/passwd'), /non-HTTPS/i);
    assert.throws(() => validateBrowserUrl('https://codepen.io/\nfoo'), /control characters/i);
  });
});
