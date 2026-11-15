import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { resolveCli, runCli, optionalImport, moduleAvailable } from './deps.js';
import { runCdpBrowser, findCdpExecutable } from './browser_cdp.js';

export interface BrowserProbe {
  /** A name for this state, e.g. "menu-open". */
  label?: string;
  /** Interactions to replay before reading, so opened menus and dialogs count. */
  interactions?: BrowserAction[];
  maxElements?: number;
}

export interface BrowserProbeResult {
  label: string;
  data: Record<string, any>;
}

export interface BrowserAction {
  type: 'wait' | 'click' | 'scroll' | 'write' | 'press' | 'screenshot' | 'goto' | 'hover' | 'probe';
  selector?: string;
  text?: string;
  key?: string;
  ms?: number;
  direction?: 'up' | 'down';
  fullPage?: boolean;
  path?: string;
  probe?: BrowserProbe;
}

/**
 * The visual properties worth comparing. Kept here rather than in the caller so
 * the live read and the static fallback cannot drift apart.
 */
export const PROBE_PROPERTIES = [
  'display', 'position', 'flex-direction', 'justify-content', 'align-items',
  'width', 'height', 'margin', 'padding', 'gap',
  'color', 'background-color', 'border', 'border-radius',
  'font-size', 'font-weight', 'font-family', 'line-height', 'letter-spacing', 'text-align',
  'box-shadow', 'opacity', 'overflow', 'z-index',
] as const;

export interface BrowserOptions {
  url: string;
  timeoutMs: number;
  actions?: BrowserAction[];
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
  userAgent?: string;
  proxy?: string;
  stealth?: boolean;
  screenshot?: boolean;
  captureNetwork?: boolean;
  viewport?: { width: number; height: number };
  signal?: AbortSignal;
}

export interface BrowserResult {
  html: string;
  status: number;
  finalUrl: string;
  screenshots: Array<{ path?: string; dataUrl?: string }>;
  /** One entry per probe action: live computed styles and layout, in order. */
  probes: BrowserProbeResult[];
  probeErrors?: Array<{ label: string; error: string }>;
  network: Array<{ url: string; method: string; status?: number; resourceType?: string }>;
  console: Array<{ type: string; text: string }>;
  via: string;
  rendered: boolean;
}

/**
 * Read what a visitor can actually see: computed styles, real geometry, visible
 * text, and the state of interactive controls.
 *
 * This runs inside the page, so it is the same script for both browser backends.
 * Only visible elements count — a hidden menu is not a section that went
 * missing from a rebuild. Paths use tag + first class + sibling ordinal, which
 * survives a rebuild that renames ids but keeps the structure.
 */
export function probeScript(maxElements = 400): string {
  return `(() => {
  const PROPS = ${JSON.stringify(PROBE_PROPERTIES)};
  const MAX = ${Math.max(1, Math.floor(maxElements))};
  const out = [];
  const ordinals = new Map();
  const root = document.body || document.documentElement;
  if (!root) return { title: document.title || '', text: '', elements: [], states: [], scroll: { width: 0, height: 0 } };
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let node = walker.currentNode;
  while (node && out.length < MAX) {
    const el = node;
    node = walker.nextNode();
    if (!(el instanceof HTMLElement)) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 && r.height <= 0) continue;
    const tag = el.tagName.toLowerCase();
    const parentKey = (el.parentElement ? el.parentElement.tagName : 'root') + '>' + tag;
    const ordinal = (ordinals.get(parentKey) || 0) + 1;
    ordinals.set(parentKey, ordinal);
    const cls = (el.className && typeof el.className === 'string') ? el.className.trim().split(/\\s+/)[0] : '';
    const path = (cls ? tag + '.' + cls : tag) + '#' + ordinal;
    const style = {};
    for (const p of PROPS) { const v = cs.getPropertyValue(p); if (v) style[p] = v; }
    const ownText = Array.from(el.childNodes)
      .filter((n) => n.nodeType === Node.TEXT_NODE)
      .map((n) => n.textContent || '').join(' ').replace(/\\s+/g, ' ').trim();
    out.push({
      path, tag,
      role: el.getAttribute('role') || '',
      text: ownText.slice(0, 400),
      style,
      rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
      state: {
        hidden: el.hasAttribute('hidden'),
        disabled: Boolean(el.disabled),
        checked: Boolean(el.checked),
        expanded: el.getAttribute('aria-expanded'),
        selected: el.getAttribute('aria-selected'),
      },
    });
  }
  const states = [];
  for (const el of document.querySelectorAll('[aria-expanded], [aria-selected], details, dialog, [role="menu"], [role="dialog"], input, select, textarea')) {
    if (states.length >= 120) break;
    states.push({
      tag: el.tagName.toLowerCase(),
      label: (el.getAttribute('aria-label') || el.getAttribute('name') || el.id || '').slice(0, 80),
      expanded: el.getAttribute('aria-expanded'),
      selected: el.getAttribute('aria-selected'),
      open: el.tagName === 'DETAILS' ? el.hasAttribute('open') : (el.tagName === 'DIALOG' ? el.hasAttribute('open') : null),
      checked: el.checked === undefined ? null : Boolean(el.checked),
      value: (el.value !== undefined && typeof el.value === 'string') ? el.value.slice(0, 120) : null,
    });
  }
  return {
    title: document.title || '',
    text: (root.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 30000),
    elements: out,
    states,
    scroll: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
  };
})()`;
}

