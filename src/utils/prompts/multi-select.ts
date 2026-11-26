import readlinePromises from 'node:readline/promises';
import { stdin as defaultInput, stdout as defaultOutput } from 'node:process';
import { createFormatter } from '../format.js';
import { runInteractiveListPrompt } from './tty-list.js';
import {
  canUseInteractiveTty,
  type MultiSelectOption,
  type PromptSelectIO,
  type PromptSelectInputStream,
  type PromptSelectOutputStream,
} from './types.js';

function getExclusiveBlockers<T extends string>(
  options: readonly MultiSelectOption<T>[],
  selected: ReadonlySet<number>,
  targetIdx: number,
): number[] {
  const target = options[targetIdx];
  if (!target || target.locked || selected.has(targetIdx)) {
    return [];
  }

  const blockers: number[] = [];
  for (const idx of selected) {
    if (idx === targetIdx) continue;
    const other = options[idx];
    if (!other || other.locked) continue;
    if (target.exclusive || other.exclusive) {
      blockers.push(idx);
    }
  }
  return blockers;
}

function formatExclusiveBlockedNotice<T extends string>(
  options: readonly MultiSelectOption<T>[],
  targetIdx: number,
  blockerIndices: readonly number[],
): string {
  const targetLabel = options[targetIdx]?.label ?? '';
  const blockerLabels = blockerIndices
    .map((idx) => options[idx]?.label)
    .filter((label): label is string => Boolean(label))
    .map((label) => `"${label}"`);
  const verb = blockerLabels.length === 1 ? 'is' : 'are';
  return `"${targetLabel}" cannot be selected while ${blockerLabels.join(', ')} ${verb} selected.`;
}

function initSelectedIndices<T extends string>(options: readonly MultiSelectOption<T>[]): Set<number> {
  const selected = new Set<number>();
  options.forEach((opt, idx) => {
    if (opt.locked) {
      selected.add(idx);
    }
  });
  options.forEach((opt, idx) => {
    if (opt.locked || !opt.checked) return;
    if (getExclusiveBlockers(options, selected, idx).length === 0) {
      selected.add(idx);
    }
  });
  return selected;
}

