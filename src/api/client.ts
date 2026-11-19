import path from 'node:path';
import type {
  ApiErrorBody,
  BinaryUploadPart,
  Build,
  Deployment,
  FilesWriteRequest,
  FilesWriteResult,
  ListPensParams,
  ListVersionsParams,
  PaginatedResult,
  Pen,
  PenCreateRequest,
  PenDomain,
  PenFile,
  PenForkRequest,
  PenSettings,
  PenUpdateRequest,
  SettingsUpdateRequest,
  Version,
} from '../types.js';
import { extractPenIdFromUrl } from '../config/project.js';
import { CodePenApiError } from './errors.js';

export const DEFAULT_API_BASE_URL = 'https://api.codepen.io';

/** Conservative threshold (12 MB) under CodePen's 16 MB JSON body limit before switching to multipart. */
const JSON_BODY_LIMIT_BYTES = 12 * 1024 * 1024;
/** CodePen's documented max multipart request size (120 MB). */
export const MAX_MULTIPART_BYTES = 120 * 1024 * 1024;
/** CodePen's documented max single file size (30 MB). */
export const MAX_FILE_BYTES = 30 * 1024 * 1024;

export interface CodePenClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface SettleBuildOptions {
  pollIntervalMs?: number;
  maxPollTimeMs?: number;
  onUpdate?: (build: Build) => void;
}

function isLocalLoopbackHost(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
}

function validateApiBaseUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid API base URL: ${rawUrl}`);
  }

  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLocalLoopbackHost(parsed.hostname))) {
    throw new Error(`Refusing non-HTTPS API base URL: ${rawUrl}`);
  }

  return parsed;
}

export function parseLinkHeader(header: string | null): PaginatedResult<unknown>['links'] {
  const links: PaginatedResult<unknown>['links'] = {};
  if (!header) return links;

  for (const part of header.split(',')) {
    const match = part.trim().match(/^<([^>]+)>;\s*rel="(next|prev|first|last)"$/);
    if (match?.[1] && match[2]) {
      const rel = match[2] as 'next' | 'prev' | 'first' | 'last';
      links[rel] = match[1];
    }
  }
  return links;
}

export function encodePenId(penIdOrUrl: string): string {
  const trimmed = penIdOrUrl.trim();
  const extracted = extractPenIdFromUrl(trimmed);
  return encodeURIComponent(extracted ?? trimmed);
}

export class CodePenClient {
  private readonly apiKey: string;
  private readonly baseUrl: URL;
  private readonly fetchImpl: typeof fetch;

  constructor(options: CodePenClientOptions) {
    if (!options.apiKey || !options.apiKey.trim()) {
      throw new Error('A CodePen API key is required.');
    }
    this.apiKey = options.apiKey.trim();
    this.baseUrl = validateApiBaseUrl(options.baseUrl ?? DEFAULT_API_BASE_URL);
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  private buildUrl(endpointPath: string, query?: Record<string, string | number | boolean | undefined>): string {
    const url = new URL(endpointPath, this.baseUrl);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      }
    }
    return url.toString();
  }

  private async requestRaw(
    method: string,
    endpointOrUrl: string,
    options: {
      query?: Record<string, string | number | boolean | undefined>;
      json?: unknown;
      formData?: FormData;
    } = {},
  ): Promise<Response> {
    let targetUrl: string;
    if (endpointOrUrl.startsWith('http://') || endpointOrUrl.startsWith('https://')) {
      const parsed = new URL(endpointOrUrl);
      if (parsed.origin !== this.baseUrl.origin) {
        throw new Error(`Refusing to send API credentials to unexpected origin: ${parsed.origin}`);
      }
      targetUrl = parsed.toString();
    } else {
      targetUrl = this.buildUrl(endpointOrUrl, options.query);
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: 'application/json',
    };

    let body: string | FormData | undefined;
    if (options.formData !== undefined) {
      body = options.formData;
    } else if (options.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.json);
    }

    const response = await this.fetchImpl(targetUrl, {
      method,
      headers,
      body,
    });

    if (!response.ok) {
      let parsedBody: Partial<ApiErrorBody> & { error?: string } = {};
      try {
        const text = await response.text();
        if (text) {
          parsedBody = JSON.parse(text) as Partial<ApiErrorBody> & { error?: string };
        }
      } catch {
        // Non-JSON error body; keep fallback status message
      }
      throw new CodePenApiError(response.status, parsedBody);
    }

    return response;
  }

  private async requestJson<T>(
    method: string,
    endpointOrUrl: string,
    options: {
      query?: Record<string, string | number | boolean | undefined>;
      json?: unknown;
      formData?: FormData;
    } = {},
  ): Promise<T> {
    const response = await this.requestRaw(method, endpointOrUrl, options);
    return (await response.json()) as T;
  }

  /**
   * Verifies that the configured API key is accepted by CodePen API v2.
   * CodePen API v2 does not expose a `/me` endpoint; listing 1 Pen validates auth
   * and optionally lets callers inspect a sample Pen URL to suggest a profile name.
   */
  public async verifyAuth(): Promise<Pen | null> {
    const response = await this.requestRaw('GET', '/v2/pens', { query: { per_page: 1 } });
    try {
      const items = (await response.json()) as unknown;
      if (Array.isArray(items) && items.length > 0 && items[0] && typeof items[0] === 'object') {
        return items[0] as Pen;
      }
    } catch {
      // Ignore empty or non-JSON bodies; 2xx status already verified the key
    }
    return null;
  }

  public async listPens(params: ListPensParams = {}): Promise<PaginatedResult<Pen>> {
    const response = await this.requestRaw('GET', '/v2/pens', {
      query: {
        page: params.page,
        per_page: params.per_page,
        sort: params.sort,
        direction: params.direction,
        access: params.access,
        deployed: params.deployed,
        template: params.template,
        forks: params.forks,
        editor: params.editor,
        tags: params.tags,
        search_term: params.search_term,
        untitled: params.untitled,
        block: params.block,
        cursor: params.cursor,
      },
    });
    const items = (await response.json()) as Pen[];
    const links = parseLinkHeader(response.headers.get('link'));
    return { items, links };
  }

  public async listPensPageByUrl(nextUrl: string): Promise<PaginatedResult<Pen>> {
    const response = await this.requestRaw('GET', nextUrl);
    const items = (await response.json()) as Pen[];
    const links = parseLinkHeader(response.headers.get('link'));
    return { items, links };
  }

  public async getPen(penIdOrUrl: string): Promise<Pen> {
    return this.requestJson<Pen>('GET', `/v2/pens/${encodePenId(penIdOrUrl)}`);
  }

  public async createPen(
    payload: PenCreateRequest = {},
    binaryFiles: BinaryUploadPart[] = [],
  ): Promise<Pen> {
    const jsonString = JSON.stringify(payload);
    const useMultipart =
      binaryFiles.length > 0 || Buffer.byteLength(jsonString, 'utf8') > JSON_BODY_LIMIT_BYTES;

    if (!useMultipart) {
      return this.requestJson<Pen>('POST', '/v2/pens', { json: payload });
    }

    const form = new FormData();
    const { wait, ...penBody } = payload;
    form.append('pen', JSON.stringify(penBody));

    let totalBytes = Buffer.byteLength(jsonString, 'utf8');
    for (const part of binaryFiles) {
      if (part.content.length === 0) {
        throw new Error(`Empty binary upload part is not allowed for ${part.path}; send empty files as text.`);
      }
      if (part.content.length > MAX_FILE_BYTES) {
        throw new Error(`File ${part.path} exceeds CodePen's 30 MB per-file limit.`);
      }
      totalBytes += part.content.length;
      if (totalBytes > MAX_MULTIPART_BYTES) {
        throw new Error(`Upload exceeds CodePen's 120 MB multipart request limit.`);
      }
      const normalizedPath = part.path.startsWith('/') ? part.path : `/${part.path}`;
      const filename = path.posix.basename(normalizedPath);
      form.append(normalizedPath, new Blob([new Uint8Array(part.content)], { type: 'application/octet-stream' }), filename);
    }

    return this.requestJson<Pen>('POST', '/v2/pens', {
      query: wait !== undefined ? { wait } : undefined,
      formData: form,
    });
  }

  public async forkPen(penIdOrUrl: string, payload: PenForkRequest = {}): Promise<Pen> {
    return this.requestJson<Pen>('POST', `/v2/pens/${encodePenId(penIdOrUrl)}/fork`, {
      json: payload,
    });
  }

  public async updatePen(penId: string, payload: PenUpdateRequest): Promise<Pen> {
    return this.requestJson<Pen>('PATCH', `/v2/pens/${encodePenId(penId)}`, { json: payload });
  }

  public async deletePen(penId: string): Promise<void> {
    await this.requestRaw('DELETE', `/v2/pens/${encodePenId(penId)}`);
  }

  public async updateSettings(penId: string, payload: SettingsUpdateRequest): Promise<PenSettings> {
    return this.requestJson<PenSettings>('PATCH', `/v2/pens/${encodePenId(penId)}/settings`, {
      json: payload,
    });
  }

  public async getPenFiles(penId: string): Promise<PenFile[]> {
    return this.requestJson<PenFile[]>('GET', `/v2/pens/${encodePenId(penId)}/files`);
  }

  public async writePenFiles(
    penId: string,
    request: FilesWriteRequest,
    binaryFiles: BinaryUploadPart[] = [],
  ): Promise<FilesWriteResult> {
    const jsonString = JSON.stringify(request);
    const useMultipart =
      binaryFiles.length > 0 || Buffer.byteLength(jsonString, 'utf8') > JSON_BODY_LIMIT_BYTES;

    if (!useMultipart) {
      return this.requestJson<FilesWriteResult>('PUT', `/v2/pens/${encodePenId(penId)}/files`, {
        json: request,
      });
    }

    const form = new FormData();
    const { wait, dry_run, expected_version_id, ...changesRest } = request;
    const changesBody: FilesWriteRequest = {
      ...changesRest,
      ...(expected_version_id ? { expected_version_id } : {}),
    };
    form.append('changes', JSON.stringify(changesBody));
    if (expected_version_id) {
      form.append('expected_version_id', expected_version_id);
    }

    let totalBytes = Buffer.byteLength(JSON.stringify(changesBody), 'utf8');
    for (const part of binaryFiles) {
      if (part.content.length === 0) {
        throw new Error(`Empty binary upload part is not allowed for ${part.path}; send empty files as text.`);
      }
      if (part.content.length > MAX_FILE_BYTES) {
        throw new Error(`File ${part.path} exceeds CodePen's 30 MB per-file limit.`);
      }
      totalBytes += part.content.length;
      if (totalBytes > MAX_MULTIPART_BYTES) {
        throw new Error(`Upload exceeds CodePen's 120 MB multipart request limit.`);
      }
      const normalizedPath = part.path.startsWith('/') ? part.path : `/${part.path}`;
      const filename = path.posix.basename(normalizedPath);
      form.append(normalizedPath, new Blob([new Uint8Array(part.content)], { type: 'application/octet-stream' }), filename);
    }

    return this.requestJson<FilesWriteResult>('PUT', `/v2/pens/${encodePenId(penId)}/files`, {
      query: {
        wait,
        dry_run,
      },
      formData: form,
    });
  }

  /**
   * Downloads raw file bytes from a signed CodePen `download_url`.
   * Intentionally sends NO Authorization header (signed URLs are self-authenticating).
   */
  public async downloadFile(downloadUrl: string): Promise<Buffer> {
    let parsed: URL;
    try {
      parsed = new URL(downloadUrl);
    } catch {
      throw new Error(`Invalid download URL: ${downloadUrl}`);
    }

    const isAllowedLocalMock =
      this.baseUrl.protocol === 'http:' &&
      isLocalLoopbackHost(this.baseUrl.hostname) &&
      parsed.origin === this.baseUrl.origin;

    if (parsed.protocol !== 'https:' && !isAllowedLocalMock) {
      throw new Error(`Refusing to download file over insecure protocol: ${parsed.protocol}`);
    }

    const response = await this.fetchImpl(parsed.toString(), {
      method: 'GET',
    });

    if (!response.ok) {
      let parsedBody: Partial<ApiErrorBody> & { error?: string } = {};
      try {
        const text = await response.text();
        if (text) {
          parsedBody = JSON.parse(text) as Partial<ApiErrorBody> & { error?: string };
        }
      } catch {
        // Ignore non-JSON error
      }
      throw new CodePenApiError(response.status, parsedBody);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  public async getVersion(versionId: string): Promise<Version> {
    return this.requestJson<Version>('GET', `/v2/versions/${encodeURIComponent(versionId)}`);
  }

  public async listVersions(penId: string, params: ListVersionsParams = {}): Promise<PaginatedResult<Version>> {
    const response = await this.requestRaw('GET', `/v2/pens/${encodePenId(penId)}/versions`, {
      query: {
        page: params.page,
        per_page: params.per_page,
        sort: params.sort,
        direction: params.direction,
      },
    });
    const items = (await response.json()) as Version[];
    const links = parseLinkHeader(response.headers.get('link'));
    return { items, links };
  }

  public async restoreVersion(penId: string, versionId: string, label?: string): Promise<Pen> {
    return this.requestJson<Pen>(
      'POST',
      `/v2/pens/${encodePenId(penId)}/versions/${encodeURIComponent(versionId)}/restore`,
      {
        query: label ? { label } : undefined,
      },
    );
  }

  public async getBuild(buildId: string, wait?: number): Promise<Build> {
    return this.requestJson<Build>('GET', `/v2/builds/${encodeURIComponent(buildId)}`, {
      query: wait !== undefined ? { wait } : undefined,
    });
  }

  /**
   * Polls a CodePen build until it settles (`Success`, `Failed`, or `Canceled` with no `next_id`).
   * Follows `next_id` automatically when the compiler applies patches and queues a follow-up build.
   */
  public async settleBuild(initialBuild: Build, options: SettleBuildOptions = {}): Promise<Build> {
    const pollIntervalMs = options.pollIntervalMs ?? 2000;
    const maxPollTimeMs = options.maxPollTimeMs ?? 5 * 60 * 1000;
    const started = Date.now();

    let current = initialBuild;
    options.onUpdate?.(current);

    for (;;) {
      const isRunning = current.status === 'Queued' || current.status === 'Running';
      const nextId = current.status === 'Canceled' ? current.next_id : null;

      if (!isRunning && !nextId) {
        return current;
      }

      if (Date.now() - started > maxPollTimeMs) {
        throw new Error(
          `Timed out waiting for build ${current.id} to settle (last status: ${current.status}).`,
        );
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      const targetBuildId = nextId ?? current.id;
      current = await this.getBuild(targetBuildId);
      options.onUpdate?.(current);
    }
  }

  public async deployPen(penId: string, versionId?: string): Promise<Deployment> {
    return this.requestJson<Deployment>('PUT', `/v2/pens/${encodePenId(penId)}/deployment`, {
      json: versionId ? { version_id: versionId } : {},
    });
  }

  public async undeployPen(penId: string): Promise<void> {
    await this.requestRaw('DELETE', `/v2/pens/${encodePenId(penId)}/deployment`);
  }

  public async listDomains(penId: string): Promise<PenDomain[]> {
    return this.requestJson<PenDomain[]>('GET', `/v2/pens/${encodePenId(penId)}/domains`);
  }

  public async addDomain(penId: string, host: string): Promise<PenDomain[]> {
    return this.requestJson<PenDomain[]>('POST', `/v2/pens/${encodePenId(penId)}/domains`, {
      json: { host },
    });
  }

  public async removeDomain(penId: string, host: string): Promise<PenDomain[]> {
    return this.requestJson<PenDomain[]>(
      'DELETE',
      `/v2/pens/${encodePenId(penId)}/domains/${encodeURIComponent(host)}`,
    );
  }
}
