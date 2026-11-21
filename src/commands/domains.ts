import type { Command } from 'commander';
import { CodePenClient } from '../api/client.js';
import type { Pen, PenDomain } from '../api/types.js';
import type { ResolvedAuth } from '../config/auth.js';
import { type ProjectLocation, requireProject } from '../config/project.js';
import { CliError } from '../errors.js';
import { resolveInheritedJsonOption } from '../utils/cli-options.js';
import { fmt, formatTable } from '../utils/format.js';
import { printJsonResponse } from '../utils/json.js';
import { defaultOutput, type CommandOutput } from '../utils/output.js';
import { isInteractive, promptConfirm } from '../utils/prompts/index.js';
import { getGlobalProfileOption, resolveCommandAuth } from '../workflows/auth-context.js';
import {
  fetchLinkedPenOrHandleMissing,
  type MissingPenPrompts,
} from '../workflows/missing-pen.js';

export interface DomainsBaseOptions {
  json?: boolean;
  cwd?: string;
  explicitProfile?: string;
  baseUrl?: string;
  interactive?: boolean;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  output?: CommandOutput;
  prompts?: MissingPenPrompts;
}

export interface RunDomainsDeleteOptions extends DomainsBaseOptions {
  yes?: boolean;
  confirm?: (question: string, defaultYes?: boolean) => Promise<boolean>;
}

export interface DomainsCommandResult {
  defaultUrl: string | null;
  domains: PenDomain[];
  pen: Pen;
  project: ProjectLocation;
  auth: ResolvedAuth;
}

export function renderDomains(
  domains: PenDomain[],
  defaultUrl: string | null,
  output: CommandOutput = defaultOutput,
): void {
  if (defaultUrl) {
    output.log(`Default URL: ${fmt.cyan(defaultUrl)}`);
  } else {
    output.log(`Default URL: ${fmt.dim('not deployed (run `cdpn deploy` to deploy)')}`);
  }

  output.log('');

  if (domains.length === 0) {
    output.log(fmt.dim('No custom domains configured for this Pen.'));
    output.log(fmt.dim('Add one with: cdpn domains add <host>'));
    return;
  }

  const rows = domains.map((d) => {
    const status =
      d.status === 'Verified'
        ? fmt.green(d.status)
        : d.status === 'Misconfigured'
          ? fmt.red(d.status)
          : fmt.yellow(d.status);

    return [fmt.cyan(d.host), status, d.cname_record, d.a_record];
  });

  output.log(formatTable(['Host', 'Status', 'CNAME', 'A Record'], rows));

  const needingDns = domains.filter((d) => d.status !== 'Verified' && d.dns.length > 0);
  if (needingDns.length > 0) {
    output.log('\nRequired DNS records:');
    for (const domain of needingDns) {
      output.log(`  ${fmt.bold(domain.host)}:`);
      for (const rec of domain.dns) {
        output.log(`    ${fmt.cyan(rec.type.padEnd(6))} ${rec.name}  →  ${fmt.bold(rec.value)}`);
      }
    }
  }
}

export async function runDomainsListCommand(
  options: DomainsBaseOptions = {},
): Promise<DomainsCommandResult | null> {
  const output = options.output ?? defaultOutput;
  const cwd = options.cwd ?? process.cwd();
  const interactive = (options.interactive ?? isInteractive()) && !options.json;

  const project = await requireProject(cwd);
  const auth = await resolveCommandAuth({
    explicitProfile: options.explicitProfile,
    project,
    interactive,
    persistProfileToProject: !options.json,
    output,
    env: options.env,
    homeDir: options.homeDir,
  });
  const client = new CodePenClient({ apiKey: auth.apiKey, baseUrl: options.baseUrl });

  const penLookup = await fetchLinkedPenOrHandleMissing({
    client,
    project,
    auth,
    commandName: 'domains',
    interactive,
    json: options.json,
    output,
    prompts: options.prompts,
  });
  if (!penLookup.found) {
    return null;
  }

  const pen = penLookup.pen;
  const domains = await client.listDomains(project.config.pen_id);
  const defaultUrl = pen.deployment?.url ?? null;

  if (options.json) {
    const message =
      domains.length === 0
        ? 'No custom domains configured for this Pen.'
        : `Found ${domains.length} custom domain(s).`;
    printJsonResponse(
      200,
      message,
      {
        default_url: defaultUrl,
        domains,
      },
      output,
    );
  } else {
    renderDomains(domains, defaultUrl, output);
  }

  return { defaultUrl, domains, pen, project, auth };
}

