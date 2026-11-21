import type { Command } from 'commander';
import { CodePenClient } from '../api/client.js';
import type { Pen, PenAccess, PenUpdateRequest } from '../api/types.js';
import type { ResolvedAuth } from '../config/auth.js';
import { requireProjectInDir, writeProjectConfig } from '../config/project.js';
import { MIN_PROTECTED_PASSWORD_LENGTH, PEN_ACCESS_CHOICES } from '../constants.js';
import { CliError } from '../errors.js';
import { mergeUpdatedPenInfoIntoConfig } from '../sync/info.js';
import { normalizeAccess } from '../utils/cli-options.js';
import { fmt } from '../utils/format.js';
import { printJsonResponse } from '../utils/json.js';
import { defaultOutput, type CommandOutput } from '../utils/output.js';
import {
  isInteractive,
  promptConfirm,
  promptSecret,
  promptSelect,
  type SelectOption,
} from '../utils/prompts/index.js';
import { getGlobalProfileOption, resolveCommandAuth } from '../workflows/auth-context.js';
import { fetchLinkedPenOrHandleMissing } from '../workflows/missing-pen.js';

export interface PrivacyCliOptions {
  password?: string;
  show?: boolean;
  json?: boolean;
}

export interface RunPrivacyCommandOptions {
  /** Optional target privacy level (`Public`, `Private`, `Protected`, `Collaborators`). */
  levelArg?: string;
  /** Optional password for `Protected` Pens (min 8 chars). */
  password?: string;
  /** Only display current privacy without prompting to change it. */
  show?: boolean;
  /** Output JSON instead of formatted terminal text. */
  json?: boolean;
  /** Working directory (must contain `.cdpn.json` directly; defaults to `process.cwd()`). */
  cwd?: string;
  /** Explicit `--profile <name>` flag value. */
  explicitProfile?: string;
  /** Injectable output sink (defaults to stdout/stderr). */
  output?: CommandOutput;
  /** Injectable API base URL (for testing). */
  baseUrl?: string;
  /** Injectable interactivity flag (for testing). */
  interactive?: boolean;
  /** Injectable env map (for testing). */
  env?: NodeJS.ProcessEnv;
  /** Injectable home dir (for testing). */
  homeDir?: string;
  /** Injectable prompts (for testing). */
  prompts?: {
    select?: <T extends string>(
      question: string,
      options: SelectOption<T>[],
      defaultIndex?: number,
    ) => Promise<T>;
    secret?: (question: string) => Promise<string>;
    confirm?: (question: string, defaultYes?: boolean) => Promise<boolean>;
  };
}

export interface PrivacyCommandResult {
  pen: Pen;
  previousAccess: PenAccess;
  access: PenAccess;
  updated: boolean;
  passwordUpdated: boolean;
  auth: ResolvedAuth;
}

async function promptForProtectedPassword(
  secretImpl: (question: string) => Promise<string>,
  promptLabel: string,
  output: CommandOutput,
): Promise<string> {
  for (;;) {
    const pw = await secretImpl(promptLabel);
    if (pw.length >= MIN_PROTECTED_PASSWORD_LENGTH) return pw;
    output.log(
      fmt.yellow(`Password must be at least ${MIN_PROTECTED_PASSWORD_LENGTH} characters.`),
    );
  }
}

/**
 * Inspects or updates the privacy/access permissions of the Pen linked by `.cdpn.json`
 * directly inside `options.cwd` (does not walk up to parent folders).
 */
