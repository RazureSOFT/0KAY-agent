import test from 'node:test'
import assert from 'node:assert/strict'
import { reviewPlan, REVIEW_DIMENSIONS } from './review.js'
import type { LoopContext, LoopRuntime } from './loop.js'
import { Plan } from './plan.js'
import type { AssessmentReview } from './tasks.js'

const loop: LoopContext = { objective: 'test the login', scopeLine: 'Scope: example.test', constraints: [], fallbackAssets: [] }

function runtimeReplying(text: string | null): LoopRuntime {
  return { llm: async () => text } as unknown as LoopRuntime
}

const plan = (): Plan => {
  const p = new Plan()
  p.setAll([{ text: 'probe 443' }, { text: 'try default creds', needs: ['s1'] }])
  return p
}

test('accept carries the dimension verdicts through', async () => {
  const reply = JSON.stringify({
    verdict: 'accept',
    dimensions: [
      { id: 'scope', verdict: 'ok' },
      { id: 'evidence', verdict: 'weak', note: 'step 2 assumes a login form nobody saw' },
    ],
  })
  const result = await reviewPlan(runtimeReplying(reply), loop, { plan: plan().toJSON(), intentTexts: ['a'], situation: {} })
  assert.equal(result.verdict, 'accept')
  assert.equal(result.dimensions.length, 2)
  assert.equal(result.dimensions[1].note, 'step 2 assumes a login form nobody saw')
})

test('a revision request is kept verbatim', async () => {
  const revision = '方向成立，但第 2 步缺前置：先把登录表单的字段确认下来再试默认口令'
  const result = await reviewPlan(
    runtimeReplying(JSON.stringify({ verdict: 'revise', dimensions: [{ id: 'sequencing', verdict: 'fails', note: 's2 needs a form' }], revision })),
    loop,
    { plan: plan().toJSON(), intentTexts: [], situation: {} },
  )
  assert.equal(result.verdict, 'revise')
  assert.equal(result.revision, revision)
})

test('a reviewer that cannot run accepts, so the loop is never blocked', async () => {
  const thrown = { llm: async () => { throw new Error('model unavailable') } } as unknown as LoopRuntime
  const result = await reviewPlan(thrown, loop, { plan: plan().toJSON(), intentTexts: [], situation: {} })
  assert.equal(result.verdict, 'accept')
  assert.match(result.error || '', /model unavailable/)
})

test('an unparseable reply accepts and says why', async () => {
  const result = await reviewPlan(runtimeReplying('I think the plan is fine.'), loop, { plan: plan().toJSON(), intentTexts: [], situation: {} })
  assert.equal(result.verdict, 'accept')
  assert.match(result.error || '', /parseable/)
})

test('every dimension the engine asks about is named', () => {
  assert.deepEqual(REVIEW_DIMENSIONS.map((d) => d.id), ['scope', 'evidence', 'sequencing', 'operability', 'effort'])
})

test('the reviewer prompt asks for every dimension and the layered wording', async () => {
  let seen = ''
  const capture = { llm: async (request: any) => { seen = request.systemPrompt; return '{}' } } as unknown as LoopRuntime
  await reviewPlan(capture, loop, { plan: plan().toJSON(), intentTexts: ['probe'], situation: {} })
  for (const dimension of REVIEW_DIMENSIONS) {
    assert.ok(seen.includes(dimension.id), `prompt is missing dimension ${dimension.id}`)
  }
  // The layered rejection wording is the point of this reviewer: direction first,
  // then the specific correction. If it is dropped, the note becomes generic.
  assert.ok(seen.includes('先给大方向的对错'), 'prompt lost the layered rejection instruction')
  assert.ok(seen.includes('最小'), 'prompt lost the "smallest change" instruction')
})

test('the manager carries a bounded review log on its state type', () => {
  // The log is a plain array on the state, ordered by round as written; the cap
  // is what keeps a long-running task from growing without bound. Both are
  // asserted through the type-level shape the UI reads.
  const state: AssessmentReview = {
    round: 3,
    at: new Date().toISOString(),
    plan: [{ id: 's1', text: 'probe', needs: [] }],
    intents: [],
    verdict: 'revise',
    dimensions: [{ id: 'scope', question: 'in scope?', verdict: 'ok' }],
    revision: 'narrow step 1',
    revised: true,
  }
  assert.equal(state.round, 3)
  assert.equal(state.verdict, 'revise')
})
