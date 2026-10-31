/**
 * The ShellSession tool: a shell that keeps its state between calls.
 *
 * The one-shot shell tool re-creates a process every time, so `cd`, exported
 * variables and activated venvs are lost. This keeps one child per session and
 * drives it by sending commands and reading until a marker comes back.
 */
import { Tool, type ToolContext, type ToolResult } from './types.js'
import { success, failure } from './helpers.js'
import { ShellSession } from './shell_session.js'

const sessions = new Map<string, ShellSession>()

function keyFor(context: ToolContext, explicit?: string): string {
  return `${context.sessionId || context.taskId || 'default'}::${explicit || 'main'}`
}

/** Test seam: kill every session this process holds. */
export function resetShellSessions(): void {
  for (const session of sessions.values()) session.dispose()
  sessions.clear()
}

export class ShellSessionTool extends Tool {
  get name(): string {
    return 'ShellSession'
  }

  get description(): string {
    return 'Runs commands in a shell that keeps its state between calls (cd, exported variables, activated envs). ' +
      'Actions: run (command, session?, timeout_ms?) — starts the session on first use; read (session?) — whatever ' +
      'was printed since the last call; close (session?); list. Interactive full-screen programs are not supported.'
  }

  get parameters(): Record<string, any> {
    return {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['run', 'read', 'close', 'list'], description: 'What to do (default: run).' },
        command: { type: 'string', description: 'run: the command to execute.' },
        session: { type: 'string', description: 'Session name; several can coexist. Default: "main".' },
        timeout_ms: { type: 'integer', description: 'run: how long to wait before dropping the session (default 30000).' },
      },
      required: [],
    }
  }

  get dangerous(): boolean {
    // It runs arbitrary commands, exactly like the shell tool.
    return true
  }

  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    const action = String(args.action || 'run')
    const name = String(args.session || 'main')
    const key = keyFor(context, name)

    if (action === 'list') {
      return success({
        sessions: [...sessions.entries()]
          .filter(([id]) => id.startsWith(`${context.sessionId || context.taskId || 'default'}::`))
          .map(([id, session]) => ({
            session: id.split('::')[1],
            alive: session.alive,
            age_ms: Date.now() - session.startedAt,
          })),
      })
    }

    if (action === 'close') {
      const session = sessions.get(key)
      if (!session) return success({ closed: false, reason: 'no such session' })
      session.dispose()
      sessions.delete(key)
      return success({ closed: true, session: name })
    }

    const session = sessions.get(key)
    if (action === 'read') {
      if (!session) return failure(`no session named ${name}`)
      return success({ session: name, output: session.drain() })
    }

    const command = String(args.command || '').trim()
    if (!command) return failure('command is required for action "run"')

    let target = session
    if (!target || !target.alive) {
      if (target) sessions.delete(key)
      try {
        target = new ShellSession(context.cwd)
      } catch (error) {
        return failure(error)
      }
      sessions.set(key, target)
    }

    const timeout = Number.isFinite(Number(args.timeout_ms)) ? Number(args.timeout_ms) : 30000
    const result = await target.run(command, timeout)
    // A timed-out session has been dropped already; keep the map honest.
    if (!target.alive) sessions.delete(key)
    return success({
      session: name,
      output: result.output,
      exit_code: result.exitCode,
      ...(result.timedOut ? { timed_out: true, note: 'the session was dropped after the timeout' } : {}),
    })
  }
}
