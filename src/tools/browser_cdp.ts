// Driving a real browser with no driver library.
//
// The craft loop needs a rendered page: computed styles, geometry, opened menus,
// and a full-page screenshot. A Playwright backend gives that when it is
// installed; this one gives it when it is not, by speaking the same protocol
// (Chrome DevTools Protocol) over the browser's own WebSocket. That matters
// because a missing driver used to degrade a craft check into a static-markup
// approximation, which is exactly the evidence clean room is supposed to avoid.
//
// One connection per render, one page target per render. No shared state: two
// widths observed at once must not fight over a tab.

import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { BrowserAction, BrowserProbeResult, BrowserResult } from './browser_driver.js';

const CANDIDATES: Record<string, string[]> = {
  win32: [
    `${process.env['ProgramFiles'] || 'C:\\Program Files'}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env['LocalAppData'] || ''}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${process.env['ProgramFiles'] || 'C:\\Program Files'}\\Microsoft\\Edge\\Application\\msedge.exe`,
  ],
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ],
  linux: [],
};

const LINUX_COMMANDS = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'];

/** The browser binary to drive, or '' when this machine has none. */
export async function findCdpExecutable(): Promise<string> {
  const explicit = process.env.OKAY_BROWSER_PATH || process.env.CHROME_PATH || '';
  if (explicit) {
    const ok = await fs.stat(explicit).then(() => true).catch(() => false);
    if (ok) return explicit;
  }
  for (const candidate of CANDIDATES[process.platform] || []) {
    if (!candidate) continue;
    const ok = await fs.stat(candidate).then(() => true).catch(() => false);
    if (ok) return candidate;
  }
  if (process.platform === 'linux') {
    for (const command of LINUX_COMMANDS) {
      const found = await which(command);
      if (found) return found;
    }
  }
  return '';
}

async function which(command: string): Promise<string> {
  const dirs = String(process.env.PATH || '').split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    const full = path.join(dir, command);
    const ok = await fs.stat(full).then((stat) => stat.isFile()).catch(() => false);
    if (ok) return full;
  }
  return '';
}

// ---- minimal CDP client ----------------------------------------------------

interface Pending {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

class Session {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private listeners = new Map<string, Array<(params: any) => void>>();

  constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', (event) => {
      let message: any;
      try { message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data)); } catch { return; }
      if (message.id && this.pending.has(message.id)) {
        const call = this.pending.get(message.id)!;
        this.pending.delete(message.id);
        clearTimeout(call.timer);
        if (message.error) call.reject(new Error(message.error.message || 'CDP error'));
        else call.resolve(message.result);
        return;
      }
      for (const listener of this.listeners.get(String(message.method || '')) || []) {
        try { listener(message.params || {}); } catch { /* a listener must not kill the session */ }
      }
    });
  }

  static connect(url: string, timeoutMs = 15_000): Promise<Session> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => { try { socket.close(); } catch { } reject(new Error('CDP connect timeout')); }, timeoutMs);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(new Session(socket)); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP connect failed')); }, { once: true });
    });
  }

  send(method: string, params: Record<string, any> = {}, timeoutMs = 30_000): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP ${method} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method: string, listener: (params: any) => void): () => void {
    const list = this.listeners.get(method) || [];
    list.push(listener);
    this.listeners.set(method, list);
    return () => {
      const next = (this.listeners.get(method) || []).filter((row) => row !== listener);
      if (next.length) this.listeners.set(method, next);
      else this.listeners.delete(method);
    };
  }

  close(): void {
    for (const call of this.pending.values()) { clearTimeout(call.timer); call.reject(new Error('CDP closed')); }
    this.pending.clear();
    try { this.socket.close(); } catch { }
  }
}

// ---- one page, one render --------------------------------------------------

const IDLE_TIMEOUT_MS = 6_000;
const SETTLE_MS = 250;

/**
 * Load a URL and run the requested actions against it, then report the same
 * shape the Playwright backends report — so `observe.ts` cannot tell which one
 * produced the evidence, and every check works the same way either way.
 */
