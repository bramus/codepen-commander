import { watch } from 'node:fs';
import path from 'node:path';

export interface DebouncedWatcherOptions {
  rootDir: string;
  debounceMs?: number;
  shouldIgnore?: (filename: string | Buffer | null) => boolean;
  onChange: () => Promise<void> | void;
  onError?: (error: Error) => void;
}

export interface DebouncedWatcherHandle {
  close: () => void;
}

export function isCommonIgnoredWatchPath(rawFilename: string | Buffer | null): boolean {
  if (typeof rawFilename !== 'string' || !rawFilename) return false;
  const normalized = rawFilename.split(path.sep).join('/');
  const segments = normalized.split('/');
  if (segments.at(-1) === '.DS_Store') return true;
  if (segments.includes('node_modules') || segments.includes('.git')) return true;
  return false;
}

/**
 * Starts a recursive `fs.watch` with debounced single-flight execution so overlapping
 * filesystem events coalesce cleanly without concurrent handler runs.
 */
export function createDebouncedWatcher(options: DebouncedWatcherOptions): DebouncedWatcherHandle {
  const { rootDir, debounceMs = 150, shouldIgnore, onChange, onError } = options;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let isRunning = false;
  let pendingRun = false;
  let closed = false;

  async function run(): Promise<void> {
    if (closed) return;
    if (isRunning) {
      pendingRun = true;
      return;
    }
    isRunning = true;
    try {
      await onChange();
    } catch (error) {
      onError?.(error instanceof Error ? error : new Error(String(error)));
    } finally {
      isRunning = false;
      if (pendingRun && !closed) {
        pendingRun = false;
        schedule();
      }
    }
  }

  function schedule(): void {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void run();
    }, debounceMs);
  }

  let watcher: ReturnType<typeof watch> | null = null;
  try {
    watcher = watch(rootDir, { recursive: true }, (_eventType, filename) => {
      if (isCommonIgnoredWatchPath(filename)) return;
      if (shouldIgnore?.(filename)) return;
      schedule();
    });
    watcher.on('error', (error) => {
      onError?.(error instanceof Error ? error : new Error(String(error)));
    });
  } catch (error) {
    onError?.(error instanceof Error ? error : new Error(String(error)));
  }

  return {
    close() {
      closed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      watcher?.close();
    },
  };
}
