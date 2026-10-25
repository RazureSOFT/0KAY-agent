import test from 'node:test'
import assert from 'node:assert/strict'
import { DeepScanTool, ExploitRuntimeTool, extractJson } from './scan.js'
import { SandboxPolicy } from '../../sandbox/policy.js'
import type { ToolContext } from '../types.js'

// deep_scan is the ARTEX loop with a model bolted on. The model is faked here on
// purpose: what needs testing is the stopping logic, not the prompt.

function contextWithPlanner(replies: string[]): ToolContext {
  let index = 0
  return {
    cwd: process.cwd(),
    taskId: 'scan',
    agentType: 'general',
    llm: async () => replies[Math.min(index++, replies.length - 1)] ?? null,
  } as ToolContext
}

test('extractJson survives fences and prose', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 })
  assert.deepEqual(extractJson('Sure! Here you go: {"a":{"b":2}} hope that helps'), { a: { b: 2 } })
  assert.equal(extractJson('no json at all'), null)
})

test('deep_scan runs rounds until the goals are proven', async () => {
  const tool = new DeepScanTool()
  const ctx = contextWithPlanner([
    // goals phase
    JSON.stringify({ constraints: ['stay on a.example.com'], goals: [{ text: 'prove the login is bypassable', assets: ['https://a.example.com/login'] }] }),
    // planner round 1
    JSON.stringify({ plan: [{ text: 'probe the login' }], intents: [{ text: 'probe login', assets: ['https://a.example.com/login'], stepId: 's1' }] }),
    // worker round 1
    JSON.stringify({ facts: [{ text: 'login accepts POST' }], findings: [{ text: 'auth bypass with empty password' }], steps: [{ action: 'curl', detail: 'POST /login', ok: true }] }),
    // planner round 2: nothing left
    JSON.stringify({ intents: [] }),
  ])
  const result = await tool.execute({ goal: 'prove login bypassable', targets: ['https://a.example.com/login'], rounds: 3 }, ctx)
  assert.equal(result.success, true, result.error)
  assert.equal(result.data.stopped, 'goal-proven')
  assert.equal(result.data.proven, true)
  assert.equal(result.data.findings.length, 1)
  assert.equal(result.data.goals[0].status, 'met')
  assert.equal(result.data.scope[0], 'domain:a.example.com', 'a URL target reduces to its host')
  assert.equal(result.data.traces, 1)
})

test('a planner that never returns intents ends immediately', async () => {
  const tool = new DeepScanTool()
  const result = await tool.execute(
    { goal: 'nothing to do', targets: ['example.com'] },
    contextWithPlanner([JSON.stringify({ intents: [] })]),
  )
  assert.equal(result.success, true, result.error)
  assert.equal(result.data.stopped, 'planner-idle')
  assert.equal(result.data.intents, 0)
})

test('a worker reply that is not JSON is a blocked intent, not a crash', async () => {
  const tool = new DeepScanTool()
  const ctx = contextWithPlanner([
    JSON.stringify({ goals: [] }), // goals phase falls back to the single objective
    JSON.stringify({ intents: [{ text: 'probe', assets: ['example.com'] }] }),
    'I could not do that.',
    JSON.stringify({ intents: [] }),
  ])
  const result = await tool.execute({ goal: 'find something', targets: ['example.com'], rounds: 2 }, ctx)
  assert.equal(result.success, true, result.error)
  assert.equal(result.data.findings.length, 0)
  assert.equal(result.data.goals.length, 1, 'the objective itself becomes the goal when decomposition fails')
})

test('deep_scan needs a model and a scope', async () => {
  const tool = new DeepScanTool()
  const noModel = await tool.execute({ goal: 'g', targets: ['x.com'] }, { cwd: process.cwd(), taskId: 't', agentType: 'general' } as ToolContext)
  assert.equal(noModel.success, false)
  assert.match(noModel.error || '', /needs a model/)

  const noTargets = await tool.execute({ goal: 'g', targets: [] }, contextWithPlanner(['{}']))
  assert.equal(noTargets.success, false)
  assert.match(noTargets.error || '', /targets/)
})

test('exploit_runtime runs a snippet and returns its output', async () => {
  const tool = new ExploitRuntimeTool()
  const result = await tool.execute(
    { code: 'print(6*7)', language: 'python' },
    { cwd: process.cwd(), taskId: 'poc', agentType: 'general', sandbox: new SandboxPolicy('workspace-write', [process.cwd()]) } as ToolContext,
  )
  if (!result.success) {
    // A machine without python on PATH should say so rather than pass silently.
    assert.match(result.error || '', /python|ENOENT/i)
    return
  }
  assert.equal(result.data.ok, true)
  assert.equal(result.data.stdout.trim(), '42')
})

test('exploit_runtime refuses to run when the policy says no', async () => {
  const tool = new ExploitRuntimeTool()
  const result = await tool.execute(
    { code: 'print(1)', language: 'python' },
    { cwd: process.cwd(), taskId: 'poc', agentType: 'general', sandbox: new SandboxPolicy('read-only', [process.cwd()]) } as ToolContext,
  )
  assert.equal(result.success, false)
  assert.match(result.error || '', /read-only/)
})
