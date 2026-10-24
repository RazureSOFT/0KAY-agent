import { Tool } from '../types.js'
import type { ToolContext, ToolResult } from '../types.js'
import { success, failure } from '../helpers.js'

// The model decides whether to open a sub-agent, how many, and what to ask.
// Nothing here is scheduled by the harness — the tool only enforces the budget
// (concurrency, task count) and reports what came back.

const MAX_TEAM = 6

export class SubAgentTool extends Tool {
  get name(): string { return 'subagent'; }
  get description(): string {
    return [
      'Run work in a child agent with its own context, and get back only its answer.',
      'Use it when a question needs many searches or a lot of reading that would otherwise fill this conversation.',
      'action=spawn runs one child; action=parallel runs several at once (max 6) and returns every result;',
      'action=list shows children started by this task; action=cancel stops one by id.',
      'A child cannot start its own children beyond one level down, and sees only the prompt you give it — not this conversation.',
    ].join(' ')
  }
  get parameters(): Record<string, any> {
    return {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['spawn', 'parallel', 'list', 'cancel'] },
        prompt: { type: 'string', description: 'spawn: what the child should do. Be specific, it cannot see this conversation.' },
        agentType: { type: 'string', description: 'spawn: sub-agent type such as code, research or general.' },
        label: { type: 'string', description: 'spawn: short name shown in list output.' },
        tasks: {
          type: 'array',
          description: 'parallel: one entry per child.',
          items: {
            type: 'object',
            required: ['prompt'],
            properties: { prompt: { type: 'string' }, agentType: { type: 'string' }, label: { type: 'string' } },
          },
        },
        id: { type: 'string', description: 'cancel: the sub-agent id from a previous spawn or list.' },
      },
    }
  }

  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    const runner = context.subagents
    if (!runner) return failure('sub-agents are unavailable at this depth')

    try {
      switch (args.action) {
        case 'spawn': {
          const record = await runner.spawn({
            prompt: String(args.prompt || ''),
            agentType: typeof args.agentType === 'string' ? args.agentType : undefined,
            label: typeof args.label === 'string' ? args.label : undefined,
          })
          return success(describe(record))
        }
        case 'parallel': {
          const tasks = Array.isArray(args.tasks) ? args.tasks : []
          if (!tasks.length) throw new Error('tasks must be a non-empty array')
          if (tasks.length > MAX_TEAM) throw new Error(`at most ${MAX_TEAM} sub-agents per call`)
          // Not Promise.all: one child failing must not hide the other five.
          const settled = await Promise.allSettled(tasks.map((task: any) => runner.spawn({
            prompt: String(task?.prompt || ''),
            agentType: typeof task?.agentType === 'string' ? task.agentType : undefined,
            label: typeof task?.label === 'string' ? task.label : undefined,
          })))
          return success({
            results: settled.map((entry, index) => entry.status === 'fulfilled'
              ? describe(entry.value)
              : { label: String(tasks[index]?.label || tasks[index]?.prompt || '').slice(0, 80), status: 'failed', error: entry.reason?.message || String(entry.reason) }),
          })
        }
        case 'list': {
          const records = runner.list()
          return success({ count: records.length, agents: records.map(describe) })
        }
        case 'cancel': {
          const id = String(args.id || '')
          if (!id) throw new Error('id is required')
          return success({ id, cancelled: runner.cancel(id) })
        }
        default:
          throw new Error('action must be spawn, parallel, list or cancel')
      }
    } catch (error) {
      return failure(error)
    }
  }
}

function describe(record: { id: string; label: string; status: string; result?: string; error?: string; agentType: string }): Record<string, any> {
  return {
    id: record.id,
    label: record.label,
    agentType: record.agentType,
    status: record.status,
    ...(record.result != null ? { result: record.result } : {}),
    ...(record.error ? { error: record.error } : {}),
  }
}
