import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';
import { Tool, type ToolContext, type ToolResult } from './types.js';
import { success, failure, clamp, limitOutput, egressOrDirect } from './helpers.js';
import { isPathAllowed } from '../workspace/paths.js';
import { ensureDataDir } from './deps.js';
import { renderWithBrowser } from './browser_driver.js';
import { htmlToMarkdown, extractLinks, extractMeta, parseHtml, queryAll, nodeText, sleep, pool, DEFAULT_USER_AGENT } from './web_util.js';

interface CrawlPage { url: string; status: number; title: string; depth: number; markdown?: string; text?: string; links: string[]; bytes: number; rendered: boolean; changed?: boolean | null; items?: any[]; }

function hostOf(url: string): string { try { return new URL(url).host.toLowerCase(); } catch { return ''; } }
function allowedHost(host: string, allowed: Set<string>): boolean {
  if (!allowed.size) return true;
  if (allowed.has(host)) return true;
  for (const domain of allowed) if (host === domain || host.endsWith(`.${domain}`)) return true;
  return false;
}

function canonical(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    u.searchParams.sort();
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1);
    return u.toString();
  } catch { return url; }
}

interface Robots { disallow: string[]; allow: string[]; crawlDelay?: number; }
function parseRobots(text: string, agent: string): Robots {
  const groups: Array<{ agents: string[]; disallow: string[]; allow: string[]; crawlDelay?: number }> = [];
  let current: { agents: string[]; disallow: string[]; allow: string[]; crawlDelay?: number } | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const [rawKey, ...rest] = line.split(':');
    const key = rawKey.trim().toLowerCase();
    const value = rest.join(':').trim();
    if (key === 'user-agent') { if (!current || current.disallow.length || current.allow.length) { current = { agents: [], disallow: [], allow: [] }; groups.push(current); } current.agents.push(value.toLowerCase()); }
    else if (key === 'disallow' && current) current.disallow.push(value);
    else if (key === 'allow' && current) current.allow.push(value);
    else if (key === 'crawl-delay' && current) current.crawlDelay = Number(value) || undefined;
  }
  const lower = agent.toLowerCase();
  let fallback: Robots | null = null;
  for (const group of groups) {
    if (group.agents.some((a) => a === lower)) return { disallow: group.disallow, allow: group.allow, crawlDelay: group.crawlDelay };
    if (!fallback && group.agents.some((a) => a === '*')) fallback = { disallow: group.disallow, allow: group.allow, crawlDelay: group.crawlDelay };
  }
  return fallback || { disallow: [], allow: [] };
}
function robotsBlocked(pathname: string, rules: Robots): boolean {
  const match = (patterns: string[]) => patterns.some((pattern) => { if (!pattern) return false; const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*'); return new RegExp(`^${escaped}`).test(pathname); });
  if (match(rules.allow)) return false;
  return match(rules.disallow);
}

export class CrawlTool extends Tool {
  get name(): string { return 'crawl'; }
  get description(): string {
    return [
      'Crawl a site from one or more start URLs (full Scrapy + Firecrawl crawl/map).',
      'Traversal follows <a> links and/or sitemap.xml, staying on allowedDomains, up to maxPages/maxDepth, bfs (default) or dfs.',
      'Extraction per page: markdown/text/html/links/metadata; add schema to run an item extractor over every page.',
      'robots.txt (with Crawl-delay) is respected unless ignoreRobots; autothrottle adapts delay to latency; dedup persists across runs.',
      'render:"js" uses a headless browser for SPA routes; proxies:[] rotates. mapOnly lists URLs (Firecrawl /map); changeTracking flags changed pages.',
    ].join('\n');
  }
  get parameters(): Record<string, any> {
    return { type: 'object', required: ['url'], properties: {
      url: { type: 'string' }, urls: { type: 'array', items: { type: 'string' } },
      allowedDomains: { type: 'array', items: { type: 'string' } },
      maxPages: { type: 'integer', minimum: 1, maximum: 5000, description: 'default 20.' },
      maxDepth: { type: 'integer', minimum: 0, maximum: 20, description: 'default 2.' },
      order: { type: 'string', enum: ['bfs', 'dfs'] },
      includePatterns: { type: 'array', items: { type: 'string' } },
      excludePatterns: { type: 'array', items: { type: 'string' } },
      follow: { type: 'string', enum: ['links', 'sitemap', 'all'], description: 'What to follow; default all.' },
      ignoreRobots: { type: 'boolean' }, useSitemap: { type: 'boolean', description: 'Seed from sitemap.xml; default true.' },
      mapOnly: { type: 'boolean' }, changeTracking: { type: 'boolean' },
      formats: { type: 'array', items: { type: 'string', enum: ['markdown', 'text', 'html', 'links', 'metadata'] } },
      schema: { type: 'object', description: 'Item extractor {fields:{name:{css|xpath|attr|all|type}}} applied to every page.' },
      render: { type: 'string', enum: ['static', 'js'], description: 'static (default) or js for SPA routes.' },
      proxies: { type: 'array', items: { type: 'string' } },
      concurrency: { type: 'integer', minimum: 1, maximum: 16 }, delay: { type: 'integer', minimum: 0, maximum: 60000 },
      autothrottle: { type: 'boolean', description: 'Adapt delay to response latency; default true.' },
      timeout: { type: 'integer', minimum: 1, maximum: 120 }, out: { type: 'string' },
    }};
  }

  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    try {
      const starts: string[] = Array.isArray(args.urls) && args.urls.length ? args.urls.map((u: any) => String(u)) : (typeof args.url === 'string' && args.url ? [args.url] : []);
      if (!starts.length) throw new Error('url or urls is required');
      for (const url of starts) if (!/^https?:\/\//i.test(url)) throw new Error(`url must be http(s): ${url}`);

      const allowed = new Set<string>((Array.isArray(args.allowedDomains) && args.allowedDomains.length ? args.allowedDomains.map((d: any) => String(d).toLowerCase()) : starts.map(hostOf)).filter(Boolean));
      const maxPages = clamp(args.maxPages, 20, 1, 5000);
      const maxDepth = clamp(args.maxDepth, 2, 0, 20);
      const order = args.order === 'dfs' ? 'dfs' : 'bfs';
      const ignoreRobots = args.ignoreRobots === true;
      const follow = ['links', 'sitemap', 'all'].includes(args.follow) ? args.follow : 'all';
      const useSitemap = args.useSitemap !== false && follow !== 'links';
      const mapOnly = args.mapOnly === true;
      const changeTracking = args.changeTracking === true;
      const renderMode = args.render === 'js' ? 'js' : 'static';
      const concurrency = clamp(args.concurrency, 4, 1, 16);
      let delay = clamp(args.delay, 0, 0, 60000);
      const autothrottle = args.autothrottle !== false;
      const timeoutMs = clamp(args.timeout, 30, 1, 120) * 1000;
      const proxies = Array.isArray(args.proxies) ? args.proxies.map((p: any) => String(p)) : [];
      const formats: string[] = Array.isArray(args.formats) && args.formats.length ? args.formats.map((f: any) => String(f)) : ['markdown', 'links'];
      const include: RegExp[] = (Array.isArray(args.includePatterns) ? args.includePatterns : []).map((p: any) => new RegExp(String(p)));
      const exclude: RegExp[] = (Array.isArray(args.excludePatterns) ? args.excludePatterns : []).map((p: any) => new RegExp(String(p)));

      const runId = createHash('sha1').update(starts.join(',')).digest('hex').slice(0, 12);
      const dedupDir = await ensureDataDir('crawl-dedup');
      const dedupFile = path.join(dedupDir, `${runId}.json`);
      let seen = new Set<string>();
      try { seen = new Set(JSON.parse(await fs.readFile(dedupFile, 'utf8'))); } catch { }
      const persistDedup = async () => { try { await fs.writeFile(dedupFile, JSON.stringify([...seen]), 'utf8'); } catch { } };

      const robotsCache = new Map<string, Robots>();
      const robotsRules = async (url: string): Promise<Robots> => {
        const host = hostOf(url);
        if (robotsCache.has(host)) return robotsCache.get(host)!;
        let rules: Robots = { disallow: [], allow: [] };
        if (!ignoreRobots) {
          try { const res = await egressOrDirect(`${new URL(url).protocol}//${host}/robots.txt`, { headers: { 'User-Agent': DEFAULT_USER_AGENT }, signal: context.signal }, 15000); if (res.ok) rules = parseRobots(await res.text(), '0kay-agent'); } catch { }
        }
        robotsCache.set(host, rules);
        return rules;
      };

      const queue: Array<{ url: string; depth: number }> = [];
      const enqueued = new Set<string>();
      const pathOf = (url: string) => { try { return new URL(url).pathname; } catch { return url; } };
      const push = (url: string, depth: number) => {
        const canon = canonical(url);
        if (seen.has(canon) || enqueued.has(canon)) return;
        if (!allowedHost(hostOf(url), allowed)) return;
        const pathname = pathOf(url);
        if (exclude.some((re) => re.test(pathname))) return;
        if (include.length && !include.some((re) => re.test(pathname))) return;
        enqueued.add(canon);
        if (order === 'dfs') queue.unshift({ url: canon, depth }); else queue.push({ url: canon, depth });
      };
      const discovered = new Set<string>(starts.map(canonical));
      for (const start of starts) push(start, 0);

      if (useSitemap && !ignoreRobots) {
        for (const start of starts) {
          const host = hostOf(start);
          try {
            const res = await egressOrDirect(`${new URL(start).protocol}//${host}/sitemap.xml`, { headers: { 'User-Agent': DEFAULT_USER_AGENT }, signal: context.signal }, 15000);
            if (res.ok) for (const m of (await res.text()).matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) { discovered.add(canonical(m[1])); push(m[1], 1); }
          } catch { }
        }
      }

      const pages: CrawlPage[] = [];
      const schemaFields = args.schema && typeof args.schema === 'object' && args.schema.fields ? args.schema.fields : null;

      const extractItems = (html: string): any[] => {
        if (!schemaFields) return [];
        const dom = parseHtml(html);
        const item: Record<string, any> = {};
        for (const [name, spec] of Object.entries<any>(schemaFields)) {
          const nodes = spec.css ? queryAll(dom, spec.css) : spec.selector ? queryAll(dom, spec.selector) : spec.xpath ? [] : [];
          const valueOf = (node: any) => (spec.attr ? node.attrs[spec.attr] || '' : spec.type === 'html' ? '' : nodeText(node));
          item[name] = spec.all || spec.type === 'list' ? nodes.map(valueOf) : (nodes.length ? valueOf(nodes[0]) : null);
        }
        return Object.values(item).some((v) => v !== null && (!Array.isArray(v) || v.length)) ? [item] : [];
      };

      const changeDir = await ensureDataDir('crawl-snapshots');
      const trackChange = async (url: string, markdown: string): Promise<boolean | null> => {
        if (!changeTracking) return null;
        const file = path.join(changeDir, `${createHash('sha1').update(url).digest('hex').slice(0, 16)}.txt`);
        let previous = ''; try { previous = await fs.readFile(file, 'utf8'); } catch { }
        await fs.writeFile(file, markdown, 'utf8');
        return previous ? previous !== markdown : null;
      };

      const fetchPage = async (url: string, depth: number): Promise<void> => {
        const canon = canonical(url);
        if (seen.has(canon) || pages.length >= maxPages) return;
        seen.add(canon);
        const rules = await robotsRules(url);
        if (!ignoreRobots && robotsBlocked(pathOf(url), rules)) return;
        if (rules.crawlDelay && rules.crawlDelay * 1000 > delay) delay = rules.crawlDelay * 1000;
        if (delay) await sleep(delay, context.signal);

        const started = Date.now();
        let html = ''; let status = 0; let rendered = false; let bytes = 0;
        try {
          if (renderMode === 'js') {
            const browser = await renderWithBrowser({ url, timeoutMs, waitUntil: 'networkidle', signal: context.signal });
            if (browser) { html = browser.html; status = browser.status; rendered = true; bytes = Buffer.byteLength(html); }
          }
          if (!html) {
            const proxy = proxies.length ? proxies[Math.floor(Math.random() * proxies.length)] : undefined;
            const headers: Record<string, string> = { 'User-Agent': DEFAULT_USER_AGENT, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9', ...(proxy ? { 'X-Proxy': proxy } : {}) };
            const res = await egressOrDirect(url, { headers, signal: context.signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), context.signal]) : AbortSignal.timeout(timeoutMs) }, timeoutMs);
            status = res.status;
            const contentType = res.headers.get('content-type') || '';
            if (/text\/html|application\/xhtml/i.test(contentType || 'text/html')) { html = await res.text(); bytes = Buffer.byteLength(html); }
          }
        } catch { return; }

        const latency = Date.now() - started;
        if (autothrottle) delay = Math.min(30000, Math.round(delay * 0.7 + latency * 0.3));

        const links: string[] = [];
        const meta = html ? extractMeta(html) : { title: '' };
        const markdown = html && !mapOnly ? htmlToMarkdown(html) : '';
        if (html && follow !== 'sitemap') {
          for (const link of extractLinks(html, url)) {
            discovered.add(canonical(link.href));
            if (depth + 1 <= maxDepth) { push(link.href, depth + 1); links.push(link.href); }
          }
        }
        if (html && follow === 'sitemap') {
          for (const m of html.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) if (depth + 1 <= maxDepth) push(m[1], depth + 1);
        }
        const page: CrawlPage = { url: canonical(url), status, title: meta.title || '', depth, links, bytes, rendered };
        if (formats.includes('markdown') && !mapOnly) page.markdown = limitOutput(markdown).text;
        if (formats.includes('text') && !mapOnly) page.text = markdown.replace(/[#*`>\-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 20000);
        if (html && !mapOnly && schemaFields) { page.items = extractItems(html); if (!page.items.length) delete page.items; }
        if (changeTracking && !mapOnly) page.changed = await trackChange(url, markdown);
        pages.push(page);
        await persistDedup();
      };

      while (queue.length && pages.length < maxPages) {
        const batch: Array<{ url: string; depth: number }> = [];
        while (batch.length < concurrency && queue.length) { const next = queue.shift()!; if (!seen.has(next.url)) batch.push(next); }
        if (!batch.length) continue;
        await pool(batch, concurrency, (item) => fetchPage(item.url, item.depth));
      }

      const urls = [...discovered];
      const payload = mapOnly ? { discovered: discovered.size, urls } : { pages: pages.length, discovered: discovered.size, results: pages };
      const limited = limitOutput(JSON.stringify(payload));
      let outPath: string | undefined;
      if (typeof args.out === 'string' && args.out.trim()) {
        outPath = path.resolve(context.cwd, args.out);
        if (!isPathAllowed(outPath)) throw new Error('path not allowed: outside workspace roots');
        await fs.mkdir(path.dirname(outPath), { recursive: true });
        await fs.writeFile(outPath, JSON.stringify(payload, null, 2), 'utf8');
      }
      if (mapOnly) return success({ discovered: discovered.size, urls, ...(outPath ? { out: outPath } : {}), ...(limited.truncated ? { truncated: true } : {}) });
      return success({ pages: pages.length, discovered: discovered.size, results: pages, ...(outPath ? { out: outPath } : {}), ...(limited.truncated ? { truncated: true } : {}) });
    } catch (error) { return failure(error); }
  }
}
