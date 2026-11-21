import { createBufferedOutput, createSilentOutput } from '../../src/utils/output.js';
import type { JsonEnvelope } from '../../src/utils/json.js';

export { createBufferedOutput, createSilentOutput };

export function parseJsonOutput<T = unknown>(
  buffered: ReturnType<typeof createBufferedOutput>,
): JsonEnvelope<T> {
  return JSON.parse(buffered.stdout()) as JsonEnvelope<T>;
}