/**
 * Is *any* backend able to render a page?
 *
 * A Playwright CLI on PATH is not enough: `playwright --version` succeeds with
 * the package installed globally while neither the Node module nor the Python
 * package can be imported, and a check built on that answer degrades into the
 * static-markup fallback without anyone noticing. So each backend is asked the
 * question it actually has to answer, and the local Chromium is the last one.
 */
export async function browserAvailable(): Promise<boolean> {
  if (await moduleAvailable('playwright')) return true;
  const python = await resolveCli('python');
  if (python.available) {
    const probe = await runCli(python.command, ['-c', 'import playwright'], { timeout: 8000 });
    if (probe.code === 0) return true;
  }
  return Boolean(await findCdpExecutable());
}

const PYTHON_DRIVER = String.raw`
import sys, json, base64, os
try:
    from playwright.sync_api import sync_playwright
except Exception:
    print(json.dumps({"error": "no-playwright"})); sys.exit(3)
cfg = json.loads(sys.stdin.read())
result = {"screenshots": [], "network": [], "console": [], "probes": []}
with sync_playwright() as p:
    launch_args = {}
    if cfg.get("proxy"):
        launch_args["proxy"] = {"server": cfg["proxy"]}
    browser = p.chromium.launch(headless=True, **launch_args)
    context_args = {}
    if cfg.get("userAgent"):
        context_args["user_agent"] = cfg["userAgent"]
    if cfg.get("viewport"):
        context_args["viewport"] = cfg["viewport"]
    context = browser.new_context(**context_args)
    page = context.new_page()
    if cfg.get("captureNetwork"):
        def on_response(resp):
            result["network"].append({"url": resp.url, "method": resp.request.method, "status": resp.status, "resourceType": resp.request.resource_type})
        page.on("response", on_response)
    page.on("console", lambda msg: result["console"].append({"type": msg.type, "text": msg.text}))
    wait_until = cfg.get("waitUntil") or "load"
    resp = page.goto(cfg["url"], wait_until=wait_until, timeout=cfg["timeoutMs"])
    result["status"] = resp.status if resp else 0
    for action in cfg.get("actions", []):
        t = action["type"]
        sel = action.get("selector")
        try:
            if t == "wait":
                page.wait_for_timeout(int(action.get("ms", 1000)))
            elif t == "click":
                page.click(sel or "body", timeout=cfg["timeoutMs"])
            elif t == "write":
                page.fill(sel or "body", action.get("text", ""), timeout=cfg["timeoutMs"])
            elif t == "press":
                page.press(sel or "body", action.get("key", "Enter"))
            elif t == "scroll":
                dy = 800
                if action.get("direction") == "up":
                    dy = -800
                page.mouse.wheel(0, dy)
                page.wait_for_timeout(400)
            elif t == "goto":
                page.goto(action.get("text") or action.get("selector"), wait_until="load", timeout=cfg["timeoutMs"])
            elif t == "screenshot":
                if action.get("path"):
                    page.screenshot(path=action["path"], full_page=bool(action.get("fullPage")))
                    result["screenshots"].append({"path": action["path"]})
                else:
                    data = page.screenshot(full_page=bool(action.get("fullPage")))
                    result["screenshots"].append({"dataUrl": "data:image/png;base64," + base64.b64encode(data).decode()})
            elif t == "hover":
                page.hover(sel or "body", timeout=cfg["timeoutMs"])
            elif t == "probe":
                probe = action.get("probe") or {}
                label = probe.get("label") or "probe"
                for step in probe.get("interactions", []):
                    st = step["type"]
                    s2 = step.get("selector")
                    try:
                        if st == "click": page.click(s2 or "body", timeout=cfg["timeoutMs"])
                        elif st == "hover": page.hover(s2 or "body", timeout=cfg["timeoutMs"])
                        elif st == "write": page.fill(s2 or "body", step.get("text", ""), timeout=cfg["timeoutMs"])
                        elif st == "press": page.press(s2 or "body", step.get("key", "Enter"))
                        elif st == "wait": page.wait_for_timeout(int(step.get("ms", 300)))
                        elif st == "scroll": page.mouse.wheel(0, 800); page.wait_for_timeout(300)
                    except Exception as exc:
                        result.setdefault("probeErrors", []).append({"label": label, "error": str(exc)})
                try:
                    data = page.evaluate(cfg["probeScript"])
                    result["probes"].append({"label": label, "data": data})
                except Exception as exc:
                    result.setdefault("probeErrors", []).append({"label": label, "error": str(exc)})
        except Exception as exc:
            result.setdefault("actionErrors", []).append({"type": t, "error": str(exc)})
    if cfg.get("screenshot"):
        data = page.screenshot(full_page=True)
        result["screenshots"].append({"dataUrl": "data:image/png;base64," + base64.b64encode(data).decode()})
    result["html"] = page.content()
    result["finalUrl"] = page.url
    browser.close()
print(json.dumps(result))
`;

