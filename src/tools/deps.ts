/**
 * Capability registry + dependency bootstrapper shared by the full-feature web,
 * reverse-engineering and pentest tools.
 *
 * The tools self-implement in TypeScript first; when a heavier engine is needed
 * (a headless browser, a decompiler, PDF rasterizer, media probe) they fall back
 * to an external capability discovered here. `setup_deps` performs the one-click
 * install of the optional npm libraries and reports which system CLIs are
 * present, so a missing capability is a clear, actionable message rather than a
 * silent degrade.
 */

import { exec, execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';

export interface CliCapability {
  /** Human name, also the key in the setup report. */
  name: string;
  /** Candidate executables, tried in order. */
  commands: string[];
  /** A short probe arg that exits 0 when present (e.g. --version). */
  versionArg: string[];
  /** What this capability unlocks. */
  purpose: string;
  /** Optional env var that overrides the executable path. */
  envVar?: string;
  /** Install recipes per platform (best-effort, idempotent). */
  install?: InstallRecipe;
}

/** How to install a CLI. Each step is tried in order until one succeeds. */
export interface InstallRecipe {
  /** Package manager recipes: {manager, args}. `{name}` is substituted. */
  packages?: Array<{ manager: 'npm' | 'pip' | 'pipx' | 'winget' | 'choco' | 'scoop' | 'brew' | 'apt' | 'cargo' | 'go' | 'script'; args: string[] }>;
  /** Free-form notes shown to the user when only manual steps exist. */
  manual?: string;
}

export interface NpmCapability {
  /** Package name to install. */
  pkg: string;
  /** What it unlocks. */
  purpose: string;
  /** Whether the tools can run without it (pure-TS fallback exists). */
  optional: boolean;
}

/** System CLIs the tools may call. Absence never crashes a tool. */
export const CLI_CAPABILITIES: CliCapability[] = [
  { name: 'python', commands: ['python', 'python3'], versionArg: ['--version'], purpose: 'Runner for Playwright/Turnstile/asset extraction scripts', envVar: 'PYTHON',
    install: { packages: [
      { manager: 'winget', args: ['install', '--id', 'Python.Python.3.12', '-e', '--accept-source-agreements', '--accept-package-agreements'] },
      { manager: 'brew', args: ['install', 'python@3.12'] },
      { manager: 'apt', args: ['install', '-y', 'python3', 'python3-pip', 'python3-venv'] },
    ] } },
  { name: 'playwright', commands: ['playwright'], versionArg: ['--version'], purpose: 'Headless browser: JS rendering, actions, preview screenshots, video frames',
    install: { packages: [
      { manager: 'npm', args: ['install', '-g', 'playwright'] },
    ], manual: 'after installing, run: playwright install chromium  (or: npx playwright install --with-deps chromium)' } },
  { name: 'curl-impersonate', commands: ['curl_chrome116', 'curl-impersonate-chrome', 'curl_ff117'], versionArg: ['--version'], purpose: 'TLS/JA3 impersonation for anti-bot fetches (Scrapling stealth)',
    install: { packages: [
      { manager: 'pip', args: ['install', 'curl_cffi'] },
      { manager: 'brew', args: ['install', 'curl-impersonate'] },
    ], manual: 'curl-impersonate ships as prebuilt binaries on GitHub (lwthiker/curl-impersonate) for Windows/Linux; or use curl_cffi via Python.' } },
  { name: 'ffmpeg', commands: ['ffmpeg'], versionArg: ['-version'], purpose: 'Video frame extraction and media probe for screenshot_to_code',
    install: { packages: [
      { manager: 'winget', args: ['install', '--id', 'Gyan.FFmpeg', '-e', '--accept-source-agreements', '--accept-package-agreements'] },
      { manager: 'choco', args: ['install', '-y', 'ffmpeg'] },
      { manager: 'brew', args: ['install', 'ffmpeg'] },
      { manager: 'apt', args: ['install', '-y', 'ffmpeg'] },
    ] } },
  { name: 'pdftotext', commands: ['pdftotext'], versionArg: ['-v'], purpose: 'PDF text layer extraction',
    install: { packages: [
      { manager: 'choco', args: ['install', '-y', 'poppler'] },
      { manager: 'brew', args: ['install', 'poppler'] },
      { manager: 'apt', args: ['install', '-y', 'poppler-utils'] },
    ] } },
  { name: 'tesseract', commands: ['tesseract'], versionArg: ['--version'], purpose: 'OCR for scanned PDFs and screenshots',
    install: { packages: [
      { manager: 'winget', args: ['install', '--id', 'UB-Mannheim.TesseractOCR', '-e', '--accept-source-agreements', '--accept-package-agreements'] },
      { manager: 'choco', args: ['install', '-y', 'tesseract'] },
      { manager: 'brew', args: ['install', 'tesseract'] },
      { manager: 'apt', args: ['install', '-y', 'tesseract-ocr'] },
    ] } },
  { name: 'ghidra', commands: ['analyzeHeadless', 'ghidraRun'], versionArg: ['-help'], purpose: 'Native binary decompilation (pseudocode) for reverse_engineer', envVar: 'GHIDRA_HOME',
    install: { packages: [
      { manager: 'choco', args: ['install', '-y', 'ghidra'] },
      { manager: 'brew', args: ['install', '--cask', 'ghidra'] },
    ], manual: 'Ghidra is a large bring-your-own tool: download from ghidra-sre.org or install via choco/brew; set GHIDRA_HOME if not on PATH.' } },
  { name: 'jadx', commands: ['jadx'], versionArg: ['--version'], purpose: 'Android APK/DEX decompilation',
    install: { packages: [
      { manager: 'choco', args: ['install', '-y', 'jadx'] },
      { manager: 'brew', args: ['install', 'jadx'] },
    ], manual: 'or download the release zip from skylot/jadx and add its bin/ to PATH.' } },
  { name: 'objdump', commands: ['objdump', 'llvm-objdump'], versionArg: ['--version'], purpose: 'Offline disassembly and section/reloc dumps',
    install: { packages: [
      { manager: 'choco', args: ['install', '-y', 'mingw'] },
      { manager: 'brew', args: ['install', 'binutils'] },
      { manager: 'apt', args: ['install', '-y', 'binutils'] },
    ] } },
  { name: 'wabt', commands: ['wasm2wat', 'wasm-decompile'], versionArg: ['--version'], purpose: 'WASM to WAT decoding',
    install: { packages: [
      { manager: 'npm', args: ['install', '-g', 'wabt'] },
      { manager: 'brew', args: ['install', 'wabt'] },
      { manager: 'apt', args: ['install', '-y', 'wabt'] },
    ] } },
  { name: 'dotnet', commands: ['dotnet', 'ildasm', 'monodis'], versionArg: ['--version'], purpose: '.NET metadata / IL disassembly',
    install: { packages: [
      { manager: 'winget', args: ['install', '--id', 'Microsoft.DotNet.SDK.8', '-e', '--accept-source-agreements', '--accept-package-agreements'] },
      { manager: 'brew', args: ['install', 'dotnet'] },
      { manager: 'apt', args: ['install', '-y', 'dotnet-sdk-8.0'] },
    ] } },
  { name: 'adb', commands: ['adb'], versionArg: ['version'], purpose: 'Android device inspection for reverse_engineer',
    install: { packages: [
      { manager: 'choco', args: ['install', '-y', 'adb'] },
      { manager: 'brew', args: ['install', '--cask', 'android-platform-tools'] },
      { manager: 'apt', args: ['install', '-y', 'adb'] },
    ] } },
  { name: 'binwalk', commands: ['binwalk'], versionArg: ['--help'], purpose: 'Firmware/archive extraction',
    install: { packages: [
      { manager: 'pip', args: ['install', 'binwalk'] },
      { manager: 'brew', args: ['install', 'binwalk'] },
      { manager: 'apt', args: ['install', '-y', 'binwalk'] },
    ] } },
  { name: 'docker', commands: ['docker'], versionArg: ['--version'], purpose: 'Isolated sandbox for pentest payload validation (Strix-style)',
    install: { packages: [
      { manager: 'winget', args: ['install', '--id', 'Docker.DockerDesktop', '-e', '--accept-source-agreements', '--accept-package-agreements'] },
      { manager: 'brew', args: ['install', '--cask', 'docker'] },
      { manager: 'apt', args: ['install', '-y', 'docker.io'] },
    ], manual: 'Docker Desktop needs a manual first-run and (on Windows) WSL2 enabled.' } },
  { name: 'nuclei', commands: ['nuclei'], versionArg: ['-version'], purpose: 'Template-driven vulnerability scanning (pentest deep mode)',
    install: { packages: [
      { manager: 'go', args: ['install', '-v', 'github.com/projectdiscovery/nuclei/v3/cmd/nuclei@latest'] },
      { manager: 'brew', args: ['install', 'nuclei'] },
    ] } },
];

/** Optional npm libraries the tools can use when installed. */
export const NPM_CAPABILITIES: NpmCapability[] = [
  { pkg: 'playwright', purpose: 'JS rendering + browser actions for scrape/crawl/pentest/screenshot', optional: true },
  { pkg: 'cheerio', purpose: 'Faster, more complete HTML parsing than the built-in tokenizer', optional: true },
  { pkg: 'turndown', purpose: 'Higher-fidelity HTML to Markdown conversion', optional: true },
  { pkg: 'pdf-parse', purpose: 'In-process PDF text extraction (no pdftotext needed)', optional: true },
  { pkg: 'mammoth', purpose: 'DOCX to HTML/text extraction', optional: true },
  { pkg: 'exceljs', purpose: 'XLSX extraction', optional: true },
  { pkg: 'sharp', purpose: 'Image decoding/resizing for screenshot_to_code asset work', optional: true },
  { pkg: 'ipaddr.js', purpose: 'SSRF/IP-literal classification in pentest', optional: true },
];

export interface ResolvedCli { name: string; command: string; available: boolean; version?: string; }

interface CacheEntry { value: ResolvedCli; at: number; }
const cliCache = new Map<string, CacheEntry>();
const CLI_TTL = 60_000;

function shellQuote(value: string): string {
  return /[\s"^&|<>()]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

/** Build a single command string for shell execution (Windows .cmd/.bat shims). */
function shellCommand(command: string, args: string[]): string {
  return [command, ...args.map(shellQuote)].join(' ');
}

function runProbe(command: string, args: string[], timeout = 8000): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const finish = (error: any, stdout: string, stderr: string) => resolve({ code: error ? (error.code ?? 1) : 0, output: `${stdout || ''}${stderr || ''}`.trim() });
    try {
      // Use a shell only for Windows .cmd/.bat shims, passing one command string
      // (no arg array) to avoid the DEP0190 warning.
      if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
        exec(shellCommand(command, args), { windowsHide: true, timeout, maxBuffer: 1 << 20 }, finish);
      } else {
        execFile(command, args, { windowsHide: true, timeout, maxBuffer: 1 << 20 }, finish);
      }
    } catch {
      resolve({ code: 127, output: '' });
    }
  });
}

