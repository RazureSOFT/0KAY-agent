import { Tool } from '../types.js'
import type { ToolContext, ToolResult } from '../types.js'
import { success, failure } from '../helpers.js'

// The index the prompt points at.
//
// Forty tool schemas is ~8.8k tokens of system prompt on every request, most of
// it describing tools the task will never touch. So the prompt carries the core
// set and names the rest in one line per group; this tool is how the model turns
// a name into a schema.
//
// Loading is an optimisation, not a permission: calling a deferred tool by name
// loads its group on the way through, so a model that never calls this tool still
// gets its work done.

export class ToolsTool extends Tool {
  get name(): string { return 'tools'; }
  get description(): string {
    return [
      'Inspect and load tool groups. action=list shows every group, whether it is loaded, and the tools in it.',
      'action=load adds a group\'s full schemas to the prompt for the rest of this task; action=unload removes one.',
      'You do not have to call this first: naming a deferred tool directly also works, and loads its group automatically.',
    ].join(' ')
  }
  get parameters(): Record<string, any> {
    return {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['list', 'load', 'unload'] },
        group: { type: 'string', description: 'load/unload: group name from the list.' },
      },
    }
  }

  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    const groups = context.toolGroups
    if (!groups) return failure('tool groups are unavailable in this context')
    try {
      if (args.action === 'list') return success({ groups: groups.list() })
      const group = String(args.group || '').trim()
      if (!group) throw new Error('group is required')
      if (args.action === 'load') {
        if (!groups.load(group)) throw new Error(`unknown group: ${group}`)
        return success({ group, loaded: true, groups: groups.list() })
      }
      if (args.action === 'unload') {
        if (!groups.unload(group)) throw new Error(`unknown group, or it cannot be unloaded: ${group}`)
        return success({ group, loaded: false, groups: groups.list() })
      }
      throw new Error('action must be list, load or unload')
    } catch (error) {
      return failure(error)
    }
  }
}
