// What a read may not touch, regardless of where the workspace roots point.
//
// The workspace roots answer "which directories is this task about". They do
// not answer "which files are secrets", and the two questions have different
// answers: a user's workspace can legitimately be their home directory, and
// their home directory contains `~/.ssh/id_rsa` and the provider keys Core
// writes to `~/.0kay/data/providers.json`. A model that reads a webpage, gets
// instructed to "summarise ~/.0kay/data/providers.json", and has a fetch tool to
// send the result onward needs no privileges at all to exfiltrate everything.
//
// So reads get a second gate. It is a deny-list on purpose: an allow-list of
// readable files would break every legitimate read the moment a project layout
// changed. What it forbids is narrow, well-known, and never needed to do work.

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

/** File names that are credentials wherever they appear. */
const SECRET_NAMES = [
  /^\.env(\..+)?$/i,
  /^\.netrc$/i,
  /^\.pgpass$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^\.htpasswd$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /^authorized_keys$/i,
  /^known_hosts$/i,
  /^credentials(\.json|\.ini)?$/i,
  /^secrets?\.(json|ya?ml|toml)$/i,
  /^providers\.json$/i,
  /^plugin-token\.key$/i,
  /^api-token$/i,
  /^device-token$/i,
  /^initial-pin\.txt$/i,
  /\.(pem|key|p12|pfx|jks|keystore)$/i,
];

/** Directories whose contents are credentials, session state, or Core internals. */
const SECRET_DIRS = [
  /(^|[\\/])\.ssh([\\/]|$)/i,
  /(^|[\\/])\.aws([\\/]|$)/i,
  /(^|[\\/])\.gnupg([\\/]|$)/i,
  /(^|[\\/])\.kube([\\/]|$)/i,
  /(^|[\\/])\.docker([\\/]|$)/i,
  /(^|[\\/])\.0kay([\\/]|$)/i,
  /(^|[\\/])\.git[\\/]config$/i,
  /(^|[\\/])AppData[\\/](Roaming|Local)[\\/](Google[\\/]Chrome|Mozilla|Microsoft[\\/]Edge|BraveSoftware)([\\/]|$)/i,
  /(^|[\\/])Library[\\/]Application Support[\\/](Google|Firefox)([\\/]|$)/i,
  /(^|[\\/])\.config[\\/](gh|gcloud)([\\/]|$)/i,
];

export interface SecretCheck {
  blocked: boolean;
  reason?: string;
}

function homeDir(): string {
  try { return path.resolve(os.homedir()) } catch { return '' }
}

/** Core's data directory: provider keys, settings, plugin tokens, session log. */
function coreDataDirs(): string[] {
  const dirs: string[] = [];
  const configured = process.env.AGENT_FORBIDDEN_READ_DIRS || '';
  for (const entry of configured.split(/[,\r\n]+/)) {
    if (entry.trim()) dirs.push(path.resolve(entry.trim()));
  }
  if (process.env.CORE_DATA_DIR) dirs.push(path.resolve(process.env.CORE_DATA_DIR));
  const home = homeDir();
  if (home) dirs.push(path.resolve(home, '.0kay', 'data'));
  // A source checkout keeps Core's data under core/data.
  dirs.push(path.resolve(process.cwd(), 'core', 'data'));
  dirs.push(path.resolve(process.cwd(), 'data', 'core'));
  return dirs;
}

/**
 * Resolve symlinks before judging. A workspace that contains `ln -s / etc`
 * would otherwise let `read("etc/shadow")` pass a string-prefix check while the
 * bytes come from somewhere else entirely.
 */
async function realTarget(target: string): Promise<string> {
  try {
    return await fs.realpath(target);
  } catch {
    // A path that does not exist yet (a write) is judged on its lexical form.
    try {
      return path.join(await fs.realpath(path.dirname(target)), path.basename(target));
    } catch {
      return path.resolve(target);
    }
  }
}

export async function checkReadable(target: string): Promise<SecretCheck> {
  const real = await realTarget(path.resolve(target));
  const normalized = real.replace(/\\/g, '/');
  for (const dir of coreDataDirs()) {
    const rel = path.relative(dir, real);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
      return { blocked: true, reason: `Core data directory is not readable by tools (${dir})` };
    }
  }
  for (const pattern of SECRET_DIRS) {
    if (pattern.test(normalized)) {
      return { blocked: true, reason: 'this path holds credentials or private state' };
    }
  }
  const base = path.basename(real);
  for (const pattern of SECRET_NAMES) {
    if (pattern.test(base)) {
      return { blocked: true, reason: `"${base}" looks like a credential file` };
    }
  }
  return { blocked: false };
}

/** Throwing form, for the tool bodies that already return failure(error). */
export async function assertReadable(target: string): Promise<void> {
  const check = await checkReadable(target);
  if (check.blocked) throw new Error(`read refused: ${check.reason} (${target})`);
}

/**
 * A directory listing can leak the same thing a read can — `read` on a
 * directory returns its entries. Only the credential directories are hidden;
 * hiding everything would break ordinary navigation.
 */
export async function filterListing(dir: string, names: string[]): Promise<string[]> {
  const kept: string[] = [];
  for (const name of names) {
    const check = await checkReadable(path.join(dir, name));
    if (!check.blocked) kept.push(name);
  }
  return kept;
}
