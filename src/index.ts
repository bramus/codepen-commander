export { CodePenClient, DEFAULT_API_BASE_URL, MAX_FILE_BYTES, MAX_MULTIPART_BYTES } from './api/client.js';
export type { CodePenClientOptions, SettleBuildOptions } from './api/client.js';
export { CodePenApiError, isCodePenApiError } from './api/errors.js';
export {
  API_KEY_ENV_VAR,
  API_KEY_FILENAME,
  CODEPEN_API_SETTINGS_URL,
  DEFAULT_PROFILE_NAME,
  findMatchingProfile,
  getApiKeyFilePath,
  getKeyType,
  isValidProfileName,
  maskApiKey,
  parseAuthStoreContent,
  readAuthStore,
  removeApiKeyFile,
  removeProfileFromFile,
  requireAuth,
  resolveAuth,
  saveApiKeyToFile,
  saveProfileToFile,
  setDefaultProfile,
  validateProfileName,
  writeAuthStore,
} from './config/auth.js';
export type {
  ApiKeyType,
  AuthOptions,
  AuthSource,
  AuthStore,
  ReadAuthStoreResult,
  ResolvedAuth,
} from './config/auth.js';
export {
  buildSyncedFileMap,
  extractCodePenOwnerFromUrl,
  findProject,
  normalizePenReference,
  PROJECT_CONFIG_FILENAME,
  readProjectConfig,
  requireProject,
  slugifyTitle,
  suggestFolderName,
  writeProjectConfig,
} from './config/project.js';
export type { ProjectLocation } from './config/project.js';
export {
  buildStarterFiles,
  getPresetFilePaths,
  normalizeScaffoldPreset,
  parseCustomFileList,
  VALID_SCAFFOLD_PRESETS,
} from './commands/scaffold.js';
export type { ScaffoldPreset } from './commands/scaffold.js';
export { computeSyncDiff, detectLocalChangesFromBaseline, hasDiffChanges } from './sync/diff.js';
export type { ComputeDiffOptions, DiffItem, SyncDiff } from './sync/diff.js';
export {
  deleteLocalFile,
  isBinaryBuffer,
  normalizePenPath,
  resolveSafeLocalPath,
  scanLocalFiles,
  sha256Hex,
  writeLocalFile,
} from './sync/fs.js';
export type { LocalFile } from './sync/fs.js';
export { applyCompilerPatchesToDisk, syncRemoteFilesToDisk } from './sync/materialize.js';
export type { MaterializeResult } from './sync/materialize.js';
export { escapeHtml, extractHtmlTitle } from './utils/html.js';
export type * from './types.js';