async function promptMultiSelectFallback<T extends string>(
  question: string,
  options: MultiSelectOption<T>[],
  input: PromptSelectInputStream,
  output: PromptSelectOutputStream,
): Promise<T[]> {
  const f = createFormatter(output);
  const selected = initSelectedIndices(options);

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
          const blockers = getExclusiveBlockers(options, selected, idx);
          if (blockers.length > 0) {
            output.write(
              `\n  ${f.boldYellow('⚠')} ${f.boldYellow(formatExclusiveBlockedNotice(options, idx, blockers))}\n`,
            );
          } else {
            selected.add(idx);
          }
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

function promptMultiSelectInteractive<T extends string>(
  question: string,
  options: MultiSelectOption<T>[],
  input: PromptSelectInputStream,
  output: PromptSelectOutputStream,
): Promise<T[]> {
  const selected = initSelectedIndices(options);

  const firstSelectable = options.findIndex(
    (opt, idx) => !opt.locked && getExclusiveBlockers(options, selected, idx).length === 0,
  );
  const firstUnlocked = options.findIndex((opt) => !opt.locked);
  const initialCursor =
    firstSelectable !== -1 ? firstSelectable : firstUnlocked !== -1 ? firstUnlocked : 0;
  let notice: string | null = null;

  return runInteractiveListPrompt<T[]>({
    question,
    itemCount: options.length,
    initialCursor,
    reserveRows: 7,
    input,
    output,
    onBeforeNavigate() {
      notice = null;
    },
    renderActiveLines({ cursorIndex, windowStart, windowEnd, fmt: f }) {
      const lines: string[] = [`${f.cyan('◆')} ${f.bold(question)}`];

      if (windowStart > 0) {
        lines.push(`    ${f.dim(`↑ ${windowStart} more`)}`);
      }

      for (let i = windowStart; i < windowEnd; i++) {
        const opt = options[i]!;
        const isCursor = i === cursorIndex;
        const isChecked = selected.has(i);
        const isBlocked = getExclusiveBlockers(options, selected, i).length > 0;
        const box = isChecked
          ? opt.locked
            ? f.dim('[✓]')
            : f.boldGreen('[✓]')
          : f.dim('[ ]');

        if (isCursor) {
          if (isBlocked) {
            const desc = opt.description ? ` ${f.dim(`— ${opt.description}`)}` : '';
            lines.push(`  ${f.cyan('→')} ${box} ${f.dim(opt.label)}${desc}`);
          } else {
            const desc = opt.description ? ` ${f.cyan(`— ${opt.description}`)}` : '';
            lines.push(`  ${f.boldCyan('→')} ${box} ${f.boldCyan(opt.label)}${desc}`);
          }
        } else {
          const labelText = opt.locked || isBlocked ? f.dim(opt.label) : opt.label;
          const desc = opt.description ? ` ${f.dim(`— ${opt.description}`)}` : '';
          lines.push(`    ${box} ${labelText}${desc}`);
        }
      }

      const hiddenBelow = options.length - windowEnd;
      if (hiddenBelow > 0) {
        lines.push(`    ${f.dim(`↓ ${hiddenBelow} more`)}`);
      }

      lines.push('');
      if (notice) {
        lines.push(`  ${f.boldYellow('⚠')} ${f.boldYellow(notice)}`);
      } else {
        const cursorOpt = options[cursorIndex];
        const cursorBlockers = getExclusiveBlockers(options, selected, cursorIndex);
        if (cursorBlockers.length > 0) {
          lines.push(
            `  ${f.boldCyan('ℹ')} ${f.cyan(formatExclusiveBlockedNotice(options, cursorIndex, cursorBlockers))}`,
          );
        } else if (cursorOpt?.locked) {
          lines.push(
            `  ${f.boldCyan('ℹ')} ${f.cyan(`"${cursorOpt.label}" is required and cannot be unselected.`)}`,
          );
        } else {
          lines.push(
            `  ${f.boldCyan('ℹ')} ${f.cyan('Use ↑/↓ to navigate, Space to select. Press Enter to confirm.')}`,
          );
        }
      }

      return lines;
    },
    renderConfirmedLines(_cursorIndex, f) {
      const chosen = options.filter((_, idx) => selected.has(idx));
      const summary = chosen.length > 0 ? chosen.map((o) => o.label).join(', ') : '(none)';
      return [
        `${f.cyan('◆')} ${f.bold(question)}`,
        `  ${f.boldGreen('→')} ${f.boldGreen(summary)}`,
      ];
    },
    getConfirmedValue() {
      return options.filter((_, idx) => selected.has(idx)).map((o) => o.value);
    },
    onCustomKey(str, key, ctx) {
      if (key?.name === 'space' || str === ' ') {
        const opt = options[ctx.cursorIndex]!;
        if (opt.locked) {
          notice = `"${opt.label}" is required and cannot be unselected.`;
        } else if (selected.has(ctx.cursorIndex)) {
          notice = null;
          selected.delete(ctx.cursorIndex);
        } else {
          const blockers = getExclusiveBlockers(options, selected, ctx.cursorIndex);
          if (blockers.length > 0) {
            notice = formatExclusiveBlockedNotice(options, ctx.cursorIndex, blockers);
          } else {
            notice = null;
            selected.add(ctx.cursorIndex);
          }
        }
        ctx.rerender();
        return;
      }

      if (!key?.ctrl && !key?.meta && str && str.toLowerCase() === 'a') {
        notice = null;
        const hasExclusiveOptions = options.some((opt) => !opt.locked && opt.exclusive);
        if (!hasExclusiveOptions) {
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
        } else {
          const selectedExclusive = [...selected].some((idx) => {
            const opt = options[idx];
            return Boolean(opt && !opt.locked && opt.exclusive);
          });
          if (selectedExclusive) {
            for (let idx = 0; idx < options.length; idx++) {
              if (!options[idx]!.locked) {
                selected.delete(idx);
              }
            }
          } else {
            const nonExclusiveUnlocked = options
              .map((opt, idx) => (!opt.locked && !opt.exclusive ? idx : -1))
              .filter((idx) => idx !== -1);
            const allSelected = nonExclusiveUnlocked.every((idx) => selected.has(idx));
            for (const idx of nonExclusiveUnlocked) {
              if (allSelected) {
                selected.delete(idx);
              } else {
                selected.add(idx);
              }
            }
          }
        }
        ctx.rerender();
        return;
      }

      if (str && /^[1-9]$/.test(str) && !key?.ctrl && !key?.meta) {
        notice = null;
        const idx = Number.parseInt(str, 10) - 1;
        if (idx >= 0 && idx < options.length && idx !== ctx.cursorIndex) {
          ctx.setCursorIndex(idx);
          ctx.rerender();
        }
      }
    },
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
