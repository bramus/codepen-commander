import { execFile } from 'node:child_process';

export interface BrowserUrlOptions {
  allowLocalhostHttp?: boolean;
}

function isLocalhostHost(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
}

/**
 * Validates that a URL is a clean HTTPS URL (or localhost HTTP when explicitly allowed)
 * with no control characters.
 */
export function validateBrowserUrl(rawUrl: string, options: BrowserUrlOptions = {}): string {
  if (/[\x00-\x1f\x7f]/.test(rawUrl)) {
    throw new Error('URL contains invalid control characters.');
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }

  const allowedLocalHttp =
    Boolean(options.allowLocalhostHttp) &&
    parsed.protocol === 'http:' &&
    isLocalhostHost(parsed.hostname);

  if (parsed.protocol !== 'https:' && !allowedLocalHttp) {
    throw new Error(`Refusing to open non-HTTPS URL in browser: ${parsed.protocol}`);
  }

  return parsed.toString();
}

/**
 * Opens an HTTPS URL (or localhost HTTP URL when `allowLocalhostHttp` is true) in the user's
 * default browser without invoking a shell.
 * Returns `true` if the launcher succeeded, or `false` if unavailable (e.g. headless/SSH).
 */
export async function openBrowser(rawUrl: string, options: BrowserUrlOptions = {}): Promise<boolean> {
  const safeUrl = validateBrowserUrl(rawUrl, options);

  let command: string;
  let args: string[];

  if (process.platform === 'darwin') {
    command = 'open';
    args = [safeUrl];
  } else if (process.platform === 'win32') {
    command = 'rundll32';
    args = ['url.dll,FileProtocolHandler', safeUrl];
  } else {
    command = 'xdg-open';
    args = [safeUrl];
  }

  return new Promise<boolean>((resolve) => {
    const child = execFile(command, args, { shell: false, timeout: 10_000 }, (error) => {
      resolve(!error);
    });
    child.unref();
  });
}
