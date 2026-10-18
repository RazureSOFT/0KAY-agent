/**
 * Shared HTML/URL helpers for the web-facing tools (scrape, crawl, screentocode,
 * pentest). Pure TypeScript, no native or third-party parsing deps: the parser
 * is a small tolerant tokenizer that mirrors the subset of HTML the source
 * projects (Scrapling, Scrapy, Firecrawl) rely on for extraction and link
 * discovery.
 */

export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '\u00a9',
  reg: '\u00ae', trade: '\u2122', hellip: '\u2026', mdash: '\u2014', ndash: '\u2013',
  lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d', middot: '\u00b7',
  laquo: '\u00ab', raquo: '\u00bb', deg: '\u00b0', euro: '\u20ac', pound: '\u00a3', yen: '\u00a5',
};

export function decodeEntities(input: string): string {
  if (!input) return '';
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try { return String.fromCodePoint(code); } catch { return match; }
      }
      return match;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

export function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

function absolutize(raw: string, base: string): string {
  try { return new URL(raw, base).toString(); } catch { return raw; }
}

/** HTML → Markdown-ish text, preserving headings, lists and links. */
export function htmlToMarkdown(html: string): string {
  let out = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<(script|style|noscript|template|svg)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n');
  out = out.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level: string, inner: string) => `\n${'#'.repeat(Number(level))} ${stripTags(inner)}\n`);
  out = out.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, inner: string) => `- ${stripTags(inner)}\n`);
  out = out.replace(/<a\b[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => `[${stripTags(inner)}](${href})`);
  out = out.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _tag: string, inner: string) => `**${stripTags(inner)}**`);
  out = out.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _tag: string, inner: string) => `*${stripTags(inner)}*`);
  out = out.replace(/<img\b[^>]*src=["']([^"']*)["'][^>]*>/gi, (_m, src: string) => `![](${src})`);
  out = out.replace(/<\/(p|div|section|article|header|footer|li|tr|h[1-6])>/gi, '\n');
  out = decodeEntities(out.replace(/<[^>]+>/g, ''))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
  return out.trim();
}

export interface LinkInfo { href: string; text: string; }

export function extractLinks(html: string, base: string): LinkInfo[] {
  const seen = new Set<string>();
  const links: LinkInfo[] = [];
  const re = /<a\b[^>]*href=["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html))) {
    const href = absolutize(match[1].trim(), base);
    if (!/^https?:\/\//i.test(href) || seen.has(href)) continue;
    seen.add(href);
    links.push({ href, text: stripTags(match[2]) });
  }
  return links;
}

export interface AssetInfo { url: string; kind: string; alt?: string; }

export function extractAssets(html: string, base: string): AssetInfo[] {
  const assets: AssetInfo[] = [];
  const seen = new Set<string>();
  const push = (raw: string, kind: string, alt?: string) => {
    const url = absolutize(raw.trim(), base);
    if (!/^https?:\/\//i.test(url) || seen.has(url)) return;
    seen.add(url);
    assets.push({ url, kind, ...(alt ? { alt } : {}) });
  };
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const src = /src=["']([^"']*)["']/i.exec(tag)?.[1];
    const alt = /alt=["']([^"']*)["']/i.exec(tag)?.[1];
    if (src) push(src, 'image', alt);
    const dataSrc = /data-src=["']([^"']*)["']/i.exec(tag)?.[1];
    if (dataSrc) push(dataSrc, 'image', alt);
  }
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    const href = /href=["']([^"']*)["']/i.exec(tag)?.[1];
    const rel = /rel=["']([^"']*)["']/i.exec(tag)?.[1] || '';
    if (href && /stylesheet|icon|preload/i.test(rel)) push(href, 'link');
  }
  for (const m of html.matchAll(/<script\b[^>]*>/gi)) {
    const src = /src=["']([^"']*)["']/i.exec(m[0])?.[1];
    if (src) push(src, 'script');
  }
  return assets;
}

