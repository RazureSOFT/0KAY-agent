/**
 * A persistent shell session.
 *
 * The reference implementation drives a real PTY (for msfconsole, ssh, a REPL).
 * This port keeps a long-lived *line-oriented* shell instead: the process stays
 * alive between calls, so `cd`, exported variables and other state survive, but
 * full-screen interactive programs do not work. That limitation is deliberate —
 * it needs no native dependency and behaves the same on Windows and POSIX.
 *
 * Completion is detected with a marker echoed after every command, because a
 * shell gives no other reliable "the prompt is back" signal when stdin is a pipe.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

const MARK = '__OKAY_SHELL_DONE__'
const MAX_BUFFER = 256 * 1024
const DEFAULT_TIMEOUT_MS = 30000
/** Kept so a session that exited can still be read once, then collected. */
const EXITED_TTL_MS = 5 * 60 * 1000

export interface ShellResult {
  output: string
  exitCode: number
  timedOut: boolean
  truncated: boolean
}

interface Pending {
  resolve: (result: ShellResult) => void
  timer: NodeJS.Timeout
  startedAt: number
}

export class ShellSession {
  private readonly child: ChildProcessWithoutNullStreams
  private buffer = ''
  private pending: Pending | null = null
  private exitCode: number | null = null
  private exitedAt = 0
  readonly startedAt = Date.now()
  closed = false

  constructor(cwd: string) {
    const isWindows = process.platform === 'win32'
    // Piped stdin makes PowerShell read commands line by line, which is exactly
    // the semantics this session relies on.
    this.child = isWindows
      ? spawn('powershell', ['-NoLogo', '-NoProfile', '-NonInteractive'], { cwd, windowsHide: true })
      : spawn('bash', ['--norc', '--noprofile'], { cwd })
    this.child.stdout.setEncoding('utf8')
    this.child.stderr.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => this.onData(chunk))
    this.child.stderr.on('data', (chunk: string) => this.onData(chunk))
    this.child.on('exit', (code) => {
      this.exitCode = typeof code === 'number' ? code : -1
      this.exitedAt = Date.now()
      this.settle('', true)
    })
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    if (this.buffer.length > MAX_BUFFER) this.buffer = this.buffer.slice(-MAX_BUFFER)
    const index = this.buffer.indexOf(MARK)
    if (index === -1) return
    // `__MARK__<code>` arrives on one line; anything after it belongs to the next
    // read, so it is put back rather than dropped.
    const after = this.buffer.slice(index + MARK.length)
    const newline = after.indexOf('\n')
    const codeText = (newline === -1 ? after : after.slice(0, newline)).trim()
    const rest = newline === -1 ? '' : after.slice(newline + 1)
    const output = this.buffer.slice(0, index)
    this.buffer = rest
    this.settle(output, false, Number.parseInt(codeText, 10))
  }

  private settle(output: string, dead = false, code = 0): void {
    const pending = this.pending
    if (!pending) return
    this.pending = null
    clearTimeout(pending.timer)
    pending.resolve({
      output: clean(output),
      exitCode: dead ? (this.exitCode ?? -1) : Number.isFinite(code) ? code : 0,
      timedOut: false,
      truncated: output.length > MAX_BUFFER,
    })
  }

  /** Run one command and wait for its marker. */
  run(command: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<ShellResult> {
    if (this.closed) return Promise.resolve({ output: 'session is closed', exitCode: -1, timedOut: false, truncated: false })
    if (this.exitCode !== null) {
      return Promise.resolve({ output: 'session has exited', exitCode: this.exitCode, timedOut: false, truncated: false })
    }
    if (this.pending) return Promise.resolve({ output: 'session is busy', exitCode: -1, timedOut: false, truncated: false })

    const isWindows = process.platform === 'win32'
    // The Windows host echoes the command line before running it, so a literal
    // marker in the command would match its own echo and settle early. Building it
    // from two halves at runtime keeps the marker only in the real output.
    const marker = isWindows
      ? "\n$m = '__OKAY' + '_SHELL_DONE__'; Write-Output ($m + $LASTEXITCODE)\n"
      : `\nprintf '\\n${MARK}%s\\n' "$?"\n`

    return new Promise<ShellResult>((resolve) => {
      const timer = setTimeout(() => {
        // The shell may be stuck on a prompt nobody answered: drop the session
        // rather than leave a wedged process holding the slot.
        const output = this.buffer
        this.buffer = ''
        this.pending = null
        resolve({ output: clean(output), exitCode: -1, timedOut: true, truncated: output.length > MAX_BUFFER })
        this.dispose()
      }, Math.max(1000, timeoutMs))
      this.pending = { resolve, timer, startedAt: Date.now() }
      try {
        this.child.stdin.write(`${command}${marker}`)
      } catch {
        clearTimeout(timer)
        this.pending = null
        resolve({ output: 'failed to write to the shell', exitCode: -1, timedOut: false, truncated: false })
      }
    })
  }

  /** Anything printed outside a command (a slow background job, a prompt). */
  drain(): string {
    const output = this.buffer
    this.buffer = ''
    return clean(output)
  }

  get alive(): boolean {
    return !this.closed && this.exitCode === null
  }

  dispose(): void {
    if (this.closed) return
    this.closed = true
    try { this.child.stdin.end() } catch { /* already gone */ }
    try { this.child.kill() } catch { /* already gone */ }
  }

  /** A dead session is kept briefly so a late read still finds its output. */
  get collectable(): boolean {
    return !this.alive && Date.now() - this.exitedAt > EXITED_TTL_MS
  }
}

/** Strip the marker, the echoed prompt and trailing noise. */
function clean(text: string): string {
  return text
    .replace(new RegExp(`\\n?${MARK}-?\\d*`, 'g'), '')
    // The host prompts with `PS C:\path>` before each line; it is not output.
    .replace(/^PS [^\n>]*>\s?/gm, '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
