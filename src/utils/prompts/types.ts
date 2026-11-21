import { stdin as defaultInput, stdout as defaultOutput } from 'node:process';
import { createFormatter, stripAnsi } from '../format.js';

export class PromptCanceledError extends Error {
  constructor() {
    super('Prompt canceled by user.');
    this.name = 'PromptCanceledError';
  }
}

export function isPromptCanceledError(error: unknown): error is PromptCanceledError {
  return error instanceof PromptCanceledError;
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

export interface MultiSelectOption<T extends string = string> {
  value: T;
  label: string;
  description?: string;
  /** Initial checked state (defaults to false; locked options always start checked). */
  checked?: boolean;
  /** When true, the option stays checked and cannot be unselected. */
  locked?: boolean;
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

export function canUseInteractiveTty(
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

export function countTerminalRows(lines: string[], columns: number): number {
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

export function formatQuestionHeader(
  question: string,
  defaultValue: string | undefined,
  f: ReturnType<typeof createFormatter>,
): string {
  const hint = defaultValue ? ` ${f.dim(`(${defaultValue})`)}` : '';
  return `${f.cyan('◆')} ${f.bold(question)}${hint}`;
}
