import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';

function gitTopLevel(dir: string): string {
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: dir,
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })
      .toString()
      .trim();
    return out;
  } catch {
    return '';
  }
}

const ALLOWED_WORKSPACE_ROOTS = (() => {
  const configured = (process.env.AGENT_WORKSPACE_ROOTS || '')
    .split(',')
    .map((root) => root.trim())
    .filter(Boolean);
  if (configured.length > 0) return configured.map((root) => path.resolve(root));
  const roots = [process.cwd(), os.homedir(), os.tmpdir()];
  const project = gitTopLevel(process.cwd());
  if (project) roots.push(project);
  return roots.map((root) => path.resolve(root));
})();

let configuredRoots: string[] = [];

function parseRootList(raw: unknown): string[] {
  return String(raw ?? '')
    .split(/[,\r\n]+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

export async function refreshWorkspaceRoots(): Promise<void> {
  try {
    const { coreFetch, coreHeaders, coreHttpBase } = await import('../connection.js');
    const res = await coreFetch(`${coreHttpBase()}/api/settings/workspace`, {
      headers: coreHeaders(),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return;
    const data = (await res.json()) as { values?: Record<string, unknown> } | null;
    configuredRoots = parseRootList(data?.values?.allowed_roots).map((root) => path.resolve(root));
  } catch {
  }
}

export function startWorkspaceRootsSync(intervalMs = 60_000): void {
  void refreshWorkspaceRoots();
  const timer = setInterval(() => void refreshWorkspaceRoots(), intervalMs);
  timer.unref?.();
}

const taskRoots = new Set<string>()

export function allowTaskRoot(dir: string): void {
  const value = String(dir || '').trim()
  if (!value) return
  try { taskRoots.add(path.resolve(value)) } catch { }
}

export function allowedWorkspaceRoots(): string[] {
  return [...ALLOWED_WORKSPACE_ROOTS, ...configuredRoots, ...taskRoots]
}

export function isPathAllowed(resolved: string): boolean {
  const fold = (value: string) => (process.platform === 'win32' ? value.toLowerCase() : value);
  const target = fold(resolved);
  return allowedWorkspaceRoots().some((root) => {
    const normalized = fold(root);
    return target === normalized || target.startsWith(normalized + path.sep);
  });
}
