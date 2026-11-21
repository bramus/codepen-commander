import readlinePromises from 'node:readline/promises';
import { stdin as defaultInput, stdout as defaultOutput } from 'node:process';
import { createFormatter } from '../format.js';
import {
  PromptCanceledError,
  canUseInteractiveTty,
  countTerminalRows,
  formatQuestionHeader,
  type PromptSelectIO,
  type PromptSelectInputStream,
  type PromptSelectOutputStream,
  type TextValidationResult,
} from './types.js';

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
      throw new PromptCanceledError();
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
      throw new PromptCanceledError();
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