/** Resolve a capability from its candidates (respecting an env override). */
export async function resolveCli(name: string, options: { refresh?: boolean } = {}): Promise<ResolvedCli> {
  const spec = CLI_CAPABILITIES.find((item) => item.name === name);
  if (!spec) return { name, command: name, available: false };
  const cached = cliCache.get(name);
  if (cached && !options.refresh && Date.now() - cached.at < CLI_TTL) return cached.value;

  const candidates: string[] = [];
  if (spec.envVar && process.env[spec.envVar]) candidates.push(process.env[spec.envVar]!);
  candidates.push(...spec.commands);

  let resolved: ResolvedCli = { name, command: candidates[0], available: false };
  for (const candidate of candidates) {
    const [bin, ...pre] = candidate.split(' ');
    const { code, output } = await runProbe(bin, [...pre, ...spec.versionArg]);
    // A failed probe is not evidence of availability. execFile reports a
    // missing executable as ENOENT (a string), not shell exit code 127/9009.
    // Requiring success also rejects timeout, permission and startup failures.
    if (code === 0) {
      resolved = { name, command: candidate, available: true, version: output.split(/\r?\n/)[0].slice(0, 80) };
      break;
    }
  }
  cliCache.set(name, { value: resolved, at: Date.now() });
  return resolved;
}

