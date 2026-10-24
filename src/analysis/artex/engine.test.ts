import test from 'node:test'
import assert from 'node:assert/strict'
import { Plan } from './plan.js'
import { TraceStore } from './traces.js'
import { ReconGraph } from './graph.js'
import { ReconEngine } from './engine.js'

// The plan exists because every planner wake-up is a fresh conversation. These
// tests are about order surviving that amnesia.

test('a step with unmet dependencies is not ready', () => {
  const plan = new Plan()
  const first = plan.add('find the injection point')
  const second = plan.add('get credentials', [first.id])
  assert.deepEqual(plan.ready().map((step) => step.text), ['find the injection point'])
  assert.equal(second.status, 'pending')
})

test('completing a step releases the next one', () => {
  const plan = new Plan()
  const first = plan.add('find the injection point')
  const second = plan.add('get credentials', [first.id])
  plan.complete(first.id)
  assert.deepEqual(plan.ready().map((step) => step.text), ['get credentials'])
  assert.equal(second.status, 'ready')
})

test('skipping counts as done for the steps behind it', () => {
  const plan = new Plan()
  const first = plan.add('try the legacy API')
  const second = plan.add('pivot through it', [first.id])
  plan.skip(first.id, 'endpoint is gone')
  assert.equal(second.status, 'ready')
  assert.equal(plan.isComplete(), false)
})

test('a dependency on a step that does not exist is refused', () => {
  const plan = new Plan()
  assert.throws(() => plan.add('orphan', ['s99']), /unknown step/)
})

test('setAll keeps the status of steps whose text survived', () => {
  const plan = new Plan()
  const step = plan.add('enumerate endpoints')
  plan.complete(step.id)
  const next = plan.setAll([{ text: 'enumerate endpoints' }, { text: 'test auth', needs: [] }])
  assert.equal(next[0].status, 'done')
  assert.equal(next[1].status, 'ready')
})

test('the plan is complete only when nothing is left to do', () => {
  const plan = new Plan()
  const only = plan.add('one thing')
  assert.equal(plan.isComplete(), false)
  plan.complete(only.id)
  assert.equal(plan.isComplete(), true)
})

test('traces are searchable across workers, excluding your own', () => {
  const traces = new TraceStore()
  traces.record({ intentId: 'i1', worker: 'w1', action: 'sqlmap', detail: 'GET /item?id=1 returned 500', ok: true })
  traces.record({ intentId: 'i2', worker: 'w2', action: 'nmap', detail: 'port 22 open', ok: true })

  const hits = traces.search('id=1')
  assert.equal(hits.length, 1)
  assert.equal(hits[0].intentId, 'i1')

  const own = traces.search('id=1', { excludeIntent: 'i1' })
  assert.deepEqual(own, [])
})

test('a trace search with no query returns nothing rather than everything', () => {
  const traces = new TraceStore()
  traces.record({ intentId: 'i1', worker: 'w1', action: 'x', detail: 'y', ok: true })
  assert.deepEqual(traces.search('   '), [])
})

test('trace list and get answer the two follow-up questions', () => {
  const traces = new TraceStore()
  traces.record({ intentId: 'i1', worker: 'w1', action: 'curl', detail: '/login', ok: true })
  traces.record({ intentId: 'i1', worker: 'w1', action: 'curl', detail: '/admin', ok: false })
  traces.record({ intentId: 'i2', worker: 'w2', action: 'nmap', detail: 'top ports', ok: true })

  const list = traces.list()
  assert.equal(list.length, 2)
  assert.equal(list.find((entry) => entry.intentId === 'i1')?.steps, 2)
  assert.equal(traces.get('i1').length, 2)
  assert.equal(traces.get('i1', [0]).length, 1)
})

const engineFor = (options = {}) => {
  const graph = new ReconGraph()
  const plan = new Plan()
  const traces = new TraceStore()
  return { graph, plan, traces, engine: new ReconEngine(graph, plan, traces, options) }
}

test('a planner with nothing to say ends the run', async () => {
  const { graph, plan, traces, engine } = engineFor()
  graph.addAsset('example.com')
  const report = await engine.run(async () => [], async () => ({}))
  assert.equal(report.stopped, 'planner-idle')
  assert.equal(report.rounds, 1)
  assert.equal(report.intents, 0)
  assert.ok(traces.size === 0 && plan.state().total === 0)
})

