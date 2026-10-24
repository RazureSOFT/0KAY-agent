import test from 'node:test'
import assert from 'node:assert/strict'
import { SubAgentTool } from './subagent.js'
import { SubAgentRegistry } from '../../agent/subagents.js'
import type { ToolContext } from '../types.js'

const context = (registry: SubAgentRegistry): ToolContext => ({
  cwd: process.cwd(),
  taskId: 't',
  sessionId: 's',
  agentType: 'general',
  subagents: {
    spawn: (spec) => registry.spawn(spec, async () => `answer to: ${spec.prompt}`),
    list: () => registry.list(),
    cancel: (id) => registry.cancel(id),
  },
} as ToolContext)

test('spawn returns the child answer and its id', async () => {
  const tool = new SubAgentTool()
  const result = await tool.execute({ action: 'spawn', prompt: 'count the files' }, context(new SubAgentRegistry(2)))
  assert.equal(result.success, true, result.error)
  assert.equal(result.data.status, 'done')
  assert.match(result.data.result, /answer to: count the files/)
  assert.match(result.data.id, /^sub_/)
})

test('parallel returns one entry per task, failures included', async () => {
  const registry = new SubAgentRegistry(4)
  const tool = new SubAgentTool()
  const ctx: ToolContext = {
    cwd: process.cwd(), taskId: 't', sessionId: 's', agentType: 'general',
    subagents: {
      spawn: (spec) => registry.spawn(spec, async () => {
        if (spec.prompt.includes('bad')) throw new Error('nope')
        return 'ok'
      }),
      list: () => registry.list(),
      cancel: (id) => registry.cancel(id),
    },
  }
  const result = await tool.execute({ action: 'parallel', tasks: [{ prompt: 'good one' }, { prompt: 'bad one' }] }, ctx)
  assert.equal(result.success, true, result.error)
  assert.equal(result.data.results.length, 2)
  assert.equal(result.data.results[0].status, 'done')
  assert.equal(result.data.results[1].status, 'failed')
})

test('parallel refuses more children than the cap', async () => {
  const tool = new SubAgentTool()
  const tasks = Array.from({ length: 7 }, (_, index) => ({ prompt: `t${index}` }))
  const result = await tool.execute({ action: 'parallel', tasks }, context(new SubAgentRegistry(8)))
  assert.equal(result.success, false)
  assert.match(result.error || '', /at most 6/)
})

test('list reports what this task started', async () => {
  const registry = new SubAgentRegistry(2)
  const tool = new SubAgentTool()
  const ctx = context(registry)
  await tool.execute({ action: 'spawn', prompt: 'one', label: 'first' }, ctx)
  const result = await tool.execute({ action: 'list' }, ctx)
  assert.equal(result.success, true)
  assert.equal(result.data.count, 1)
  assert.equal(result.data.agents[0].label, 'first')
})

test('without a runner the tool fails instead of pretending', async () => {
  const tool = new SubAgentTool()
  const result = await tool.execute({ action: 'spawn', prompt: 'x' }, { cwd: process.cwd(), taskId: 't', agentType: 'general' } as ToolContext)
  assert.equal(result.success, false)
  assert.match(result.error || '', /unavailable/)
})
