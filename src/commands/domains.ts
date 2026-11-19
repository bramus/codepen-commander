import type { Command } from 'commander';
import { CodePenClient } from '../api/client.js';
import { requireAuth } from '../config/auth.js';
import { requireProject } from '../config/project.js';
import type { PenDomain } from '../types.js';
import { fmt, formatTable } from '../utils/format.js';
import { isInteractive, promptConfirm } from '../utils/prompts.js';

function renderDomains(domains: PenDomain[]): void {
  if (domains.length === 0) {
    console.log(fmt.dim('No custom domains configured for this Pen.'));
    console.log(fmt.dim('Add one with: cdpn domains add <host>'));
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

  console.log(formatTable(['Host', 'Status', 'CNAME', 'A Record'], rows));

  const needingDns = domains.filter((d) => d.status !== 'Verified' && d.dns.length > 0);
  if (needingDns.length > 0) {
    console.log('\nRequired DNS records:');
    for (const domain of needingDns) {
      console.log(`  ${fmt.bold(domain.host)}:`);
      for (const rec of domain.dns) {
        console.log(`    ${fmt.cyan(rec.type.padEnd(6))} ${rec.name}  →  ${fmt.bold(rec.value)}`);
      }
    }
  }
}

export function registerDomainsCommand(program: Command): void {
  const domainsCmd = program
    .command('domains')
    .description('Manage custom domains for the Pen’s deployment')
    .option('--json', 'Output domains as JSON')
    .action(async (options: { json?: boolean }) => {
      const auth = await requireAuth();
      const project = await requireProject();
      const client = new CodePenClient({ apiKey: auth.apiKey });

      const domains = await client.listDomains(project.config.pen_id);
      if (options.json) {
        console.log(JSON.stringify(domains, null, 2));
        return;
      }
      renderDomains(domains);
    });

  domainsCmd
    .command('list')
    .alias('ls')
    .description('List custom domains and required DNS records')
    .option('--json', 'Output domains as JSON')
    .action(async (options: { json?: boolean }) => {
      const auth = await requireAuth();
      const project = await requireProject();
      const client = new CodePenClient({ apiKey: auth.apiKey });

      const domains = await client.listDomains(project.config.pen_id);
      if (options.json) {
        console.log(JSON.stringify(domains, null, 2));
        return;
      }
      renderDomains(domains);
    });

  domainsCmd
    .command('add <host>')
    .description('Attach a custom domain (e.g. www.example.com) to this Pen’s deployment')
    .option('--json', 'Output updated domains as JSON')
    .action(async (host: string, options: { json?: boolean }) => {
      const cleanHost = host.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
      if (!cleanHost || !/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(cleanHost)) {
        throw new Error(`Invalid domain host: "${host}". Provide a hostname like www.example.com.`);
      }

      const auth = await requireAuth();
      const project = await requireProject();
      const client = new CodePenClient({ apiKey: auth.apiKey });

      const domains = await client.addDomain(project.config.pen_id, cleanHost);
      if (options.json) {
        console.log(JSON.stringify(domains, null, 2));
        return;
      }

      console.log(`${fmt.green('✓')} Added custom domain ${fmt.cyan(cleanHost)}.\n`);
      renderDomains(domains);
    });

  domainsCmd
    .command('remove <host>')
    .alias('rm')
    .description('Remove a custom domain from this Pen’s deployment')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--json', 'Output remaining domains as JSON')
    .action(async (host: string, options: { yes?: boolean; json?: boolean }) => {
      const cleanHost = host.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');

      if (!options.yes) {
        if (!isInteractive()) {
          throw new Error('Refusing to remove domain in non-interactive mode without --yes.');
        }
        const ok = await promptConfirm(`Remove custom domain ${fmt.cyan(cleanHost)}?`, false);
        if (!ok) {
          console.log('Aborted.');
          return;
        }
      }

      const auth = await requireAuth();
      const project = await requireProject();
      const client = new CodePenClient({ apiKey: auth.apiKey });

      const remaining = await client.removeDomain(project.config.pen_id, cleanHost);
      if (options.json) {
        console.log(JSON.stringify(remaining, null, 2));
        return;
      }

      console.log(`${fmt.green('✓')} Removed custom domain ${fmt.cyan(cleanHost)}.\n`);
      renderDomains(remaining);
    });
}
