export const CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f]/;

const ACRONYMS = new Map<string, string>([
  ['ai', 'AI'],
  ['api', 'API'],
  ['apis', 'APIs'],
  ['aria', 'ARIA'],
  ['cls', 'CLS'],
  ['css', 'CSS'],
  ['cwv', 'CWV'],
  ['dom', 'DOM'],
  ['html', 'HTML'],
  ['http', 'HTTP'],
  ['inp', 'INP'],
  ['js', 'JS'],
  ['json', 'JSON'],
  ['lcp', 'LCP'],
  ['mcp', 'MCP'],
  ['pwa', 'PWA'],
  ['svg', 'SVG'],
  ['ui', 'UI'],
  ['url', 'URL'],
  ['ux', 'UX'],
  ['wasm', 'WASM'],
  ['webgl', 'WebGL'],
  ['webgpu', 'WebGPU'],
  ['webmcp', 'WebMCP'],
]);

const MINOR_WORDS = new Set([
  'a',
  'an',
  'and',
  'as',
  'at',
  'by',
  'for',
  'from',
  'in',
  'of',
  'on',
  'or',
  'the',
  'to',
  'with',
]);

export function hasControlChars(value: string): boolean {
  return CONTROL_CHAR_PATTERN.test(value);
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function isLoopbackHost(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
}

export function compareNatural(a: string, b: string): number {
  return a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });
}

export function normalizePlainText(value: unknown, maxLength: number): string | null {
  const cleaned = String(value).replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength - 1)}…` : cleaned;
}

export function formatFolderTitle(folderName: string): string {
  const words = folderName.split(/[-_]+/).filter(Boolean);
  return words
    .map((word, index) => {
      const lower = word.toLowerCase();
      const acronym = ACRONYMS.get(lower);
      if (acronym) {
        return acronym;
      }
      if (index > 0 && index < words.length - 1 && MINOR_WORDS.has(lower)) {
        return lower;
      }
      return (word[0]?.toUpperCase() ?? '') + word.slice(1);
    })
    .join(' ');
}

/**
 * Converts a Pen title into a safe directory-name slug, or returns null for empty / "Untitled".
 */
export function slugifyTitle(rawTitle: string | undefined | null): string | null {
  const title = (rawTitle ?? '').trim();
  if (!title || title.toLowerCase() === 'untitled') {
    return null;
  }
  const slug = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  if (!slug || slug === '.' || slug === '..') {
    return null;
  }
  return slug;
}