async function runPythonBrowser(options: BrowserOptions): Promise<BrowserResult | null> {
  const python = await resolveCli('python');
  if (!python.available) return null;
  const config = {
    url: options.url,
    timeoutMs: options.timeoutMs,
    actions: options.actions || [],
    waitUntil: options.waitUntil || 'load',
    userAgent: options.userAgent,
    proxy: options.proxy,
    screenshot: options.screenshot,
    captureNetwork: options.captureNetwork,
    viewport: options.viewport,
    probeScript: probeScript(),
  };
  const result = await runCli(python.command, ['-c', PYTHON_DRIVER], { input: JSON.stringify(config), timeout: options.timeoutMs + 60_000, signal: options.signal, maxBuffer: 128 * 1024 * 1024 });
  if (result.code !== 0 || !result.stdout.trim()) return null;
  try {
    const parsed = JSON.parse(result.stdout.trim().split('\n').pop()!);
    if (parsed.error) return null;
    return {
      html: parsed.html || '',
      status: parsed.status || 200,
      finalUrl: parsed.finalUrl || options.url,
      screenshots: parsed.screenshots || [],
      probes: parsed.probes || [],
      ...(parsed.probeErrors ? { probeErrors: parsed.probeErrors } : {}),
      network: parsed.network || [],
      console: parsed.console || [],
      via: 'python-playwright',
      rendered: true,
    };
  } catch {
    return null;
  }
}