/** Report every capability and whether it is present. */
export async function probeCapabilities(refresh = false): Promise<{
  cli: ResolvedCli[];
  npm: Array<{ pkg: string; purpose: string; optional: boolean; installed: boolean }>;
}> {
  const cli = await Promise.all(CLI_CAPABILITIES.map((spec) => resolveCli(spec.name, { refresh })));
  const npm = await Promise.all(NPM_CAPABILITIES.map(async (spec) => ({ ...spec, installed: await moduleAvailable(spec.pkg) })));
  return { cli, npm };
}

/** True when an npm module can be resolved from here. Uses require.resolve
 *  first (fresh each call, no dynamic-import cache) so a package installed
 *  mid-process is detected immediately. */
export async function moduleAvailable(pkg: string): Promise<boolean> {
  try {
    const { createRequire } = await import('module');
    const require = createRequire(import.meta.url);
    require.resolve(pkg);
    return true;
  } catch {
    try {
      await import(pkg);
      return true;
    } catch {
      return false;
    }
  }
}

/** Dynamically import an optional module, returning null when it is absent. */
export async function optionalImport<T = any>(pkg: string): Promise<T | null> {
  try {
    const mod = await import(pkg);
    return (mod.default ?? mod) as T;
  } catch {
    return null;
  }
}

