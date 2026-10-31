/**
 * Background-task tools: TaskList / TaskOutput / TaskStop.
 *
 * These are the process-level task surface (a detached command and a long-lived
 * monitor), deliberately separate from the agent loop and from the assessment
 * runs that AssessmentManager owns. Each session gets its own manager, so a task
 * started in one conversation is not visible from another.
 */
import * as os from 'node:os'
import * as path from 'node:path'
import { Tool, type ToolContext, type ToolResult } from './types.js'
import { success, failure } from './helpers.js'
import { TaskManager } from '../tasks/manager.js'

const managers = new Map<string, TaskManager>()

/** One manager per session, created on first use. */
export function taskManagerFor(context: ToolContext): TaskManager {
  const sessionId = context.sessionId || context.taskId || 'default'
  let manager = managers.get(sessionId)
  if (!manager) {
    manager = new TaskManager({
      root: path.join(os.tmpdir(), '0kay-tasks'),
      sessionId,
    })
    managers.set(sessionId, manager)
  }
  return manager
}

/** Test seam: forget every session's manager. */
export function resetTaskManagers(): void {
  for (const manager of managers.values()) manager.dispose()
  managers.clear()
}

function shortCommand(command: string, limit = 80): string {
  const oneLine = command.replace(/\s+/g, ' ').trim()
  return oneLine.length > limit ? `${oneLine.slice(0, limit - 1)}…` : oneLine
}

export class TaskListTool extends Tool {
  get name(): string {
    return 'TaskList'
  }

  get description(): string {
    return 'Lists the background tasks started in this session with their status, exit code and command.'
  }

  get parameters(): Record<string, any> {
    return { type: 'object', properties: {} }
  }

  async execute(_args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    try {
      const tasks = taskManagerFor(context).list()
      if (!tasks.length) return success('No background tasks.')
      const lines = tasks.map((task) => {
        let line = `${task.id} [${task.kind}] ${task.status}`
        if (task.status === 'completed' || task.status === 'failed') line += ` exit=${task.exitCode}`
        return `${line}  ${shortCommand(task.command)}`
      })
      return success(lines.join('\n'))
    } catch (error) {
      return failure(error)
    }
  }
}

export class TaskOutputTool extends Tool {
  get name(): string {
    return 'TaskOutput'
  }

  get description(): string {
    return 'Reads the output of a background task started by Bash (run_in_background) or Monitor. ' +
      'You can also read the task\'s output-file path directly. Set block=true to wait for it to finish first.'
  }

  get parameters(): Record<string, any> {
    return {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'The task id (e.g. task_1).' },
        max_bytes: { type: 'integer', description: 'Max bytes of output to return from the tail (default 30000).' },
        block: { type: 'boolean', description: 'Wait until the task finishes before returning (default false).' },
        timeout_ms: { type: 'integer', description: 'Max wait when block=true (default 30000).' },
      },
      required: ['task_id'],
    }
  }

  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    const taskId = String(args.task_id || '').trim()
    if (!taskId) return failure('task_id is required')
    const manager = taskManagerFor(context)
    try {
      const known = manager.get(taskId)
      if (!known) return failure(`unknown task ${taskId}`)
      if (args.block) {
        const timeout = Number.isFinite(Number(args.timeout_ms)) ? Number(args.timeout_ms) : 30000
        await manager.wait(taskId, timeout)
      }
      const maxBytes = Number.isFinite(Number(args.max_bytes)) ? Number(args.max_bytes) : 30000
      const output = manager.output(taskId, maxBytes) ?? ''
      const current = manager.get(taskId)
      // The status travels with the output: a truncated log means nothing without
      // knowing whether the process is still running.
      return success({
        task_id: taskId,
        status: current?.status ?? 'unknown',
        exit_code: current?.exitCode ?? 0,
        output_file: known.outputFile,
        output,
      })
    } catch (error) {
      return failure(error)
    }
  }
}

export class TaskStopTool extends Tool {
  get name(): string {
    return 'TaskStop'
  }

  get description(): string {
    return 'Stops a running background task. Returns whether a process was actually signalled.'
  }

  get parameters(): Record<string, any> {
    return {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'The task id to stop.' },
      },
      required: ['task_id'],
    }
  }

  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    const taskId = String(args.task_id || '').trim()
    if (!taskId) return failure('task_id is required')
    try {
      const manager = taskManagerFor(context)
      const known = manager.get(taskId)
      if (!known) return failure(`unknown task ${taskId}`)
      const stopped = manager.stop(taskId)
      return success({ task_id: taskId, stopped, status: manager.get(taskId)?.status ?? 'unknown' })
    } catch (error) {
      return failure(error)
    }
  }
}

/**
 * Wait a bounded number of seconds, staying cancellable.
 *
 * Pairs with the task tools: start something in the background, sleep, then read
 * its partial output. The wait ends the moment the run is paused or stopped
 * instead of sitting out the whole deadline.
 */
export class SleepTool extends Tool {
  get name(): string {
    return 'sleep'
  }

  get description(): string {
    return 'Waits for N seconds, then returns. Use it to let a backgrounded command make progress ' +
      'before reading its partial output with TaskOutput. Interrupted immediately if the run is paused or stopped.'
  }

  get parameters(): Record<string, any> {
    return {
      type: 'object',
      properties: {
        seconds: { type: 'integer', description: 'Seconds to wait, 1-3600.' },
      },
      required: ['seconds'],
    }
  }

  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    const asked = Number(args.seconds)
    const seconds = Math.min(3600, Math.max(1, Number.isFinite(asked) ? Math.trunc(asked) : 1))
    const signal = context.signal
    if (signal?.aborted) return success('sleep interrupted')
    return new Promise<ToolResult>((resolve) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        resolve(success(`slept ${seconds}s`))
      }, seconds * 1000)
      const onAbort = () => {
        clearTimeout(timer)
        resolve(success('sleep interrupted'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }
}

/** Same catastrophic-command floor as the shell tool: a monitor runs for real. */
const DESTRUCTIVE = /\b(rm\s+-rf\s+\/|format\s+[a-z]:|del\s+\/[sf]\s+\/q\s+[a-z]:\|shutdown|reboot|mkfs\.)/i

/**
 * Start a long-running streaming process (tail -f, watch, a dev server, a polling
 * loop) and return at once with a task id and the output-file path.
 */
export class MonitorTool extends Tool {
  get name(): string {
    return 'Monitor'
  }

  get description(): string {
    return 'Starts a long-running streaming process in the background (e.g. tail -f, watch, a dev server, ' +
      'a polling loop) and returns immediately with a task id and output-file path. Use TaskOutput to inspect ' +
      'it and TaskStop to end it.'
  }

  get parameters(): Record<string, any> {
    return {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The streaming command to run.' },
        description: { type: 'string', description: 'Short description of what is being monitored.' },
      },
      required: ['command'],
    }
  }

  get dangerous(): boolean {
    return true
  }

  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    const command = String(args.command || '').trim()
    if (!command) return failure('command is required')
    if (DESTRUCTIVE.test(command)) return failure('refused: destructive command')
    try {
      const started = taskManagerFor(context).start(command, 'monitor', context.cwd)
      return success({
        task_id: started.id,
        output_file: started.outputFile,
        note: `Started monitor ${started.id}. Use TaskOutput{task_id:"${started.id}"} to inspect it; TaskStop{task_id:"${started.id}"} to end it.`,
      })
    } catch (error) {
      return failure(error)
    }
  }
}
