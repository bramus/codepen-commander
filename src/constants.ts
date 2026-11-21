import type { PenAccess } from './api/types.js';

export const PROJECT_CONFIG_FILENAME = '.cdpn.json';
export const IGNORE_FILENAME = '.cdpnignore';
export const CODEPEN_DIR = '.codepen';
export const PEN_CONFIG_FILENAME = 'pen.config.json';
export const CLASSIC_CONFIG_FILENAME = 'classic.config.json';
export const PEN_HTML_SUFFIX = '.pen.html';

export const CODEPEN_API_SETTINGS_URL = 'https://codepen.io/settings/api';
export const CODEPEN_DELETED_ITEMS_URL = 'https://codepen.io/your-work?item_type=DELETED_ITEMS';

/** CodePen's documented max multipart request size (120 MB). */
export const MAX_MULTIPART_BYTES = 120 * 1024 * 1024;
/** CodePen's documented max single file size (30 MB). */
export const MAX_FILE_BYTES = 30 * 1024 * 1024;
/** CodePen's documented max tags per Pen. */
export const MAX_PEN_TAGS = 5;
/** CodePen's documented max version label length. */
export const MAX_VERSION_LABEL_LENGTH = 80;
/** CodePen's documented minimum password length for Protected Pens. */
export const MIN_PROTECTED_PASSWORD_LENGTH = 8;

export const VALID_PEN_ACCESS_LOWER = new Set<string>([
  'public',
  'private',
  'protected',
  'collaborators',
]);

export interface PenAccessChoice {
  value: PenAccess;
  label: string;
  description: string;
}

export const PEN_ACCESS_CHOICES: readonly PenAccessChoice[] = Object.freeze([
  { value: 'Public', label: 'Public', description: 'visible to everyone' },
  {
    value: 'Private',
    label: 'Private',
    description: 'unlisted; anyone with the link can view it',
  },
  {
    value: 'Protected',
    label: 'Protected',
    description: 'private and password-protected (min 8 chars)',
  },
  {
    value: 'Collaborators',
    label: 'Collaborators',
    description: 'private; visible only to you and collaborators',
  },
]);