export async function runPrivacyCommand(
  options: RunPrivacyCommandOptions = {},
): Promise<PrivacyCommandResult | null> {
  const output = options.output ?? defaultOutput;
  const cwd = options.cwd ?? process.cwd();
  const interactive = (options.interactive ?? isInteractive()) && !options.json;
  const selectImpl = options.prompts?.select ?? promptSelect;
  const secretImpl = options.prompts?.secret ?? promptSecret;
  const confirmImpl = options.prompts?.confirm ?? promptConfirm;

  // Strictly requires `.cdpn.json` in the current folder
  const project = await requireProjectInDir(cwd);

  const requestedAccess = normalizeAccess(options.levelArg);
  if (options.password !== undefined) {
    if (options.password.length < MIN_PROTECTED_PASSWORD_LENGTH) {
      throw new CliError(
        400,
        `Password must be at least ${MIN_PROTECTED_PASSWORD_LENGTH} characters.`,
      );
    }
    if (requestedAccess && requestedAccess !== 'Protected') {
      throw new CliError(400, '--password can only be used with Protected privacy.');
    }
  }

  if (options.show && (requestedAccess || options.password !== undefined)) {
    throw new CliError(400, 'Cannot combine --show with a privacy level or --password.');
  }

  const auth = await resolveCommandAuth({
    explicitProfile: options.explicitProfile,
    project,
    interactive,
    persistProfileToProject: !options.json,
    output,
    env: options.env,
    homeDir: options.homeDir,
    selectProfile: selectImpl,
  });
  const client = new CodePenClient({ apiKey: auth.apiKey, baseUrl: options.baseUrl });

  const penLookup = await fetchLinkedPenOrHandleMissing({
    client,
    project,
    auth,
    commandName: 'privacy',
    interactive,
    json: options.json,
    output,
    prompts: {
      select: selectImpl,
      confirm: confirmImpl,
    },
  });
  if (!penLookup.found) {
    return null;
  }

  const currentPen = penLookup.pen;
  const previousAccess = currentPen.access;

  // Read-only mode: `--show`, or no level/password in non-interactive / `--json` mode
  if (options.show || (!requestedAccess && options.password === undefined && !interactive)) {
    if (options.json) {
      printJsonResponse(
        200,
        `Pen privacy is ${currentPen.access}.`,
        {
          pen_id: currentPen.id,
          title: currentPen.title,
          access: currentPen.access,
          editor: currentPen.editor,
          profile: auth.profile ?? project.config.profile ?? null,
          updated: false,
        },
        output,
      );
    } else {
      output.log(`${fmt.bold(currentPen.title || 'Untitled')} ${fmt.dim(`(${currentPen.id})`)}`);
      if (auth.profile) {
        output.log(`  Profile: ${fmt.cyan(auth.profile)}`);
      }
      output.log(`  Privacy: ${fmt.cyan(currentPen.access)}`);
    }

    return {
      pen: currentPen,
      previousAccess,
      access: currentPen.access,
      updated: false,
      passwordUpdated: false,
      auth,
    };
  }

  // Determine target access and password
  let targetAccess: PenAccess;
  let password = options.password;

  if (requestedAccess) {
    targetAccess = requestedAccess;
  } else if (options.password !== undefined) {
    if (previousAccess !== 'Protected') {
      throw new CliError(
        400,
        `This Pen is currently ${previousAccess}. To set a password and make it Protected, run \`cdpn privacy protected --password <password>\`.`,
      );
    }
    targetAccess = 'Protected';
  } else {
    // Interactive picker with current privacy pre-selected
    output.log(
      `Current privacy for ${fmt.bold(currentPen.title || 'Untitled')} ${fmt.dim(`(${currentPen.id})`)}: ${fmt.cyan(previousAccess)}\n`,
    );
    const defaultIndex = Math.max(
      0,
      PEN_ACCESS_CHOICES.findIndex((c) => c.value === previousAccess),
    );
    const selectOptions: SelectOption<PenAccess>[] = PEN_ACCESS_CHOICES.map((choice) => ({
      value: choice.value,
      label: choice.label,
      description:
        choice.value === previousAccess ? `${choice.description} (current)` : choice.description,
    }));

    targetAccess = await selectImpl<PenAccess>('Set Pen privacy:', selectOptions, defaultIndex);
  }

  const patch: PenUpdateRequest = {};
  let passwordUpdated = false;

  if (targetAccess === 'Protected') {
    if (previousAccess === 'Protected') {
      // Already Protected: rotate password if explicitly requested, or confirm in picker flow
      if (!password) {
        if (!interactive) {
          throw new CliError(
            400,
            'This Pen is already Protected. Pass --password <new-password> (min 8 chars) to replace its password.',
          );
        }
        if (!requestedAccess) {
          const rotate = await confirmImpl(
            'Pen is already Protected. Replace its password?',
            false,
          );
          if (!rotate) {
            output.log(`Privacy unchanged (${fmt.cyan('Protected')}).`);
            return {
              pen: currentPen,
              previousAccess,
              access: previousAccess,
              updated: false,
              passwordUpdated: false,
              auth,
            };
          }
        }
        password = await promptForProtectedPassword(
          secretImpl,
          `New password for Protected Pen (min ${MIN_PROTECTED_PASSWORD_LENGTH} characters)`,
          output,
        );
      }
      patch.password = password;
      passwordUpdated = true;
    } else {
      // Changing to Protected -> password is required by CodePen API
      if (!password) {
        if (!interactive) {
          throw new CliError(
            400,
            `Changing privacy to Protected requires --password with at least ${MIN_PROTECTED_PASSWORD_LENGTH} characters.`,
          );
        }
        password = await promptForProtectedPassword(
          secretImpl,
          `Password for Protected Pen (min ${MIN_PROTECTED_PASSWORD_LENGTH} characters)`,
          output,
        );
      }
      patch.access = 'Protected';
      patch.password = password;
      passwordUpdated = true;
    }
  } else if (targetAccess !== previousAccess) {
    patch.access = targetAccess;
  }

  // No-op when privacy did not change
  if (Object.keys(patch).length === 0) {
    if (options.json) {
      printJsonResponse(
        200,
        `Privacy is already ${currentPen.access} — no changes made.`,
        {
          pen_id: currentPen.id,
          title: currentPen.title,
          previous_access: previousAccess,
          access: currentPen.access,
          editor: currentPen.editor,
          profile: auth.profile ?? project.config.profile ?? null,
          password_updated: false,
          updated: false,
        },
        output,
      );
    } else {
      output.log(`Privacy is already ${fmt.cyan(currentPen.access)} — no changes made.`);
    }

    return {
      pen: currentPen,
      previousAccess,
      access: currentPen.access,
      updated: false,
      passwordUpdated: false,
      auth,
    };
  }

  const updatedPen = await client.updatePen(project.config.pen_id, patch);
  const nextConfig = mergeUpdatedPenInfoIntoConfig(project.config, updatedPen, patch);
  await writeProjectConfig(project.rootDir, nextConfig);
  project.config = nextConfig;

  if (options.json) {
    const message =
      previousAccess === updatedPen.access && passwordUpdated
        ? 'Updated password for Protected Pen.'
        : `Updated privacy from ${previousAccess} to ${updatedPen.access}.`;
    printJsonResponse(
      200,
      message,
      {
        pen_id: updatedPen.id,
        title: updatedPen.title,
        previous_access: previousAccess,
        access: updatedPen.access,
        editor: updatedPen.editor,
        profile: auth.profile ?? project.config.profile ?? null,
        password_updated: passwordUpdated,
        updated: true,
        url: updatedPen.urls.editor,
      },
      output,
    );
  } else if (previousAccess === updatedPen.access && passwordUpdated) {
    output.log(
      `\n${fmt.green('✓')} Updated password for Protected Pen ${fmt.bold(updatedPen.title || 'Untitled')} ${fmt.dim(`(${updatedPen.id})`)}`,
    );
  } else {
    output.log(
      `\n${fmt.green('✓')} Updated privacy for ${fmt.bold(updatedPen.title || 'Untitled')} ${fmt.dim(`(${updatedPen.id})`)}: ${fmt.dim(previousAccess)} → ${fmt.cyan(updatedPen.access)}`,
    );
  }

  if (!options.json) {
    if (auth.profile) {
      output.log(`  Profile: ${fmt.cyan(auth.profile)}`);
    }
    output.log(`  Editor:  ${fmt.cyan(updatedPen.urls.editor)}`);
  }

  return {
    pen: updatedPen,
    previousAccess,
    access: updatedPen.access,
    updated: true,
    passwordUpdated,
    auth,
  };
}

export function registerPrivacyCommand(program: Command): void {
  program
    .command('privacy [level]')
    .alias('access')
    .description(
      'View or update a Pen’s privacy permissions (Public, Private, Protected, Collaborators; requires .cdpn.json in current folder)',
    )
    .option(
      '--password <password>',
      'Password for Protected privacy (min 8 chars; replaces password if already Protected)',
    )
    .option('--show', 'Show the current privacy level without prompting')
    .option('--json', 'Output privacy status/result as JSON')
    .action(async (levelArg: string | undefined, options: PrivacyCliOptions, command: Command) => {
      await runPrivacyCommand({
        levelArg,
        password: options.password,
        show: options.show,
        json: options.json,
        explicitProfile: getGlobalProfileOption(command),
      });
    });
}