export async function runCdpBrowser(options: {
  url: string;
  timeoutMs: number;
  actions?: BrowserAction[];
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
  viewport?: { width: number; height: number };
  probeScript?: string;
  screenshot?: boolean;
}): Promise<BrowserResult | null> {
  const executable = await findCdpExecutable();
  if (!executable) return null;
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), '0kay-craft-browser-'));
  const width = options.viewport?.width || 1280;
  const height = options.viewport?.height || 900;
  let child: ChildProcess | null = null;
  let session: Session | null = null;
  try {
    child = spawn(executable, [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
      '--disable-extensions', '--disable-popup-blocking', '--disable-gpu', '--hide-scrollbars',
      '--disable-sync', '--no-service-autorun', '--disable-component-update',
      '--disable-features=msEdgeSyncPromo,msSyncPromo,EdgeCollectionsPromo,msEdgeWelcomePage,SigninPromo',
      `--window-size=${width},${height}`,
      'about:blank',
    ], { stdio: 'ignore', windowsHide: true });

    const port = await readDevToolsPort(profile, Math.min(options.timeoutMs, 25_000));
    const target = await firstPageTarget(port);
    if (!target) return null;
    session = await Session.connect(target.webSocketDebuggerUrl);

    await session.send('Page.enable');
    await session.send('Runtime.enable');
    // `mobile: true` makes Chrome fall back to the 980px layout width whenever
    // the page has no `<meta name="viewport">` — the measured page then reports
    // 980 at every "phone" width, which would quietly ruin the narrow check.
    // A desktop metric override sets the layout width to exactly what was asked.
    await session.send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 1, mobile: false,
    });

    const consoleMessages: BrowserResult['console'] = [];
    const network: BrowserResult['network'] = [];
    session.on('Runtime.consoleAPICalled', (params: any) => {
      consoleMessages.push({ type: String(params.type || 'log'), text: (params.args || []).map((arg: any) => String(arg.value ?? arg.description ?? '')).join(' ') });
    });
    session.on('Runtime.exceptionThrown', (params: any) => {
      consoleMessages.push({ type: 'error', text: String(params.exceptionDetails?.exception?.description || params.exceptionDetails?.text || '') });
    });
    session.on('Network.responseReceived', (params: any) => {
      network.push({ url: String(params.response?.url || ''), method: '', status: Number(params.response?.status || 0), resourceType: String(params.type || '') });
    });

    let loaded = false;
    const offLoad = session.on('Page.loadEventFired', () => { loaded = true; });
    const navigate = await session.send('Page.navigate', { url: options.url }, options.timeoutMs).catch((error: Error) => ({ error }));
    if ((navigate as any).error) return null;
    const status = Number((navigate as any).frameId ? 200 : 200);

    await waitFor(() => loaded, Math.min(options.timeoutMs, 30_000));
    offLoad();
    if (options.waitUntil === 'networkidle') await settle(session);
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

    const screenshots: BrowserResult['screenshots'] = [];
    const probes: BrowserProbeResult[] = [];
    const probeErrors: Array<{ label: string; error: string }> = [];

    for (const action of options.actions || []) {
      try {
        await performAction(session, action, options, screenshots, probes, probeErrors);
      } catch (error: any) {
        probeErrors.push({ label: action.probe?.label || action.type, error: error?.message || String(error) });
      }
    }

    if (options.screenshot) {
      const data = await captureScreenshot(session, true);
      if (data) screenshots.push({ dataUrl: `data:image/png;base64,${data}` });
    }

    const html = await evaluate(session, 'document.documentElement.outerHTML').catch(() => '');
    const finalUrl = await evaluate(session, 'location.href').catch(() => options.url);
    return {
      html: String(html || ''),
      status,
      finalUrl: String(finalUrl || options.url),
      screenshots,
      probes,
      ...(probeErrors.length ? { probeErrors } : {}),
      network,
      console: consoleMessages,
      via: 'cdp',
      rendered: true,
    };
  } catch {
    return null;
  } finally {
    session?.close();
    try { child?.kill(); } catch { }
    await fs.rm(profile, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function performAction(
  session: Session,
  action: BrowserAction,
  options: { timeoutMs: number; probeScript?: string; viewport?: { width: number; height: number }; url: string },
  screenshots: BrowserResult['screenshots'],
  probes: BrowserProbeResult[],
  probeErrors: Array<{ label: string; error: string }>,
): Promise<void> {
  const selector = action.selector || 'body';
  switch (action.type) {
    case 'wait':
      await new Promise((resolve) => setTimeout(resolve, action.ms ?? 1000));
      return;
    case 'click':
      await clickSelector(session, selector);
      return;
    case 'hover':
      await hoverSelector(session, selector);
      return;
    case 'write': {
      const text = JSON.stringify(action.text || '');
      await evaluate(session, `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) throw new Error('no element for ${selector}');
        el.focus();
        if ('value' in el) { el.value = ${text}; }
        else { el.textContent = ${text}; }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`);
      return;
    }
    case 'press': {
      const key = action.key || 'Enter';
      await evaluate(session, `(() => {
        const el = document.querySelector(${JSON.stringify(selector)}) || document.body;
        const key = ${JSON.stringify(key)};
        const down = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
        el.dispatchEvent(down);
        el.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }));
        if (key === 'Enter' && el.form && typeof el.form.requestSubmit === 'function') el.form.requestSubmit();
        return true;
      })()`);
      return;
    }
    case 'scroll':
      await evaluate(session, `window.scrollBy(0, ${action.direction === 'up' ? -800 : 800})`);
      await new Promise((resolve) => setTimeout(resolve, 400));
      return;
    case 'goto':
      await session.send('Page.navigate', { url: action.text || action.selector || options.url }, options.timeoutMs);
      await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
      return;
    case 'screenshot': {
      const fullPage = action.fullPage !== false;
      const data = await captureScreenshot(session, fullPage);
      if (!data) return;
      if (action.path) {
        await fs.mkdir(path.dirname(action.path), { recursive: true });
        await fs.writeFile(action.path, Buffer.from(data, 'base64'));
        screenshots.push({ path: action.path });
      } else {
        screenshots.push({ dataUrl: `data:image/png;base64,${data}` });
      }
      return;
    }
    case 'probe': {
      const label = action.probe?.label || `probe-${probes.length + 1}`;
      for (const step of action.probe?.interactions || []) {
        try {
          if (step.type === 'click') await clickSelector(session, step.selector || 'body');
          else if (step.type === 'hover') await hoverSelector(session, step.selector || 'body');
          else if (step.type === 'write') {
            await performAction(session, { ...step, type: 'write' }, options, screenshots, probes, probeErrors);
          } else if (step.type === 'press') {
            await performAction(session, { ...step, type: 'press' }, options, screenshots, probes, probeErrors);
          } else if (step.type === 'wait') {
            await new Promise((resolve) => setTimeout(resolve, step.ms ?? 300));
          } else if (step.type === 'scroll') {
            await evaluate(session, 'window.scrollBy(0, 800)');
            await new Promise((resolve) => setTimeout(resolve, 300));
          }
        } catch (error: any) {
          // An interaction that finds no control is normal on most pages; it is
          // reported as a limitation rather than failing the whole observation.
          probeErrors.push({ label, error: error?.message || String(error) });
        }
      }
      const data = await evaluate(session, options.probeScript || 'null');
      if (data) probes.push({ label, data });
      return;
    }
    default:
      return;
  }
}

async function evaluate(session: Session, expression: string): Promise<any> {
  const result = await session.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result?.exceptionDetails) {
    throw new Error(String(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'evaluate failed'));
  }
  return result?.result?.value;
}

/** Click by real mouse events, so hover menus and mousedown handlers see it. */
async function clickSelector(session: Session, selector: string): Promise<void> {
  const box = await evaluate(session, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return null;
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  if (!box) throw new Error(`no visible element for ${selector}`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await session.send('Input.dispatchMouseEvent', {
      type, x: box.x, y: box.y, button: 'left', clickCount: 1,
    });
  }
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
}

async function hoverSelector(session: Session, selector: string): Promise<void> {
  const box = await evaluate(session, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return null;
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  if (!box) throw new Error(`no visible element for ${selector}`);
  await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
}

async function captureScreenshot(session: Session, fullPage: boolean): Promise<string | null> {
  if (fullPage) {
    const metrics = await session.send('Page.getLayoutMetrics').catch(() => null);
    const content = metrics?.cssContentSize || metrics?.contentSize;
    if (content?.width && content?.height) {
      const width = Math.ceil(content.width);
      const height = Math.ceil(content.height);
      const shot = await session.send('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width, height, scale: 1 },
      }).catch(() => null);
      if (shot?.data) return String(shot.data);
    }
  }
  const shot = await session.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: fullPage }).catch(() => null);
  return shot?.data ? String(shot.data) : null;
}

