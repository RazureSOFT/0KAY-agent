import test from 'node:test'
import assert from 'node:assert/strict'
import { ProgressTool, progressFor, clearProgress } from './progress.js'
import type { ToolContext } from './types.js'

// The progress number is a self-report, so the only thing the runtime can do is
// keep it sane: clamp it, refuse a cliff-dive, and never let a failed report
// break the task.

const tool = new ProgressTool()

function context(taskId: string): ToolContext {
  return { cwd: process.cwd(), taskId, sessionId: `s-${taskId}`, agentType: 'general' } as ToolContext
}

test('reports the percent it was given', async () => {
  clearProgress('t1')
  const result = await tool.execute({ percent: 40, note: 'reading files', phase: 'acting' }, context('t1'))
  assert.equal(result.success, true)
  assert.equal(result.data.percent, 40)
  assert.equal(result.data.phase, 'acting')
  assert.equal(progressFor('t1')?.percent, 40)
})

test('clamps out-of-range values instead of trusting them', async () => {
  clearProgress('t2')
  const high = await tool.execute({ percent: 250 }, context('t2'))
  assert.equal(high.data.percent, 100)
  clearProgress('t2')
  const low = await tool.execute({ percent: -20 }, context('t2'))
  assert.equal(low.data.percent, 0)
})

test('a large drop is corrected and explained', async () => {
  clearProgress('t3')
  await tool.execute({ percent: 80 }, context('t3'))
  const result = await tool.execute({ percent: 20 }, context('t3'))
  assert.equal(result.data.percent, 70)
  assert.match(result.data.correction, /accepted 70/)
})

test('a small revision is allowed', async () => {
  clearProgress('t4')
  await tool.execute({ percent: 60 }, context('t4'))
  const result = await tool.execute({ percent: 55 }, context('t4'))
  assert.equal(result.data.percent, 55)
  assert.equal(result.data.correction, undefined)
})

test('the checklist carries over when not replaced', async () => {
  clearProgress('t5')
  await tool.execute({ percent: 10, items: [{ title: 'scan', status: 'done' }, { title: 'fix', status: 'doing' }] }, context('t5'))
  const result = await tool.execute({ percent: 30, note: 'fixing' }, context('t5'))
  assert.equal(result.data.items.length, 2)
  assert.equal(result.data.items[1].status, 'doing')
})

test('unknown phase and statuses fall back instead of throwing', async () => {
  clearProgress('t6')
  const result = await tool.execute({ percent: 5, phase: 'nonsense', items: [{ title: 'x', status: 'weird' }] }, context('t6'))
  assert.equal(result.success, true)
  assert.equal(result.data.items[0].status, 'pending')
  assert.ok(['thinking', 'acting', 'waiting', 'done', 'failed'].includes(result.data.phase))
})
