/**
 * Browser automation for the Agent, driven over the Chrome DevTools Protocol.
 *
 * Node 22+ ships a global WebSocket, so a launched Chrome/Edge can be driven
 * with no extra dependency (no Playwright/Puppeteer). One controller owns a
 * single browser instance per agent host and exposes a queryable status object
 * that the WebUI reads to show the live state.
 */

import { spawn, type ChildProcess } from 'child_process';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const execFileAsync = promisify(execFile);

export interface BrowserStatus {
  /** Whether a browser binary was found on this host. */
  available: boolean;
  /** Whether a browser instance is currently running. */
  running: boolean;
  /** Whether the running instance is headless. */
  headless: boolean;
  /** Current page URL. */
  url: string;
  /** Current page title. */
  title: string;
  /** Number of open page targets. */
  tabs: number;
  /** Navigation history availability for the controlled tab. */
  canGoBack: boolean;
  canGoForward: boolean;
  /** Page viewport size in CSS px (for mapping clicks from the streamed image). */
  viewportWidth: number;
  viewportHeight: number;
  /** Best-known executable path. */
  executable: string;
  /** Last error, cleared on the next successful action. */
  error: string;
  /** ISO timestamp of the last status change. */
  updatedAt: string;
}

interface PendingCall {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

type CdpEventHandler = (method: string, params: any) => void;

class CdpConnection {
  private socket: WebSocket;
  private nextId = 1;
  private pending = new Map<number, PendingCall>();
  private handler: CdpEventHandler | null;

  private constructor(socket: WebSocket, handler: CdpEventHandler | null) {
    this.socket = socket;
    this.handler = handler;
    this.socket.addEventListener('message', (event) => {
      let message: any;
      try { message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data)); } catch { return; }
      if (message.id && this.pending.has(message.id)) {
        const call = this.pending.get(message.id)!;
        this.pending.delete(message.id);
        clearTimeout(call.timer);
        if (message.error) call.reject(new Error(message.error.message || 'CDP error'));
        else call.resolve(message.result);
      } else if (message.method && this.handler) {
        this.handler(message.method, message.params);
      }
    });
  }

  static connect(url: string, timeoutMs = 15000, handler: CdpEventHandler | null = null): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => { try { socket.close(); } catch { /* ignore */ } reject(new Error('CDP connect timeout')); }, timeoutMs);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(new CdpConnection(socket, handler)); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP connect failed')); }, { once: true });
    });
  }

  send(method: string, params: Record<string, any> = {}, timeoutMs = 30000): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP ${method} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void {
    for (const call of this.pending.values()) { clearTimeout(call.timer); call.reject(new Error('CDP closed')); }
    this.pending.clear();
    try { this.socket.close(); } catch { /* ignore */ }
  }
}