/** Run an external command and capture stdout/stderr, with an optional abort. */
export function runCli(command: string, args: string[], options: { cwd?: string; timeout?: number; signal?: AbortSignal; input?: string; env?: Record<string, string>; maxBuffer?: number } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const common = {
      cwd: options.cwd,
      windowsHide: true,
      timeout: options.timeout ?? 120_000,
      maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
      env: { ...process.env, ...options.env },
      signal: options.signal,
    } as const;
    const finish = (error: any, stdout: string, stderr: string) => resolve({ code: error ? (error.code ?? 1) : 0, stdout: stdout || '', stderr: stderr || '' });
    try {
      // `command` is the executable path (may contain spaces); args are separate.
      if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
        exec(shellCommand(command, args), { ...common }, (error: any, stdout: string, stderr: string) => finish(error, stdout, stderr));
      } else {
        const child = execFile(command, args, common, finish);
        if (options.input != null) { child.stdin?.write(options.input); child.stdin?.end(); }
        child.on('error', (error) => reject(error));
      }
    } catch (error) {
      reject(error);
    }
  });
}

/** Install optional npm libraries (used by the setup_deps tool). */
export function npmInstall(pkgs: string[], cwd: string, signal?: AbortSignal): Promise<{ code: number; stdout: string; stderr: string }> {
  return runCli(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--no-audit', '--no-fund', ...pkgs], { cwd, timeout: 600_000, signal, maxBuffer: 8 * 1024 * 1024 });
}

/** Ensure a persistent data directory exists (dedup stores, fingerprints, runs). */
export async function ensureDataDir(sub: string): Promise<string> {
  const base = process.env.AGENT_DATA_DIR || path.join(process.cwd(), 'data', 'agent');
  const dir = path.join(base, sub);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export function capabilityHint(names: string[]): string {
  const specs = names.map((name) => CLI_CAPABILITIES.find((spec) => spec.name === name)).filter(Boolean) as CliCapability[];
  return specs.map((spec) => `${spec.name}: ${spec.purpose}`).join('; ');
}

/** Package-manager executables per platform. */
const MANAGER_BIN: Record<string, { win?: string; posix?: string }> = {
  npm: { win: 'npm.cmd', posix: 'npm' },
  pip: { win: 'pip', posix: 'pip3' },
  pipx: { win: 'pipx', posix: 'pipx' },
  winget: { win: 'winget' },
  choco: { win: 'choco' },
  scoop: { win: 'scoop' },
  brew: { posix: 'brew' },
  apt: { posix: 'apt-get' },
  cargo: { win: 'cargo', posix: 'cargo' },
  go: { win: 'go', posix: 'go' },
};

function managerCommand(manager: string): string | null {
  const spec = MANAGER_BIN[manager];
  if (!spec) return null;
  return (process.platform === 'win32' ? spec.win : spec.posix) || null;
}

/** Resolve the executable for a package manager, or null when not on this host. */
export async function packageManagerAvailable(manager: string): Promise<string | null> {
  const command = managerCommand(manager);
  if (!command) return null;
  const probe = await runProbe(command, ['--version']);
  if (probe.code === 127) return null;
  return command;
}

export interface CliInstallPlanItem { manager: string; command: string; args: string[]; }
export interface CliInstallPlan { name: string; purpose: string; steps: CliInstallPlanItem[]; manual?: string; }

/** Build the install plan for a capability (the steps that would run). */
export async function planCliInstall(name: string): Promise<CliInstallPlan | null> {
  const spec = CLI_CAPABILITIES.find((item) => item.name === name);
  if (!spec) return null;
  const steps: CliInstallPlanItem[] = [];
  for (const recipe of spec.install?.packages || []) {
    const command = await packageManagerAvailable(recipe.manager);
    if (command) steps.push({ manager: recipe.manager, command, args: recipe.args });
  }
  return { name, purpose: spec.purpose, steps, manual: spec.install?.manual };
}

export interface CliInstallResult { name: string; ok: boolean; usedManager?: string; command?: string; exitCode?: number; output?: string; note?: string; }

/** Install one CLI by running its recipe steps until the probe succeeds. */
export async function installCli(name: string, options: { signal?: AbortSignal; refresh?: boolean } = {}): Promise<CliInstallResult> {
  const spec = CLI_CAPABILITIES.find((item) => item.name === name);
  if (!spec) return { name, ok: false, note: `unknown capability: ${name}` };
  if ((await resolveCli(name, { refresh: true })).available) return { name, ok: true, note: 'already available' };

  const plan = await planCliInstall(name);
  if (!plan || !plan.steps.length) return { name, ok: false, note: plan?.manual || 'no automatic installer for this platform' };

  const attempted: string[] = [];
  for (const step of plan.steps) {
    attempted.push(step.manager);
    const result = await runCli(step.command, step.args, { timeout: 900_000, signal: options.signal, maxBuffer: 16 * 1024 * 1024 }).catch(() => ({ code: 1, stdout: '', stderr: 'launch failed' }));
    if (result.code === 0 && (await resolveCli(name, { refresh: true })).available) {
      return { name, ok: true, usedManager: step.manager, command: `${step.command} ${step.args.join(' ')}`, exitCode: 0, output: (result.stdout || result.stderr).slice(-4000) };
    }
  }
  // Playwright needs its browser binaries after the package install.
  if (name === 'playwright') {
    const cli = await resolveCli('playwright', { refresh: true });
    if (cli.available) {
      const install = await runCli(cli.command, ['install', 'chromium'], { timeout: 900_000, signal: options.signal, maxBuffer: 16 * 1024 * 1024 }).catch(() => null);
      if (install?.code === 0) return { name, ok: true, usedManager: 'playwright', command: 'playwright install chromium', exitCode: 0, output: install.stdout.slice(-2000) };
    }
  }
  return { name, ok: false, note: plan.manual || `tried: ${attempted.join(', ') || 'none'}` };
}
