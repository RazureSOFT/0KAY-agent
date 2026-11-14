import { decodeEntities, extractLinks, extractMeta, htmlToMarkdown, stripTags } from './web_util.js';

/**
 * What a fetch gives the model, decided by what was actually fetched.
 *
 * Handing a page's markup to a model wastes its attention on attributes and
 * inline scripts, and a model that was given markup will happily quote it
 * back. So a page is reduced to its content: prose, headings, lists, code and
 * tables, in the order a reader meets them. Raw markup stays available, but
 * has to be asked for, because inspecting the markup is a different task from
 * reading the page.
 */
export interface ReadableOptions {
  /** Return the body untouched. For work about the markup itself. */
  raw?: boolean;
  /** Prose only: drop the markdown structure too. */
  plain?: boolean;
  /** The final URL, so relative links resolve against it. */
  base?: string;
}

export interface Readable {
  content: string;
  title: string;
  kind: 'html' | 'text' | 'json' | 'binary';
}

const BLOCK_TAGS = 'p|div|section|article|main|header|footer|aside|nav|figure|figcaption|blockquote|ul|ol|dl|dt|dd|table|thead|tbody|tfoot|tr|td|th|pre|hr';

export function readable(body: string, contentType: string, options: ReadableOptions = {}): Readable {
  const type = (contentType || '').toLowerCase();
  const mime = type.split(';')[0].trim();

  if (options.raw) {
    return { content: body, title: titleOf(body, mime), kind: kindOf(mime) };
  }

  // JSON is already structure; reformatting it as prose would lose it.
  if (mime.includes('json')) {
    return { content: prettyJson(body), title: '', kind: 'json' };
  }
  if (isBinary(mime)) {
    return { content: describeBinary(body, mime), title: '', kind: 'binary' };
  }
  if (mime && !mime.includes('html') && !mime.includes('xml') && mime.startsWith('text/')) {
    return { content: body.trim(), title: '', kind: 'text' };
  }
  // No content type at all: look at the body rather than guess.
  if (!mime && !looksLikeHtml(body)) {
    return { content: body.trim(), title: '', kind: 'text' };
  }

  const markdown = extractContent(body, options.base || '');
  return {
    content: options.plain ? toPlain(markdown) : markdown,
    title: extractMeta(body).title || '',
    kind: 'html',
  };
}

function kindOf(mime: string): Readable['kind'] {
  if (mime.includes('json')) return 'json';
  if (mime.includes('html') || mime.includes('xml')) return 'html';
  if (mime && !mime.startsWith('text/')) return 'binary';
  return 'text';
}

function titleOf(body: string, mime: string): string {
  if (!mime.includes('html')) return '';
  return extractMeta(body).title || '';
}

function looksLikeHtml(body: string): boolean {
  const head = body.slice(0, 2048).toLowerCase();
  return head.includes('<!doctype html') || head.includes('<html') || /<(head|body|div|p)\b/.test(head);
}

function isBinary(mime: string): boolean {
  if (!mime) return false;
  if (mime.startsWith('text/') || mime.includes('json') || mime.includes('xml')) return false;
  if (mime.includes('html') || mime.includes('javascript') || mime.includes('x-www-form-urlencoded')) return false;
  return /image\/|audio\/|video\/|application\/(pdf|zip|gzip|octet-stream|x-tar|x-7z|x-rar|msword|vnd\.)/.test(mime);
}

function describeBinary(body: string, mime: string): string {
  const bytes = body.length;
  return `(${mime}, ${bytes} bytes of binary content -- fetch it with a tool that downloads files if the bytes are needed)`;
}

function prettyJson(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body.trim();
  }
}

/**
 * The page's content, in reading order.
 *
 * Navigation, sidebars, cookie banners and footers are the bulk of a page's
 * markup and almost none of its meaning. Choosing the main element when one
 * exists drops them; when it does not, the whole body is used after the
 * obviously-decorative elements are removed.
 */
export function extractContent(html: string, base: string): string {
  let source = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|template|svg|iframe|canvas|form)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<(nav|aside|footer|header)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<div[^>]*(?:class|id)=["'][^"']*(?:cookie|consent|banner|breadcrumb|sidebar|ads?|promo|newsletter|social|share|related|comment)[^"']*["'][^>]*>[\s\S]*?<\/div>/gi, '');

  const main = pickMain(source);
  if (main) source = main;

  // A table carries information in its cells; turning it into loose lines
  // loses which cell belonged to which column.
  source = tableToMarkdown(source);
  source = source
    .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, inner: string) => {
      // The language sits in a class on the inner <code>; it is worth keeping
      // as a fence label, and it must come out before the tags are stripped
      // or it turns into the first word of the code.
      const language = /class=["'][^"']*(?:language|lang)-([\w+#-]+)/i.exec(inner)?.[1] || '';
      const code = decodeEntities(inner.replace(/<[^>]+>/g, '')).replace(/^\n+|\n+$/g, '');
      return `\n\`\`\`${language}\n${code}\n\`\`\`\n`;
    })
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_m, inner: string) => `\`${stripTags(inner)}\``);

  let markdown = htmlToMarkdown(source);

  // Links: keep the few that go somewhere a reader would follow, drop the
  // hundreds that are navigation, and absolutise the rest.
  const links = extractLinks(source, base).slice(0, 40);
  if (links.length) {
    const list = links.map((link) => `- [${link.text || link.href}](${link.href})`).join('\n');
    markdown += `\n\n## Links\n\n${list}\n`;
  }
  return tidy(markdown);
}

function pickMain(html: string): string {
  const candidates: Array<[RegExp, number]> = [
    [/<article\b[^>]*>([\s\S]*?)<\/article>/i, 3],
    [/<main\b[^>]*>([\s\S]*?)<\/main>/i, 2],
    [/<div[^>]*(?:id|class)=["'][^"']*(?:content|article|post|entry|markdown-body|readme)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i, 1],
  ];
  let best = '';
  let bestScore = 0;
  for (const [pattern, weight] of candidates) {
    const match = pattern.exec(html);
    if (!match) continue;
    // Weight by the tag's meaning *and* by how much it holds: a "main" that
    // wraps a single paragraph is a layout shell, and the real content is
    // outside it. The weight breaks ties between similar-sized candidates.
    const score = match[1].length * weight;
    if (score > bestScore) {
      best = match[1];
      bestScore = score;
    }
  }
  // Too small to be a page's content: nothing was found, not a short page.
  return best.length > 200 ? best : '';
}

function tableToMarkdown(html: string): string {
  return html.replace(/<table\b[^>]*>([\s\S]*?)<\/table>/gi, (_m, inner: string) => {
    const rows: string[][] = [];
    for (const row of inner.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells: string[] = [];
      for (const cell of row[1].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)) {
        cells.push(stripTags(cell[1]).replace(/\|/g, '\\|'));
      }
      if (cells.length) rows.push(cells);
    }
    if (!rows.length) return '';
    const width = Math.max(...rows.map((row) => row.length));
    const line = (cells: string[]) => `| ${[...cells, ...Array(width - cells.length).fill('')].join(' | ')} |`;
    const out = [line(rows[0]), `|${' --- |'.repeat(width)}`, ...rows.slice(1).map(line)];
    return `\n\n${out.join('\n')}\n\n`;
  });
}

function toPlain(markdown: string): string {
  return tidy(markdown
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]{1,3}([^*_`]+)[*_`]{1,3}/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\|.*\|\s*$/gm, (line: string) => line.split('|').map((cell) => cell.trim()).filter(Boolean).join(' · '))
    .replace(/^---\s*$/gm, ''));
}

function tidy(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
