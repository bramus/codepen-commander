import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { resolveCommandAuth } from '../src/commands/auth-context.js';
import {
  findMatchingProfile,
  getKeyType,
  getShellExportSnippets,
  isRecognizedKeyFormat,
  isValidProfileName,
  maskApiKey,
  parseAuthStoreContent,
  parseKeyFileContent,
  readAuthStore,
  removeApiKeyFile,
  removeProfileFromFile,
  resolveAuth,
  saveApiKeyToFile,
  saveProfileToFile,
  setDefaultProfile,
  validateProfileName,
} from '../src/config/auth.js';
import {
  PROJECT_CONFIG_FILENAME,
  readProjectConfig,
  writeProjectConfig,
  type ProjectLocation,
} from '../src/config/project.js';

describe('auth configuration (~/.cdpn & multi-profile)', () => {
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

  it('validates profile names and blocks prototype-pollution keys', () => {
    assert.equal(validateProfileName('bramus'), 'bramus');
    assert.equal(validateProfileName('username'), 'username');
    assert.equal(validateProfileName('acme.team_1'), 'acme.team_1');

    for (const bad of ['', '  ', '__proto__', 'constructor', 'prototype', '-leading', 'a/b', 'has space']) {
      assert.equal(isValidProfileName(bad), false, `Expected "${bad}" to be invalid`);
      assert.throws(() => validateProfileName(bad), /Invalid profile name/);
    }
  });

  it('parses ~/.cdpn in multi-profile JSON, flat JSON, single-key JSON, env, and raw formats', () => {
    const multi = parseAuthStoreContent(
      JSON.stringify({
        default: 'username',
        profiles: {
          bramus: 'cp_user_bramuskey12345',
          'username': 'cp_team_userkey98765',
        },
      }),
    );
    assert.equal(multi.defaultProfile, 'username');
    assert.equal(multi.profiles.bramus, 'cp_user_bramuskey12345');
    assert.equal(multi.profiles['username'], 'cp_team_userkey98765');

    const flat = parseAuthStoreContent(
      JSON.stringify({
        bramus: 'cp_user_bramuskey12345',
        'username': { api_key: 'cp_team_userkey98765' },
      }),
    );
    assert.equal(flat.profiles.bramus, 'cp_user_bramuskey12345');
    assert.equal(flat.profiles['username'], 'cp_team_userkey98765');

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

  it('stores multiple profiles in ~/.cdpn with 0600 permissions, manages default, and removes profiles cleanly', async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-auth-test-'));
    try {
      // Nothing set initially
      assert.equal(await resolveAuth({ env: {}, homeDir: tmpHome }), null);

      // Save first profile -> stored in ~/.cdpn and becomes default
      const first = await saveProfileToFile('bramus', 'cp_user_bramus12345678', { homeDir: tmpHome });
      assert.equal(first.filePath, path.join(tmpHome, '.cdpn'));
      assert.equal(first.profile, 'bramus');
      assert.equal(first.isDefault, true);

      if (process.platform !== 'win32') {
        const stat = await fs.stat(first.filePath);
        assert.equal(stat.mode & 0o777, 0o600);
      }

      // Add second profile -> preserves existing default unless setAsDefault is true
      const second = await saveProfileToFile('username', 'cp_team_user98765432', {
        homeDir: tmpHome,
      });
      assert.equal(second.profile, 'username');
      assert.equal(second.isDefault, false);

      // Resolve default profile
      const defAuth = await resolveAuth({ env: {}, homeDir: tmpHome });
      assert.ok(defAuth);
      assert.equal(defAuth.source, 'file');
      assert.equal(defAuth.profile, 'bramus');
      assert.equal(defAuth.apiKey, 'cp_user_bramus12345678');
      assert.deepEqual(defAuth.availableProfiles, ['bramus', 'username']);

      // Resolve named profile explicitly (overrides CODEPEN_API_KEY env var)
      const explicitAuth = await resolveAuth({
        env: { CODEPEN_API_KEY: 'cp_user_envkey98765432' },
        homeDir: tmpHome,
        profile: 'username',
      });
      assert.ok(explicitAuth);
      assert.equal(explicitAuth.source, 'file');
      assert.equal(explicitAuth.profile, 'username');
      assert.equal(explicitAuth.apiKey, 'cp_team_user98765432');

      // Env var wins when no explicit profile is specified
      const fromEnv = await resolveAuth({
        env: { CODEPEN_API_KEY: 'cp_user_envkey98765432' },
        homeDir: tmpHome,
      });
      assert.ok(fromEnv);
      assert.equal(fromEnv.source, 'env');
      assert.equal(fromEnv.profile, null);
      assert.equal(fromEnv.apiKey, 'cp_user_envkey98765432');

      // Change default profile
      await setDefaultProfile('username', { homeDir: tmpHome });
      const switched = await resolveAuth({ env: {}, homeDir: tmpHome });
      assert.equal(switched?.profile, 'username');

      // Detect insecure permissions on POSIX
      if (process.platform !== 'win32') {
        await fs.chmod(first.filePath, 0o644);
        const warned = await resolveAuth({ env: {}, homeDir: tmpHome });
        assert.equal(warned?.insecureFilePermissions, true);
      }

      // Remove default profile -> promotes remaining profile to default
      const rm1 = await removeProfileFromFile('username', { homeDir: tmpHome });
      assert.equal(rm1.removed, true);
      assert.deepEqual(rm1.remainingProfiles, ['bramus']);
      assert.equal(rm1.newDefault, 'bramus');

      // Remove last profile -> deletes ~/.cdpn
      const rm2 = await removeProfileFromFile('bramus', { homeDir: tmpHome });
      assert.equal(rm2.removed, true);
      assert.deepEqual(rm2.remainingProfiles, []);
      assert.equal((await readAuthStore({ homeDir: tmpHome })).exists, false);

      // saveApiKeyToFile backwards-compat helper writes to ~/.cdpn
      const compatPath = await saveApiKeyToFile('cp_user_compat12345678', { homeDir: tmpHome });
      assert.equal(compatPath, path.join(tmpHome, '.cdpn'));
      assert.equal(await removeApiKeyFile({ homeDir: tmpHome }), true);
      assert.equal(await removeApiKeyFile({ homeDir: tmpHome }), false);
    } finally {
      await fs.rm(tmpHome, { recursive: true, force: true });
    }
  });

  it('resolves command auth from .cdpn.json profile, prompts when unassociated, and persists choice', async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-cmd-auth-home-'));
    const tmpProj = await fs.mkdtemp(path.join(os.tmpdir(), 'cdpn-cmd-auth-proj-'));

    try {
      await saveProfileToFile('bramus', 'cp_user_bramus11111111', {
        homeDir: tmpHome,
        setAsDefault: true,
      });
      await saveProfileToFile('username', 'cp_team_user22222222', {
        homeDir: tmpHome,
      });

      // 1. Project already associated with username -> uses username without prompting
      let promptCalls = 0;
      const boundProject: ProjectLocation = {
        rootDir: tmpProj,
        configPath: path.join(tmpProj, PROJECT_CONFIG_FILENAME),
        config: {
          url: 'https://codepen.io/username/pen/abcde',
          pen_id: 'pen-1',
          profile: 'username',
          last_synced_version_id: 'v1',
        },
      };

      const boundAuth = await resolveCommandAuth({
        project: boundProject,
        env: {},
        homeDir: tmpHome,
        interactive: true,
        selectProfile: async () => {
          promptCalls++;
          return 'bramus';
        },
      });
      assert.equal(boundAuth.profile, 'username');
      assert.equal(boundAuth.apiKey, 'cp_team_user22222222');
      assert.equal(promptCalls, 0);

      // 2. Project NOT associated with a profile -> prompts interactively, pre-selects URL match,
      //    and persists the selected profile back to .cdpn.json
      await writeProjectConfig(tmpProj, {
        url: 'https://codepen.io/username/pen/xyz99',
        pen_id: 'pen-2',
        last_synced_version_id: 'v2',
      });
      const unassociatedProject: ProjectLocation = {
        rootDir: tmpProj,
        configPath: path.join(tmpProj, PROJECT_CONFIG_FILENAME),
        config: await readProjectConfig(tmpProj),
      };

      let observedDefaultIndex = -1;
      let observedLabels: string[] = [];
      let observedDescriptions: Array<string | undefined> = [];
      const promptedAuth = await resolveCommandAuth({
        project: unassociatedProject,
        env: {},
        homeDir: tmpHome,
        interactive: true,
        selectProfile: async (_question, opts, defaultIdx) => {
          promptCalls++;
          observedDefaultIndex = defaultIdx;
          observedLabels = opts.map((o) => o.value);
          observedDescriptions = opts.map((o) => o.description);
          return opts[defaultIdx]!.value;
        },
      });

      assert.equal(promptCalls, 1);
      assert.deepEqual(observedLabels, ['bramus', 'username']);
      assert.deepEqual(observedDescriptions, ['User · default', 'Team · matches URL']);
      for (const desc of observedDescriptions) {
        assert.equal(desc?.includes('cp_user_'), false, 'Account choice should not include API key');
        assert.equal(desc?.includes('cp_team_'), false, 'Account choice should not include API key');
        assert.equal(desc?.includes('••••'), false, 'Account choice should not include masked API key');
      }
      assert.equal(observedDefaultIndex, 1, 'Should pre-select username based on Pen URL');
      assert.equal(promptedAuth.profile, 'username');
      assert.equal(promptedAuth.apiKey, 'cp_team_user22222222');

      // Persisted into .cdpn.json!
      const persisted = await readProjectConfig(tmpProj);
      assert.equal(persisted.profile, 'username');

      // 3. Explicit --profile overrides project profile
      const overrideAuth = await resolveCommandAuth({
        explicitProfile: 'bramus',
        project: boundProject,
        env: {},
        homeDir: tmpHome,
        interactive: true,
      });
      assert.equal(overrideAuth.profile, 'bramus');
      assert.equal(overrideAuth.apiKey, 'cp_user_bramus11111111');

      // 4. Missing profile referenced by .cdpn.json throws a helpful error
      const missingProfileProject: ProjectLocation = {
        ...boundProject,
        config: { ...boundProject.config, profile: 'other-team' },
      };
      await assert.rejects(
        () =>
          resolveCommandAuth({
            project: missingProfileProject,
            env: {},
            homeDir: tmpHome,
            interactive: false,
          }),
        /Profile "other-team".*not found/,
      );

      // 5. CODEPEN_API_KEY env var works in CI even when .cdpn.json names a profile
      const ciAuth = await resolveCommandAuth({
        project: missingProfileProject,
        env: { CODEPEN_API_KEY: 'cp_team_ci_override1234' },
        homeDir: path.join(tmpHome, 'nonexistent-home'),
        interactive: false,
      });
      assert.equal(ciAuth.source, 'env');
      assert.equal(ciAuth.apiKey, 'cp_team_ci_override1234');
    } finally {
      await fs.rm(tmpHome, { recursive: true, force: true });
      await fs.rm(tmpProj, { recursive: true, force: true });
    }
  });

  it('matches CodePen URL owners to stored profiles case-insensitively', () => {
    const profiles = ['bramus', 'username'];
    assert.equal(findMatchingProfile(profiles, 'https://codepen.io/bramus/pen/abcde'), 'bramus');
    assert.equal(
      findMatchingProfile(
        profiles,
        'https://codepen.io/editor/bramus/pen/01a11c78-9eba-777b-98a7-fa51e8b7cb08',
      ),
      'bramus',
    );
    assert.equal(
      findMatchingProfile(
        profiles,
        'https://codepen.io/editor/team/USERNAME/pen/01a11c78-9eba-777b-98a7-fa51e8b7cb08',
      ),
      'username',
    );
    assert.equal(findMatchingProfile(profiles, 'https://codepen.io/USERNAME/editor/abcde'), 'username');
    assert.equal(findMatchingProfile(profiles, 'https://codepen.io/team/username/pen/abcde'), 'username');
    assert.equal(findMatchingProfile(profiles, 'https://codepen.io/someone-else/pen/abcde'), null);
    assert.equal(findMatchingProfile(profiles, 'https://89bb1234.codepen.dev/'), null);
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
