import type { Command } from 'commander';
import { CodePenClient } from '../api/client.js';
import type { Deployment, Pen, PenDomain } from '../api/types.js';
import type { ResolvedAuth } from '../config/auth.js';
import { type ProjectLocation, requireProject } from '../config/project.js';
import { CliError } from '../errors.js';
import { openBrowser } from '../utils/browser.js';
import { fmt } from '../utils/format.js';
import { defaultOutput, type CommandOutput } from '../utils/output.js';
import { isInteractive, promptSelect, type SelectOption } from '../utils/prompts/index.js';
import { getGlobalProfileOption, resolveCommandAuth } from '../workflows/auth-context.js';
import {
  fetchLinkedPenOrHandleMissing,
  type MissingPenPrompts,
} from '../workflows/missing-pen.js';

export interface OpenCliOptions {
  preview?: boolean;
  deploy?: boolean;
  live?: boolean;
}

export interface RunOpenCommandOptions extends OpenCliOptions {
  cwd?: string;
  explicitProfile?: string;
  baseUrl?: string;
  interactive?: boolean;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  output?: CommandOutput;
  select?: <T extends string>(
    question: string,
    options: SelectOption<T>[],
    defaultIndex?: number,
  ) => Promise<T>;
  prompts?: MissingPenPrompts;
  openBrowserImpl?: (url: string) => Promise<boolean>;
}

export interface OpenCommandResult {
  url: string;
  label: string;
  launched: boolean;
  pen: Pen;
  project: ProjectLocation;
  auth: ResolvedAuth;
}

export interface DeployedDomainChoice {
  url: string;
  host: string;
  isDefault: boolean;
  description: string;
}

function normalizeDeployedHostToUrl(rawHostOrUrl: string): { url: string; host: string } | null {
  const trimmed = rawHostOrUrl.trim();
  if (!trimmed) return null;

  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return null;
    }
    const httpsUrl = new URL(`https://${parsed.host}${parsed.pathname}`);
    return {
      url: httpsUrl.toString(),
      host: httpsUrl.host.toLowerCase(),
    };
  } catch {
    return null;
  }
}

/**
 * Builds the deduplicated list of deployed URLs for a Pen:
 * its default CodePen deployment URL first, followed by any configured custom domains.
 */
export function buildDeployedDomainChoices(
  deployment: Deployment,
  domains: PenDomain[] = [],
): DeployedDomainChoice[] {
  const choices: DeployedDomainChoice[] = [];
  const seenHosts = new Set<string>();

  const defaultNormalized = normalizeDeployedHostToUrl(deployment.url);
  if (defaultNormalized) {
    seenHosts.add(defaultNormalized.host);
    choices.push({
      url: deployment.url,
      host: defaultNormalized.host,
      isDefault: true,
      description: 'default',
    });
  } else {
    choices.push({
      url: deployment.url,
      host: deployment.url.toLowerCase(),
      isDefault: true,
      description: 'default',
    });
  }

  const statusByHost = new Map<string, PenDomain['status']>();
  for (const domain of domains) {
    const normalized = normalizeDeployedHostToUrl(domain.host);
    if (normalized) {
      statusByHost.set(normalized.host, domain.status);
    }
  }

  const candidateHosts: string[] = [
    ...deployment.custom_domains,
    ...domains.map((d) => d.host),
  ];

  for (const rawHost of candidateHosts) {
    const normalized = normalizeDeployedHostToUrl(rawHost);
    if (!normalized || seenHosts.has(normalized.host)) {
      continue;
    }
    seenHosts.add(normalized.host);

    const status = statusByHost.get(normalized.host);
    choices.push({
      url: normalized.url,
      host: normalized.host,
      isDefault: false,
      description: status ? `custom domain · ${status}` : 'custom domain',
    });
  }

  return choices;
}

export async function runOpenCommand(
  options: RunOpenCommandOptions = {},
): Promise<OpenCommandResult | null> {
  const output = options.output ?? defaultOutput;
  const openDeployed = Boolean(options.deploy || options.live);
  if (options.preview && openDeployed) {
    throw new CliError(400, 'Specify at most one of --preview or --deploy / --live.');
  }

  const cwd = options.cwd ?? process.cwd();
  const interactive = options.interactive ?? isInteractive();
  const selectImpl = options.select ?? promptSelect;
  const openBrowserImpl = options.openBrowserImpl ?? openBrowser;

  const project = await requireProject(cwd);
  const auth = await resolveCommandAuth({
    explicitProfile: options.explicitProfile,
    project,
    interactive,
    output,
    env: options.env,
    homeDir: options.homeDir,
  });
  const client = new CodePenClient({ apiKey: auth.apiKey, baseUrl: options.baseUrl });

  const penLookup = await fetchLinkedPenOrHandleMissing({
    client,
    project,
    auth,
    commandName: 'open',
    interactive,
    output,
    prompts: options.prompts ?? { select: selectImpl },
  });
  if (!penLookup.found) {
    return null;
  }

  const pen = penLookup.pen;
  const domains: PenDomain[] = openDeployed
    ? await client.listDomains(project.config.pen_id).catch(() => [])
    : [];

  let targetUrl: string;
  let label: string;

  if (openDeployed) {
    if (!pen.deployment) {
      throw new CliError(404, 'This Pen is not deployed yet. Run `cdpn deploy` first.');
    }

    const choices = buildDeployedDomainChoices(pen.deployment, domains);
    if (choices.length > 1) {
      if (interactive) {
        targetUrl = await selectImpl(
          'This Pen is deployed to multiple domains. Which URL would you like to open?',
          choices.map((choice) => ({
            value: choice.url,
            label: choice.url,
            description: choice.description,
          })),
          0,
        );
      } else {
        targetUrl = choices[0]!.url;
        const otherUrls = choices
          .slice(1)
          .map((c) => c.url)
          .join(', ');
        output.log(
          fmt.dim(
            `Deployed to multiple domains; opening default URL (other domains: ${otherUrls}).`,
          ),
        );
      }
    } else {
      targetUrl = choices[0]!.url;
    }

    label = 'deployed site';
  } else if (options.preview) {
    targetUrl = pen.urls.preview;
    label = 'preview';
  } else {
    targetUrl = pen.urls.editor || project.config.url;
    label = 'editor';
  }

  output.log(`Opening ${label}: ${fmt.cyan(targetUrl)}`);
  const launched = await openBrowserImpl(targetUrl);
  if (!launched) {
    output.log(fmt.yellow('Could not launch browser automatically. Open the URL above manually.'));
  }

  return {
    url: targetUrl,
    label,
    launched,
    pen,
    project,
    auth,
  };
}

export function registerOpenCommand(program: Command): void {
  program
    .command('open')
    .description('Open the Pen in your browser (editor by default, or --preview / --deploy)')
    .option('-p, --preview', 'Open the saved head preview URL')
    .option(
      '-d, --deploy',
      'Open the deployed URL (prompts to choose when multiple domains exist)',
    )
    .option('-l, --live', 'Alias for --deploy')
    .action(async (options: OpenCliOptions, command: Command) => {
      await runOpenCommand({
        preview: options.preview,
        deploy: options.deploy,
        live: options.live,
        explicitProfile: getGlobalProfileOption(command),
      });
    });
}
