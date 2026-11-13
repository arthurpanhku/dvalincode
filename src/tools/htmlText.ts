/**
 * Small HTML → text conversion for the web tools. Not a parser: it keeps what a
 * model needs from a page (title, headings, paragraphs, lists, links, code
 * blocks) and drops scripts, styles, navigation and markup.
 *
 * Entities are decoded exactly once, after every tag is stripped, so escaped
 * text such as `&lt;div&gt;` survives as `<div>` instead of being mistaken for
 * a tag and removed.
 *
 * Tag names end at `(?=[\s/>])` rather than `\b`, so a custom element such as
 * `<nav-menu>` is not taken for `<nav>`.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»',
  bull: '•', middot: '·', times: '×', deg: '°', larr: '←', rarr: '→',
};

/** Elements dropped with everything inside them. An unclosed one runs to the end. */
const DROPPED_ELEMENTS =
  /<(head|script|style|noscript|template|svg|math|iframe|object|canvas|select|nav|footer)(?=[\s/>])[\s\S]*?(?:<\/\1\s*>|$)/gi;
const PARAGRAPH_TAGS =
  /<\/?(?:p|div|section|article|aside|header|main|blockquote|figure|table|ul|ol|dl|details|form|fieldset|address)(?=[\s/>])[^>]*>/gi;
const LINE_TAGS = /<\/?(?:tr|dt|dd|summary|figcaption|caption)(?=[\s/>])[^>]*>/gi;
const BR_TAG = /<br(?=[\s/>])[^>]*>/gi;

function decodeEntities(text: string): string {
  return text.replace(/&(#\d{1,7}|#x[\da-f]{1,6}|[a-z][a-z\d]{1,9});/gi, (entity, body: string) => {
    if (body[0] !== '#') return NAMED_ENTITIES[body] ?? entity;
    const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  });
}

/** Inline markup, such as a page title or a search snippet, as one line of text. */
export function inlineHtmlToText(html: string): string {
  return decodeEntities(stripTags(html)).replace(/\s+/g, ' ').trim();
}

/** A whole page as readable text. Links are kept as `[label](absolute-url)`. */
export function htmlToText(html: string, baseUrl: string): { title: string; text: string } {
  const source = html.replace(/\u0000/g, '');
  const title = inlineHtmlToText(/<title(?=[\s/>])[^>]*>([\s\S]*?)<\/title\s*>/i.exec(source)?.[1] ?? '');
  const cleaned = source.replace(/<!--[\s\S]*?(?:-->|$)/g, '').replace(DROPPED_ELEMENTS, '');
  let body =
    /<main(?=[\s/>])[^>]*>([\s\S]*?)(?:<\/main\s*>|$)/i.exec(cleaned)?.[1] ??
    /<body(?=[\s/>])[^>]*>([\s\S]*?)(?:<\/body\s*>|$)/i.exec(cleaned)?.[1] ??
    cleaned;

  // Preformatted blocks keep their whitespace, so set them aside before the rest is collapsed.
  const preBlocks: string[] = [];
  body = body.replace(/<pre(?=[\s/>])[^>]*>([\s\S]*?)(?:<\/pre\s*>|$)/gi, (_match, inner: string) => {
    preBlocks.push(decodeEntities(stripTags(inner.replace(BR_TAG, '\n'))).replace(/^\n+|\s+$/g, ''));
    return `<p>\u0000${preBlocks.length - 1}\u0000</p>`;
  });

  const flattened = body
    .replace(/\s+/g, ' ')
    .replace(/<h([1-6])(?=[\s/>])[^>]*>(.*?)<\/h\1\s*>/gi, (_match, level: string, inner: string) =>
      `\n\n${'#'.repeat(Number(level))} ${stripTags(inner).trim()}\n\n`)
    .replace(/<a(?=[\s/>])([^>]*)>(.*?)<\/a\s*>/gi, (_match, attrs: string, inner: string) => renderLink(attrs, inner, baseUrl))
    .replace(/<li(?=[\s/>])[^>]*>/gi, '\n- ')
    .replace(BR_TAG, '\n')
    .replace(/<hr(?=[\s/>])[^>]*>/gi, '\n\n---\n\n')
    .replace(/<\/t[dh]\s*>/gi, ' | ')
    .replace(LINE_TAGS, '\n')
    .replace(PARAGRAPH_TAGS, '\n\n');

  const text = decodeEntities(stripTags(flattened))
    .split('\n')
    // Zero-width spaces come from heading anchors (VitePress, Docusaurus) and BOMs.
    .map(line => line.replace(/[​﻿]/g, '').replace(/[ \t ]+/g, ' ').replace(/\s*\|\s*$/, '').trim())
    .filter(line => line !== '-')
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .replace(/\u0000(\d+)\u0000/g, (_match, index: string) => `\`\`\`\n${preBlocks[Number(index)]}\n\`\`\``);

  return { title, text };
}

/**
 * Remove every tag, repeating until nothing changes so that no tag can be left
 * behind or re-formed from the pieces around a removed one.
 */
function stripTags(html: string): string {
  let text = html;
  let previous: string;
  do {
    previous = text;
    text = text.replace(/<[^>]*>/g, '');
  } while (text !== previous);
  return text;
}

function renderLink(attrs: string, inner: string, baseUrl: string): string {
  const label = stripTags(inner).trim();
  if (!label) return '';
  const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(attrs);
  const target = resolveLink(decodeEntities(href?.[1] ?? href?.[2] ?? href?.[3] ?? '').trim(), baseUrl);
  return target ? `[${label}](${target})` : label;
}

/** Absolute http(s) target of a link, or null for same-page anchors and other schemes. */
function resolveLink(href: string, baseUrl: string): string | null {
  if (!href || href.startsWith('#')) return null;
  try {
    const url = new URL(href, baseUrl);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}
