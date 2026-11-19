import type { ApiErrorBody } from '../types.js';

export class CodePenApiError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly expectedVersionId?: string;
  public readonly currentVersionId?: string;
  public readonly buildId?: string;
  public readonly field?: string;
  public readonly details?: Record<string, unknown>;
  public readonly limit?: number;
  public readonly retryAfterSeconds?: number;
  public readonly resetAt?: string | null;

  constructor(status: number, body: Partial<ApiErrorBody> & { error?: string }) {
    const message = body.message || body.error || `CodePen API returned HTTP ${status}`;
    super(message);
    this.name = 'CodePenApiError';
    this.status = status;
    this.code = body.code || (status === 404 ? 'NOT_FOUND' : 'UNKNOWN');
    this.expectedVersionId = body.expected_version_id;
    this.currentVersionId = body.current_version_id;
    this.buildId = body.build_id;
    this.field = body.field;
    this.details = body.details;
    this.limit = body.limit;
    this.retryAfterSeconds = body.retry_after_seconds;
    this.resetAt = body.reset_at;
  }

  public formatForUser(): string {
    const lines: string[] = [`API Error (${this.status} ${this.code}): ${this.message}`];

    if (this.code === 'UNAUTHENTICATED') {
      lines.push('Check your API key with `cdpn auth status` or run `cdpn auth login`.');
    } else if (this.code === 'CONFLICT') {
      if (this.currentVersionId && this.expectedVersionId) {
        lines.push(
          `Expected version ${this.expectedVersionId}, but remote head is ${this.currentVersionId}.`,
        );
      }
      lines.push('Run `cdpn status` to inspect differences, `cdpn pull` to sync, or `cdpn push --force` to overwrite.');
    } else if (this.code === 'RATE_LIMITED') {
      if (typeof this.retryAfterSeconds === 'number') {
        const mins = Math.ceil(this.retryAfterSeconds / 60);
        lines.push(`Retry after ~${mins} minute(s)${this.resetAt ? ` (resets at ${this.resetAt})` : ''}.`);
      }
    }

    return lines.join('\n');
  }
}

export function isCodePenApiError(error: unknown): error is CodePenApiError {
  return error instanceof CodePenApiError;
}
