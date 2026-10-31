import test from 'node:test'
import assert from 'node:assert/strict'
import { inferContextWindow, compactPolicy, decideCompactTier, cacheProfileFor, DEFAULT_CONTEXT_WINDOW } from './window.js'
import { allocateBudget, overBudget } from './budget.js'

// The window has to come from somewhere before the loop can decide anything.
// Precedence matters: a hand-typed value must win, an explicit `-32k` suffix
// must beat the family guess, and an unknown model must still get a usable
// number instead of 0 (which used to mean "never compact").

test('configured value wins over everything', () => {
  const info = inferContextWindow('deepseek-v4-flash', 64000, 128000)
  assert.deepEqual(info, { tokens: 64000, source: 'configured' })
})

test('provider value beats inference', () => {
  const info = inferContextWindow('deepseek-v4-flash', 0, 65536)
  assert.deepEqual(info, { tokens: 65536, source: 'provider' })
})

test('an explicit size suffix beats the family table', () => {
  assert.equal(inferContextWindow('qwen2.5-32k').tokens, 32 * 1024)
  assert.equal(inferContextWindow('some-model-1m').tokens, 1_000_000)
})

test('known families get their real window', () => {
  assert.equal(inferContextWindow('deepseek-v4-flash').tokens, 128000)
  assert.equal(inferContextWindow('claude-sonnet-4').tokens, 200000)
  assert.equal(inferContextWindow('gemini-2.5-pro').tokens, 1_000_000)
})

test('an unknown model falls back instead of reporting zero', () => {
  const info = inferContextWindow('totally-new-model')
  assert.equal(info.tokens, DEFAULT_CONTEXT_WINDOW)
  assert.equal(info.source, 'default')
})

test('cache profile changes how eagerly history is folded', () => {
  assert.equal(cacheProfileFor('deepseek-v4-flash'), 'cache-preserving')
  assert.equal(cacheProfileFor('gpt-4o'), 'balanced')
  const ds = compactPolicy('deepseek-v4-flash')
  const gpt = compactPolicy('gpt-4o')
  assert.ok(ds.compact > gpt.compact, 'cache-preserving must compact later')
  assert.ok(ds.ceiling <= 0.95)
})

test('tiers step through watch, compact, reactive, ceiling', () => {
  const policy = compactPolicy('gpt-4o')
  const window = 100_000
  assert.equal(decideCompactTier(10_000, window, policy), 'none')
  assert.equal(decideCompactTier(65_000, window, policy), 'watch')
  assert.equal(decideCompactTier(80_000, window, policy), 'compact')
  assert.equal(decideCompactTier(90_000, window, policy), 'reactive')
  assert.equal(decideCompactTier(99_000, window, policy), 'ceiling')
  assert.equal(decideCompactTier(50_000, 0, policy), 'none')
})

test('budget never exceeds the window and keeps room for the reply', () => {
  for (const window of [8_000, 32_768, 128_000, 1_000_000]) {
    const budget = allocateBudget(window)
    const sum = budget.system + budget.tools + budget.skills + budget.history + budget.toolResults
    assert.ok(sum <= budget.usable, `${window}: ${sum} > ${budget.usable}`)
    assert.ok(budget.outputReserve > 0)
    assert.ok(budget.history > budget.toolResults, 'history deserves the biggest share')
  }
})

test('a tiny window still gives every block something', () => {
  const budget = allocateBudget(8_000)
  assert.ok(budget.system >= 1)
  assert.ok(budget.tools >= 1)
  assert.ok(budget.history >= 1)
})

test('overBudget reports the trimming order', () => {
  const budget = allocateBudget(128_000)
  const order = overBudget(budget, {
    system: 0,
    tools: 0,
    skills: 0,
    history: budget.history + 1,
    toolResults: budget.toolResults + 1,
    used: 0,
  })
  assert.deepEqual(order, ['toolResults', 'history'])
})
