import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type {
  Build,
  Deployment,
  Pen,
  PenDomain,
  PenFile,
  PenSettings,
  TrashItem,
  Version,
} from '../../src/api/types.js';

export interface MockRequestContext {
  method: string;
  pathname: string;
  searchParams: URLSearchParams;
  url: URL;
  headers: IncomingMessage['headers'];
  rawBody: Buffer;
  jsonBody: () => Record<string, unknown>;
}

export interface MockJsonResponse {
  status?: number;
  body?: unknown;
  rawBody?: string | Buffer;
  contentType?: string;
  headers?: Record<string, string>;
}

export interface MockApiServer {
  baseUrl: string;
  requests: Array<{
    method: string;
    pathname: string;
    search: string;
    headers: IncomingMessage['headers'];
    body: string;
  }>;
  close: () => Promise<void>;
}

export function makeSettings(overrides: Partial<PenSettings> = {}): PenSettings {
  return {
    auto_deploy: false,
    auto_run: true,
    auto_save: true,
    indent_with: 'spaces',
    tab_size: 2,
    ...overrides,
  };
}

export function makeBuild(overrides: Partial<Build> = {}): Build {
  return {
    id: 'bld_0000000001',
    status: 'Success',
    started_at: '2026-01-01T00:00:00Z',
    ended_at: '2026-01-01T00:00:01Z',
    rounds: 1,
    diagnostics: [],
    errors: [],
    applied_patches: [],
    patches: [],
    version_id: 'ver_0000000001',
    next_id: null,
    previous_id: null,
    ...overrides,
  };
}

export function makeVersion(overrides: Partial<Version> = {}): Version {
  return {
    id: 'ver_0000000001',
    pen_id: 'cpid_test_1',
    hash: 'hash_v1',
    label: null,
    created_at: '2026-01-01T00:00:00Z',
    deployed: false,
    saved: true,
    build: makeBuild(),
    preview_url: 'https://cpid_test_1.codepen.dev/',
    ...overrides,
  };
}

export function makeDeployment(overrides: Partial<Deployment> = {}): Deployment {
  return {
    id: 'dep_0000000001',
    url: 'https://cpid_test_1.codepen.app/',
    version_id: 'ver_0000000001',
    custom_domains: [],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

export function makeDomain(overrides: Partial<PenDomain> = {}): PenDomain {
  return {
    id: 'dom_0000000001',
    host: 'demo.example.com',
    status: 'Verified',
    cname_record: 'custom.codepen.app',
    a_record: '1.2.3.4',
    dns: [],
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

export function makeTrashItem(overrides: Partial<TrashItem> = {}): TrashItem {
  return {
    id: 'tr_0000000001',
    item_id: 'cpid_test_1',
    type: 'Pen',
    title: 'Deleted Pen',
    deleted_at: '2026-01-01T00:00:00Z',
    expires_at: '2026-01-04T00:00:00Z',
    ...overrides,
  };
}

export function makePen(overrides: Partial<Pen> = {}): Pen {
  const id = overrides.id ?? 'cpid_test_1';
  const owner = 'bramus';
  return {
    id,
    title: 'Test Pen',
    description: '',
    tags: [],
    access: 'Public',
    password: null,
    template: false,
    popularity: 0,
    editor: 'V2',
    views_count: 10,
    loves_count: 2,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
    urls: {
      editor: `https://codepen.io/${owner}/pen/${id}`,
      preview: `https://${id}.codepen.dev/`,
    },
    screenshot_urls: null,
    settings: makeSettings(),
    saved_version: makeVersion({ pen_id: id }),
    deployment: null,
    ...overrides,
  };
}

export function makePenFile(
  filePath: string,
  content: string,
  overrides: Partial<PenFile> = {},
): PenFile {
  const normalizedPath = filePath.startsWith('/') ? filePath : `/${filePath}`;
  const name = normalizedPath.split('/').pop() ?? normalizedPath;
  return {
    id: `file_${filePath.replace(/[^a-z0-9]/gi, '_')}`,
    path: normalizedPath,
    name,
    is_binary: false,
    bytes: Buffer.byteLength(content, 'utf8'),
    content_type: 'text/plain',
    content_hash: 'hash_placeholder',
    content,
    url: null,
    download_url: null,
    ...overrides,
  };
}

export async function startMockCodePenServer(
  handler: (
    ctx: MockRequestContext,
  ) => Promise<MockJsonResponse | void> | MockJsonResponse | void,
): Promise<MockApiServer> {
  const requests: MockApiServer['requests'] = [];

  const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const rawBody = Buffer.concat(chunks);
    const parsedUrl = new URL(req.url ?? '/', 'http://127.0.0.1');

    requests.push({
      method: req.method ?? 'GET',
      pathname: parsedUrl.pathname,
      search: parsedUrl.search,
      headers: req.headers,
      body: rawBody.toString('utf8'),
    });

    try {
      const result = await handler({
        method: req.method ?? 'GET',
        pathname: parsedUrl.pathname,
        searchParams: parsedUrl.searchParams,
        url: parsedUrl,
        headers: req.headers,
        rawBody,
        jsonBody: () => JSON.parse(rawBody.toString('utf8') || '{}') as Record<string, unknown>,
      });

      if (!result) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            code: 'NOT_FOUND',
            message: `Unhandled ${req.method} ${parsedUrl.pathname}`,
          }),
        );
        return;
      }

      const status = result.status ?? 200;
      const extraHeaders = result.headers ?? {};
      if (status === 204) {
        res.writeHead(204, extraHeaders);
        res.end();
        return;
      }

      if (result.rawBody !== undefined) {
        const buf = Buffer.isBuffer(result.rawBody)
          ? result.rawBody
          : Buffer.from(result.rawBody, 'utf8');
        res.writeHead(status, {
          'Content-Type': result.contentType ?? 'application/octet-stream',
          'Content-Length': buf.byteLength,
          ...extraHeaders,
        });
        res.end(buf);
        return;
      }

      const payload = JSON.stringify(result.body ?? {});
      res.writeHead(status, {
        'Content-Type': result.contentType ?? 'application/json',
        'Content-Length': Buffer.byteLength(payload, 'utf8'),
        ...extraHeaders,
      });
      res.end(payload);
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          code: 'INTERNAL_ERROR',
          message: (error as Error).message,
        }),
      );
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