const CHROME_CANDIDATES: Record<string, string[]> = {
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

export class BrowserController {
  private process: ChildProcess | null = null;
  private cdp: CdpConnection | null = null;
  private port = 0;
  private profileDir = '';
  private headless = true;
  private executable = '';
  private targetId = '';
  private frame: { data: string; at: number } | null = null;
  /** Screenshot files written to tmpdir; pruned and cleared so they don't accumulate. */
  private screenshots: string[] = [];
  private status: BrowserStatus = {
    available: false, running: false, headless: true, url: '', title: '', tabs: 0, canGoBack: false, canGoForward: false, viewportWidth: 0, viewportHeight: 0, executable: '', error: '', updatedAt: new Date().toISOString(),
  };

  /** Cached executable discovery. */
  private async findExecutable(): Promise<string> {
    if (this.executable) return this.executable;
    const explicit = process.env.OKAY_BROWSER_PATH || process.env.CHROME_PATH || '';
    if (explicit) { this.executable = explicit; this.status.available = true; return explicit; }
    const candidates = CHROME_CANDIDATES[process.platform] || [];
    for (const candidate of candidates) {
      if (candidate && await fs.stat(candidate).then(() => true).catch(() => false)) { this.executable = candidate; this.status.available = true; return candidate; }
    }
    if (process.platform === 'linux') {
      for (const command of LINUX_COMMANDS) {
        try { const { stdout } = await execFileAsync('which', [command]); const found = String(stdout).trim(); if (found) { this.executable = found; this.status.available = true; return found; } } catch { /* try next */ }
      }
    }
    this.status.available = false;
    return '';
  }

  getStatus(): BrowserStatus {
    return { ...this.status, executable: this.executable, updatedAt: this.status.updatedAt };
  }

  /** Probe the host for a browser binary, then return the current status. */
  async probe(): Promise<BrowserStatus> {
    await this.findExecutable();
    return this.getStatus();
  }

  /** Re-point the controlled session at another existing target. */
  private async connectToTarget(id: string): Promise<void> {
    this.cdp?.close();
    this.cdp = null;
    this.frame = null;
    this.targetId = id;
    await this.ensureConnection();
  }

  /** List the browser's page tabs. */
  private async tabsResult(): Promise<any> {
    if (!this.process) return { tabs: [] };
    await this.ensureConnection().catch(() => null);
    const pages = (await this.pageList()).filter((t) => t.type === 'page');
    return { tabs: pages.map((t) => ({ id: t.id, url: t.url || '', title: t.title || '', active: t.id === this.targetId })) };
  }

  /** Open a new tab and make it the controlled one. */
  private async newTab(args: Record<string, any>): Promise<any> {
    await this.ensureConnection();
    const url = String(args.url || 'about:blank');
    // DevTools HTTP endpoint; Chrome 111+ requires PUT for /json/new.
    const res = await fetch(`http://127.0.0.1:${this.port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT', signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`new tab failed: ${res.status}`);
    const target: any = await res.json();
    if (target?.id) await this.connectToTarget(target.id);
    return { id: target?.id || '', url: target?.url || url };
  }

  /** Switch the controlled tab. */
  private async activateTab(args: Record<string, any>): Promise<any> {
    const id = String(args.id || '');
    if (!id) throw new Error('id is required');
    await fetch(`http://127.0.0.1:${this.port}/json/activate/${id}`, { signal: AbortSignal.timeout(5000) }).catch(() => {});
    await this.connectToTarget(id);
    return { activated: id };
  }

  /** Close a tab; if it was controlled, fall back to another page. */
  private async closeTab(args: Record<string, any>): Promise<any> {
    const id = String(args.id || '');
    if (!id) throw new Error('id is required');
    await fetch(`http://127.0.0.1:${this.port}/json/close/${id}`, { signal: AbortSignal.timeout(8000) }).catch(() => {});
    if (id === this.targetId) {
      const pages = (await this.pageList()).filter((t) => t.type === 'page' && t.id !== id);
      const next = pages.find((t) => !/^(edge|chrome|devtools|about):/i.test(String(t.url || ''))) || pages[0];
      if (next) await this.connectToTarget(next.id);
      else { this.cdp?.close(); this.cdp = null; this.frame = null; this.targetId = ''; }
    }
    await this.refreshStatus().catch(() => {});
    return { closed: id };
  }

  /** Latest live frame, falling back to an on-demand capture. */
  private async frameResult(): Promise<any> {
    if (!this.process) return { image: '', mime: 'image/jpeg', at: 0 };
    await this.ensureConnection();
    let frame = this.frame;
    if (!frame) {
      try { const shot = await this.screenshot({ format: 'jpeg' }); frame = { data: shot.base64, at: Date.now() }; } catch { /* ignore */ }
    }
    return { image: frame?.data || '', mime: 'image/jpeg', at: frame?.at || 0 };
  }

  private touch(patch: Partial<BrowserStatus>): void {
    this.status = { ...this.status, ...patch, executable: this.executable, headless: this.headless, updatedAt: new Date().toISOString() };
  }

  /** Launch a hidden (headless) browser instance. Never shows a window. */
  private async launch(): Promise<void> {
    const executable = await this.findExecutable();
    if (!executable) throw new Error('no Chrome/Chromium/Edge found; set OKAY_BROWSER_PATH to the browser executable');
    this.headless = true;
    // Port 0 lets the OS pick a free port; the browser then writes the real
    // port to DevToolsActivePort in the profile dir, so collisions are impossible.
    this.profileDir = await fs.mkdtemp(path.join(os.tmpdir(), '0kay-browser-'));
    const args = [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${this.profileDir}`,
      '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
      '--disable-extensions', '--disable-popup-blocking', '--disable-gpu',
      '--disable-sync', '--no-service-autorun', '--disable-component-update',
      '--disable-features=msEdgeSyncPromo,msSyncPromo,EdgeCollectionsPromo,msEdgeWelcomePage,SigninPromo',
      '--window-size=1280,800',
      'about:blank',
    ];
    this.process = spawn(executable, args, { stdio: 'ignore', windowsHide: true, detached: false });
    this.process.on('exit', () => this.cleanupAfterExit());
    const proc = this.process;
    // Fail fast when the browser dies (or cannot spawn at all) during startup
    // instead of polling for a DevTools endpoint that will never come up.
    await new Promise<void>((resolve, reject) => {
      const onExit = (code: number | null) => reject(new Error(`browser exited during startup (code ${code ?? 'signal'})`));
      const onError = (error: Error) => reject(new Error(`browser failed to start: ${error.message}`));
      proc.once('exit', onExit);
      proc.once('error', onError);
      this.readDevToolsPort().then(
        () => { proc.off('exit', onExit); proc.off('error', onError); resolve(); },
        (error: Error) => reject(error),
      );
    });
    await this.waitForDevTools();
    this.touch({ available: true, running: true, error: '' });
  }

  /** Read the OS-assigned debugging port from DevToolsActivePort in the profile dir. */
  private async readDevToolsPort(timeoutMs = 20000): Promise<void> {
    const marker = path.join(this.profileDir, 'DevToolsActivePort');
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const text = await fs.readFile(marker, 'utf8');
        const port = Number(text.split(/\r?\n/, 1)[0]);
        if (Number.isInteger(port) && port > 0) { this.port = port; return; }
      } catch { /* not written yet */ }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error('browser did not write DevToolsActivePort in time');
  }

  private async waitForDevTools(timeoutMs = 20000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastError = '';
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${this.port}/json/version`, { signal: AbortSignal.timeout(2000) });
        if (res.ok) return;
      } catch (error: any) { lastError = error?.message || String(error); }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    throw new Error(`browser DevTools endpoint did not come up: ${lastError}`);
  }

  private async pageTarget(): Promise<{ id: string; webSocketDebuggerUrl: string; url: string; title: string } | null> {
    try {
      const res = await fetch(`http://127.0.0.1:${this.port}/json/list`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return null;
      const targets: any[] = await res.json();
      const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      // Prefer our previously-controlled tab, then a normal web page; Edge/Chrome
      // first-run or sync dialogs (edge://, chrome://, devtools://) must not hijack
      // the controlled tab.
      return pages.find((t) => t.id === this.targetId)
        || pages.find((t) => !/^(edge|chrome|devtools|about):/i.test(String(t.url || '')))
        || pages[0]
        || null;
    } catch { return null; }
  }

  private async ensureConnection(): Promise<CdpConnection> {
    if (this.cdp && this.process && !this.process.killed) return this.cdp;
    if (!this.process) await this.launch();
    let target = await this.pageTarget();
    if (!target) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      target = await this.pageTarget();
    }
    if (!target) throw new Error('no browser page target available');
    this.targetId = target.id || '';
    this.cdp = await CdpConnection.connect(target.webSocketDebuggerUrl, 15000, (method, params) => this.onCdpEvent(method, params));
    await this.cdp.send('Page.enable').catch(() => {});
    await this.cdp.send('Runtime.enable').catch(() => {});
    await this.startScreencast();
    return this.cdp;
  }

  /** Continuous frames pushed by CDP so the WebUI stream stays smooth. */
  private onCdpEvent(method: string, params: any): void {
    if (method !== 'Page.screencastFrame') return;
    const data = params?.data;
    if (typeof data === 'string' && data) this.frame = { data, at: Date.now() };
    const sessionId = params?.sessionId;
    if (sessionId !== undefined) this.cdp?.send('Page.screencastFrameAck', { sessionId }, 5000).catch(() => {});
  }

  private async startScreencast(): Promise<void> {
    if (!this.cdp) return;
    try {
      await this.cdp.send('Page.startScreencast', { format: 'jpeg', quality: 55, maxWidth: 960, maxHeight: 600, everyNthFrame: 1 });
    } catch { /* screencast unsupported */ }
  }

  /** Latest screencast frame (JPEG base64), or null when none has arrived yet. */
  latestFrame(): { data: string; at: number } | null {
    return this.frame;
  }

  private async refreshStatus(): Promise<void> {
    const targets = await this.pageList();
    const pages = targets.filter((t) => t.type === 'page');
    const active = pages.find((t) => t.id === this.targetId) || pages.find((t) => !/^(edge|chrome|devtools|about):/i.test(String(t.url || ''))) || pages[0];
    let canGoBack = false;
    let canGoForward = false;
    let viewportWidth = this.status.viewportWidth;
    let viewportHeight = this.status.viewportHeight;
    if (this.cdp) {
      try {
        const history = await this.cdp.send('Page.getNavigationHistory', {}, 4000);
        const index = Number(history?.currentIndex ?? 0);
        const total = Array.isArray(history?.entries) ? history.entries.length : 0;
        canGoBack = index > 0;
        canGoForward = total > 0 && index < total - 1;
      } catch { /* history unavailable */ }
      try {
        const metrics = await this.cdp.send('Page.getLayoutMetrics', {}, 4000);
        const view = metrics?.cssVisualViewport || metrics?.visualViewport || metrics?.cssLayoutViewport || metrics?.layoutViewport;
        if (view?.clientWidth) { viewportWidth = Math.round(Number(view.clientWidth)); viewportHeight = Math.round(Number(view.clientHeight)); }
      } catch { /* metrics unavailable */ }
    }
    this.touch({ running: !!this.process, tabs: pages.length, canGoBack, canGoForward, viewportWidth, viewportHeight, url: active?.url || this.status.url, title: active?.title || this.status.title });
  }

  private async pageList(): Promise<any[]> {
    try {
      const res = await fetch(`http://127.0.0.1:${this.port}/json/list`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return [];
      return await res.json();
    } catch { return []; }
  }

  private cleanupAfterExit(): void {
    this.cdp?.close();
    this.cdp = null;
    this.process = null;
    this.frame = null;
    void this.clearScreenshots();
    const profile = this.profileDir;
    this.profileDir = '';
    if (profile) fs.rm(profile, { recursive: true, force: true }).catch(() => {});
    this.touch({ running: false, tabs: 0, url: '', title: '' });
  }

  private async evaluate(expression: string, timeoutMs = 30000): Promise<any> {
    const cdp = await this.ensureConnection();
    const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, timeoutMs);
    if (result?.exceptionDetails) throw new Error(result.exceptionDetails.text || 'page evaluation failed');
    return result?.result?.value;
  }

  private async readyState(): Promise<string> {
    return String(await this.evaluate('document.readyState').catch(() => 'complete'));
  }

  async action(command: string, args: Record<string, any>): Promise<any> {
    try {
      const result = await this.run(command, args);
      await this.refreshStatus().catch(() => {});
      this.touch({ error: '' });
      return result;
    } catch (error: any) {
      this.touch({ error: error?.message || String(error) });
      throw error;
    }
  }

  private async run(command: string, args: Record<string, any>): Promise<any> {
    switch (command) {
      case 'status': return this.probe();
      case 'start': { if (!this.process) await this.launch(); return this.getStatus(); }
      case 'stop': case 'close': { await this.close(); return { closed: true }; }
      case 'goto': case 'open': return this.goto(String(args.url || ''), Number(args.timeout) || 30000);
      case 'screenshot': return this.screenshot(args);
      case 'frame': return this.frameResult();
      case 'mouse': return this.mouse(args);
      case 'wheel': return this.wheel(args);
      case 'tabs': return this.tabsResult();
      case 'newtab': return this.newTab(args);
      case 'activate': return this.activateTab(args);
      case 'closetab': return this.closeTab(args);
      case 'text': return { url: await this.currentUrl(), text: String(await this.evaluate('document.body ? document.body.innerText : ""')) };
      case 'html': return { url: await this.currentUrl(), html: String(await this.evaluate('document.documentElement ? document.documentElement.outerHTML : ""')) };
      case 'click': return this.click(args);
      case 'type': return this.type(args);
      case 'press': return this.press(args);
      case 'eval': return { value: await this.evaluate(String(args.expression || '')) };
      case 'wait': return this.wait(args);
      case 'back': await this.evaluate('history.back(); true'); await this.settle(); return { url: await this.currentUrl() };
      case 'forward': await this.evaluate('history.forward(); true'); await this.settle(); return { url: await this.currentUrl() };
      case 'reload': await this.evaluate('location.reload(); true').catch(() => {}); await this.settle(); return { url: await this.currentUrl() };
      default: throw new Error(`unknown browser action: ${command}`);
    }
  }

  private async settle(ms = 800): Promise<void> { await new Promise((resolve) => setTimeout(resolve, ms)); }

  private async currentUrl(): Promise<string> {
    return String(await this.evaluate('location.href').catch(() => this.status.url));
  }

  private async goto(url: string, timeoutMs: number): Promise<any> {
    if (!/^https?:\/\//i.test(url)) throw new Error('url must be an http(s) URL');
    const cdp = await this.ensureConnection();
    await cdp.send('Page.navigate', { url }, timeoutMs).catch(() => {});
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = await this.readyState();
      if (state === 'complete' || state === 'interactive') break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await this.settle(300);
    return { url: await this.currentUrl(), title: String(await this.evaluate('document.title').catch(() => '')) };
  }

  private async screenshot(args: Record<string, any>): Promise<any> {
    const cdp = await this.ensureConnection();
    const format = args.format === 'jpeg' ? 'jpeg' : 'png';
    const result = await cdp.send('Page.captureScreenshot', { format, captureBeyondViewport: !!args.fullPage }, 40000);
    const data: string = result?.data || '';
    const filename = path.join(os.tmpdir(), `0kay-browser-${Date.now()}.${format === 'jpeg' ? 'jpg' : 'png'}`);
    await fs.writeFile(filename, Buffer.from(data, 'base64')).catch(() => {});
    this.trackScreenshot(filename);
    return { path: filename, mime: format === 'jpeg' ? 'image/jpeg' : 'image/png', base64: data, url: await this.currentUrl() };
  }

  /** Keep only the newest screenshot files; older ones are deleted. */
  private trackScreenshot(file: string): void {
    this.screenshots.push(file);
    while (this.screenshots.length > 20) {
      const stale = this.screenshots.shift()!;
      fs.rm(stale, { force: true }).catch(() => {});
    }
  }

  private async clearScreenshots(): Promise<void> {
    const files = this.screenshots;
    this.screenshots = [];
    await Promise.all(files.map((file) => fs.rm(file, { force: true }).catch(() => {})));
  }

  private async click(args: Record<string, any>): Promise<any> {
    const selector = args.selector ? String(args.selector) : '';
    let x = Number(args.x); let y = Number(args.y);
    if (selector) {
      const box = await this.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({block:'center'}); const r = el.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`);
      if (!box) throw new Error(`selector not found: ${selector}`);
      x = box.x; y = box.y;
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('click needs a selector or x/y');
    const cdp = await this.ensureConnection();
    const button = args.button === 'right' ? 'right' : 'left';
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 1 });
    await this.settle(300);
    return { clicked: selector || `${x},${y}` };
  }

  private async type(args: Record<string, any>): Promise<any> {
    const text = String(args.text ?? '');
    if (!text) throw new Error('text is required');
    if (args.selector) {
      const focused = await this.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(String(args.selector))}); if (!el) return false; el.focus(); return true; })()`);
      if (!focused) throw new Error(`selector not found: ${args.selector}`);
    }
    const cdp = await this.ensureConnection();
    await cdp.send('Input.insertText', { text });
    await this.settle(200);
    return { typed: text.length };
  }

  /** Forward a pointer event (for manual interaction through the streamed view). */
  private async mouse(args: Record<string, any>): Promise<any> {
    const cdp = await this.ensureConnection();
    const x = Number(args.x) || 0;
    const y = Number(args.y) || 0;
    const button = args.button === 'right' ? 'right' : args.button === 'middle' ? 'middle' : 'left';
    const kind = args.type === 'down' ? 'mousePressed' : args.type === 'up' ? 'mouseReleased' : 'mouseMoved';
    const params: Record<string, any> = { type: kind, x, y, button, clickCount: kind === 'mouseMoved' ? 0 : 1 };
    if (args.buttons !== undefined) params.buttons = Number(args.buttons) || 0;
    await cdp.send('Input.dispatchMouseEvent', params);
    return { ok: true };
  }

  /** Forward a wheel/scroll event. */
  private async wheel(args: Record<string, any>): Promise<any> {
    const cdp = await this.ensureConnection();
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: Number(args.x) || 0, y: Number(args.y) || 0,
      deltaX: Number(args.deltaX) || 0, deltaY: Number(args.deltaY) || 0,
    });
    return { ok: true };
  }

  private async press(args: Record<string, any>): Promise<any> {
    const key = String(args.key || '').trim();
    if (!key) throw new Error('key is required');
    const cdp = await this.ensureConnection();
    // "ctrl+shift+a" style combos: modifiers accumulate, the last part is the key.
    const parts = key.split('+').map((part) => part.trim().toLowerCase()).filter(Boolean);
    let modifiers = 0;
    let main = '';
    for (const part of parts) {
      if (part === 'ctrl' || part === 'control') modifiers |= 2;
      else if (part === 'alt') modifiers |= 1;
      else if (part === 'meta' || part === 'cmd' || part === 'win') modifiers |= 4;
      else if (part === 'shift') modifiers |= 8;
      else main = part;
    }
    if (!main) throw new Error(`no key in "${key}"`);
    const named: Record<string, number> = {
      enter: 13, return: 13, tab: 9, escape: 27, esc: 27, backspace: 8, delete: 46,
      arrowup: 38, up: 38, arrowdown: 40, down: 40, arrowleft: 37, left: 37, arrowright: 39, right: 39,
      space: 32, pageup: 33, pagedown: 34, home: 36, end: 35,
    };
    if (/^[a-z]$/.test(main)) named[main] = main.toUpperCase().charCodeAt(0);
    else if (/^[0-9]$/.test(main)) named[main] = 48 + Number(main);
    else if (/^f([1-9]|1[0-2])$/.test(main)) named[main] = 111 + Number(main.slice(1));
    const code = named[main];
    if (code === undefined) {
      if (parts.length > 1) throw new Error(`unsupported key: ${main}`);
      await cdp.send('Input.insertText', { text: key });
    } else {
      await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers, windowsVirtualKeyCode: code, key: main });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers, windowsVirtualKeyCode: code, key: main });
    }
    await this.settle(150);
    return { pressed: key };
  }

  private async wait(args: Record<string, any>): Promise<any> {
    const selector = String(args.selector || '');
    const timeoutMs = Math.max(0, Math.min(Number(args.timeout) || 10000, 120000));
    if (!selector) { await this.settle(Math.min(timeoutMs, 5000)); return { waited: true }; }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = await this.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`).catch(() => false);
      if (found) return { found: true, selector };
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    throw new Error(`timed out waiting for selector: ${selector}`);
  }

  async close(): Promise<void> {
    if (this.cdp) { try { await this.cdp.send('Page.stopScreencast', {}, 2000); } catch { /* ignore */ } }
    this.cdp?.close();
    this.cdp = null;
    this.frame = null;
    if (this.process) {
      const proc = this.process;
      this.process = null;
      try { proc.kill(); } catch { /* ignore */ }
      if (process.platform === 'win32' && proc.pid) execFileAsync('taskkill', ['/pid', String(proc.pid), '/T', '/F']).catch(() => {});
    }
    if (this.profileDir) { await fs.rm(this.profileDir, { recursive: true, force: true }).catch(() => {}); this.profileDir = ''; }
    await this.clearScreenshots();
    this.touch({ running: false, tabs: 0, url: '', title: '' });
  }
}

/** One browser instance per agent host. */
export const browserController = new BrowserController();
