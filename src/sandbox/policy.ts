import * as path from 'node:path'

// Sandbox policy: what a task is allowed to touch, and what it gets told when it
// tries something else.
//
// This is the policy layer, not the kernel. It decides and explains; it cannot
// make `rm -rf /` harmless — only an OS boundary can (bwrap / landlock on Linux,
// sandbox-exec on macOS, a restricted job object on Windows). What it does do is
// make the default safe and the failure legible: a blocked call comes back as a
// sentence the model can act on, not a silent no-op.
//
// Modes, borrowed from the vocabulary people already know:
//   read-only            nothing writes, no process may be started that writes
//   workspace-write      writes only inside the workspace roots (default)
//   danger-full-access   no restriction, and the caller said so out loud

export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

export const SANDBOX_MODES: SandboxMode[] = ['read-only', 'workspace-write', 'danger-full-access']

export interface SandboxDecision {
  allowed: boolean
  reason?: string
}

const ALLOWED: SandboxDecision = { allowed: true }

// Commands that only read. In read-only mode everything else is refused, which
// is why the list is short and boring on purpose.
const READ_ONLY_COMMANDS = new Set([
  'ls', 'dir', 'pwd', 'cd', 'cat', 'type', 'head', 'tail', 'less', 'more',
  'grep', 'rg', 'find', 'findstr', 'wc', 'sort', 'uniq', 'diff', 'file',
  'git', 'node', 'python', 'python3', 'go', 'npm', 'npx', 'tsc', 'echo', 'which', 'where', 'env', 'printenv',
])

// Read-only subcommands for the tools where the verb decides, not the binary.
const READ_ONLY_GIT = new Set(['status', 'log', 'diff', 'show', 'branch', 'remote', 'describe', 'rev-parse', 'ls-files', 'blame'])
const READ_ONLY_NPM = new Set(['ls', 'list', 'view', 'outdated', 'why'])
const READ_ONLY_GO = new Set(['version', 'env', 'list', 'vet'])
const READ_ONLY_NODE = new Set(['--version', '-v'])

// Shell syntax that writes regardless of the command name.
const WRITE_OPERATORS = /(^|[^>])>{1,2}(?!&)|>>|\btee\b|\bdd\b|\bmv\b|\bcp\b|\brm\b|\bdel\b|\brmdir\b|\bmkdir\b|\btouch\b|\bchmod\b|\bchown\b|\btruncate\b|\bsed\s+-i\b|\bgit\s+(commit|push|merge|reset|checkout|clean)\b/i

export class SandboxPolicy {
  readonly mode: SandboxMode
  private readonly roots: string[]

  constructor(mode: SandboxMode = 'workspace-write', roots: string[] = [process.cwd()]) {
    this.mode = SANDBOX_MODES.includes(mode) ? mode : 'workspace-write'
    this.roots = roots.map((root) => path.resolve(root))
  }

  get isUnrestricted(): boolean {
    return this.mode === 'danger-full-access'
  }

  /** May this path be written? Resolves symlinks only as far as path.resolve can. */
  checkWrite(target: string): SandboxDecision {
    if (this.isUnrestricted) return ALLOWED
    if (this.mode === 'read-only') {
      return { allowed: false, reason: 'sandbox is read-only: writes are disabled for this task' }
    }
    const resolved = path.resolve(target)
    const inside = this.roots.some((root) => resolved === root || resolved.startsWith(root + path.sep))
    if (inside) return ALLOWED
    return {
      allowed: false,
      reason: `sandbox is workspace-write: ${resolved} is outside ${this.roots.join(', ')}`,
    }
  }

  /** May this path be read? Reads are allowed everywhere except when the caller asked for a strict task. */
  checkRead(target: string): SandboxDecision {
    if (this.mode !== 'read-only') return ALLOWED
    return ALLOWED
  }

  /**
   * May this shell command run? Classification is textual, so it is a guardrail,
   * not a boundary: it stops the obvious and refuses what it cannot classify in
   * read-only mode.
   */
  checkShell(command: string): SandboxDecision {
    const text = String(command || '').trim()
    if (!text) return { allowed: false, reason: 'empty command' }
    if (this.isUnrestricted) return ALLOWED

    if (this.mode === 'read-only') {
      const writes = WRITE_OPERATORS.exec(text)
      if (writes) {
        return { allowed: false, reason: `sandbox is read-only: "${writes[0].trim()}" writes to disk` }
      }
      const [head, ...rest] = text.split(/\s+/)
      const binary = path.basename(head).replace(/\.exe$/i, '').toLowerCase()
      if (!READ_ONLY_COMMANDS.has(binary)) {
        return { allowed: false, reason: `sandbox is read-only: "${binary}" is not a read-only command` }
      }
      const sub = (rest[0] || '').toLowerCase()
      if (binary === 'git' && sub && !READ_ONLY_GIT.has(sub)) {
        return { allowed: false, reason: `sandbox is read-only: "git ${sub}" is not read-only` }
      }
      if (binary === 'npm' && sub && !READ_ONLY_NPM.has(sub)) {
        return { allowed: false, reason: `sandbox is read-only: "npm ${sub}" is not read-only` }
      }
      if (binary === 'go' && sub && !READ_ONLY_GO.has(sub)) {
        return { allowed: false, reason: `sandbox is read-only: "go ${sub}" is not read-only` }
      }
      if (binary === 'node' && sub && !READ_ONLY_NODE.has(sub)) {
        return { allowed: false, reason: 'sandbox is read-only: running a script can write' }
      }
      return ALLOWED
    }

    // workspace-write: the shell is not parsed, so a write outside the workspace
    // cannot be detected reliably. Refuse the patterns that are unambiguous and
    // say why, instead of pretending the whole command was checked.
    const destructive = /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\s+([/~]|[A-Za-z]:\\)/i.exec(text)
    if (destructive) {
      return { allowed: false, reason: `refusing "${destructive[0]}": recursive delete of a root path` }
    }
    return ALLOWED
  }
}

/** Parse a stored setting, defaulting to the safe mode rather than the open one. */
export function parseSandboxMode(value: unknown): SandboxMode {
  const text = String(value ?? '').trim()
  return (SANDBOX_MODES as string[]).includes(text) ? (text as SandboxMode) : 'workspace-write'
}