/** Wait for the page to stop opening connections; time out quietly. */
async function settle(session: Session): Promise<void> {
  const inFlight = new Set<string>();
  const started = Date.now();
  let last = Date.now();
  const offStart = session.on('Network.requestWillBeSent', (params: any) => {
    inFlight.add(String(params.requestId || ''));
    last = Date.now();
  });
  const offEnd = session.on('Network.loadingFinished', (params: any) => {
    inFlight.delete(String(params.requestId || ''));
    last = Date.now();
  });
  const offFail = session.on('Network.loadingFailed', (params: any) => {
    inFlight.delete(String(params.requestId || ''));
    last = Date.now();
  });
  await session.send('Network.enable').catch(() => undefined);
  while (Date.now() - started < IDLE_TIMEOUT_MS) {
    if (!inFlight.size && Date.now() - last > 400) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  offStart(); offEnd(); offFail();
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function readDevToolsPort(profile: string, timeoutMs: number): Promise<number> {
  const marker = path.join(profile, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const text = await fs.readFile(marker, 'utf8');
      const port = Number(text.split(/\r?\n/, 1)[0]);
      if (Number.isFinite(port) && port > 0) return port;
    } catch { /* not written yet */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('the browser did not expose a debugging port');
}

async function firstPageTarget(port: number): Promise<{ webSocketDebuggerUrl: string } | null> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) });
      const list = await response.json() as Array<Record<string, any>>;
      const page = list.find((row) => row.type === 'page' && row.webSocketDebuggerUrl);
      if (page) return { webSocketDebuggerUrl: String(page.webSocketDebuggerUrl) };
    } catch { /* devtools not listening yet */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}