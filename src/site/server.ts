import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PROJECT_CONFIG_FILENAME } from '../config/project.js';
import { CliError } from '../utils/json.js';
import {
  PEN_HTML_SUFFIX,
  isWithinRoot,
  resolveServedHtmlWithBlocks,
  resolveUnsupportedBlocksPage,
  resolveVirtualClassicHtml,
} from './blocks.js';
import {
  classifyDirectoryMode,
  inspectTargetDirectory,
  type DirectoryInspection,
  type DirectoryMode,
} from './detect.js';
import {
  countDemos,
  createInMemoryManifestWatcher,
  type InMemoryManifestWatcher,
} from './manifest.js';
import {
  renderShellIndexHtml,
  resolveActiveShell,
  resolveShellAssetForRequest,
  resolveSiteMetadata,
  type ResolvedShell,
  type SiteMetadataOverrides,
} from './shell.js';

export const SERVE_HOST = '127.0.0.1';
export const DEFAULT_SERVE_PORT = 3000;

export const MIME_TYPES: Record<string, string> = {
  '.avif': 'image/avif',
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.ogg': 'audio/ogg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.vtt': 'text/vtt; charset=utf-8',
  '.wasm': 'application/wasm',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.xml': 'application/xml; charset=utf-8',
};

// TODO(security): Permissions-Policy and Content-Security-Policy are intentionally
// omitted on user demo routes served by this localhost-only dev server so users
// are free to author demos using inline scripts/styles, import maps, third-party
// CDNs, frameworks, or experimental browser APIs (sensors, media, fullscreen).
const BASE_SECURITY_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
};

const BUILTIN_SHELL_SECURITY_HEADERS: Record<string, string> = {
  ...BASE_SECURITY_HEADERS,
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'",
};

