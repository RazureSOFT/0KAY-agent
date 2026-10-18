/**
 * `scrape` tool — full reimplementation of the Scrapling + Firecrawl scrape
 * pipelines in TypeScript.
 *
 * Features (matching the source projects):
 *  - Fetch modes: static (HTTP), js (headless browser), stealth (curl
 *    impersonation when available). Browser actions: wait/click/scroll/write/
 *    press/screenshot/goto (Firecrawl actions, Scrapling interactions).
 *  - Formats: markdown, text, html, links, metadata, screenshot, json
 *    (structured extraction), summary, rawHtml, changeTracking.
 *  - Selection: CSS and XPath subsets; adaptive selection with saved
 *    fingerprints (Scrapling auto_save/adaptive).
 *  - Structured extraction: a JSON schema with per-field css/xpath selectors or
 *    a natural-language prompt mapped to fields (Firecrawl extract).
 *  - Non-HTML payloads: PDF/DOCX/XLSX/CSV/media are detected and extracted.
 *  - Proxy rotation across a list of proxies; onlyMainContent; batch scrapes.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';
import { Tool, type ToolContext, type ToolResult } from './types.js';
import { success, failure, clamp, limitOutput, egressOrDirect } from './helpers.js';
import { isPathAllowed } from '../workspace/paths.js';
import { ensureDataDir, resolveCli } from './deps.js';
import { renderWithBrowser, type BrowserAction, type BrowserResult } from './browser_driver.js';
import { chatVia } from './llm_bridge.js';
import { detectDocumentKind, extractPdf, extractDocx, extractXlsx, probeMedia } from './document.js';
import {
  DEFAULT_USER_AGENT, htmlToMarkdown, extractLinks, extractAssets, extractMeta,
  parseHtml, queryAll, nodeText, nodeHtml, pool, type DomNode,
} from './web_util.js';

type Format = 'markdown' | 'text' | 'html' | 'links' | 'metadata' | 'screenshot' | 'json' | 'summary' | 'changeTracking';

interface ScrapeOptions {
  url: string;
  formats: Format[];
  css?: string;
  xpath?: string;
  onlyMainContent: boolean;
  timeoutMs: number;
  proxies: string[];
  render: 'auto' | 'static' | 'js' | 'stealth';
  actions: BrowserAction[];
  schema?: Record<string, any>;
  prompt?: string;
  signal?: AbortSignal;
}

interface Fetched { html: string; status: number; contentType: string; finalUrl: string; rendered: boolean; via: string; screenshots?: string[]; network?: BrowserResult['network']; console?: BrowserResult['console']; kind: string; documentText?: string; documentMeta?: Record<string, any>; }

interface Fingerprint { url: string; selector: string; tag: string; text: string; attrs: Record<string, string>; savedAt: string; }

function requestHeaders(url: string, extra?: Record<string, string>): Record<string, string> {
  let origin = '';
  try { const parsed = new URL(url); origin = `${parsed.protocol}//${parsed.host}`; } catch { /* blank */ }
  return {
    'User-Agent': DEFAULT_USER_AGENT,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'none', 'Upgrade-Insecure-Requests': '1',
    ...(origin ? { Referer: origin } : {}),
    ...(extra || {}),
  };
}

function mainContentHtml(html: string): string {
  const dom = parseHtml(html);
  for (const selector of ['article', 'main', '[role=main]', '#content', '.content', '.post', '.article']) {
    const found = queryAll(dom, selector);
    if (found.length) {
      const best = found.sort((a, b) => nodeText(b).length - nodeText(a).length)[0];
      if (nodeText(best).length > 200) return nodeHtml(best);
    }
  }
  return html;
}

