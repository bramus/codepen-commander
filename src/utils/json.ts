import { CommanderError } from 'commander';
import { isCodePenApiError } from '../api/errors.js';
import { stripAnsi } from './format.js';

export interface JsonStatus {
  code: number;
  message: string;
}

export interface JsonEnvelope<T = unknown> {
  status: JsonStatus;
  contents: T;
}

/**
 * Structured CLI error carrying an HTTP-modeled status code and optional structured contents
 * for `--json` output while remaining a standard `Error` for human-readable terminal output.
 */
export class CliError extends Error {
  public readonly statusCode: number;
  public readonly contents: unknown;

  constructor(statusCode: number, message: string, contents: unknown = null) {
    super(message);
    this.name = 'CliError';
    this.statusCode = statusCode;
    this.contents = contents;
  }
}

export function isCliError(error: unknown): error is CliError {
  return error instanceof CliError;
}

export function createJsonResponse<T>(code: number, message: string, contents: T): JsonEnvelope<T> {
  return {
    status: {
      code,
      message: stripAnsi(message),
    },
    contents,
  };
}

export function formatJsonResponse<T>(code: number, message: string, contents: T): string {
  return JSON.stringify(createJsonResponse(code, message, contents), null, 2);
}

export function printJsonResponse<T>(code: number, message: string, contents: T): JsonEnvelope<T> {
  const envelope = createJsonResponse(code, message, contents);
  console.log(JSON.stringify(envelope, null, 2));
  return envelope;
}

/**
 * Checks whether `--json` was passed in the CLI argument vector (stopping at `--`).
 */
export function wantsJsonOutput(argv: readonly string[]): boolean {
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') break;
    if (arg === '--json') return true;
  }
  return false;
}

function inferHttpStatusCode(error: Error): number {
  const errno = (error as NodeJS.ErrnoException).code;
  if (errno === 'ENOENT') return 404;
  if (errno === 'EACCES' || errno === 'EPERM') return 403;
  if (errno === 'EEXIST') return 409;
  if (errno === 'ETIMEDOUT') return 504;
  if (errno === 'ECONNREFUSED' || errno === 'ENOTFOUND' || errno === 'EAI_AGAIN' || errno === 'ECONNRESET') {
    return 502;
  }

  const msg = error.message;
  if (/no codepen api key found|not authenticated|unauthenticated/i.test(msg)) return 401;
  if (/classic pen.*read-only|cannot (fork|clone) .+ via codepen api/i.test(msg)) return 403;
  if (
    /not found|no \.cdpn\.json found|no profiles found|no saved versions|no codepen template found/i.test(msg)
  ) {
    return 404;
  }
  if (
    /already exists|is not empty|moved ahead|local changes detected|already contains|multiple codepen templates match/i.test(
      msg,
    )
  ) {
    return 409;
  }
  if (/build failed/i.test(msg)) return 422;
  if (
    /invalid |cannot combine|must be |requires? |missing |specify |refusing to |at most |expected a codepen url|cannot be empty|not deployed yet|only supported for|only works/i.test(
      msg,
    )
  ) {
    return 400;
  }
  return 500;
}

/**
 * Converts any thrown error into a consistent `{ status: { code, message }, contents }` envelope.
 */
export function errorToJsonEnvelope(error: unknown): JsonEnvelope<unknown> {
  if (isCodePenApiError(error)) {
    const code =
      Number.isInteger(error.status) && error.status >= 100 && error.status <= 599
        ? error.status
        : 502;

    const details: Record<string, unknown> = {
      error_code: error.code,
    };
    if (error.expectedVersionId !== undefined) details.expected_version_id = error.expectedVersionId;
    if (error.currentVersionId !== undefined) details.current_version_id = error.currentVersionId;
    if (error.buildId !== undefined) details.build_id = error.buildId;
    if (error.field !== undefined) details.field = error.field;
    if (error.details !== undefined) details.details = error.details;
    if (error.limit !== undefined) details.limit = error.limit;
    if (error.retryAfterSeconds !== undefined) details.retry_after_seconds = error.retryAfterSeconds;
    if (error.resetAt !== undefined) details.reset_at = error.resetAt;

    return createJsonResponse(code, error.message, details);
  }

  if (isCliError(error)) {
    return createJsonResponse(error.statusCode, error.message, error.contents);
  }

  if (error instanceof CommanderError) {
    const cleanMessage = error.message.replace(/^error:\s*/i, '').trim() || error.message;
    return createJsonResponse(400, cleanMessage, { error_code: error.code });
  }

  if (error instanceof Error) {
    return createJsonResponse(inferHttpStatusCode(error), error.message, null);
  }

  return createJsonResponse(500, String(error), null);
}
