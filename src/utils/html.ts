const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  copy: '©',
};

function decodeHtmlEntities(input: string): string {
  return input.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const codePoint = Number.parseInt(entity.slice(2), 16);
      if (isValidCodePoint(codePoint)) {
        return String.fromCodePoint(codePoint);
      }
      return match;
    }
    if (entity.startsWith('#')) {
      const codePoint = Number.parseInt(entity.slice(1), 10);
      if (isValidCodePoint(codePoint)) {
        return String.fromCodePoint(codePoint);
      }
      return match;
    }
    const named = NAMED_ENTITIES[entity.toLowerCase()];
    return named ?? match;
  });
}

function isValidCodePoint(cp: number): boolean {
  return Number.isInteger(cp) && cp >= 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff);
}

/**
 * Extracts and cleans the text inside an HTML document's `<title>` tag,
 * ignoring HTML comments and decoding common HTML entities.
 */
export function extractHtmlTitle(html: string): string | null {
  if (!html) return null;

  // Strip HTML comments so commented-out <title> tags are ignored
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, '');
  const match = withoutComments.match(/<title(?:\s[^>]*)?>([\s\S]*?)<\/title>/i);
  if (!match?.[1]) {
    return null;
  }

  const decoded = decodeHtmlEntities(match[1]).replace(/\s+/g, ' ').trim();
  return decoded || null;
}

/**
 * Escapes HTML special characters for safe interpolation inside text nodes and attributes.
 */
export function escapeHtml(input: string): string {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
