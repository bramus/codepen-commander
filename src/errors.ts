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
