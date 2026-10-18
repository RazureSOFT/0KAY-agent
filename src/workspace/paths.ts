/**
 * Shared workspace path policy. The same root set gates the WebUI file tools
 * (workspace_read/workspace_write) and the agent's write/edit tools, so every
 * non-shell write path enforces one boundary. bash is intentionally
 * unrestricted (full-feature shell).
 */
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';

/**
 * The git top level containing `dir`, or '' when there is none.
 *
 * Each 0KAY service is launched from its own subdirectory (start-0kay.sh cds
 * into agent/ and core/ separately), so the default cwd root is `<repo>/agent`
 * and the repository the user is actually editing — the directory the WebUI
 * offers as the workspace — falls outside its own allowed set. Every write then
 * failed with "path not allowed: outside workspace roots". Adding the containing
 * repository makes the default set match what the UI calls a workspace.
 */
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

/** Allowed roots for workspace writes. Defaults to the process cwd, the
 *  containing repository, the user's home and the temp dir; override with a
 *  comma-separated AGENT_WORKSPACE_ROOTS to lock the WebUI file browser further
 *  (e.g. a single project dir). */
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

/**
 * Roots the operator added in Core's Settings → 工作区.
 *
 * Core enforces the same boundary for its git panel and exposes the list as
 * `workspace.allowed_roots`. Reading it here keeps the two in agreement: without
 * it, a folder allowed in the UI would work for git but still fail every
 * write/edit with "path not allowed: outside workspace roots".
 *
 * Refreshed in the background (see startWorkspaceRootsSync) so allowing a folder
 * does not require restarting the agent. `isPathAllowed` stays synchronous and
 * fs-free — it only reads this snapshot.
 */
let configuredRoots: string[] = [];

function parseRootList(raw: unknown): string[] {
  return String(raw ?? '')
    .split(/[,\r\n]+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

/** Re-read the allow-list from Core. Never throws: Core may not be up yet. */
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
    // Keep the previous snapshot: a transient Core hiccup must not silently
    // narrow the boundary mid-task.
  }
}

/** Refresh now, then every `intervalMs`. The timer is unref'd so it never keeps
 *  the process alive on its own. */
export function startWorkspaceRootsSync(intervalMs = 60_000): void {
  void refreshWorkspaceRoots();
  const timer = setInterval(() => void refreshWorkspaceRoots(), intervalMs);
  timer.unref?.();
}

// Roots granted because a task explicitly selected them. The workspace picker
// lets the user choose any directory, and that choice is the strongest signal
// there is — waiting for the 60s settings sync (or for the settings section to
// exist at all) meant a picked workspace still failed every write with
// "path not allowed". Kept separate so a config refresh cannot drop them.
const taskRoots = new Set<string>()

/** Allow one directory for the lifetime of the process (a task's workspace). */
export function allowTaskRoot(dir: string): void {
  const value = String(dir || '').trim()
  if (!value) return
  try { taskRoots.add(path.resolve(value)) } catch { /* unresolvable: ignore */ }
}

/** Exposed for diagnostics and tests: the roots actually enforced. */
export function allowedWorkspaceRoots(): string[] {
  return [...ALLOWED_WORKSPACE_ROOTS, ...configuredRoots, ...taskRoots]
}

export function isPathAllowed(resolved: string): boolean {
  // NTFS is case-insensitive, so the prefix check must be too on win32;
  // POSIX stays case-sensitive. Pure string work — no fs calls.
  const fold = (value: string) => (process.platform === 'win32' ? value.toLowerCase() : value);
  const target = fold(resolved);
  return allowedWorkspaceRoots().some((root) => {
    const normalized = fold(root);
    return target === normalized || target.startsWith(normalized + path.sep);
  });
}
