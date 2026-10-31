/**
 * Background task execution for the agent plugin.
 *
 * This is a port of the reference task system, kept deliberately independent of
 * the agent loop: a Manager owns the processes started during a session, each one
 * runs detached from the turn that launched it, and its combined stdout/stderr is
 * streamed to a per-task file on disk. When a task finishes it enqueues a
 * notification that the caller drains into the conversation.
 *
 * The model is told only the id, the status and the output path; it reads the
 * output on demand through TaskOutput (or a plain file read).
 */
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export type TaskStatus = 'running' | 'completed' | 'failed' | 'killed'
export type TaskKind = 'bash' | 'monitor'

/** Caps a single task's output file; a task that exceeds it is terminated. */
export const MAX_TASK_OUTPUT_BYTES = 50 * 1024 * 1024
/** Another session's task directory is collected after this long. */
export const STALE_SESSION_TTL_MS = 24 * 60 * 60 * 1000

export interface TaskInfo {
  id: string
  kind: TaskKind
  status: TaskStatus
  command: string
  exitCode: number
  outputFile: string
  startedAt: number
  endedAt: number
}

export interface StartedTask {
  id: string
  status: TaskStatus
  outputFile: string
}

interface TaskRecord extends TaskInfo {
  child?: ChildProcess
  killed: boolean
  stream?: fs.WriteStream
}

export interface ManagerOptions {
  /** Directory that holds `session-<id>/task_<n>.log` files. */
  root: string
  sessionId: string
  /** Notifications are queued here; the caller drains them into the transcript. */
  onNotify?: (event: TaskNotification) => void
}

export interface TaskNotification {
  taskId: string
  status: TaskStatus
  exitCode: number
  outputFile: string
  command: string
}

function isTerminal(status: TaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'killed'
}

export class TaskManager {
  private readonly tasks = new Map<string, TaskRecord>()
  private readonly order: string[] = []
  private counter = 0
  private readonly dir: string

  constructor(private readonly options: ManagerOptions) {
    this.dir = path.join(options.root, `session-${options.sessionId}`)
    fs.mkdirSync(this.dir, { recursive: true })
    TaskManager.collectStale(options.root)
  }

  /** Remove task directories of sessions that have been idle for a day. */
  private static collectStale(root: string): void {
    let entries: string[]
    try {
      entries = fs.readdirSync(root)
    } catch {
      return
    }
    const cutoff = Date.now() - STALE_SESSION_TTL_MS
    for (const name of entries) {
      if (!name.startsWith('session-')) continue
      const full = path.join(root, name)
      try {
        if (fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full, { recursive: true, force: true })
      } catch {
        // A directory another process is using is not ours to delete.
      }
    }
  }

