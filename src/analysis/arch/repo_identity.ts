// Whose repository is this?
//
// A large project often holds nested git repositories: its own modules split out
// for independent release, and other people's code cloned in for reference. To
// an architecture scan they look identical — a directory with a `.git` in it —
// and the ignore file treats them identically too, which is how half the project
// ended up missing from its own architecture diagram.
//
// The distinguishing fact is the remote: a nested repository whose origin is
// owned by the same account as the repository containing it is part of the
// project; one owned by somebody else is a reference clone. That is not a
// heuristic about names or layouts, it is the actual relationship, read from the
// repository metadata the tools already produced.
//
// This never calls git. `.git/config` is an INI file, and reading it costs one
// file read where spawning a process costs milliseconds and can fail for reasons
// that have nothing to do with the question.

import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * The owner in a remote URL.
 *
 * Handles the two forms git writes (`git@host:owner/repo.git` and any URL
 * ending `.../owner/repo.git`), including one reached through a proxy, where the
 * meaningful segments are still the last two.
 */
export function remoteOwner(url: string): string | undefined {
  const trimmed = String(url || '').trim();
  if (!trimmed) return undefined;
  // Strip a trailing slash, then take the final `owner/repo` pair. The `[:/]`
  // covers both `host:` (scp syntax) and `host/` (URL).
  const match = /[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/.exec(trimmed);
  return match ? match[1] : undefined;
}

/** The origin URL from a `.git/config` body, or undefined. */
export function originUrlFromConfig(config: string): string | undefined {
  const lines = String(config || '').split(/\r?\n/);
  let inOrigin = false;
  for (const line of lines) {
    const section = /^\s*\[remote\s+"([^"]+)"\]\s*$/.exec(line);
    if (section) {
      inOrigin = section[1] === 'origin';
      continue;
    }
    if (/^\s*\[/.test(line)) {
      inOrigin = false;
      continue;
    }
    if (!inOrigin) continue;
    const url = /^\s*url\s*=\s*(.+?)\s*$/.exec(line);
    if (url) return url[1];
  }
  return undefined;
}

/**
 * Resolve a `.git` entry to its config file.
 *
 * A `.git` directory holds the config directly. A `.git` FILE (a worktree or a
 * submodule) holds `gitdir: <path>`, which is relative to the entry's directory.
 */
async function configPathFor(gitEntry: string): Promise<string | undefined> {
  let stats;
  try {
    stats = await fs.stat(gitEntry);
  } catch {
    return undefined;
  }
  if (stats.isDirectory()) return path.join(gitEntry, 'config');
  let body = '';
  try {
    body = await fs.readFile(gitEntry, 'utf8');
  } catch {
    return undefined;
  }
  const match = /^gitdir:\s*(.+)$/m.exec(body);
  if (!match) return undefined;
  const gitdir = path.resolve(path.dirname(gitEntry), match[1].trim());
  return path.join(gitdir, 'config');
}

/** The origin owner of a repository directory, or undefined if it has none. */
export async function repositoryOwner(repoDir: string): Promise<string | undefined> {
  const configPath = await configPathFor(path.join(repoDir, '.git'));
  if (!configPath) return undefined;
  let body = '';
  try {
    body = await fs.readFile(configPath, 'utf8');
  } catch {
    return undefined;
  }
  return remoteOwner(originUrlFromConfig(body) || '');
}

/** Does this directory hold a git repository of its own? */
export async function isRepository(dir: string): Promise<boolean> {
  try {
    await fs.stat(path.join(dir, '.git'));
    return true;
  } catch {
    return false;
  }
}

export type RepoOwnership = 'ours' | 'foreign' | 'unknown';

/**
 * Is a nested repository part of this project?
 *
 * `unknown` when either side has no readable origin — an unpublished local repo
 * or a stripped checkout. Unknown deliberately falls through to whatever other
 * rule applies, rather than guessing: hiding a real module and including a
 * vendored copy are both wrong, and neither is more wrong than the other.
 */
export async function ownership(nestedDir: string, rootDir: string): Promise<RepoOwnership> {
  const [nested, root] = await Promise.all([repositoryOwner(nestedDir), repositoryOwner(rootDir)]);
  if (!nested || !root) return 'unknown';
  return nested.toLowerCase() === root.toLowerCase() ? 'ours' : 'foreign';
}