// TODO(security): Custom user shells (exported and edited locally by the user) omit
// strict script-src/style-src CSP on localhost so users can freely add inline styles,
// external fonts, or custom scripts, while retaining nosniff, SAMEORIGIN, and Permissions-Policy.
const CUSTOM_SHELL_SECURITY_HEADERS: Record<string, string> = {
  ...BASE_SECURITY_HEADERS,
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

export function parseServePort(
  rawPort: string | number | undefined,
  allowZero = false,
): number {
  if (rawPort === undefined || rawPort === '') return DEFAULT_SERVE_PORT;
  const parsed = typeof rawPort === 'number' ? rawPort : Number.parseInt(String(rawPort), 10);
  const minPort = allowZero ? 0 : 1;
  if (
    !Number.isInteger(parsed) ||
    parsed < minPort ||
    parsed > 65535 ||
    String(parsed) !== String(rawPort).trim()
  ) {
    throw new CliError(
      400,
      `Invalid port value: ${String(rawPort)} (expected an integer between 1 and 65535).`,
    );
  }
  return parsed;
}

function sendError(
  res: ServerResponse,
  statusCode: number,
  message: string,
  extraHeaders: Record<string, string> = {},
): void {
  const body = `${statusCode} ${message}\n`;
  res.writeHead(statusCode, {
    ...BUILTIN_SHELL_SECURITY_HEADERS,
    ...extraHeaders,
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

type PathResolution =
  | { status: 200; filePath: string; size: number }
  | { status: 200; virtualHtml: string; contentType: string }
  | { status: 301; redirect: string }
  | { status: 501; errorHtml: string; csp: string }
  | { status: 400 | 403 | 404; message: string };

async function hasEnclosingCdpnJson(
  dirRealpath: string,
  rootRealpath: string,
): Promise<boolean> {
  let current = path.resolve(dirRealpath);
  while (current !== rootRealpath && isWithinRoot(current, rootRealpath)) {
    const candidate = path.join(current, PROJECT_CONFIG_FILENAME);
    try {
      const stat = await fs.lstat(candidate);
      if (!stat.isSymbolicLink() && stat.isFile()) {
        const real = await fs.realpath(candidate);
        if (isWithinRoot(real, rootRealpath)) {
          return true;
        }
      }
    } catch {
      // Check parent directory
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return false;
}

async function resolveSafePath(
  rawPathname: string,
  rootDir: string,
  rootRealpath: string,
  isCollectionRoot: boolean,
): Promise<PathResolution> {
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(rawPathname);
  } catch {
    return { status: 400, message: 'Bad Request' };
  }

  if (decodedPath.includes('\0') || decodedPath.includes('\\')) {
    return { status: 400, message: 'Bad Request' };
  }

  const segments = decodedPath.split('/').filter(Boolean);
  for (const segment of segments) {
    if (segment === '.' || segment === '..' || segment.startsWith('.')) {
      return { status: 403, message: 'Forbidden' };
    }
  }

  const resolvedPath = path.resolve(rootDir, ...segments);
  if (!isWithinRoot(resolvedPath, rootDir)) {
    return { status: 403, message: 'Forbidden' };
  }

  let lstat;
  try {
    lstat = await fs.lstat(resolvedPath);
  } catch {
    const canResolvePenBlocks = !isCollectionRoot || segments.length >= 2;
    if (canResolvePenBlocks && !decodedPath.endsWith('/') && segments.length > 0) {
      const requestedFilename = segments.at(-1)!;
      const lowerFilename = requestedFilename.toLowerCase();
      if (lowerFilename.endsWith('.html') && !lowerFilename.endsWith(PEN_HTML_SUFFIX)) {
        const parentDir = path.dirname(resolvedPath);
        if (isWithinRoot(parentDir, rootDir)) {
          try {
            const parentStat = await fs.lstat(parentDir);
            if (!parentStat.isSymbolicLink() && parentStat.isDirectory()) {
              const realParentDir = await fs.realpath(parentDir);
              if (isWithinRoot(realParentDir, rootRealpath)) {
                if (
                  isCollectionRoot &&
                  !(await hasEnclosingCdpnJson(realParentDir, rootRealpath))
                ) {
                  return { status: 404, message: 'Not Found' };
                }
                const unsupportedPage = await resolveUnsupportedBlocksPage({
                  dirRealpath: realParentDir,
                  rootRealpath,
                  isRootServe: isCollectionRoot,
                });
                if (unsupportedPage) {
                  return {
                    status: 501,
                    errorHtml: unsupportedPage.html,
                    csp: unsupportedPage.csp,
                  };
                }
                const virtualHtml = await resolveVirtualClassicHtml({
                  dirRealpath: realParentDir,
                  requestedFilename,
                  rootRealpath,
                });
                if (virtualHtml !== null) {
                  return { status: 200, virtualHtml, contentType: MIME_TYPES['.html']! };
                }
              }
            }
          } catch {
            // Fall through to 404
          }
        }
      }
    }
    return { status: 404, message: 'Not Found' };
  }

  if (lstat.isSymbolicLink()) {
    return { status: 403, message: 'Forbidden' };
  }

  if (lstat.isDirectory()) {
    let realDirPath: string;
    try {
      realDirPath = await fs.realpath(resolvedPath);
    } catch {
      return { status: 404, message: 'Not Found' };
    }
    if (!isWithinRoot(realDirPath, rootRealpath)) {
      return { status: 403, message: 'Forbidden' };
    }

    // In collection mode, never serve subdirectories that do not have an enclosing `.cdpn.json`
    if (
      isCollectionRoot &&
      segments.length > 0 &&
      !(await hasEnclosingCdpnJson(realDirPath, rootRealpath))
    ) {
      return { status: 404, message: 'Not Found' };
    }

    if (!decodedPath.endsWith('/')) {
      const normalizedRedirect = `/${segments.map(encodeURIComponent).join('/')}/`;
      return { status: 301, redirect: normalizedRedirect };
    }

    const canResolvePenBlocks = !isCollectionRoot || segments.length > 0;
    if (canResolvePenBlocks) {
      const unsupportedPage = await resolveUnsupportedBlocksPage({
        dirRealpath: realDirPath,
        rootRealpath,
        isRootServe: isCollectionRoot,
      });
      if (unsupportedPage) {
        return {
          status: 501,
          errorHtml: unsupportedPage.html,
          csp: unsupportedPage.csp,
        };
      }
    }

    const indexPath = path.join(resolvedPath, 'index.html');
    try {
      const indexStat = await fs.lstat(indexPath);
      if (indexStat.isSymbolicLink() || !indexStat.isFile()) {
        return { status: 404, message: 'Not Found' };
      }
      const realIndexPath = await fs.realpath(indexPath);
      if (!isWithinRoot(realIndexPath, rootRealpath)) {
        return { status: 403, message: 'Forbidden' };
      }
      return { status: 200, filePath: realIndexPath, size: indexStat.size };
    } catch {
      if (canResolvePenBlocks) {
        try {
          const virtualHtml = await resolveVirtualClassicHtml({
            dirRealpath: realDirPath,
            requestedFilename: 'index.html',
            rootRealpath,
          });
          if (virtualHtml !== null) {
            return { status: 200, virtualHtml, contentType: MIME_TYPES['.html']! };
          }
        } catch {
          // Fall through to 404
        }
      }
      return { status: 404, message: 'Not Found' };
    }
  }

  if (!lstat.isFile()) {
    return { status: 404, message: 'Not Found' };
  }

  const realFilePath = await fs.realpath(resolvedPath);
  if (!isWithinRoot(realFilePath, rootRealpath)) {
    return { status: 403, message: 'Forbidden' };
  }

  // In collection mode, files inside subdirectories are only served when enclosed by a `.cdpn.json` demo
  if (
    isCollectionRoot &&
    segments.length >= 2 &&
    !(await hasEnclosingCdpnJson(path.dirname(realFilePath), rootRealpath))
  ) {
    return { status: 404, message: 'Not Found' };
  }

  const lowerFilePath = realFilePath.toLowerCase();
  if (
    (!isCollectionRoot || segments.length >= 2) &&
    lowerFilePath.endsWith('.html') &&
    !lowerFilePath.endsWith(PEN_HTML_SUFFIX)
  ) {
    const unsupportedPage = await resolveUnsupportedBlocksPage({
      dirRealpath: path.dirname(realFilePath),
      rootRealpath,
      isRootServe: isCollectionRoot,
    });
    if (unsupportedPage) {
      return {
        status: 501,
        errorHtml: unsupportedPage.html,
        csp: unsupportedPage.csp,
      };
    }
  }

  return { status: 200, filePath: realFilePath, size: lstat.size };
}

export interface StartDevServerOptions {
  targetDir?: string;
  port?: string | number;
  allowEphemeralPort?: boolean;
  explicitShell?: string;
  site?: SiteMetadataOverrides;
  homeDir?: string;
  cwd?: string;
  onManifestUpdate?: (demoCount: number) => void;
  onWatchError?: (error: Error) => void;
}

export interface RunningDevServer {
  server: http.Server;
  url: string;
  port: number;
  host: string;
  mode: DirectoryMode;
  inspection: DirectoryInspection;
  demoCount: number;
  shell: ResolvedShell | null;
  close: () => Promise<void>;
}

/**
 * Starts the local localhost-only (`127.0.0.1`) HTTP server for either a single Pen
 * (`.cdpn.json`) or a multi-Pen collection directory with in-memory `demos.json`.
 */
export async function startDevServer(
  options: StartDevServerOptions = {},
): Promise<RunningDevServer> {
  const baseCwd = path.resolve(options.cwd ?? process.cwd());
  const resolvedTarget = path.resolve(baseCwd, options.targetDir ?? '.');

  let stat;
  try {
    stat = await fs.stat(resolvedTarget);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new CliError(404, `Directory not found: ${resolvedTarget}`);
    }
    throw error;
  }
  if (!stat.isDirectory()) {
    throw new CliError(400, `Not a directory: ${resolvedTarget}`);
  }

  const port = parseServePort(options.port, Boolean(options.allowEphemeralPort));
  const inspection = await inspectTargetDirectory(resolvedTarget);
  const mode = classifyDirectoryMode(inspection);

  let manifestWatcher: InMemoryManifestWatcher | null = null;
  let initialDemoCount = 0;

  if (mode === 'collection') {
    manifestWatcher = await createInMemoryManifestWatcher({
      rootDir: inspection.rootRealpath,
      onUpdate({ demoCount }) {
        options.onManifestUpdate?.(demoCount);
      },
      onError(error) {
        options.onWatchError?.(error);
      },
    });
    initialDemoCount = countDemos(manifestWatcher.getManifest());
  }

  let activeShell: ResolvedShell | null = null;
  if (mode === 'collection') {
    activeShell = await resolveActiveShell({
      explicitShell: options.explicitShell,
      cwd: baseCwd,
      homeDir: options.homeDir,
    });
  } else if (options.explicitShell !== undefined) {
    // Still validate explicit --shell early so typos aren't silently swallowed
    await resolveActiveShell({
      explicitShell: options.explicitShell,
      cwd: baseCwd,
      homeDir: options.homeDir,
    });
  }

  const siteMeta = resolveSiteMetadata(inspection.rootRealpath, options.site);
  const isCollectionRoot = mode === 'collection';

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendError(res, 405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
      return;
    }

    let requestUrl: URL;
    try {
      requestUrl = new URL(req.url ?? '/', `http://${SERVE_HOST}:${port || DEFAULT_SERVE_PORT}`);
    } catch {
      sendError(res, 400, 'Bad Request');
      return;
    }

    const result = await resolveSafePath(
      requestUrl.pathname,
      inspection.rootDir,
      inspection.rootRealpath,
      isCollectionRoot,
    );

    if (result.status === 301) {
      res.writeHead(301, {
        ...BASE_SECURITY_HEADERS,
        Location: result.redirect,
      });
      res.end();
      return;
    }

    // Serve in-memory demos.json at /demos.json in collection mode if not present on disk
    if (result.status === 404 && isCollectionRoot && manifestWatcher && requestUrl.pathname === '/demos.json') {
      const content = Buffer.from(manifestWatcher.getSerialized(), 'utf8');
      res.writeHead(200, {
        ...BUILTIN_SHELL_SECURITY_HEADERS,
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': content.byteLength,
      });
      if (req.method === 'HEAD') {
        res.end();
      } else {
        res.end(content);
      }
      return;
    }

    // Fall back to active shell assets in collection mode whenever a root asset is not on disk
    if (result.status === 404 && isCollectionRoot && activeShell) {
      const shellAsset = await resolveShellAssetForRequest(requestUrl.pathname, activeShell);
      if (shellAsset) {
        // Never overwrite an existing root index.html (handled by resolveSafePath returning 200 above)
        const ext = path.extname(shellAsset.filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';
        const securityHeaders = shellAsset.fromBuiltin
          ? BUILTIN_SHELL_SECURITY_HEADERS
          : CUSTOM_SHELL_SECURITY_HEADERS;

        try {
          let content: Buffer;
          if (shellAsset.isIndexHtml) {
            const templateHtml = await fs.readFile(shellAsset.filePath, 'utf8');
            content = Buffer.from(
              renderShellIndexHtml(templateHtml, siteMeta, { includeMissingDemoWarning: true }),
              'utf8',
            );
          } else {
            content = await fs.readFile(shellAsset.filePath);
          }

          res.writeHead(200, {
            ...securityHeaders,
            'Content-Type': contentType,
            'Content-Length': content.byteLength,
          });
          if (req.method === 'HEAD') {
            res.end();
          } else {
            res.end(content);
          }
        } catch {
          sendError(res, 500, 'Internal Server Error');
        }
        return;
      }
    }

    if (result.status === 501) {
      const content = Buffer.from(result.errorHtml, 'utf8');
      res.writeHead(501, {
        ...BASE_SECURITY_HEADERS,
        'Content-Security-Policy': result.csp,
        'Content-Type': MIME_TYPES['.html']!,
        'Content-Length': content.byteLength,
      });
      if (req.method === 'HEAD') {
        res.end();
      } else {
        res.end(content);
      }
      return;
    }

    if (result.status === 200 && 'virtualHtml' in result) {
      const content = Buffer.from(result.virtualHtml, 'utf8');
      res.writeHead(200, {
        ...BASE_SECURITY_HEADERS,
        'Content-Type': result.contentType,
        'Content-Length': content.byteLength,
      });
      if (req.method === 'HEAD') {
        res.end();
      } else {
        res.end(content);
      }
      return;
    }

    if (result.status !== 200) {
      sendError(res, result.status, result.message);
      return;
    }

    const ext = path.extname(result.filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';

    try {
      let content: Buffer;
      if (ext === '.html' && (!isCollectionRoot || path.dirname(result.filePath) !== inspection.rootRealpath)) {
        const blockResult = await resolveServedHtmlWithBlocks({
          filePath: result.filePath,
          rootRealpath: inspection.rootRealpath,
        });
        content = blockResult.transformed
          ? Buffer.from(blockResult.html, 'utf8')
          : await fs.readFile(result.filePath);
      } else {
        content = await fs.readFile(result.filePath);
      }
      res.writeHead(200, {
        ...BASE_SECURITY_HEADERS,
        'Content-Type': contentType,
        'Content-Length': content.byteLength,
      });
      if (req.method === 'HEAD') {
        res.end();
      } else {
        res.end(content);
      }
    } catch {
      sendError(res, 500, 'Internal Server Error');
    }
  };

  const server = http.createServer((req, res) => {
    void handleRequest(req, res).catch(() => {
      if (!res.headersSent) {
        sendError(res, 500, 'Internal Server Error');
      }
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, SERVE_HOST, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    manifestWatcher?.close();
    throw error;
  }

  const address = server.address();
  const boundPort = typeof address === 'object' && address ? address.port : port;
  const url = `http://${SERVE_HOST}:${boundPort}`;

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    manifestWatcher?.close();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  };

  return {
    server,
    url,
    port: boundPort,
    host: SERVE_HOST,
    mode,
    inspection,
    demoCount: initialDemoCount,
    shell: activeShell,
    close,
  };
}
