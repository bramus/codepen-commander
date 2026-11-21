import readline from 'node:readline';
import { createFormatter, type Formatter } from '../format.js';
import {
  PromptCanceledError,
  countTerminalRows,
  type PromptSelectInputStream,
  type PromptSelectOutputStream,
} from './types.js';

export interface InteractiveListRenderContext {
  cursorIndex: number;
  windowStart: number;
  windowEnd: number;
  fmt: Formatter;
}

export interface InteractiveListKeyContext {
  cursorIndex: number;
  setCursorIndex: (index: number) => void;
  rerender: () => void;
  confirm: () => void;
  cancel: () => void;
}

export interface InteractiveListPromptConfig<T> {
  question: string;
  itemCount: number;
  initialCursor: number;
  reserveRows: number;
  input: PromptSelectInputStream;
  output: PromptSelectOutputStream;
  renderActiveLines: (ctx: InteractiveListRenderContext) => string[];
  renderConfirmedLines: (cursorIndex: number, fmt: Formatter) => string[];
  getConfirmedValue: (cursorIndex: number) => T;
  onBeforeNavigate?: () => void;
  onCustomKey?: (
    str: string | undefined,
    key: readline.Key | undefined,
    ctx: InteractiveListKeyContext,
  ) => void;
}

/**
 * Shared raw-mode TTY viewport, ANSI redraw, resize/SIGINT cleanup, and navigation engine
 * powering both single-select and multi-select interactive prompts.
 */
export function runInteractiveListPrompt<T>(config: InteractiveListPromptConfig<T>): Promise<T> {
  const {
    question,
    itemCount,
    initialCursor,
    reserveRows,
    input,
    output,
    renderActiveLines,
    renderConfirmedLines,
    getConfirmedValue,
    onBeforeNavigate,
    onCustomKey,
  } = config;

  const f = createFormatter(output);
  readline.emitKeypressEvents(input);

  let cursorIndex = initialCursor;
  let windowStart = 0;
  let lastRenderedRows = 0;
  let settled = false;

  const getColumns = () => Math.max(20, output.columns || 80);
  const getMaxVisible = () => {
    const termRows = output.rows || 24;
    const available = Math.max(3, termRows - reserveRows);
    return Math.min(itemCount, available, 12);
  };

  const syncWindow = (maxVisible: number) => {
    if (itemCount <= maxVisible) {
      windowStart = 0;
      return;
    }
    if (cursorIndex < windowStart) {
      windowStart = cursorIndex;
    } else if (cursorIndex >= windowStart + maxVisible) {
      windowStart = cursorIndex - maxVisible + 1;
    }
    const maxStart = Math.max(0, itemCount - maxVisible);
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
    const windowEnd = Math.min(itemCount, windowStart + maxVisible);

    const lines = renderActiveLines({
      cursorIndex,
      windowStart,
      windowEnd,
      fmt: f,
    });

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
      reject(new PromptCanceledError());
    };

    const confirm = () => {
      if (settled) return;
      settled = true;
      cleanup();
      renderFinal(renderConfirmedLines(cursorIndex, f));
      resolve(getConfirmedValue(cursorIndex));
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
        onBeforeNavigate?.();
        cursorIndex = (cursorIndex - 1 + itemCount) % itemCount;
        renderActive(false);
        return;
      }

      if (key?.name === 'down' || (!key?.ctrl && !key?.meta && key?.name === 'j')) {
        onBeforeNavigate?.();
        cursorIndex = (cursorIndex + 1) % itemCount;
        renderActive(false);
        return;
      }

      if (key?.name === 'home' || key?.name === 'pageup') {
        onBeforeNavigate?.();
        if (cursorIndex !== 0) {
          cursorIndex = 0;
          renderActive(false);
        }
        return;
      }

      if (key?.name === 'end' || key?.name === 'pagedown') {
        onBeforeNavigate?.();
        if (cursorIndex !== itemCount - 1) {
          cursorIndex = itemCount - 1;
          renderActive(false);
        }
        return;
      }

      onCustomKey?.(str, key, {
        cursorIndex,
        setCursorIndex(nextIdx) {
          cursorIndex = nextIdx;
        },
        rerender: () => renderActive(false),
        confirm,
        cancel,
      });
    };

    input.on('keypress', onKeypress);
    input.once('end', onEnd);
    output.on('resize', onResize);
    process.on('SIGINT', onSigint);

    renderActive(true);
  });
}
