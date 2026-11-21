import readlinePromises from 'node:readline/promises';
import { stdin as defaultInput, stdout as defaultOutput } from 'node:process';
import { createFormatter } from '../format.js';
import { runInteractiveListPrompt } from './tty-list.js';
import {
  canUseInteractiveTty,
  type PromptSelectIO,
  type PromptSelectInputStream,
  type PromptSelectOutputStream,
  type SelectOption,
} from './types.js';

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

function promptSelectInteractive<T extends string>(
  question: string,
  options: SelectOption<T>[],
  defaultIndex: number,
  input: PromptSelectInputStream,
  output: PromptSelectOutputStream,
): Promise<T> {
  return runInteractiveListPrompt<T>({
    question,
    itemCount: options.length,
    initialCursor: defaultIndex,
    reserveRows: 5,
    input,
    output,
    renderActiveLines({ cursorIndex, windowStart, windowEnd, fmt: f }) {
      const lines: string[] = [
        `${f.cyan('◆')} ${f.bold(question)} ${f.dim('(↑/↓, Enter)')}`,
      ];

      if (windowStart > 0) {
        lines.push(`    ${f.dim(`↑ ${windowStart} more`)}`);
      }

      for (let i = windowStart; i < windowEnd; i++) {
        const opt = options[i]!;
        const isSelected = i === cursorIndex;
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

      return lines;
    },
    renderConfirmedLines(cursorIndex, f) {
      const chosen = options[cursorIndex]!;
      const desc = chosen.description ? ` ${f.dim(`— ${chosen.description}`)}` : '';
      return [
        `${f.cyan('◆')} ${f.bold(question)}`,
        `  ${f.boldGreen('→')} ${f.boldGreen(chosen.label)}${desc}`,
      ];
    },
    getConfirmedValue(cursorIndex) {
      return options[cursorIndex]!.value;
    },
    onCustomKey(str, key, ctx) {
      if (!str || key?.ctrl || key?.meta) return;

      if (/^[1-9]$/.test(str)) {
        const idx = Number.parseInt(str, 10) - 1;
        if (idx >= 0 && idx < options.length && idx !== ctx.cursorIndex) {
          ctx.setCursorIndex(idx);
          ctx.rerender();
        }
        return;
      }

      const lower = str.toLowerCase();
      const shortcutIdx = options.findIndex(
        (opt) => opt.shortcut !== undefined && opt.shortcut.toLowerCase() === lower,
      );
      if (shortcutIdx !== -1 && shortcutIdx !== ctx.cursorIndex) {
        ctx.setCursorIndex(shortcutIdx);
        ctx.rerender();
      }
    },
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