export function extractMeta(html: string): Record<string, string> {
  const meta: Record<string, string> = {};
  const assign = (key: string, value: string) => { if (value && !meta[key]) meta[key] = stripTags(value); };
  assign('title', /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || '');
  const attr = (tag: string, name: string): string => {
    const re = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>=]+))`, 'i');
    const m = re.exec(tag);
    return m ? (m[1] ?? m[2] ?? m[3] ?? '') : '';
  };
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const name = (attr(tag, 'name') || attr(tag, 'property')).toLowerCase();
    if (name) assign(name, attr(tag, 'content'));
  }
  assign('lang', attr(/<html\b[^>]*>/i.exec(html)?.[0] || '', 'lang'));
  return meta;
}

/**
 * A tolerant CSS-subset selector engine. Supports tag, #id, .class, [attr],
 * [attr=value], descendant (space) and child (>) combinators, and the
 * pseudo-classes :first-child / :last-child / :nth-child(n). This covers the
 * selectors used by Scrapling/Scrapy examples without pulling in a DOM library.
 */
export interface DomNode {
  tag: string;
  attrs: Record<string, string>;
  children: DomNode[];
  parent?: DomNode;
  text: string;
}

export function parseHtml(html: string): DomNode {
  const root: DomNode = { tag: '#root', attrs: {}, children: [], text: '' };
  const stack: DomNode[] = [root];
  const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\/?([a-zA-Z][\w:-]*)((?:\s+[^\s/>"']+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*\/?>/g;
  let last = 0;
  let match: RegExpExecArray | null;
  const appendText = (text: string) => {
    if (text.trim()) stack[stack.length - 1].text += decodeEntities(text);
  };
  while ((match = re.exec(html))) {
    appendText(html.slice(last, match.index));
    last = re.lastIndex;
    const raw = match[0];
    if (raw.startsWith('<!--') || raw.startsWith('<!')) continue;
    const closing = raw[1] === '/';
    const tag = (match[1] || '').toLowerCase();
    if (closing) {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === tag) { stack.length = i; break; }
      }
      continue;
    }
    const attrs: Record<string, string> = {};
    const attrRe = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
    let am: RegExpExecArray | null;
    const attrText = (match[2] || '').trim();
    while ((am = attrRe.exec(attrText))) {
      attrs[am[1].toLowerCase()] = decodeEntities(am[2] ?? am[3] ?? am[4] ?? '');
    }
    const node: DomNode = { tag, attrs, children: [], text: '' };
    node.parent = stack[stack.length - 1];
    node.parent.children.push(node);
    if (!voidTags.has(tag) && !raw.endsWith('/>')) stack.push(node);
  }
  appendText(html.slice(last));
  return root;
}

function matchesSimple(node: DomNode, compound: string): boolean {
  const tokens = compound.match(/([.#]?[^.#\[:]+|\[[^\]]+\]|:[a-z-]+(?:\([^)]*\))?)/gi) || [];
  for (const token of tokens) {
    if (token[0] === '.') {
      if (!((node.attrs.class || '').split(/\s+/).includes(token.slice(1)))) return false;
    } else if (token[0] === '#') {
      if (node.attrs.id !== token.slice(1)) return false;
    } else if (token[0] === '[') {
      const body = token.slice(1, -1);
      const eq = body.indexOf('=');
      if (eq === -1) { if (!(body in node.attrs)) return false; }
      else {
        const name = body.slice(0, eq);
        const value = body.slice(eq + 1).replace(/^["']|["']$/g, '');
        if (node.attrs[name] !== value) return false;
      }
    } else if (token[0] === ':') {
      if (!matchPseudo(node, token)) return false;
    } else if (token !== '*') {
      if (node.tag !== token.toLowerCase()) return false;
    }
  }
  return tokens.length > 0;
}

function matchPseudo(node: DomNode, token: string): boolean {
  const siblings = node.parent ? node.parent.children.filter((c) => c.tag === node.tag) : [node];
  const index = siblings.indexOf(node);
  if (token === ':first-child') return index === 0;
  if (token === ':last-child') return index === siblings.length - 1;
  const nth = /^:nth-child\((\d+)\)$/.exec(token);
  if (nth) return index === Number(nth[1]) - 1;
  return true;
}

/** Query the parsed DOM with a CSS-subset selector. */
export function queryAll(root: DomNode, selector: string): DomNode[] {
  const groups = selector.split(',').map((s) => s.trim()).filter(Boolean);
  const results: DomNode[] = [];
  const seen = new Set<DomNode>();
  for (const group of groups) {
    // Walk combinators (descendant space, child >) left-to-right.
    let current: DomNode[] = [root];
    const tokens = group.replace(/\s*>\s*/g, ' > ').split(/\s+/).filter(Boolean);
    let expectChild = false;
    for (const token of tokens) {
      if (token === '>') { expectChild = true; continue; }
      const next: DomNode[] = [];
      for (const base of current) {
        const pool = expectChild ? base.children : descendants(base);
        for (const candidate of pool) {
          if (candidate !== root && matchesSimple(candidate, token)) next.push(candidate);
        }
      }
      current = next;
      expectChild = false;
    }
    for (const node of current) { if (!seen.has(node)) { seen.add(node); results.push(node); } }
  }
  return results;
}

function descendants(node: DomNode): DomNode[] {
  const out: DomNode[] = [];
  const visit = (n: DomNode) => { for (const child of n.children) { out.push(child); visit(child); } };
  visit(node);
  return out;
}

export function nodeText(node: DomNode): string {
  let text = node.text;
  for (const child of node.children) text += ` ${nodeText(child)}`;
  return decodeEntities(text).replace(/\s+/g, ' ').trim();
}

export function nodeAttr(node: DomNode, name: string): string {
  return node.attrs[name] || '';
}

export function nodeHtml(node: DomNode): string {
  const attrs = Object.entries(node.attrs).map(([k, v]) => ` ${k}="${v}"`).join('');
  const inner = node.text + node.children.map(nodeHtml).join('');
  return `<${node.tag}${attrs}>${inner}</${node.tag}>`;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted')); };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Run tasks with a bounded concurrency pool (mirrors Scrapy's CONCURRENT_REQUESTS). */
export async function pool<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const size = Math.max(1, Math.min(limit, items.length));
  const runners = Array.from({ length: size }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}
