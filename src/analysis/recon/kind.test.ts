import test from 'node:test'
import assert from 'node:assert/strict'
import { makePlanner } from './loop.js'
import type { LoopContext, LoopRuntime } from './loop.js'
import { Plan } from './plan.js'
import type { Situation } from './engine.js'

// The two kinds differ in the planner prompt, and that difference is the whole
// feature: an engineering task whose planner still thinks in "probe the target"
// terms produces a recon plan with a different label.

function situation(): Situation {
  return {
    round: 1,
    overview: {
      goals: [{ id: 'g1', text: 'make the build pass', status: 'open' }],
      coverage: { total: 1, tested: 0, scope: { rows: 1, denominator: 1, pct: 0 } },
      openIntents: [],
      runningIntents: 0,
      blockedIntents: [],
      hints: [],
      recent: [],
    },
    plan: { steps: [], done: 0, total: 0, ready: [], blocked: [] },
    ready: [],
    traces: [],
    budget: {},
  } as unknown as Situation
}

/**
 * Run one planner round and return the prompt the *planner* saw.
 *
 * The round makes two calls — planner then reviewer — and both are model calls,
 * so collecting them in order and taking the first would pick whichever happened
 * to be first. The reviewer is separated by its own marker.
 */
async function plannerPromptFor(kind?: 'recon' | 'engineering'): Promise<string> {
  const plannerPrompts: string[] = []
  const runtime = {
    llm: async (request: any) => {
      const content = String(request.messages?.[0]?.content || '')
      if (content.includes('"reviewer":true')) return JSON.stringify({ verdict: 'accept', dimensions: [] })
      plannerPrompts.push(String(request.systemPrompt || ''))
      return JSON.stringify({ plan: [{ text: 'a step' }], intents: [] })
    },
  } as unknown as LoopRuntime
  const loop: LoopContext = {
    objective: 'make the build pass',
    scopeLine: 'Scope: repo',
    constraints: [],
    fallbackAssets: [],
    ...(kind ? { kind } : {}),
  }
  await makePlanner(runtime, new Plan(), loop)(situation())
  assert.equal(plannerPrompts.length, 1, 'exactly one planner call per round')
  return plannerPrompts[0]
}

test('an engineering task gets the engineering planner prompt', async () => {
  const prompt = await plannerPromptFor('engineering')
  assert.match(prompt, /工程任务/, 'engineering plan mode is not the one selected')
  assert.match(prompt, /可回退的基线/, 'engineering prompt lost the baseline requirement')
  assert.doesNotMatch(prompt, /授权渗透测试系统/, 'the recon prompt leaked into engineering mode')
})

test('a recon task keeps the penetration-test planner prompt', async () => {
  const prompt = await plannerPromptFor('recon')
  assert.match(prompt, /授权渗透测试系统/)
  assert.doesNotMatch(prompt, /工程任务/)
})

test('an absent kind means recon, so stored tasks keep their behaviour', async () => {
  const prompt = await plannerPromptFor()
  assert.match(prompt, /授权渗透测试系统/)
})
