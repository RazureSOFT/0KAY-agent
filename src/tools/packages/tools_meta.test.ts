import test from 'node:test'
import assert from 'node:assert/strict'
import { ToolsTool } from './tools_meta.js'
import { TOOL_GROUPS, ALWAYS_LOADED } from '../groups.js'
import type { ToolContext } from '../types.js'

function context(loaded = new Set<string>()): ToolContext {
  return {
    cwd: process.cwd(),
    taskId: 't',
    agentType: 'general',
    toolGroups: {
      list: () => Object.entries(TOOL_GROUPS).map(([group, definition]) => ({
        group,
        hint: definition.hint,
        loaded: ALWAYS_LOADED.includes(group) || loaded.has(group),
        tools: definition.tools,
      })),
      load: (group) => {
        if (!TOOL_GROUPS[group]) return false
        loaded.add(group)
        return true
      },
      unload: (group) => {
        if (ALWAYS_LOADED.includes(group) || !TOOL_GROUPS[group]) return false
        return loaded.delete(group)
      },
    },
  } as ToolContext
}

test('list shows every group and which are loaded', async () => {
  const tool = new ToolsTool()
  const result = await tool.execute({ action: 'list' }, context())
  assert.equal(result.success, true, result.error)
  const groups = result.data.groups
  assert.ok(groups.length >= 7)
  const analysis = groups.find((group: any) => group.group === 'analysis')
  assert.equal(analysis.loaded, false)
  assert.ok(analysis.tools.includes('pentest'))
  const core = groups.find((group: any) => group.group === 'core')
  assert.equal(core.loaded, true)
})

test('load flips a group on', async () => {
  const tool = new ToolsTool()
  const ctx = context()
  const result = await tool.execute({ action: 'load', group: 'analysis' }, ctx)
  assert.equal(result.success, true, result.error)
  assert.equal(result.data.loaded, true)
  const analysis = result.data.groups.find((group: any) => group.group === 'analysis')
  assert.equal(analysis.loaded, true)
})

test('an unknown group is an error, not a silent no-op', async () => {
  const tool = new ToolsTool()
  const result = await tool.execute({ action: 'load', group: 'nope' }, context())
  assert.equal(result.success, false)
  assert.match(result.error || '', /unknown group/)
})

test('core cannot be unloaded', async () => {
  const tool = new ToolsTool()
  const result = await tool.execute({ action: 'unload', group: 'core' }, context())
  assert.equal(result.success, false)
  assert.match(result.error || '', /cannot be unloaded/)
})

test('unload works for a group that was loaded', async () => {
  const loaded = new Set(['docs'])
  const tool = new ToolsTool()
  const result = await tool.execute({ action: 'unload', group: 'docs' }, context(loaded))
  assert.equal(result.success, true, result.error)
  assert.equal(loaded.has('docs'), false)
})

test('without the group API the tool says so', async () => {
  const tool = new ToolsTool()
  const result = await tool.execute({ action: 'list' }, { cwd: process.cwd(), taskId: 't', agentType: 'general' } as ToolContext)
  assert.equal(result.success, false)
  assert.match(result.error || '', /unavailable/)
})
