/**
 * Headless-browser driver shared by scrape, crawl, pentest and
 * screenshot_to_code.
 *
 * Prefers the Node Playwright library when installed; falls back to a Python
 * Playwright script when only the system CLI is present; otherwise reports the
 * capability as unavailable so the caller can degrade to a static fetch.
 *
 * Supports the Firecrawl-style action list (wait, click, scroll, write, press,
 * screenshot) and page observation (network, console, screenshots), so JS-heavy
 * pages and interactions behave like Scrapling's DynamicFetcher / Firecrawl's
 * /scrape actions.
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { resolveCli, runCli, optionalImport, moduleAvailable } from './deps.js';

export interface BrowserAction {
  type: 'wait' | 'click' | 'scroll' | 'write' | 'press' | 'screenshot' | 'goto';
  selector?: string;
  text?: string;
  key?: string;
  ms?: number;
  direction?: 'up' | 'down';
  fullPage?: boolean;
  path?: string;
}

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
  network: Array<{ url: string; method: string; status?: number; resourceType?: string }>;
  console: Array<{ type: string; text: string }>;
  via: string;
  rendered: boolean;
}

export async function browserAvailable(): Promise<boolean> {
  if (await moduleAvailable('playwright')) return true;
  const cli = await resolveCli('playwright');
  if (cli.available) return true;
  const python = await resolveCli('python');
  if (python.available) {
    const probe = await runCli(python.command, ['-c', 'import playwright'], { timeout: 8000 });
    if (probe.code === 0) return true;
  }
  return false;
}

const PYTHON_DRIVER = String.raw`
import sys, json, base64, os
try:
    from playwright.sync_api import sync_playwright
except Exception:
    print(json.dumps({"error": "no-playwright"})); sys.exit(3)
cfg = json.loads(sys.stdin.read())
result = {"screenshots": [], "network": [], "console": []}
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

/** Drive the page with the Python Playwright driver. */
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
      network: parsed.network || [],
      console: parsed.console || [],
      via: 'python-playwright',
      rendered: true,
    };
  } catch {
    return null;
  }
}

/** Drive the page with the Node Playwright library. */
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
    for (const action of options.actions || []) {
      try {
        if (action.type === 'wait') await page.waitForTimeout(action.ms ?? 1000);
        else if (action.type === 'click') await page.click(action.selector || 'body', { timeout: options.timeoutMs });
        else if (action.type === 'write') await page.fill(action.selector || 'body', action.text || '', { timeout: options.timeoutMs });
        else if (action.type === 'press') await page.press(action.selector || 'body', action.key || 'Enter');
        else if (action.type === 'scroll') { await page.mouse.wheel(0, (action.direction === 'up' ? -1 : 1) * 800); await page.waitForTimeout(400); }
        else if (action.type === 'goto') await page.goto(action.text || action.selector || options.url, { waitUntil: 'load', timeout: options.timeoutMs });
        else if (action.type === 'screenshot') {
          if (action.path) { await page.screenshot({ path: action.path, fullPage: !!action.fullPage }); screenshots.push({ path: action.path }); }
          else { const data = await page.screenshot({ fullPage: !!action.fullPage }); screenshots.push({ dataUrl: `data:image/png;base64,${Buffer.from(data).toString('base64')}` }); }
        }
      } catch { /* keep going through the action list */ }
    }
    if (options.screenshot) {
      const data = await page.screenshot({ fullPage: true });
      screenshots.push({ dataUrl: `data:image/png;base64,${Buffer.from(data).toString('base64')}` });
    }
    const html = await page.content();
    const finalUrl = page.url();
    const status = response ? response.status() : 200;
    return { html, status, finalUrl, screenshots, network, console: consoleMessages, via: 'node-playwright', rendered: true };
  } catch {
    return null;
  } finally {
    try { await browser?.close(); } catch { /* already closed */ }
  }
}

/** Render a page with any available browser; returns null when none works. */
export async function renderWithBrowser(options: BrowserOptions): Promise<BrowserResult | null> {
  if (process.env.OKAY_NO_BROWSER === '1') return null;
  const node = await runNodeBrowser(options);
  if (node) return node;
  return runPythonBrowser(options);
}

/** Screenshot a URL or an HTML string (used by screenshot_to_code preview). */
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

/** Render an HTML string and return a PNG data URL (for self-check previews). */
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