test('findings and facts land in the graph with provenance', async () => {
  const { graph, engine } = engineFor()
  graph.addAsset('https://a.example.com/login')
  let round = 0
  const report = await engine.run(
    async () => (round++ === 0 ? [{ text: 'probe login', assets: ['https://a.example.com/login'] }] : []),
    async () => ({
      facts: [{ text: 'login accepts POST' }],
      findings: [{ text: 'auth bypass with empty password' }],
      steps: [{ action: 'curl', detail: 'POST /login {}', ok: true }],
    }),
  )
  assert.equal(report.facts, 1)
  assert.equal(report.findings, 1)
  assert.equal(report.stopped, 'planner-idle')
  const nodes = graph.toJSON().nodes
  const finding = nodes.find((node) => node.kind === 'finding')
  assert.ok(finding?.derivedFrom.length, 'a finding must point at the intent that produced it')
  assert.equal(report.coverage.tested, 1)
})

test('a round that changes nothing stops the run instead of looping', async () => {
  const { graph, engine } = engineFor({ maxRounds: 10 })
  graph.addAsset('example.com')
  let calls = 0
  const report = await engine.run(
    async () => { calls += 1; return [{ text: 'same idea again', assets: ['example.com'] }] },
    async () => ({ note: 'nothing found' }),
  )
  assert.equal(report.stopped, 'no-progress')
  assert.equal(calls, 1, 'it must not ask a second time after a round that produced nothing')
})

test('the intent budget is respected even when the planner keeps talking', async () => {
  const { graph, engine } = engineFor({ maxIntents: 3, maxRounds: 10 })
  graph.addAsset('example.com')
  const report = await engine.run(
    async () => [{ text: 'a', assets: ['example.com'] }, { text: 'b', assets: ['example.com'] }, { text: 'c', assets: ['example.com'] }, { text: 'd' }],
    async (intent) => ({ facts: [{ text: `fact for ${intent.text}` }] }),
  )
  assert.equal(report.intents, 3)
  assert.equal(report.stopped, 'budget')
})

test('a goal is proved once evidence lands, and the run stops', async () => {
  const { graph, plan, traces } = engineFor()
  graph.addAsset('https://a.example.com/login')
  const goal = graph.addNode({ kind: 'goal', text: 'prove the login is bypassable', assets: ['https://a.example.com/login'] })
  const engine = new ReconEngine(graph, plan, traces, { goalId: goal.id, maxRounds: 5 })
  const report = await engine.run(
    async () => [{ text: 'try empty password', assets: ['https://a.example.com/login'] }],
    async () => ({ findings: [{ text: 'auth bypass with empty password' }] }),
  )
  assert.equal(report.proven, true)
  assert.equal(report.stopped, 'goal-proven')
})

test('a worker that throws is a failed intent, not a dead run', async () => {
  const { graph, engine } = engineFor({ maxIntents: 2 })
  graph.addAsset('example.com')
  let round = 0
  const report = await engine.run(
    async () => (round++ === 0 ? [{ text: 'explode', assets: ['example.com'] }] : [{ text: 'retry differently', assets: ['example.com'] }]),
    async (intent) => {
      if (intent.text === 'explode') throw new Error('tool crashed')
      return { facts: [{ text: 'second attempt worked' }] }
    },
  )
  assert.equal(report.intents, 2)
  assert.equal(report.facts, 1)
  assert.equal(report.stopped, 'budget')
  const intents = graph.toJSON().nodes.filter((node) => node.kind === 'intent')
  assert.equal(intents[0].status, 'failed')
  assert.equal(intents[1].status, 'done')
})

test('plan progress alone counts as progress', async () => {
  const { graph, plan, traces } = engineFor({ maxRounds: 3 })
  graph.addAsset('example.com')
  const step = plan.add('enumerate endpoints')
  const engine = new ReconEngine(graph, plan, traces, { maxRounds: 3 })
  let round = 0
  const report = await engine.run(
    async () => (round++ === 0 ? [{ text: 'list endpoints', stepId: step.id, assets: ['example.com'] }] : []),
    async () => ({ note: 'found three' }),
  )
  assert.equal(plan.state().done, 1)
  // The only step finished, so the plan is complete — that is the better reason
  // to stop than "the planner had nothing to say".
  assert.equal(report.stopped, 'plan-complete')
})
