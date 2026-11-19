import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { fmt } from './format.js';

export function isInteractive(): boolean {
  return Boolean(input.isTTY && output.isTTY);
}

export async function promptText(question: string, defaultValue?: string): Promise<string> {
  const rl = readline.createInterface({ input, output });
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
  const rl = readline.createInterface({ input, output });
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

export async function promptSelect<T extends string>(
  question: string,
  options: SelectOption<T>[],
  defaultIndex = 0,
): Promise<T> {
  if (options.length === 0) {
    throw new Error('promptSelect requires at least one option.');
  }

  console.log(question);
  options.forEach((opt, idx) => {
    const num = fmt.cyan(`${idx + 1})`);
    const desc = opt.description ? ` ${fmt.dim(`— ${opt.description}`)}` : '';
    console.log(`  ${num} ${opt.label}${desc}`);
  });

  const rl = readline.createInterface({ input, output });
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

      console.log(fmt.yellow(`Please enter a number between 1 and ${options.length} (or an option name).`));
    }
  } finally {
    rl.close();
  }
}

/**
 * Prompts for a secret (such as an API key) without echoing the raw characters to the terminal.
 */
export async function promptSecret(question: string): Promise<string> {
  if (!input.isTTY) {
    const rl = readline.createInterface({ input, output });
    try {
      return (await rl.question(`${question}: `)).trim();
    } finally {
      rl.close();
    }
  }

  return new Promise<string>((resolve, reject) => {
    output.write(`${question}: `);
    let value = '';
    const wasRaw = input.isRaw;

    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');

    const cleanup = () => {
      input.removeListener('data', onData);
      input.setRawMode(Boolean(wasRaw));
      input.pause();
    };

    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          cleanup();
          output.write('\n');
          resolve(value.trim());
          return;
        }
        if (ch === '\u0003') {
          // Ctrl+C
          cleanup();
          output.write('\n');
          reject(new Error('Prompt canceled by user.'));
          return;
        }
        if (ch === '\u007f' || ch === '\b') {
          if (value.length > 0) {
            value = value.slice(0, -1);
            output.write('\b \b');
          }
          continue;
        }
        // Ignore non-printable escape sequences
        if (ch.charCodeAt(0) < 32) {
          continue;
        }
        value += ch;
        output.write('•');
      }
    };

    input.on('data', onData);
  });
}