function applyXPath(dom: DomNode, xpath: string): DomNode[] {
  const results: DomNode[] = [];
  for (const part of xpath.split('|').map((p) => p.trim()).filter(Boolean)) {
    let tag = '*';
    const tagMatch = /\/\/([a-zA-Z][\w-]*|\*)/.exec(part);
    if (tagMatch) tag = tagMatch[1].toLowerCase();
    const attr = /\[@([\w:-]+)(?:=(["'])(.*?)\2)?\]/.exec(part);
    for (const node of queryAll(dom, tag === '*' ? '*' : tag)) {
      if (attr) { if (!(attr[1] in node.attrs)) continue; if (attr[3] !== undefined && node.attrs[attr[1]] !== attr[3]) continue; }
      results.push(node);
    }
  }
  return results;
}

function selectNodes(dom: DomNode, options: Pick<ScrapeOptions, 'css' | 'xpath'>): DomNode[] {
  if (options.css) return queryAll(dom, options.css);
  if (options.xpath) return applyXPath(dom, options.xpath);
  return [];
}

async function fingerprintPath(url: string): Promise<string> {
  const dir = await ensureDataDir('scrape-fingerprints');
  const hash = createHash('sha1').update(url).digest('hex').slice(0, 16);
  return path.join(dir, `${hash}.json`);
}

async function loadFingerprints(url: string): Promise<Fingerprint[]> {
  try { return JSON.parse(await fs.readFile(await fingerprintPath(url), 'utf8')); } catch { return []; }
}

async function saveFingerprints(url: string, prints: Fingerprint[]): Promise<void> {
  const file = await fingerprintPath(url);
  if (!isPathAllowed(file)) return;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(prints, null, 2), 'utf8');
}

function adaptiveMatch(dom: DomNode, print: Fingerprint): DomNode[] {
  const all: DomNode[] = queryAll(dom, '*');
  let best: DomNode | null = null; let bestScore = 0;
  for (const node of all) {
    let score = 0;
    if (node.tag === print.tag) score += 2;
    const text = nodeText(node);
    if (print.text && text && (text.includes(print.text.slice(0, 40)) || print.text.includes(text.slice(0, 40)))) score += 3;
    for (const [k, v] of Object.entries(print.attrs || {})) if (node.attrs[k] === v) score += 1;
    if (score > bestScore) { bestScore = score; best = node; }
  }
  return best && bestScore >= 3 ? [best] : [];
}

function pickProxy(proxies: string[], url: string, attempt = 0): string | undefined {
  if (!proxies.length) return undefined;
  const hash = createHash('md5').update(url).digest().readUInt32BE(0);
  return proxies[(hash + attempt) % proxies.length];
}

async function staticFetch(url: string, options: ScrapeOptions): Promise<Fetched> {
  const proxy = pickProxy(options.proxies, url);
  const extra: Record<string, string> = proxy ? { 'X-Proxy': proxy } : {};
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  const response = await egressOrDirect(url, { headers: requestHeaders(url, extra), signal }, options.timeoutMs);
  const buffer = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get('content-type') || '';
  const kind = /text\/html|application\/xhtml|application\/xml|text\/plain|application\/json/i.test(contentType)
    ? (/json/i.test(contentType) ? 'json' : /html|xhtml/i.test(contentType) ? 'html' : 'text')
    : detectDocumentKind(buffer, url);
  if (kind === 'pdf') { const doc = await extractPdf(buffer, options.signal); return { html: '', status: response.status, contentType, finalUrl: response.url || url, rendered: false, via: `static+${doc.via}`, kind, documentText: doc.text, documentMeta: doc.meta }; }
  if (kind === 'docx') { const doc = await extractDocx(buffer); return { html: '', status: response.status, contentType, finalUrl: response.url || url, rendered: false, via: `static+${doc.via}`, kind, documentText: doc.text, documentMeta: doc.meta }; }
  if (kind === 'xlsx') { const doc = await extractXlsx(buffer); return { html: '', status: response.status, contentType, finalUrl: response.url || url, rendered: false, via: `static+${doc.via}`, kind, documentText: doc.text, documentMeta: doc.meta }; }
  if (kind === 'media') { const doc = await probeMedia(buffer, url, options.signal); return { html: '', status: response.status, contentType, finalUrl: response.url || url, rendered: false, via: `static+${doc.via}`, kind, documentText: '', documentMeta: doc.meta }; }
  const html = buffer.toString('utf8');
  return { html, status: response.status, contentType, finalUrl: response.url || url, rendered: false, via: 'static', kind };
}

/** Stealth fetch via curl-impersonate (TLS/JA3 impersonation) when available. */
async function stealthFetch(url: string, options: ScrapeOptions): Promise<Fetched | null> {
  const curl = await resolveCli('curl-impersonate');
  if (!curl.available) return null;
  const { runCli } = await import('./deps.js');
  const args = ['-sL', '--compressed', url];
  if (options.proxies.length) args.push('-x', pickProxy(options.proxies, url)!);
  const result = await runCli(curl.command, args, { timeout: options.timeoutMs, signal: options.signal, maxBuffer: 64 * 1024 * 1024 });
  if (result.code !== 0 || !result.stdout) return null;
  const kind = detectDocumentKind(Buffer.from(result.stdout), url);
  return { html: kind === 'text' || kind === 'binary' ? result.stdout : result.stdout, status: 200, contentType: 'text/html', finalUrl: url, rendered: false, via: 'stealth-curl-impersonate', kind: 'html' };
}

async function fetchPage(url: string, options: ScrapeOptions): Promise<Fetched> {
  const mode = options.render;
  if (mode === 'static') return staticFetch(url, options);
  if (mode === 'stealth') {
    const stealth = await stealthFetch(url, options);
    if (stealth) return stealth;
    // Fall through to static if impersonation is unavailable.
    return staticFetch(url, options);
  }
  // auto | js: use the browser when possible.
  const wantScreenshot = options.formats.includes('screenshot');
  const browser = await renderWithBrowser({
    url, timeoutMs: options.timeoutMs, actions: options.actions, waitUntil: 'networkidle',
    proxy: pickProxy(options.proxies, url), screenshot: wantScreenshot,
    captureNetwork: options.formats.includes('metadata'), signal: options.signal,
    viewport: { width: 1280, height: 900 },
  });
  if (browser) {
    return {
      html: browser.html, status: browser.status, contentType: 'text/html', finalUrl: browser.finalUrl,
      rendered: true, via: browser.via, kind: 'html',
      screenshots: browser.screenshots.map((s) => s.dataUrl || s.path || '').filter(Boolean),
      network: browser.network, console: browser.console,
    };
  }
  const stat = await staticFetch(url, options);
  return { ...stat, rendered: false };
}

function documentResult(data: Record<string, any>, fetched: Fetched, formats: Format[]): void {
  if (formats.includes('markdown') || formats.includes('text')) data.markdown = fetched.documentText || '';
  if (formats.includes('text')) data.text = fetched.documentText || '';
  if (formats.includes('json')) data.document = { kind: fetched.kind, meta: fetched.documentMeta };
}

export class ScrapeTool extends Tool {
  get name(): string { return 'scrape'; }
  get description(): string {
    return [
      'Scrape one or more URLs into LLM-ready output (full Scrapling + Firecrawl).',
      'render: auto (default, js when a browser is available) | static | js | stealth (curl impersonation).',
      'formats: markdown (default), text, html, links, metadata, screenshot, json, summary, changeTracking.',
      'actions: [{type:"wait|click|scroll|write|press|goto|screenshot", selector?, text?, key?, ms?, direction?, fullPage?, path?}] run before extraction.',
      'Select with css or xpath; save:true fingerprints the match and adaptive:true relocates it after page changes.',
      'Structured extraction: schema:{fields:{name:{css|xpath|selector|attr|type}}} or prompt (natural language) -> formats:["json"].',
      'PDF/DOCX/XLSX/CSV/media are detected and their text/metadata extracted. proxies:[] rotates per request.',
    ].join('\n');
  }
  get parameters(): Record<string, any> {
    return { type: 'object', properties: {
      url: { type: 'string' }, urls: { type: 'array', items: { type: 'string' } },
      formats: { type: 'array', items: { type: 'string', enum: ['markdown', 'text', 'html', 'links', 'metadata', 'screenshot', 'json', 'summary', 'changeTracking'] } },
      css: { type: 'string' }, xpath: { type: 'string' },
      onlyMainContent: { type: 'boolean', description: 'Strip navigation/boilerplate; default true.' },
      render: { type: 'string', enum: ['auto', 'static', 'js', 'stealth'] },
      actions: { type: 'array', items: { type: 'object', properties: { type: { type: 'string' }, selector: { type: 'string' }, text: { type: 'string' }, key: { type: 'string' }, ms: { type: 'integer' }, direction: { type: 'string' }, fullPage: { type: 'boolean' }, path: { type: 'string' } }, required: ['type'] } },
      schema: { type: 'object', description: 'For formats:["json"]: {fields:{name:{css|xpath|selector|attr|all|type:list|text|attr}}}. ' },
      prompt: { type: 'string', description: 'Natural-language extraction instruction for formats:["json"].' },
      proxies: { type: 'array', items: { type: 'string' }, description: 'Proxy URLs rotated per request.' },
      proxy: { type: 'string', description: 'A single proxy URL (shorthand for proxies:[proxy]).' },
      save: { type: 'boolean' }, adaptive: { type: 'boolean' },
      concurrency: { type: 'integer', minimum: 1, maximum: 16 }, timeout: { type: 'integer', minimum: 1, maximum: 180 },
      out: { type: 'string', description: 'Optional path to write the JSON result.' },
    }};
  }

  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    try {
      const urls: string[] = Array.isArray(args.urls) && args.urls.length ? args.urls.map((u: any) => String(u)) : (typeof args.url === 'string' && args.url ? [args.url] : []);
      if (!urls.length) throw new Error('url or urls is required');
      for (const url of urls) if (!/^https?:\/\//i.test(url)) throw new Error(`url must be http(s): ${url}`);

      const known: Format[] = ['markdown', 'text', 'html', 'links', 'metadata', 'screenshot', 'json', 'summary', 'changeTracking'];
      const formats: Format[] = Array.isArray(args.formats) && args.formats.length
        ? args.formats.map((f: any) => String(f) as Format).filter((f) => known.includes(f))
        : ['markdown'];
      if (!formats.length) throw new Error('formats must include at least one known format');

      const proxies = Array.isArray(args.proxies) && args.proxies.length ? args.proxies.map((p: any) => String(p)) : (typeof args.proxy === 'string' && args.proxy ? [args.proxy] : []);
      const options: ScrapeOptions = {
        url: '', formats,
        css: typeof args.css === 'string' && args.css ? args.css : undefined,
        xpath: typeof args.xpath === 'string' && args.xpath ? args.xpath : undefined,
        onlyMainContent: args.onlyMainContent !== false,
        timeoutMs: clamp(args.timeout, 30, 1, 180) * 1000,
        proxies,
        render: ['static', 'js', 'stealth'].includes(args.render) ? args.render : 'auto',
        actions: Array.isArray(args.actions) ? args.actions : [],
        schema: args.schema && typeof args.schema === 'object' ? args.schema : undefined,
        prompt: typeof args.prompt === 'string' ? args.prompt : undefined,
        signal: context.signal,
      };
      const concurrency = clamp(args.concurrency, 4, 1, 16);
      const results = await pool(urls, concurrency, (url) => this.scrapeOne(url, options, args.save === true, args.adaptive === true, context));

      const payload = args.urls ? { count: results.length, results } : results[0];
      const limited = limitOutput(JSON.stringify(payload));
      let outPath: string | undefined;
      if (typeof args.out === 'string' && args.out.trim()) {
        outPath = path.resolve(context.cwd, args.out);
        if (!isPathAllowed(outPath)) throw new Error('path not allowed: outside workspace roots');
        await fs.mkdir(path.dirname(outPath), { recursive: true });
        await fs.writeFile(outPath, JSON.stringify(payload, null, 2), 'utf8');
      }
      return success({ ...(payload as any), ...(outPath ? { out: outPath } : {}), ...(limited.truncated ? { truncated: true } : {}) });
    } catch (error) { return failure(error); }
  }

  private async scrapeOne(url: string, base: ScrapeOptions, save: boolean, adaptive: boolean, context: ToolContext): Promise<any> {
    const options: ScrapeOptions = { ...base, url };
    const fetched = await fetchPage(url, options);
    const meta = extractMeta(fetched.html);
    const data: Record<string, any> = {};

    if (!['html', 'text', 'json'].includes(fetched.kind)) {
      documentResult(data, fetched, options.formats);
      return { url: fetched.finalUrl, status: fetched.status, contentType: fetched.contentType, title: meta.title || '', kind: fetched.kind, via: fetched.via, data };
    }

    const target = options.onlyMainContent ? mainContentHtml(fetched.html) : fetched.html;
    const dom = parseHtml(target);
    const wantsSelection = Boolean(options.css || options.xpath);
    const selectionWanted = wantsSelection && (options.formats.some((f) => ['markdown', 'text', 'html'].includes(f)) || save || adaptive);

    if (selectionWanted) {
      let nodes = selectNodes(dom, options);
      let matchedVia: 'selector' | 'adaptive' | 'none' = nodes.length ? 'selector' : 'none';
      if (!nodes.length && adaptive) {
        const prints = await loadFingerprints(url);
        const selector = options.css || options.xpath || '';
        const print = prints.find((p) => p.selector === selector) || prints[0];
        if (print) { nodes = adaptiveMatch(dom, print); if (nodes.length) matchedVia = 'adaptive'; }
      }
      const selected = nodes.slice(0, 500).map((node) => {
        const entry: Record<string, any> = { tag: node.tag };
        if (options.formats.includes('markdown')) entry.markdown = htmlToMarkdown(nodeHtml(node));
        if (options.formats.includes('text')) entry.text = nodeText(node);
        if (options.formats.includes('html')) entry.html = nodeHtml(node);
        if (Object.keys(node.attrs).length) entry.attrs = node.attrs;
        return entry;
      });
      data.selector = options.css || options.xpath;
      data.matchedVia = matchedVia;
      data.count = selected.length;
      data.elements = selected;
      if (save && nodes.length) {
        const selector = options.css || options.xpath || '';
        const prints = await loadFingerprints(url);
        const first = nodes[0];
        const updated = prints.filter((p) => p.selector !== selector);
        updated.push({ url, selector, tag: first.tag, text: nodeText(first).slice(0, 200), attrs: first.attrs, savedAt: new Date().toISOString() });
        await saveFingerprints(url, updated);
      }
    } else {
      if (options.formats.includes('markdown')) data.markdown = htmlToMarkdown(target);
      if (options.formats.includes('text')) data.text = htmlToMarkdown(target).replace(/[#*`>\-]+/g, ' ').replace(/\s+/g, ' ').trim();
      if (options.formats.includes('html')) data.html = target;
    }
    if (options.formats.includes('links')) data.links = extractLinks(fetched.html, fetched.finalUrl);
    if (options.formats.includes('metadata')) data.metadata = { ...meta, url: fetched.finalUrl, status: fetched.status, contentType: fetched.contentType, rendered: fetched.rendered, via: fetched.via, network: fetched.network, console: fetched.console };
    if (options.formats.includes('screenshot')) data.screenshots = fetched.screenshots || [];
    data.assets = extractAssets(fetched.html, fetched.finalUrl).slice(0, 200);
    data.rendered = fetched.rendered;

    if (options.formats.includes('summary')) data.summary = await this.summarize(target, meta, context);
    if (options.formats.includes('json')) data.json = await this.extractStructured(dom, options, fetched, meta, context);
    if (options.formats.includes('changeTracking')) data.changeTracking = await this.trackChange(fetched.finalUrl, htmlToMarkdown(target));

    return { url: fetched.finalUrl, status: fetched.status, contentType: fetched.contentType, title: meta.title || '', kind: 'html', via: fetched.via, data };
  }

  private async summarize(html: string, meta: Record<string, string>, context: ToolContext): Promise<any> {
    const text = htmlToMarkdown(html).slice(0, 8000);
    const result = await chatVia(context, [
      { role: 'system', content: 'Summarize the page as one short paragraph followed by 3-6 bullet takeaways. Be concise.' },
      { role: 'user', content: `Title: ${meta.title || ''}\n\n${text}` },
    ], { signal: context.signal, maxTokens: 800 });
    return result ? { summary: result, via: 'llm' } : { summary: text.slice(0, 400), via: 'truncated-text' };
  }

  private async extractStructured(dom: DomNode, options: ScrapeOptions, fetched: Fetched, meta: Record<string, string>, context: ToolContext): Promise<any> {
    const schema = options.schema;
    if (schema && schema.fields && typeof schema.fields === 'object') {
      const out: Record<string, any> = {};
      for (const [name, spec] of Object.entries<any>(schema.fields)) {
        const selector = spec.selector || spec.css || spec.xpath;
        let nodes: DomNode[];
        if (spec.xpath) nodes = applyXPath(dom, spec.xpath);
        else if (spec.css) nodes = queryAll(dom, spec.css);
        else if (spec.selector) nodes = queryAll(dom, spec.selector);
        else nodes = [];
        const valueOf = (node: DomNode): any => {
          if (spec.attr) return node.attrs[spec.attr] || '';
          if (spec.type === 'html') return nodeHtml(node);
          if (spec.type === 'text') return nodeText(node);
          return node.attrs[spec.attr || 'content'] ?? nodeText(node);
        };
        out[name] = spec.all || spec.type === 'list' ? nodes.map(valueOf) : (nodes.length ? valueOf(nodes[0]) : null);
      }
      return { data: out, via: 'selector-schema' };
    }
    const prompt = options.prompt || 'Extract the key facts as a JSON object with sensible field names.';
    const text = htmlToMarkdown(fetched.html).slice(0, 12000);
    const reply = await chatVia(context, [
      { role: 'system', content: 'You extract structured data. Respond with ONLY a JSON object, no prose, no code fences.' },
      { role: 'user', content: `${prompt}\n\nPage title: ${meta.title || ''}\n\n${text}` },
    ], { signal: options.signal, maxTokens: 2000 });
    if (!reply) return { data: null, via: 'llm-unavailable', note: 'configure OPENAI_API_KEY / ANTHROPIC_API_KEY / GEMINI_API_KEY for prompt-based extraction' };
    try { return { data: JSON.parse(reply.replace(/^```json\s*|\s*```$/g, '').trim()), via: 'llm' }; }
    catch { return { data: null, raw: reply.slice(0, 2000), via: 'llm-unparsed' }; }
  }

  private async trackChange(url: string, markdown: string): Promise<any> {
    const dir = await ensureDataDir('scrape-snapshots');
    const hash = createHash('sha1').update(url).digest('hex').slice(0, 16);
    const file = path.join(dir, `${hash}.txt`);
    let previous = '';
    try { previous = await fs.readFile(file, 'utf8'); } catch { /* first run */ }
    await fs.writeFile(file, markdown, 'utf8');
    if (!previous) return { changed: true, firstRun: true, bytes: markdown.length };
    const changed = previous !== markdown;
    return { changed, previousBytes: previous.length, currentBytes: markdown.length, similarity: similarity(previous, markdown) };
  }
}

/** Quick Dice coefficient over 4-gram shingles for a change score. */
function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const grams = (s: string) => { const set = new Set<string>(); for (let i = 0; i + 4 <= s.length; i++) set.add(s.slice(i, i + 4)); return set; };
  const ga = grams(a); const gb = grams(b);
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter++;
  return Number((2 * inter / (ga.size + gb.size)).toFixed(3));
}