export async function runDomainsAddCommand(
  host: string,
  options: DomainsBaseOptions = {},
): Promise<DomainsCommandResult | null> {
  const output = options.output ?? defaultOutput;
  const cleanHost = host.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  if (!cleanHost || !/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(cleanHost)) {
    throw new CliError(
      400,
      `Invalid domain host: "${host}". Provide a hostname like www.example.com.`,
    );
  }

  const cwd = options.cwd ?? process.cwd();
  const interactive = (options.interactive ?? isInteractive()) && !options.json;

  const project = await requireProject(cwd);
  const auth = await resolveCommandAuth({
    explicitProfile: options.explicitProfile,
    project,
    interactive,
    persistProfileToProject: !options.json,
    output,
    env: options.env,
    homeDir: options.homeDir,
  });
  const client = new CodePenClient({ apiKey: auth.apiKey, baseUrl: options.baseUrl });

  const penLookup = await fetchLinkedPenOrHandleMissing({
    client,
    project,
    auth,
    commandName: 'domains add',
    interactive,
    json: options.json,
    output,
    prompts: options.prompts,
  });
  if (!penLookup.found) {
    return null;
  }

  const domains = await client.addDomain(project.config.pen_id, cleanHost);
  const pen = await client.getPen(project.config.pen_id);
  const defaultUrl = pen.deployment?.url ?? null;

  if (options.json) {
    printJsonResponse(
      201,
      `Added custom domain ${cleanHost}.`,
      {
        host: cleanHost,
        default_url: defaultUrl,
        domains,
      },
      output,
    );
  } else {
    output.log(`${fmt.green('✓')} Added custom domain ${fmt.cyan(cleanHost)}.\n`);
    renderDomains(domains, defaultUrl, output);
  }

  return { defaultUrl, domains, pen, project, auth };
}

export async function runDomainsDeleteCommand(
  host: string,
  options: RunDomainsDeleteOptions = {},
): Promise<DomainsCommandResult | null> {
  const output = options.output ?? defaultOutput;
  const cleanHost = host.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  if (!cleanHost) {
    throw new CliError(
      400,
      `Invalid domain host: "${host}". Provide a hostname like www.example.com.`,
    );
  }

  const interactive = (options.interactive ?? isInteractive()) && !options.json;
  const confirmImpl = options.confirm ?? promptConfirm;

  if (!options.yes) {
    if (!interactive) {
      throw new CliError(400, 'Refusing to delete domain in non-interactive mode without --yes.');
    }
    const ok = await confirmImpl(`Delete custom domain ${fmt.cyan(cleanHost)}?`, false);
    if (!ok) {
      output.log('Aborted.');
      return null;
    }
  }

  const cwd = options.cwd ?? process.cwd();
  const project = await requireProject(cwd);
  const auth = await resolveCommandAuth({
    explicitProfile: options.explicitProfile,
    project,
    interactive,
    persistProfileToProject: !options.json,
    output,
    env: options.env,
    homeDir: options.homeDir,
  });
  const client = new CodePenClient({ apiKey: auth.apiKey, baseUrl: options.baseUrl });

  const penLookup = await fetchLinkedPenOrHandleMissing({
    client,
    project,
    auth,
    commandName: 'domains delete',
    interactive,
    json: options.json,
    output,
    prompts: options.prompts,
  });
  if (!penLookup.found) {
    return null;
  }

  const remaining = await client.removeDomain(project.config.pen_id, cleanHost);
  const pen = await client.getPen(project.config.pen_id);
  const defaultUrl = pen.deployment?.url ?? null;

  if (options.json) {
    printJsonResponse(
      200,
      `Deleted custom domain ${cleanHost}.`,
      {
        host: cleanHost,
        default_url: defaultUrl,
        domains: remaining,
      },
      output,
    );
  } else {
    output.log(`${fmt.green('✓')} Deleted custom domain ${fmt.cyan(cleanHost)}.\n`);
    renderDomains(remaining, defaultUrl, output);
  }

  return { defaultUrl, domains: remaining, pen, project, auth };
}

export function registerDomainsCommand(program: Command): void {
  const domainsCmd = program
    .command('domains')
    .description('Show the default deployed URL and manage custom domains for the Pen’s deployment')
    .option('--json', 'Output default deployed URL and domains as JSON')
    .action(async (options: { json?: boolean }, command: Command) => {
      await runDomainsListCommand({
        json: options.json,
        explicitProfile: getGlobalProfileOption(command),
      });
    });

  domainsCmd
    .command('list')
    .alias('ls')
    .description('Show the default deployed URL, custom domains, and required DNS records')
    .option('--json', 'Output default deployed URL and domains as JSON')
    .action(async (options: { json?: boolean }, command: Command) => {
      await runDomainsListCommand({
        json: resolveInheritedJsonOption(options, command),
        explicitProfile: getGlobalProfileOption(command),
      });
    });

  domainsCmd
    .command('add <host>')
    .description('Attach a custom domain (e.g. www.example.com) to this Pen’s deployment')
    .option('--json', 'Output default deployed URL and updated domains as JSON')
    .action(async (host: string, options: { json?: boolean }, command: Command) => {
      await runDomainsAddCommand(host, {
        json: resolveInheritedJsonOption(options, command),
        explicitProfile: getGlobalProfileOption(command),
      });
    });

  domainsCmd
    .command('delete <host>')
    .aliases(['del', 'rm'])
    .description('Delete a custom domain from this Pen’s deployment')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--json', 'Output default deployed URL and remaining domains as JSON')
    .action(async (host: string, options: { yes?: boolean; json?: boolean }, command: Command) => {
      await runDomainsDeleteCommand(host, {
        yes: options.yes,
        json: resolveInheritedJsonOption(options, command),
        explicitProfile: getGlobalProfileOption(command),
      });
    });
}
