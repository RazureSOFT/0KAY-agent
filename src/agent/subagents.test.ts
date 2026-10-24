import test from 'node:test'
import assert from 'node:assert/strict'
import { SubAgentRegistry, runTeam } from './subagents.js'

// The registry is the part that can hurt you: too many children, a child that
// never finishes, a cancel that does not actually stop the work.

const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

test('a child records its result', async () => {
  const registry = new SubAgentRegistry(2)
  const record = await registry.spawn({ prompt: 'say hi', label: 'greeter' }, async () => 'hi')
  assert.equal(record.status, 'done')
  assert.equal(record.result, 'hi')
  assert.equal(record.label, 'greeter')
  assert.ok(record.finishedAt)
})

test('a failing child is recorded, not thrown', async () => {
  const registry = new SubAgentRegistry(2)
  const record = await registry.spawn({ prompt: 'boom' }, async () => { throw new Error('model exploded') })
  assert.equal(record.status, 'failed')
  assert.equal(record.error, 'model exploded')
  assert.equal(registry.stats().running, 0)
})

test('concurrency is capped and the rest queue', async () => {
  const registry = new SubAgentRegistry(2)
  let running = 0
  let peak = 0
  const jobs = Array.from({ length: 5 }, (_, index) => registry.spawn({ prompt: `job ${index}` }, async () => {
    running++
    peak = Math.max(peak, running)
    await tick()
    running--
    return `done ${index}`
  }))
  const records = await Promise.all(jobs)
  assert.equal(peak, 2, `expected at most 2 concurrent children, saw ${peak}`)
  assert.deepEqual(records.map((record) => record.status), ['done', 'done', 'done', 'done', 'done'])
})

test('cancel aborts the child and marks it cancelled, not failed', async () => {
  const registry = new SubAgentRegistry(1)
  let started = false
  const pending = registry.spawn({ prompt: 'long job' }, async (signal) => {
    started = true
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 500)
      signal.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(new Error('aborted'))
      })
    })
    return 'never'
  })
  while (!started) await tick()
  const [record] = registry.list()
  assert.equal(registry.cancel(record.id), true)
  const settled = await pending
  assert.equal(settled.status, 'cancelled')
  assert.equal(settled.error, undefined, 'a cancellation is not an error')
})

test('cancelling an unknown id is a no-op, not a crash', () => {
  const registry = new SubAgentRegistry(1)
  assert.equal(registry.cancel('nope'), false)
})

test('the registry does not grow without bound', async () => {
  const registry = new SubAgentRegistry(1)
  for (let index = 0; index < 80; index++) {
    await registry.spawn({ prompt: `p${index}` }, async () => 'ok')
  }
  assert.ok(registry.list().length <= 64, `kept ${registry.list().length} records`)
})

test('runTeam keeps the failures alongside the successes', async () => {
  const registry = new SubAgentRegistry(3)
  const records = await runTeam(registry, [{ prompt: 'a' }, { prompt: 'b' }, { prompt: 'c' }], async (spec) => {
    if (spec.prompt === 'b') throw new Error('b failed')
    return `${spec.prompt} ok`
  })
  assert.deepEqual(records.map((record) => record.status), ['done', 'failed', 'done'])
  assert.equal(records[1].error, 'b failed')
})
