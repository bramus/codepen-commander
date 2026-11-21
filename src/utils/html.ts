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

export function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function decodeHtmlEntities(input: string): string {
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
 * Extracts and cleans the `<meta name="description" content="...">` value from HTML.
 */
export function extractMetaDescription(html: string, maxLength = 320): string | null {
  if (!html) return null;

  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, '');
  const metaTagPattern = /<meta\b[^>]{1,1000}>/gi;
  const attrPattern = /([a-zA-Z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;

  for (const tagMatch of withoutComments.matchAll(metaTagPattern)) {
    let metaName: string | null = null;
    let metaContent: string | null = null;

    for (const attrMatch of tagMatch[0].matchAll(attrPattern)) {
      const key = attrMatch[1]?.toLowerCase();
      const value = attrMatch[2] ?? attrMatch[3] ?? attrMatch[4] ?? '';
      if (key === 'name') {
        metaName = value.trim().toLowerCase();
      } else if (key === 'content') {
        metaContent = value;
      }
    }

    if (metaName === 'description' && metaContent !== null) {
      const cleaned = decodeHtmlEntities(metaContent).replace(/\s+/g, ' ').trim();
      if (!cleaned) return null;
      return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength - 1)}…` : cleaned;
    }
  }

  return null;
}