async function runNodeBrowser(options: BrowserOptions): Promise<BrowserResult | null> {
  const playwright = await optionalImport<any>('playwright');
  if (!playwright) return null;
  let browser: any;
  try {
    const launchOptions: Record<string, any> = {};
    if (options.proxy) launchOptions.proxy = { server: options.proxy };
    browser = await playwright.chromium.launch({ headless: true, ...launchOptions });
    const context = await browser.newContext({ userAgent: options.userAgent, viewport: options.viewport });
    const page = await context.newPage();
    const network: BrowserResult['network'] = [];
    const consoleMessages: BrowserResult['console'] = [];
    if (options.captureNetwork) page.on('response', (resp: any) => network.push({ url: resp.url(), method: resp.request().method(), status: resp.status(), resourceType: resp.request().resourceType() }));
    page.on('console', (msg: any) => consoleMessages.push({ type: msg.type(), text: msg.text() }));
    const response = await page.goto(options.url, { waitUntil: options.waitUntil || 'load', timeout: options.timeoutMs });
    const screenshots: BrowserResult['screenshots'] = [];
    const probes: BrowserProbeResult[] = [];
    const probeErrors: Array<{ label: string; error: string }> = [];
    for (const action of options.actions || []) {
      try {
        if (action.type === 'wait') await page.waitForTimeout(action.ms ?? 1000);
        else if (action.type === 'click') await page.click(action.selector || 'body', { timeout: options.timeoutMs });
        else if (action.type === 'hover') await page.hover(action.selector || 'body', { timeout: options.timeoutMs });
        else if (action.type === 'write') await page.fill(action.selector || 'body', action.text || '', { timeout: options.timeoutMs });
        else if (action.type === 'press') await page.press(action.selector || 'body', action.key || 'Enter');
        else if (action.type === 'scroll') { await page.mouse.wheel(0, (action.direction === 'up' ? -1 : 1) * 800); await page.waitForTimeout(400); }
        else if (action.type === 'goto') await page.goto(action.text || action.selector || options.url, { waitUntil: 'load', timeout: options.timeoutMs });
        else if (action.type === 'screenshot') {
          if (action.path) { await page.screenshot({ path: action.path, fullPage: !!action.fullPage }); screenshots.push({ path: action.path }); }
          else { const data = await page.screenshot({ fullPage: !!action.fullPage }); screenshots.push({ dataUrl: `data:image/png;base64,${Buffer.from(data).toString('base64')}` }); }
        }
        else if (action.type === 'probe') {
          const label = action.probe?.label || `probe-${probes.length + 1}`;
          for (const step of action.probe?.interactions || []) {
            try {
              if (step.type === 'click') await page.click(step.selector || 'body', { timeout: options.timeoutMs });
              else if (step.type === 'hover') await page.hover(step.selector || 'body', { timeout: options.timeoutMs });
              else if (step.type === 'write') await page.fill(step.selector || 'body', step.text || '', { timeout: options.timeoutMs });
              else if (step.type === 'press') await page.press(step.selector || 'body', step.key || 'Enter');
              else if (step.type === 'wait') await page.waitForTimeout(step.ms ?? 300);
              else if (step.type === 'scroll') { await page.mouse.wheel(0, 800); await page.waitForTimeout(300); }
            } catch (error: any) {
              probeErrors.push({ label, error: error?.message || String(error) });
            }
          }
          const data = await page.evaluate(probeScript(action.probe?.maxElements ?? 400));
          probes.push({ label, data });
        }
      } catch (error: any) {
        probeErrors.push({ label: action.probe?.label || action.type, error: error?.message || String(error) });
      }
    }
    if (options.screenshot) {
      const data = await page.screenshot({ fullPage: true });
      screenshots.push({ dataUrl: `data:image/png;base64,${Buffer.from(data).toString('base64')}` });
    }
    const html = await page.content();
    const finalUrl = page.url();
    const status = response ? response.status() : 200;
    return { html, status, finalUrl, screenshots, probes, ...(probeErrors.length ? { probeErrors } : {}), network, console: consoleMessages, via: 'node-playwright', rendered: true };
  } catch {
    return null;
  } finally {
    try { await browser?.close(); } catch { }
  }
}

/**
 * Render a page with whichever backend is present.
 *
 * Order matters: the Node module, then the Python package, then the local
 * browser over CDP. The last one is not a degraded mode — it renders, probes
 * and screenshots exactly like the other two — which is what keeps a craft
 * check honest on a machine with no Playwright installed.
 */
export async function renderWithBrowser(options: BrowserOptions): Promise<BrowserResult | null> {
  if (process.env.OKAY_NO_BROWSER === '1') return null;
  const node = await runNodeBrowser(options);
  if (node) return node;
  const python = await runPythonBrowser(options);
  if (python) return python;
  return runCdpBrowser({
    url: options.url,
    timeoutMs: options.timeoutMs,
    ...(options.actions ? { actions: options.actions } : {}),
    ...(options.waitUntil ? { waitUntil: options.waitUntil } : {}),
    ...(options.viewport ? { viewport: options.viewport } : {}),
    ...(options.screenshot ? { screenshot: options.screenshot } : {}),
    probeScript: probeScript(),
  });
}

export async function screenshotUrl(urlOrHtml: string, outPath: string, options: { timeoutMs?: number; fullPage?: boolean; signal?: AbortSignal } = {}): Promise<boolean> {
  const isUrl = /^https?:\/\//i.test(urlOrHtml);
  const timeoutMs = options.timeoutMs ?? 30_000;
  const result = await renderWithBrowser({
    url: isUrl ? urlOrHtml : `data:text/html;base64,${Buffer.from(urlOrHtml).toString('base64')}`,
    timeoutMs,
    screenshot: false,
    actions: [{ type: 'screenshot', path: outPath, fullPage: options.fullPage !== false }],
    signal: options.signal,
  });
  return !!result && result.screenshots.some((shot) => shot.path === outPath);
}

export async function screenshotHtmlDataUrl(html: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<string | null> {
  const result = await renderWithBrowser({
    url: `data:text/html;base64,${Buffer.from(html).toString('base64')}`,
    timeoutMs: options.timeoutMs ?? 30_000,
    screenshot: true,
    signal: options.signal,
  });
  const shot = result?.screenshots.find((s) => s.dataUrl);
  return shot?.dataUrl || null;
}

export async function tempScreenshotPath(label: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), '0kay-shot-'));
  return path.join(dir, `${label}-${randomUUID().slice(0, 8)}.png`);
}
