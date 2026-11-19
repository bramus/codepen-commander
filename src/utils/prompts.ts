import readline from 'node:readline';
import readlinePromises from 'node:readline/promises';
import { stdin as defaultInput, stdout as defaultOutput } from 'node:process';
import { fmt, stripAnsi } from './format.js';

export function isInteractive(): boolean {
  return Boolean(defaultInput.isTTY && defaultOutput.isTTY);
}

export async function promptText(question: string, defaultValue?: string): Promise<string> {
  const rl = readlinePromises.createInterface({ input: defaultInput, output: defaultOutput });
  try {
    const suffix = defaultValue ? ` ${fmt.dim(`(${defaultValue})`)}` : '';
    const answer = await rl.question(`${question}${suffix}: `);
    const trimmed = answer.trim();
    return trimmed || defaultValue || '';
  } finally {
    rl.close();
  }
}

export async function promptConfirm(question: string, defaultYes = false): Promise<boolean> {
  const rl = readlinePromises.createInterface({ input: defaultInput, output: defaultOutput });
  try {
    const hint = defaultYes ? 'Y/n' : 'y/N';
    const answer = (await rl.question(`${question} ${fmt.dim(`[${hint}]`)} `)).trim().toLowerCase();
    if (!answer) return defaultYes;
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
  description?: string;
}

export interface PromptSelectInputStream extends NodeJS.ReadableStream {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?: (mode: boolean) => void;
}

export interface PromptSelectOutputStream extends NodeJS.WritableStream {
  isTTY?: boolean;
  columns?: number;
  rows?: number;
}

export interface PromptSelectIO {
  input?: PromptSelectInputStream;
  output?: PromptSelectOutputStream;
  term?: string;
}

function countTerminalRows(lines: string[], columns: number): number {
  const safeCols = Math.max(1, columns);
  let total = 0;
  for (const rawLine of lines) {
    for (const subLine of rawLine.split('\n')) {
      const visibleLength = stripAnsi(subLine).length;
      total += visibleLength === 0 ? 1 : Math.ceil(visibleLength / safeCols);
    }
  }
  return total;
}

async function promptSelectFallback<T extends string>(
  question: string,
  options: SelectOption<T>[],
  defaultIndex: number,
  input: PromptSelectInputStream,
  output: PromptSelectOutputStream,
): Promise<T> {
  output.write(`${question}\n`);
  options.forEach((opt, idx) => {
    const num = fmt.cyan(`${idx + 1})`);
    const desc = opt.description ? ` ${fmt.dim(`— ${opt.description}`)}` : '';
    output.write(`  ${num} ${opt.label}${desc}\n`);
  });

  const rl = readlinePromises.createInterface({ input, output });
  try {
    for (;;) {
      const answer = (
        await rl.question(`Choose [1-${options.length}] ${fmt.dim(`(default ${defaultIndex + 1})`)}: `)
      ).trim();

      if (!answer) {
        return options[defaultIndex]!.value;
      }

      const num = Number.parseInt(answer, 10);
      if (!Number.isNaN(num) && num >= 1 && num <= options.length && String(num) === answer) {
        return options[num - 1]!.value;
      }

      const byValue = options.find((opt) => opt.value.toLowerCase() === answer.toLowerCase());
      if (byValue) {
        return byValue.value;
      }

      output.write(
        `${fmt.yellow(`Please enter a number between 1 and ${options.length} (or an option name).`)}\n`,
      );
    }
  } finally {
    rl.close();
  }
}

async function promptSelectInteractive<T extends string>(
  question: string,
  options: SelectOption<T>[],
  defaultIndex: number,
  input: PromptSelectInputStream,
  output: PromptSelectOutputStream,
): Promise<T> {
  readline.emitKeypressEvents(input);

  let selectedIndex = defaultIndex;
  let windowStart = 0;
  let lastRenderedRows = 0;
  let settled = false;

  const getColumns = () => Math.max(20, output.columns || 80);
  const getMaxVisible = () => {
    const termRows = output.rows || 24;
    const available = Math.max(3, termRows - 5);
    return Math.min(options.length, available, 12);
  };

  const syncWindow = (maxVisible: number) => {
    if (options.length <= maxVisible) {
      windowStart = 0;
      return;
    }
    if (selectedIndex < windowStart) {
      windowStart = selectedIndex;
    } else if (selectedIndex >= windowStart + maxVisible) {
      windowStart = selectedIndex - maxVisible + 1;
    }
    const maxStart = Math.max(0, options.length - maxVisible);
    if (windowStart > maxStart) {
      windowStart = maxStart;
    }
  };

  const erasePrevious = (): string => {
    if (lastRenderedRows <= 0) return '';
    return `\x1b[${lastRenderedRows}A\r\x1b[J`;
  };

  const renderActive = (hideCursor: boolean) => {
    const columns = getColumns();
    const maxVisible = getMaxVisible();
    syncWindow(maxVisible);

    const lines: string[] = [`${fmt.bold(question)} ${fmt.dim('(↑/↓, Enter)')}`];

    if (windowStart > 0) {
      lines.push(`    ${fmt.dim(`↑ ${windowStart} more`)}`);
    }

    const windowEnd = Math.min(options.length, windowStart + maxVisible);
    for (let i = windowStart; i < windowEnd; i++) {
      const opt = options[i]!;
      const isSelected = i === selectedIndex;
      if (isSelected) {
        const desc = opt.description ? ` ${fmt.cyan(`— ${opt.description}`)}` : '';
        lines.push(`  ${fmt.bold(fmt.cyan('→'))} ${fmt.bold(fmt.cyan(opt.label))}${desc}`);
      } else {
        const desc = opt.description ? ` ${fmt.dim(`— ${opt.description}`)}` : '';
        lines.push(`    ${opt.label}${desc}`);
      }
    }

    const hiddenBelow = options.length - windowEnd;
    if (hiddenBelow > 0) {
      lines.push(`    ${fmt.dim(`↓ ${hiddenBelow} more`)}`);
    }

    const prefix = `${hideCursor ? '\x1b[?25l' : ''}${erasePrevious()}`;
    output.write(`${prefix}${lines.join('\n')}\n`);
    lastRenderedRows = countTerminalRows(lines, columns);
  };

  const renderFinal = (lines: string[]) => {
    const prefix = erasePrevious();
    output.write(`${prefix}${lines.join('\n')}\n\x1b[?25h`);
    lastRenderedRows = 0;
  };

  const wasRaw = Boolean(input.isRaw);
  input.setRawMode?.(true);
  input.resume();

  return new Promise<T>((resolve, reject) => {
    const cleanup = () => {
      input.removeListener('keypress', onKeypress);
      input.removeListener('end', onEnd);
      output.removeListener('resize', onResize);
      process.removeListener('SIGINT', onSigint);
      try {
        input.setRawMode?.(wasRaw);
      } catch {
        // Ignore if stream already closed
      }
      input.pause();
    };

    const cancel = () => {
      if (settled) return;
      settled = true;
      cleanup();
      renderFinal([fmt.bold(question), `  ${fmt.red('×')} ${fmt.dim('Canceled')}`]);
      reject(new Error('Prompt canceled by user.'));
    };

    const confirm = () => {
      if (settled) return;
      settled = true;
      cleanup();
      const chosen = options[selectedIndex]!;
      const desc = chosen.description ? ` ${fmt.dim(`— ${chosen.description}`)}` : '';
      renderFinal([
        fmt.bold(question),
        `  ${fmt.bold(fmt.green('→'))} ${fmt.bold(fmt.green(chosen.label))}${desc}`,
      ]);
      resolve(chosen.value);
    };

    const onResize = () => {
      if (settled) return;
      renderActive(false);
    };

    const onSigint = () => {
      cancel();
    };

    const onEnd = () => {
      cancel();
    };

    const onKeypress = (str: string | undefined, key: readline.Key | undefined) => {
      if (settled) return;

      if (str === '\u0003' || (key?.ctrl && key.name === 'c') || key?.name === 'escape') {
        cancel();
        return;
      }

      if (key?.name === 'return' || key?.name === 'enter') {
        confirm();
        return;
      }

      if (key?.name === 'up' || (!key?.ctrl && !key?.meta && key?.name === 'k')) {
        selectedIndex = (selectedIndex - 1 + options.length) % options.length;
        renderActive(false);
        return;
      }

      if (key?.name === 'down' || (!key?.ctrl && !key?.meta && key?.name === 'j')) {
        selectedIndex = (selectedIndex + 1) % options.length;
        renderActive(false);
        return;
      }

      if (key?.name === 'home' || key?.name === 'pageup') {
        if (selectedIndex !== 0) {
          selectedIndex = 0;
          renderActive(false);
        }
        return;
      }

      if (key?.name === 'end' || key?.name === 'pagedown') {
        if (selectedIndex !== options.length - 1) {
          selectedIndex = options.length - 1;
          renderActive(false);
        }
        return;
      }

      if (str && /^[1-9]$/.test(str) && !key?.ctrl && !key?.meta) {
        const idx = Number.parseInt(str, 10) - 1;
        if (idx >= 0 && idx < options.length && idx !== selectedIndex) {
          selectedIndex = idx;
          renderActive(false);
        }
      }
    };

    input.on('keypress', onKeypress);
    input.once('end', onEnd);
    output.on('resize', onResize);
    process.on('SIGINT', onSigint);

    renderActive(true);
  });
}

export async function promptSelectWithIO<T extends string>(
  question: string,
  options: SelectOption<T>[],
  defaultIndex = 0,
  io: PromptSelectIO = {},
): Promise<T> {
  if (options.length === 0) {
    throw new Error('promptSelect requires at least one option.');
  }

  const clampedDefault = Math.min(Math.max(0, Math.trunc(defaultIndex)), options.length - 1);
  const input = io.input ?? defaultInput;
  const output = io.output ?? defaultOutput;
  const term = io.term ?? process.env.TERM;

  const canUseInteractive =
    Boolean(input.isTTY) &&
    Boolean(output.isTTY) &&
    typeof input.setRawMode === 'function' &&
    term !== 'dumb';

  if (canUseInteractive) {
    return promptSelectInteractive(question, options, clampedDefault, input, output);
  }

  return promptSelectFallback(question, options, clampedDefault, input, output);
}

export async function promptSelect<T extends string>(
  question: string,
  options: SelectOption<T>[],
  defaultIndex = 0,
): Promise<T> {
  return promptSelectWithIO(question, options, defaultIndex);
}

/**
 * Prompts for a secret (such as an API key) without echoing the raw characters to the terminal.
 */
export async function promptSecret(question: string): Promise<string> {
  if (!defaultInput.isTTY) {
    const rl = readlinePromises.createInterface({ input: defaultInput, output: defaultOutput });
    try {
      return (await rl.question(`${question}: `)).trim();
    } finally {
      rl.close();
    }
  }

  return new Promise<string>((resolve, reject) => {
    defaultOutput.write(`${question}: `);
    let value = '';
    const wasRaw = defaultInput.isRaw;

    defaultInput.setRawMode(true);
    defaultInput.resume();
    defaultInput.setEncoding('utf8');

    const cleanup = () => {
      defaultInput.removeListener('data', onData);
      defaultInput.setRawMode(Boolean(wasRaw));
      defaultInput.pause();
    };

    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          cleanup();
          defaultOutput.write('\n');
          resolve(value.trim());
          return;
        }
        if (ch === '\u0003') {
          // Ctrl+C
          cleanup();
          defaultOutput.write('\n');
          reject(new Error('Prompt canceled by user.'));
          return;
        }
        if (ch === '\u007f' || ch === '\b') {
          if (value.length > 0) {
            value = value.slice(0, -1);
            defaultOutput.write('\b \b');
          }
          continue;
        }
        // Ignore non-printable escape sequences
        if (ch.charCodeAt(0) < 32) {
          continue;
        }
        value += ch;
        defaultOutput.write('•');
      }
    };

    defaultInput.on('data', onData);
  });
}
