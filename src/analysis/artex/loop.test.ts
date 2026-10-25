import test from 'node:test'
import assert from 'node:assert/strict'
import { ReconGraph } from './graph.js'
import { makeWorker } from './loop.js'

// The sub-agent worker is the real executor: its brief must carry the intent,
// the scope, the graph write-back protocol, and — for a re-queued intent —
// what the direction already produced.

test('the sub-agent brief is tool-first and carries the write-back protocol', async () => {
  const graph = new ReconGraph()
  let brief = ''
  const worker = makeWorker({ llm: async () => null, subagent: async (prompt) => { brief = prompt; return '{"steps":[],"note":"done"}' } }, {
    objective: 'find one hole',
    scopeLine: 'Scope (never leave it): example.com',
    constraints: ['no DoS'],
    fallbackAssets: ['example.com'],
    graph,
  })
  await worker({ text: 'probe the login form', assets: ['example.com'] }, {} as any)
  assert.ok(brief.includes('record_fact') && brief.includes('insert_assets'), 'the write-back protocol is the contract')
  assert.ok(brief.includes('probe the login form'))
  assert.ok(brief.includes('Scope (never leave it): example.com'))
  assert.ok(brief.includes('Constraints: no DoS'))
  assert.ok(brief.includes('唯一职责'), 'the single-mandate boundary is stated')
})

test('a re-queued intent carries what it already produced', async () => {
  const graph = new ReconGraph()
  const intent = graph.addNode({ kind: 'intent', text: 'probe the login form', assets: ['api.example.com'] })
  graph.addNode({ kind: 'fact', text: 'login accepts POST /auth', assets: ['api.example.com'], derivedFrom: [intent.id] })

  let brief = ''
  const worker = makeWorker({ llm: async () => null, subagent: async (prompt) => { brief = prompt; return '{}' } }, {
    objective: 'find one hole',
    scopeLine: 'Scope (never leave it): example.com',
    constraints: [],
    fallbackAssets: ['example.com'],
    graph,
  })
  await worker({ id: intent.id, text: 'probe the login form' }, {} as any)
  assert.ok(brief.includes('已产出'), 'resume context is present')
  assert.ok(brief.includes('login accepts POST /auth'))
})

test('a worker without a subagent host falls back to the JSON protocol', async () => {
  const worker = makeWorker({ llm: async () => '{"facts":[{"text":"saw it"}],"note":"ok"}' }, {
    objective: 'find one hole',
    scopeLine: 'Scope (never leave it): example.com',
    constraints: [],
    fallbackAssets: ['example.com'],
  })
  const result = await worker({ text: 'probe' }, {} as any)
  assert.equal(result.facts?.length, 1)
  assert.equal(result.note, 'ok')
})
