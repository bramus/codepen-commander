import type { Build, BuildDiagnostic } from '../types.js';

export interface Formatter {
  bold: (s: string) => string;
  dim: (s: string) => string;
  red: (s: string) => string;
  green: (s: string) => string;
  yellow: (s: string) => string;
  blue: (s: string) => string;
  magenta: (s: string) => string;
  cyan: (s: string) => string;
  gray: (s: string) => string;
  boldGreen: (s: string) => string;
  boldYellow: (s: string) => string;
  boldCyan: (s: string) => string;
  boldMagenta: (s: string) => string;
  boldRed: (s: string) => string;
}

export function createFormatter(output: { isTTY?: boolean } = process.stdout): Formatter {
  const colorsEnabled = (): boolean => {
    if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') {
      return false;
    }
    if (process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== '0') {
      return true;
    }
    return Boolean(output.isTTY);
  };

  const wrap = (code: string, text: string): string => {
    if (!colorsEnabled()) return text;
    return `\x1b[${code}m${text}\x1b[0m`;
  };

  return {
    bold: (s: string) => wrap('1', s),
    dim: (s: string) => wrap('2', s),
    red: (s: string) => wrap('31', s),
    green: (s: string) => wrap('32', s),
    yellow: (s: string) => wrap('33', s),
    blue: (s: string) => wrap('34', s),
    magenta: (s: string) => wrap('35', s),
    cyan: (s: string) => wrap('36', s),
    gray: (s: string) => wrap('90', s),
    boldGreen: (s: string) => wrap('1;32', s),
    boldYellow: (s: string) => wrap('1;33', s),
    boldCyan: (s: string) => wrap('1;36', s),
    boldMagenta: (s: string) => wrap('1;35', s),
    boldRed: (s: string) => wrap('1;31', s),
  };
}

export const fmt: Formatter = createFormatter(process.stdout);

export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

export function shortId(id: string | null | undefined): string {
  if (!id) return 'none';
  return id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

export function formatTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => {
    let max = stripAnsi(h).length;
    for (const row of rows) {
      const cell = row[i] ?? '';
      max = Math.max(max, stripAnsi(cell).length);
    }
    return max;
  });

  const pad = (text: string, width: number): string => {
    const visible = stripAnsi(text).length;
    return text + ' '.repeat(Math.max(0, width - visible));
  };

  const lines: string[] = [];
  lines.push(headers.map((h, i) => fmt.bold(pad(h, widths[i]!))).join('  '));
  lines.push(widths.map((w) => fmt.dim('─'.repeat(w))).join('  '));

  for (const row of rows) {
    lines.push(headers.map((_, i) => pad(row[i] ?? '', widths[i]!)).join('  '));
  }

  return lines.join('\n');
}

export function formatDiagnostic(diag: BuildDiagnostic): string {
  const badge =
    diag.type === 'Error'
      ? fmt.red('ERROR')
      : diag.type === 'Warning'
        ? fmt.yellow('WARN ')
        : fmt.cyan(diag.type.toUpperCase());

  let loc = '';
  if (diag.path) {
    loc = diag.path;
    if (diag.range?.start) {
      loc += `:${diag.range.start.line}:${diag.range.start.column}`;
    }
    loc = `${fmt.dim(loc)} `;
  }

  const block = diag.block_name ? ` ${fmt.dim(`[${diag.block_name}]`)}` : '';
  return `  ${badge} ${loc}${diag.message}${block}`;
}

export function printBuildSummary(build: Build): void {
  const statusLabel =
    build.status === 'Success'
      ? fmt.green(build.status)
      : build.status === 'Failed'
        ? fmt.red(build.status)
        : fmt.yellow(build.status);

  const roundsNote = build.rounds > 1 ? fmt.dim(` (${build.rounds} build rounds)`) : '';
  console.log(`Build: ${statusLabel}${roundsNote}`);

  if (build.applied_patches.length > 0) {
    console.log(fmt.cyan(`Compiler applied ${build.applied_patches.length} patch(es):`));
    for (const patch of build.applied_patches) {
      const symbol = patch.type === 'create' ? '+' : patch.type === 'delete' ? '-' : '~';
      console.log(`  ${fmt.cyan(symbol)} ${patch.path} ${fmt.dim(`(${patch.type})`)}`);
    }
  }

  const actionableDiags = build.diagnostics.filter(
    (d) => d.type === 'Error' || d.type === 'Warning',
  );
  if (actionableDiags.length > 0) {
    console.log('Diagnostics:');
    for (const diag of actionableDiags) {
      console.log(formatDiagnostic(diag));
    }
  }
}
