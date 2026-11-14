import test from 'node:test'
import assert from 'node:assert/strict'
import { RetestTool, parseVerdict } from './retest.js'
import { FindingStore } from '../../analysis/recon/findings.js'
import { AssessmentManager } from '../../analysis/recon/tasks.js'
import { ReconGraph } from '../../analysis/recon/graph.js'
import type { ToolContext } from '../types.js'

// The retester's job is a judgement, and the failures worth guarding against are
// judgement failures: a missing verdict read as "still vulnerable", a retest that
// ends without an answer, two retests racing on one finding.

function contextWithReply(reply: string | Error, manager: AssessmentManager): ToolContext {
  return {
    cwd: process.cwd(),
    taskId: 'retest-task',
    agentType: 'general',
    assessments: manager,
    runSubAgent: async () => {
      if (reply instanceof Error) throw reply
      return reply
    },
  } as unknown as ToolContext
}

async function managerWithFinding(): Promise<{ manager: AssessmentManager; findingId: string }> {
  const manager = new AssessmentManager(async () => new ReconGraph())
  const finding = manager.findings.add({ taskId: 'as_1', sessionId: 's1', text: 'auth bypass with empty password', assets: ['example.test'] })
  return { manager, findingId: finding.id }
}

test('reproduced is recorded with its evidence', async () => {
  const { manager, findingId } = await managerWithFinding()
  const tool = new RetestTool()
  const result = await tool.execute(
    { action: 'start', finding_id: findingId },
    contextWithReply('{"verdict":"reproduced","summary":"payload still accepted","evidence":"POST /login with empty pass → 200"}', manager),
  )
  assert.equal(result.success, true, result.error)
  assert.equal(result.data.retest.status, 'completed')
  assert.equal(result.data.retest.verdict, 'reproduced')
  assert.match(result.data.retest.evidence, /POST \/login/)
})

test('a missing verdict is inconclusive, never reproduced', async () => {
  const { manager, findingId } = await managerWithFinding()
  const tool = new RetestTool()
  const result = await tool.execute({ action: 'start', finding_id: findingId }, contextWithReply('我看了一下，感觉应该还在', manager))
  assert.equal(result.success, true, result.error)
  assert.equal(result.data.retest.verdict, 'inconclusive')
})

test('an agent error marks the retest failed and keeps the reason', async () => {
  const { manager, findingId } = await managerWithFinding()
  const tool = new RetestTool()
  const result = await tool.execute({ action: 'start', finding_id: findingId }, contextWithReply(new Error('target unreachable'), manager))
  assert.equal(result.success, true, result.error)
  assert.equal(result.data.retest.status, 'failed')
  assert.match(result.data.retest.error, /unreachable/)
})

test('starting on an unknown finding is refused', async () => {
  const { manager } = await managerWithFinding()
  const result = await new RetestTool().execute({ action: 'start', finding_id: 'fi_nope' }, contextWithReply('{}', manager))
  assert.equal(result.success, false)
  assert.match(result.error || '', /unknown finding/)
})

test('a second concurrent retest on one finding is refused', async () => {
  const { manager, findingId } = await managerWithFinding()
  manager.findings.startRetest(findingId) // left active on purpose
  const result = await new RetestTool().execute({ action: 'start', finding_id: findingId }, contextWithReply('{}', manager))
  assert.equal(result.success, true, result.error)
  assert.match(result.data.error || '', /already running/)
})

test('list returns the history and active returns only running ones', async () => {
  const { manager, findingId } = await managerWithFinding()
  const tool = new RetestTool()
  await tool.execute({ action: 'start', finding_id: findingId }, contextWithReply('{"verdict":"fixed"}', manager))
  const listed = await tool.execute({ action: 'list', finding_id: findingId }, contextWithReply('{}', manager))
  assert.equal(listed.data.retests.length, 1)
  const active = await tool.execute({ action: 'active' }, contextWithReply('{}', manager))
  assert.equal(active.data.retests.length, 0)
})

test('parseVerdict only accepts the three words', () => {
  assert.equal(parseVerdict('{"verdict":"fixed"}').verdict, 'fixed')
  assert.equal(parseVerdict('{"verdict":"still-vulnerable"}').verdict, 'inconclusive')
  assert.equal(parseVerdict('no json').verdict, 'inconclusive')
  assert.equal(parseVerdict('{"verdict":"reproduced","summary":"s"}').summary, 's')
})