  /**
   * Start a detached command.
   *
   * The child keeps running after the turn that started it returns; its output
   * goes straight to the file so a slow reader cannot block the process.
   */
  start(command: string, kind: TaskKind = 'bash', cwd?: string): StartedTask {
    const id = `task_${++this.counter}`
    const outputFile = path.join(this.dir, `${id}.log`)
    const stream = fs.createWriteStream(outputFile, { flags: 'w' })

    const shell = process.platform === 'win32' ? 'powershell' : 'bash'
    const args = process.platform === 'win32'
      ? ['-NoProfile', '-NonInteractive', '-Command', command]
      : ['-c', command]

    const child = spawn(shell, args, {
      cwd: cwd || process.cwd(),
      detached: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const record: TaskRecord = {
      id, kind, command,
      status: 'running',
      exitCode: 0,
      outputFile,
      startedAt: Date.now(),
      endedAt: 0,
      child,
      killed: false,
      stream,
    }
    this.tasks.set(id, record)
    this.order.push(id)

    let written = 0
    const pump = (chunk: Buffer) => {
      written += chunk.length
      stream.write(chunk)
      if (written > MAX_TASK_OUTPUT_BYTES) {
        // A runaway process must not fill the disk: stop it and say why.
        record.killed = true
        stream.write(`\n[task output exceeded ${MAX_TASK_OUTPUT_BYTES} bytes; terminated]\n`)
        this.kill(id)
      }
    }
    child.stdout?.on('data', pump)
    child.stderr?.on('data', pump)

    const finish = (code: number | null, signal: string | null) => {
      if (isTerminal(record.status)) return
      record.exitCode = typeof code === 'number' ? code : signal ? 137 : 0
      record.status = record.killed ? 'killed' : record.exitCode === 0 ? 'completed' : 'failed'
      record.endedAt = Date.now()
      stream.end(() => {
        this.options.onNotify?.({
          taskId: record.id,
          status: record.status,
          exitCode: record.exitCode,
          outputFile: record.outputFile,
          command: record.command,
        })
      })
    }
    child.on('error', (error) => {
      stream.write(`\n[task failed to start: ${error.message}]\n`)
      finish(127, null)
    })
    child.on('close', (code, signal) => finish(code, signal))

    return { id, status: 'running', outputFile }
  }

  /** Snapshot of one task, or undefined when the id is unknown. */
  get(id: string): TaskInfo | undefined {
    const record = this.tasks.get(id)
    if (!record) return undefined
    const { child: _child, stream: _stream, killed: _killed, ...info } = record
    return info
  }

  /** All tasks of this session, in start order. */
  list(): TaskInfo[] {
    return this.order.map((id) => this.get(id)).filter((t): t is TaskInfo => !!t)
  }

  /**
   * Read a task's output.
   *
   * Reading is tail-oriented: a long build log is not useful in full, and the
   * model only needs the end to decide what to do next.
   */
  output(id: string, maxBytes = 30000): string | undefined {
    const record = this.tasks.get(id)
    if (!record) return undefined
    let stat: fs.Stats
    try {
      stat = fs.statSync(record.outputFile)
    } catch {
      return ''
    }
    const start = Math.max(0, stat.size - Math.max(1, maxBytes))
    const fd = fs.openSync(record.outputFile, 'r')
    try {
      const length = stat.size - start
      const buffer = Buffer.alloc(length)
      fs.readSync(fd, buffer, 0, length, start)
      const text = buffer.toString('utf8')
      return start > 0 ? `…(${start} bytes trimmed)\n${text}` : text
    } finally {
      fs.closeSync(fd)
    }
  }

  /** Wait until a task reaches a terminal state (or the timeout elapses). */
  async wait(id: string, timeoutMs = 30000): Promise<TaskStatus | undefined> {
    const record = this.tasks.get(id)
    if (!record) return undefined
    if (isTerminal(record.status)) return record.status
    return new Promise((resolve) => {
      const started = Date.now()
      const tick = setInterval(() => {
        const current = this.tasks.get(id)
        if (!current) { clearInterval(tick); resolve(undefined); return }
        if (isTerminal(current.status)) { clearInterval(tick); resolve(current.status); return }
        if (Date.now() - started > timeoutMs) { clearInterval(tick); resolve(current.status) }
      }, 100)
      // Deliberately NOT unref'd: with nothing else on the loop Node would settle
      // the await before the first tick ever fires, and every wait would hang.
      // The child process keeps the loop alive anyway.
    })
  }

  /** Terminate a task's process tree. */
  stop(id: string): boolean {
    const record = this.tasks.get(id)
    if (!record || isTerminal(record.status)) return false
    record.killed = true
    this.kill(id)
    return true
  }

  private kill(id: string): void {
    const record = this.tasks.get(id)
    const child = record?.child
    if (!child || child.killed) return
    try {
      if (process.platform === 'win32' && child.pid) {
        // taskkill takes the tree: `powershell -Command` spawns the real work.
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
      } else {
        child.kill('SIGTERM')
      }
    } catch {
      // The process is already gone; the close handler settles the state.
    }
  }

  /** Stop everything and close the output files (session teardown). */
  dispose(): void {
    for (const id of this.order) {
      const record = this.tasks.get(id)
      if (record && !isTerminal(record.status)) this.stop(id)
      try { record?.stream?.end() } catch { /* already closed */ }
    }
  }
}
