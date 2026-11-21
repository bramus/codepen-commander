import readlinePromises from 'node:readline/promises';
import { stdin as defaultInput, stdout as defaultOutput } from 'node:process';
import { createFormatter } from '../format.js';
import { PromptCanceledError } from './types.js';

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
          reject(new PromptCanceledError());
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
