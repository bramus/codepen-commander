import readline from 'node:readline';
import readlinePromises from 'node:readline/promises';
import { stdin as defaultInput, stdout as defaultOutput } from 'node:process';
import { createFormatter, stripAnsi } from './format.js';

export class PromptCancelledError extends Error {
  constructor() {
    super('Prompt canceled by user.');
    this.name = 'PromptCancelledError';
  }
}

export function isPromptCancelledError(error: unknown): error is PromptCancelledError {
  return error instanceof PromptCancelledError;
}

export function isInteractive(): boolean {
  return Boolean(defaultInput.isTTY && defaultOutput.isTTY);
}

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
  description?: string;
  shortcut?: string;
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

export type TextValidationResult<T = string> =
  | { ok: true; value: T; displayValue?: string }
  | { ok: false; error: string };

function canUseInteractiveTty(
  input: PromptSelectInputStream,
  output: PromptSelectOutputStream,
  term: string | undefined,
): boolean {
  return (
    Boolean(input.isTTY) &&
    Boolean(output.isTTY) &&
    typeof input.setRawMode === 'function' &&
    term !== 'dumb'
  );
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

function formatQuestionHeader(
  question: string,
  defaultValue: string | undefined,
  f: ReturnType<typeof createFormatter>,
): string {
  const hint = defaultValue ? ` ${f.dim(`(${defaultValue})`)}` : '';
  return `${f.cyan('◆')} ${f.bold(question)}${hint}`;
}

async function readInteractiveLine(
  promptText: string,
  input: PromptSelectInputStream,
  output: PromptSelectOutputStream,
  f: ReturnType<typeof createFormatter>,
): Promise<string> {
  const rl = readlinePromises.createInterface({ input, output });
  const abortController = new AbortController();

  const onSigint = () => {
    abortController.abort();
    rl.close();
  };
  const onClose = () => {
    abortController.abort();
  };

  rl.on('SIGINT', onSigint);
  rl.once('close', onClose);

  try {
    return await rl.question(promptText, { signal: abortController.signal });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    const name = (err as Error | undefined)?.name;
    if (
      abortController.signal.aborted ||
      name === 'AbortError' ||
      code === 'ABORT_ERR' ||
      code === 'ERR_USE_AFTER_CLOSE'
    ) {
      output.write(`\r\x1b[K  ${f.red('×')} ${f.dim('Canceled')}\n`);
      throw new PromptCancelledError();
    }
    throw err;
  } finally {
    rl.off('SIGINT', onSigint);
    rl.off('close', onClose);
    rl.close();
  }
}

export async function promptValidatedTextWithIO<T = string>(
  question: string,
  options: {
    defaultValue?: string;
    validate: (raw: string) => TextValidationResult<T> | Promise<TextValidationResult<T>>;
    io?: PromptSelectIO;
  },
): Promise<T> {
  const input = options.io?.input ?? defaultInput;
  const output = options.io?.output ?? defaultOutput;
  const term = options.io?.term ?? process.env.TERM;
  const f = createFormatter(output);
  const interactive = canUseInteractiveTty(input, output, term);

  output.write(`${formatQuestionHeader(question, options.defaultValue, f)}\n`);

  if (interactive) {
    const promptPrefix = `  ${f.boldCyan('→')} `;
    const getColumns = () => Math.max(20, output.columns || 80);

    for (;;) {
      const raw = await readInteractiveLine(promptPrefix, input, output, f);
      const result = await options.validate(raw);
      if (!result.ok) {
        output.write(`  ${f.yellow(result.error)}\n`);
        continue;
      }

      const displayText = result.displayValue ?? String(result.value);
      const enteredRows = countTerminalRows([`  → ${raw}`], getColumns());
      output.write(
        `\x1b[${enteredRows}A\r\x1b[J  ${f.boldGreen('→')} ${f.boldGreen(displayText)}\n`,
      );
      return result.value;
    }
  }

  const rl = readlinePromises.createInterface({ input, output });
  try {
    for (;;) {
      const raw = await rl.question(`  ${f.boldCyan('→')} `);
      const result = await options.validate(raw);
      if (!result.ok) {
        output.write(`  ${f.yellow(result.error)}\n`);
        continue;
      }
      const displayText = result.displayValue ?? String(result.value);
      output.write(`  ${f.boldGreen('→')} ${f.boldGreen(displayText)}\n`);
      return result.value;
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ERR_USE_AFTER_CLOSE') {
      throw new PromptCancelledError();
    }
    throw err;
  } finally {
    rl.close();
  }
}

export async function promptTextWithIO(
  question: string,
  defaultValue?: string,
  io: PromptSelectIO = {},
): Promise<string> {
  return promptValidatedTextWithIO<string>(question, {
    defaultValue,
    io,
    validate(raw) {
      const trimmed = raw.trim();
      const value = trimmed || defaultValue || '';
      return { ok: true, value, displayValue: value || '(empty)' };
    },
  });
}

export async function promptText(question: string, defaultValue?: string): Promise<string> {
  return promptTextWithIO(question, defaultValue);
}

export async function promptConfirmWithIO(
  question: string,
  defaultYes = false,
  io: PromptSelectIO = {},
): Promise<boolean> {
  const options: SelectOption<'yes' | 'no'>[] = defaultYes
    ? [
        { value: 'yes', label: 'Yes', shortcut: 'y' },
        { value: 'no', label: 'No', shortcut: 'n' },
      ]
    : [
        { value: 'no', label: 'No', shortcut: 'n' },
        { value: 'yes', label: 'Yes', shortcut: 'y' },
      ];
  const choice = await promptSelectWithIO(question, options, 0, io);
  return choice === 'yes';
}

export async function promptConfirm(question: string, defaultYes = false): Promise<boolean> {
  return promptConfirmWithIO(question, defaultYes);
}

async function promptSelectFallback<T extends string>(
  question: string,
  options: SelectOption<T>[],
  defaultIndex: number,
  input: PromptSelectInputStream,
  output: PromptSelectOutputStream,
): Promise<T> {
  const f = createFormatter(output);
  output.write(`${f.cyan('◆')} ${f.bold(question)}\n`);
  options.forEach((opt, idx) => {
    const num = f.cyan(`${idx + 1})`);
    const desc = opt.description ? ` ${f.dim(`— ${opt.description}`)}` : '';
    output.write(`  ${num} ${opt.label}${desc}\n`);
  });

  const rl = readlinePromises.createInterface({ input, output });
  try {
    for (;;) {
      const answer = (
        await rl.question(
          `  ${f.dim(`Choose [1-${options.length}] (default ${defaultIndex + 1}):`)} `,
        )
      ).trim();

      let matched: SelectOption<T> | undefined;
      if (!answer) {
        matched = options[defaultIndex];
      } else {
        const num = Number.parseInt(answer, 10);
        if (!Number.isNaN(num) && num >= 1 && num <= options.length && String(num) === answer) {
          matched = options[num - 1];
        } else {
          const lower = answer.toLowerCase();
          matched = options.find(
            (opt) =>
              opt.value.toLowerCase() === lower ||
              opt.label.toLowerCase() === lower ||
              (opt.shortcut !== undefined && opt.shortcut.toLowerCase() === lower),
          );
        }
      }

      if (matched) {
        const desc = matched.description ? ` ${f.dim(`— ${matched.description}`)}` : '';
        output.write(`  ${f.boldGreen('→')} ${f.boldGreen(matched.label)}${desc}\n`);
        return matched.value;
      }

      output.write(
        `  ${f.yellow(`Please enter a number between 1 and ${options.length} (or an option name).`)}\n`,
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
  const f = createFormatter(output);
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

    const lines: string[] = [
      `${f.cyan('◆')} ${f.bold(question)} ${f.dim('(↑/↓, Enter)')}`,
    ];

    if (windowStart > 0) {
      lines.push(`    ${f.dim(`↑ ${windowStart} more`)}`);
    }

    const windowEnd = Math.min(options.length, windowStart + maxVisible);
    for (let i = windowStart; i < windowEnd; i++) {
      const opt = options[i]!;
      const isSelected = i === selectedIndex;
      if (isSelected) {
        const desc = opt.description ? ` ${f.cyan(`— ${opt.description}`)}` : '';
        lines.push(`  ${f.boldCyan('→')} ${f.boldCyan(opt.label)}${desc}`);
      } else {
        const desc = opt.description ? ` ${f.dim(`— ${opt.description}`)}` : '';
        lines.push(`    ${opt.label}${desc}`);
      }
    }

    const hiddenBelow = options.length - windowEnd;
    if (hiddenBelow > 0) {
      lines.push(`    ${f.dim(`↓ ${hiddenBelow} more`)}`);
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
      renderFinal([
        `${f.cyan('◆')} ${f.bold(question)}`,
        `  ${f.red('×')} ${f.dim('Canceled')}`,
      ]);
      reject(new PromptCancelledError());
    };

    const confirm = () => {
      if (settled) return;
      settled = true;
      cleanup();
      const chosen = options[selectedIndex]!;
      const desc = chosen.description ? ` ${f.dim(`— ${chosen.description}`)}` : '';
      renderFinal([
        `${f.cyan('◆')} ${f.bold(question)}`,
        `  ${f.boldGreen('→')} ${f.boldGreen(chosen.label)}${desc}`,
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

      if (str && !key?.ctrl && !key?.meta) {
        if (/^[1-9]$/.test(str)) {
          const idx = Number.parseInt(str, 10) - 1;
          if (idx >= 0 && idx < options.length && idx !== selectedIndex) {
            selectedIndex = idx;
            renderActive(false);
          }
          return;
        }

        const lower = str.toLowerCase();
        const shortcutIdx = options.findIndex(
          (opt) => opt.shortcut !== undefined && opt.shortcut.toLowerCase() === lower,
        );
        if (shortcutIdx !== -1 && shortcutIdx !== selectedIndex) {
          selectedIndex = shortcutIdx;
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

  if (canUseInteractiveTty(input, output, term)) {
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

export interface MultiSelectOption<T extends string = string> {
  value: T;
  label: string;
  description?: string;
  /** Initial checked state (defaults to false; locked options always start checked). */
  checked?: boolean;
  /** When true, the option stays checked and cannot be unselected. */
  locked?: boolean;
}

async function promptMultiSelectFallback<T extends string>(
  question: string,
  options: MultiSelectOption<T>[],
  input: PromptSelectInputStream,
  output: PromptSelectOutputStream,
): Promise<T[]> {
  const f = createFormatter(output);
  const selected = new Set<number>();
  options.forEach((opt, idx) => {
    if (opt.locked || opt.checked) {
      selected.add(idx);
    }
  });

  output.write(`${f.cyan('◆')} ${f.bold(question)}\n`);
  options.forEach((opt, idx) => {
    const num = f.cyan(`${idx + 1})`);
    const mark = selected.has(idx) ? (opt.locked ? f.dim('[✓]') : f.boldGreen('[✓]')) : f.dim('[ ]');
    const desc = opt.description ? ` ${f.dim(`— ${opt.description}`)}` : '';
    output.write(`  ${num} ${mark} ${opt.label}${desc}\n`);
  });

  const rl = readlinePromises.createInterface({ input, output });
  try {
    const answer = (
      await rl.question(
        `  ${f.dim('Toggle numbers/names (comma-separated) or press Enter to keep defaults:')} `,
      )
    ).trim();

    if (answer && answer.toLowerCase() !== 'none') {
      for (const token of answer.split(',').map((t) => t.trim()).filter(Boolean)) {
        let idx = -1;
        const num = Number.parseInt(token, 10);
        if (!Number.isNaN(num) && num >= 1 && num <= options.length && String(num) === token) {
          idx = num - 1;
        } else {
          const lower = token.toLowerCase();
          idx = options.findIndex(
            (opt) => opt.value.toLowerCase() === lower || opt.label.toLowerCase() === lower,
          );
        }
        if (idx === -1) continue;
        const opt = options[idx]!;
        if (opt.locked) {
          selected.add(idx);
          continue;
        }
        if (selected.has(idx)) {
          selected.delete(idx);
        } else {
          selected.add(idx);
        }
      }
    }
  } finally {
    rl.close();
  }

  const chosen = options.filter((_, idx) => selected.has(idx));
  const summary = chosen.length > 0 ? chosen.map((o) => o.label).join(', ') : '(none)';
  output.write(`  ${f.boldGreen('→')} ${f.boldGreen(summary)}\n`);
  return chosen.map((o) => o.value);
}

async function promptMultiSelectInteractive<T extends string>(
  question: string,
  options: MultiSelectOption<T>[],
  input: PromptSelectInputStream,
  output: PromptSelectOutputStream,
): Promise<T[]> {
  const f = createFormatter(output);
  readline.emitKeypressEvents(input);

  const selected = new Set<number>();
  options.forEach((opt, idx) => {
    if (opt.locked || opt.checked) {
      selected.add(idx);
    }
  });

  const firstUnlocked = options.findIndex((opt) => !opt.locked);
  let cursorIndex = firstUnlocked !== -1 ? firstUnlocked : 0;
  let windowStart = 0;
  let lastRenderedRows = 0;
  let notice: string | null = null;
  let settled = false;

  const getColumns = () => Math.max(20, output.columns || 80);
  const getMaxVisible = () => {
    const termRows = output.rows || 24;
    const available = Math.max(3, termRows - 6);
    return Math.min(options.length, available, 12);
  };

  const syncWindow = (maxVisible: number) => {
    if (options.length <= maxVisible) {
      windowStart = 0;
      return;
    }
    if (cursorIndex < windowStart) {
      windowStart = cursorIndex;
    } else if (cursorIndex >= windowStart + maxVisible) {
      windowStart = cursorIndex - maxVisible + 1;
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

    const lines: string[] = [
      `${f.cyan('◆')} ${f.bold(question)} ${f.dim('(↑/↓, Space toggle, Enter confirm)')}`,
    ];

    if (windowStart > 0) {
      lines.push(`    ${f.dim(`↑ ${windowStart} more`)}`);
    }

    const windowEnd = Math.min(options.length, windowStart + maxVisible);
    for (let i = windowStart; i < windowEnd; i++) {
      const opt = options[i]!;
      const isCursor = i === cursorIndex;
      const isChecked = selected.has(i);
      const box = isChecked
        ? opt.locked
          ? f.dim('[✓]')
          : f.boldGreen('[✓]')
        : f.dim('[ ]');

      if (isCursor) {
        const desc = opt.description ? ` ${f.cyan(`— ${opt.description}`)}` : '';
        lines.push(`  ${f.boldCyan('→')} ${box} ${f.boldCyan(opt.label)}${desc}`);
      } else {
        const labelText = opt.locked ? f.dim(opt.label) : opt.label;
        const desc = opt.description ? ` ${f.dim(`— ${opt.description}`)}` : '';
        lines.push(`    ${box} ${labelText}${desc}`);
      }
    }

    const hiddenBelow = options.length - windowEnd;
    if (hiddenBelow > 0) {
      lines.push(`    ${f.dim(`↓ ${hiddenBelow} more`)}`);
    }

    if (notice) {
      lines.push(`  ${f.yellow(notice)}`);
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

  return new Promise<T[]>((resolve, reject) => {
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
      renderFinal([
        `${f.cyan('◆')} ${f.bold(question)}`,
        `  ${f.red('×')} ${f.dim('Canceled')}`,
      ]);
      reject(new PromptCancelledError());
    };

    const confirm = () => {
      if (settled) return;
      settled = true;
      cleanup();
      const chosen = options.filter((_, idx) => selected.has(idx));
      const summary = chosen.length > 0 ? chosen.map((o) => o.label).join(', ') : '(none)';
      renderFinal([
        `${f.cyan('◆')} ${f.bold(question)}`,
        `  ${f.boldGreen('→')} ${f.boldGreen(summary)}`,
      ]);
      resolve(chosen.map((o) => o.value));
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

      if (key?.name === 'space' || str === ' ') {
        const opt = options[cursorIndex]!;
        if (opt.locked) {
          notice = `"${opt.label}" is required and cannot be unselected.`;
        } else {
          notice = null;
          if (selected.has(cursorIndex)) {
            selected.delete(cursorIndex);
          } else {
            selected.add(cursorIndex);
          }
        }
        renderActive(false);
        return;
      }

      if (key?.name === 'up' || (!key?.ctrl && !key?.meta && key?.name === 'k')) {
        notice = null;
        cursorIndex = (cursorIndex - 1 + options.length) % options.length;
        renderActive(false);
        return;
      }

      if (key?.name === 'down' || (!key?.ctrl && !key?.meta && key?.name === 'j')) {
        notice = null;
        cursorIndex = (cursorIndex + 1) % options.length;
        renderActive(false);
        return;
      }

      if (key?.name === 'home' || key?.name === 'pageup') {
        notice = null;
        if (cursorIndex !== 0) {
          cursorIndex = 0;
          renderActive(false);
        }
        return;
      }

      if (key?.name === 'end' || key?.name === 'pagedown') {
        notice = null;
        if (cursorIndex !== options.length - 1) {
          cursorIndex = options.length - 1;
          renderActive(false);
        }
        return;
      }

      if (!key?.ctrl && !key?.meta && str && str.toLowerCase() === 'a') {
        notice = null;
        const unlockedIndices = options
          .map((opt, idx) => (opt.locked ? -1 : idx))
          .filter((idx) => idx !== -1);
        const allUnlockedSelected = unlockedIndices.every((idx) => selected.has(idx));
        for (const idx of unlockedIndices) {
          if (allUnlockedSelected) {
            selected.delete(idx);
          } else {
            selected.add(idx);
          }
        }
        renderActive(false);
        return;
      }

      if (str && /^[1-9]$/.test(str) && !key?.ctrl && !key?.meta) {
        notice = null;
        const idx = Number.parseInt(str, 10) - 1;
        if (idx >= 0 && idx < options.length && idx !== cursorIndex) {
          cursorIndex = idx;
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

export async function promptMultiSelectWithIO<T extends string>(
  question: string,
  options: MultiSelectOption<T>[],
  io: PromptSelectIO = {},
): Promise<T[]> {
  if (options.length === 0) {
    throw new Error('promptMultiSelect requires at least one option.');
  }

  const input = io.input ?? defaultInput;
  const output = io.output ?? defaultOutput;
  const term = io.term ?? process.env.TERM;

  if (canUseInteractiveTty(input, output, term)) {
    return promptMultiSelectInteractive(question, options, input, output);
  }

  return promptMultiSelectFallback(question, options, input, output);
}

export async function promptMultiSelect<T extends string>(
  question: string,
  options: MultiSelectOption<T>[],
): Promise<T[]> {
  return promptMultiSelectWithIO(question, options);
}

/**
 * Prompts for a secret (such as an API key) without echoing the raw characters to the terminal.
 */
export async function promptSecret(question: string): Promise<string> {
  const f = createFormatter(defaultOutput);

  if (!defaultInput.isTTY) {
    defaultOutput.write(`${f.cyan('◆')} ${f.bold(question)}\n`);
    const rl = readlinePromises.createInterface({ input: defaultInput, output: defaultOutput });
    try {
      return (await rl.question(`  ${f.boldCyan('→')} `)).trim();
    } finally {
      rl.close();
    }
  }

  return new Promise<string>((resolve, reject) => {
    defaultOutput.write(`${f.cyan('◆')} ${f.bold(question)}\n  ${f.boldCyan('→')} `);
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
          const masked = value.trim() ? '•'.repeat(Math.min(value.trim().length, 16)) : '(empty)';
          defaultOutput.write(`\r\x1b[K  ${f.boldGreen('→')} ${f.dim(masked)}\n`);
          resolve(value.trim());
          return;
        }
        if (ch === '\u0003') {
          // Ctrl+C
          cleanup();
          defaultOutput.write(`\r\x1b[K  ${f.red('×')} ${f.dim('Canceled')}\n`);
          reject(new PromptCancelledError());
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
