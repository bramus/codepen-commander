export type PenAccess = 'Public' | 'Private' | 'Protected' | 'Collaborators';
export type PenEditor = 'V2' | 'Classic';
export type BuildStatus = 'Queued' | 'Running' | 'Success' | 'Failed' | 'Canceled';
export type DiagnosticType = 'Error' | 'Warning' | 'Information' | 'Hint' | 'Patch';
export type DiagnosticScope = 'Build' | 'BuildStep' | 'File';
export type DomainStatus = 'Pending' | 'Verified' | 'Misconfigured';
export type IndentWith = 'tabs' | 'spaces';
export type SortDirection = 'asc' | 'desc';
export type PenSortField = 'created' | 'updated' | 'popularity' | 'title';
export type BasicSortField = 'created' | 'updated';
export type ForkFilter = 'All' | 'Forked' | 'NotForked';

export type ApiErrorCode =
  | 'BAD_USER_INPUT'
  | 'BUILD_TIMEOUT'
  | 'CONFLICT'
  | 'FORBIDDEN'
  | 'INTERNAL'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'UNAUTHENTICATED';

export interface ApiErrorBody {
  message: string;
  code: ApiErrorCode | string;
  build_id?: string;
  current_version_id?: string;
  expected_version_id?: string;
  details?: Record<string, unknown>;
  field?: string;
  limit?: number;
  reset_at?: string | null;
  retry_after_seconds?: number;
}

export interface PenUrls {
  editor: string;
  preview: string;
}

export interface ScreenshotUrls {
  small: string;
  medium: string;
  large: string;
  xlarge: string;
}

export interface PenSettings {
  auto_deploy: boolean;
  auto_run: boolean;
  auto_save: boolean;
  indent_with: string;
  tab_size: number;
}

export interface SettingsUpdateRequest {
  auto_deploy?: boolean;
  auto_run?: boolean;
  auto_save?: boolean;
  indent_with?: IndentWith;
  tab_size?: number;
}

export interface Deployment {
  id: string;
  version_id: string;
  url: string;
  custom_domains: string[];
  created_at: string;
  updated_at: string;
}

export interface DnsRecord {
  type: string;
  name: string;
  value: string;
}

export interface PenDomain {
  id: string;
  host: string;
  status: DomainStatus;
  dns: DnsRecord[];
  cname_record: string;
  a_record: string;
  created_at: string;
}

export interface PenFile {
  id: string;
  path: string;
  name: string;
  content_hash: string;
  is_binary: boolean;
  bytes: number;
  content_type: string;
  content: string | null;
  url: string | null;
  download_url: string | null;
}

export interface FileLocation {
  line: number;
  column: number;
  position: number | null;
}

export interface FileRange {
  start: FileLocation;
  end: FileLocation | null;
}

export interface BuildDiagnostic {
  type: DiagnosticType;
  scope: DiagnosticScope;
  message: string;
  code: string | null;
  url: string | null;
  block_name: string | null;
  path: string | null;
  file_id: string | null;
  range: FileRange | null;
}

export interface BuildPatch {
  type: 'create' | 'update' | 'delete' | string;
  path: string;
  file_id: string | null;
  content: string | null;
}

export interface Build {
  id: string;
  status: BuildStatus;
  started_at: string | null;
  ended_at: string | null;
  rounds: number;
  diagnostics: BuildDiagnostic[];
  errors: BuildDiagnostic[];
  applied_patches: BuildPatch[];
  patches: BuildPatch[];
  files?: PenFile[];
  version_id: string | null;
  next_id: string | null;
  previous_id: string | null;
}

export interface Version {
  id: string;
  pen_id: string;
  hash: string;
  created_at: string;
  deployed: boolean;
  saved: boolean;
  label: string | null;
  build: Build | null;
  preview_url: string | null;
  files?: PenFile[];
}

export interface Pen {
  id: string;
  title: string;
  description: string;
  tags: string[];
  access: PenAccess;
  password: string | null;
  template: boolean;
  popularity: number;
  views_count: number;
  loves_count: number;
  editor: PenEditor;
  created_at: string;
  updated_at: string;
  urls: PenUrls;
  screenshot_urls: ScreenshotUrls | null;
  saved_version: Version | null;
  deployment: Deployment | null;
  settings: PenSettings;
  build?: Build | null;
}

export interface FileChange {
  id?: string;
  path?: string;
  content?: string;
  delete?: boolean;
}

export interface FilesWriteRequest {
  files: FileChange[];
  label?: string;
  expected_version_id?: string;
  wait?: number;
  dry_run?: boolean;
}

export interface FilesWriteResult {
  pen: Pen | null;
  version: Version | null;
  build: Build | null;
}

export interface PenFileRequest {
  path: string;
  content: string;
}

export interface PenCreateRequest {
  title?: string;
  description?: string;
  tags?: string[];
  access?: PenAccess;
  password?: string;
  template?: boolean;
  files?: PenFileRequest[];
  wait?: number;
}

export interface PenForkRequest {
  title?: string;
  description?: string;
  tags?: string[];
  access?: PenAccess;
  password?: string;
  wait?: number;
}

export interface PenUpdateRequest {
  title?: string;
  description?: string;
  tags?: string[];
  access?: PenAccess;
  password?: string;
  template?: boolean;
}

export interface BinaryUploadPart {
  /** Full path in the Pen, with leading `/` (e.g. `/img/logo.png`). */
  path: string;
  content: Buffer;
}

export interface ListPensParams {
  page?: number;
  per_page?: number;
  sort?: PenSortField;
  direction?: SortDirection;
  access?: string;
  deployed?: boolean;
  template?: boolean;
  forks?: ForkFilter;
  editor?: PenEditor;
  tags?: string;
  search_term?: string;
  untitled?: boolean;
  block?: string;
  cursor?: string;
}

export interface ListVersionsParams {
  page?: number;
  per_page?: number;
  sort?: BasicSortField;
  direction?: SortDirection;
}

export interface PaginatedResult<T> {
  items: T[];
  links: {
    next?: string;
    prev?: string;
    first?: string;
    last?: string;
  };
}

/** Per-file sync baseline stored inside `.cdpn.json`. */
export interface SyncedFileEntry {
  id: string;
  content_hash: string;
  local_sha256: string;
  is_binary: boolean;
}

/** Editable Pen metadata stored under `info` in `.cdpn.json`. */
export interface PenInfo {
  title?: string;
  description?: string;
  tags?: string[];
  access?: PenAccess;
  template?: boolean;
}

/** Fully populated Pen metadata extracted from CodePen API v2. */
export type CompletePenInfo = Required<PenInfo>;

/** Local Pen sync metadata stored in `.cdpn.json` at the Pen folder root. */
export interface CdpnConfig {
  url: string;
  pen_id: string;
  profile?: string;
  last_synced_version_id: string | null;
  last_synced_info_hash?: string;
  editor?: PenEditor;
  info?: PenInfo;
  files?: Record<string, SyncedFileEntry>;
}
