import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  getKeyType,
  getShellExportSnippets,
  isRecognizedKeyFormat,
  maskApiKey,
  parseKeyFileContent,
  removeApiKeyFile,
  resolveAuth,
  saveApiKeyToFile,
} from '../src/config/auth.js';

describe('auth configuration', () => {
  it('masks API keys without leaking middle characters', () => {
    assert.equal(maskApiKey('cp_user_1234567890abcdef'), 'cp_user_••••••••cdef');
    assert.equal(maskApiKey('cp_team_abcdef9876543210'), 'cp_team_••••••••3210');
    assert.equal(maskApiKey('short'), '********');
  });

  it('identifies key types and formats', () => {
    assert.equal(getKeyType('cp_user_1234567890'), 'User');
    assert.equal(getKeyType('cp_team_1234567890'), 'Team');
    assert.equal(getKeyType('other_key'), 'Unknown');
    assert.equal(isRecognizedKeyFormat('cp_user_1234567890abcdef'), true);
    assert.equal(isRecognizedKeyFormat('cp_user_short'), false);
    assert.equal(isRecognizedKeyFormat('random_1234567890abcdef'), false);
  });

  it('parses ~/.codepen in raw, env, and JSON formats', () => {
    assert.equal(parseKeyFileContent('cp_user_rawkey123456\n'), 'cp_user_rawkey123456');
    assert.equal(
      parseKeyFileContent('# comment\nCODEPEN_API_KEY="cp_user_envkey123456"\n'),
      'cp_user_envkey123456',
    );
    assert.equal(
      parseKeyFileContent("export CODEPEN_API_KEY='cp_team_exported1234'"),
      'cp_team_exported1234',
    );
    assert.equal(
      parseKeyFileContent('{"api_key":"cp_user_jsonkey12345"}'),
      'cp_user_jsonkey12345',
    );
    assert.equal(parseKeyFileContent('   \n  '), null);
  });

  it('resolves env var before ~/.codepen and enforces 0600 permissions on save', async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-auth-test-'));
    try {
      // Nothing set initially
      assert.equal(await resolveAuth({ env: {}, homeDir: tmpHome }), null);

      // Save to ~/.codepen
      const savedPath = await saveApiKeyToFile('cp_user_filekey12345678', { homeDir: tmpHome });
      assert.equal(savedPath, path.join(tmpHome, '.codepen'));

      if (process.platform !== 'win32') {
        const stat = await fs.stat(savedPath);
        assert.equal(stat.mode & 0o777, 0o600);
      }

      // Resolves from file when env is absent
      const fromFile = await resolveAuth({ env: {}, homeDir: tmpHome });
      assert.ok(fromFile);
      assert.equal(fromFile.source, 'file');
      assert.equal(fromFile.apiKey, 'cp_user_filekey12345678');
      assert.equal(fromFile.insecureFilePermissions, false);

      // Env var takes precedence over file
      const fromEnv = await resolveAuth({
        env: { CODEPEN_API_KEY: 'cp_user_envkey98765432' },
        homeDir: tmpHome,
      });
      assert.ok(fromEnv);
      assert.equal(fromEnv.source, 'env');
      assert.equal(fromEnv.apiKey, 'cp_user_envkey98765432');
      assert.equal(fromEnv.hasEnv, true);
      assert.equal(fromEnv.hasFile, true);

      // Detects insecure file permissions on POSIX
      if (process.platform !== 'win32') {
        await fs.chmod(savedPath, 0o644);
        const warned = await resolveAuth({ env: {}, homeDir: tmpHome });
        assert.equal(warned?.insecureFilePermissions, true);
      }

      // Removes file cleanly
      assert.equal(await removeApiKeyFile({ homeDir: tmpHome }), true);
      assert.equal(await removeApiKeyFile({ homeDir: tmpHome }), false);
    } finally {
      await fs.rm(tmpHome, { recursive: true, force: true });
    }
  });

  it('orders shell export snippets with active shell first', () => {
    const zshFirst = getShellExportSnippets('cp_user_test12345678', '/bin/zsh');
    assert.equal(zshFirst[0]?.shell, 'zsh');
    assert.equal(zshFirst[0]?.rcFile, '~/.zshrc');
    assert.ok(zshFirst[0]?.line.includes('CODEPEN_API_KEY='));

    const fishFirst = getShellExportSnippets('cp_user_test12345678', '/usr/local/bin/fish');
    assert.equal(fishFirst[0]?.shell, 'fish');
    assert.ok(fishFirst[0]?.line.startsWith('set -gx CODEPEN_API_KEY'));
  });
});
