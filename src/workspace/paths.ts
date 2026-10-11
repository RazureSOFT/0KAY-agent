/**
 * Shared workspace path policy. The same root set gates the WebUI file tools
 * (workspace_read/workspace_write) and the agent's write/edit tools, so every
 * non-shell write path enforces one boundary. bash is intentionally
 * unrestricted (full-feature shell).
 */
import * as path from 'path';
import * as os from 'os';

/** Allowed roots for workspace writes. Defaults to the process cwd, the user's
 *  home and the temp dir; override with a comma-separated AGENT_WORKSPACE_ROOTS
 *  to lock the WebUI file browser further (e.g. a single project dir). */
const ALLOWED_WORKSPACE_ROOTS = (() => {
  const configured = (process.env.AGENT_WORKSPACE_ROOTS || '')
    .split(',')
    .map((root) => root.trim())
    .filter(Boolean);
  const roots = configured.length > 0
    ? configured
    : [process.cwd(), os.homedir(), os.tmpdir()];
  return roots.map((root) => path.resolve(root));
})();

export function isPathAllowed(resolved: string): boolean {
  // NTFS is case-insensitive, so the prefix check must be too on win32;
  // POSIX stays case-sensitive. Pure string work — no fs calls.
  const fold = (value: string) => (process.platform === 'win32' ? value.toLowerCase() : value);
  const target = fold(resolved);
  return ALLOWED_WORKSPACE_ROOTS.some((root) => {
    const normalized = fold(root);
    return target === normalized || target.startsWith(normalized + path.sep);
  });
}
