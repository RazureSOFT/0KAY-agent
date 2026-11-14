import test from 'node:test'
import assert from 'node:assert/strict'
import { ReconGraph } from '../../analysis/recon/graph.js'
import { TraceStore } from '../../analysis/recon/traces.js'
import { RecordFactTool, InsertAssetsTool, AddIntentTool, ProveGoalTool, GoalMetTool, SetConstraintsTool, GraphOverviewTool, SearchAllWorkerTracesTool, KillWorkTool, AddCompanyScopeTool, GetWorkerOutputTool, ListWorkerTracesTool } from './recon_ops.js'
import type { ToolContext } from '../types.js'

// The RECON tool surface runs on a run context (graph + traces + live
// constraints). These tests pin the 1:1 semantics: batch writes with intent
// linkage, asset anchoring, evidence-gated proofs, and the global finish.

function contextWith(graph: ReconGraph, traces: TraceStore = new TraceStore(), constraints?: string[]): ToolContext {
  return { reconRun: { graph, traces, ...(constraints ? { constraints } : {}) }, cwd: process.cwd(), taskId: 't', agentType: 'general' } as unknown as ToolContext
}

test('record_fact writes a fact linked to the intent, batch mode included', async () => {
  const graph = new ReconGraph()
  const intent = graph.addNode({ kind: 'intent', text: 'probe the api', assets: ['api.example.com'] })
  const tool = new RecordFactTool()
  const single = await tool.execute({ intent_id: intent.id, summary: 'api speaks json', detail: 'POST /auth works', evidence: 'curl -X POST → 200 {"token"}', confidence: 'observed', asset_ids: ['api.example.com'] }, contextWith(graph))
  assert.equal(single.success, true)
  const factId = (single.data as any).ids[0]
  const fact = graph.node(factId)!
  assert.equal(fact.kind, 'fact')
  assert.ok(fact.text.includes('api speaks json'))
  assert.ok(fact.text.includes('证据: curl'))
  assert.deepEqual(fact.derivedFrom, [intent.id], 'provenance reaches the intent')
  assert.ok(fact.assetIds.length, 'the asset anchor landed')

  const batch = await tool.execute({ intent_id: intent.id, facts: [{ summary: 'a' }, { summary: 'b' }] }, contextWith(graph))
  assert.equal((batch.data as any).ids.length, 2)
})

test('insert_assets anchors discovered assets to the intent', async () => {
  const graph = new ReconGraph()
  const intent = graph.addNode({ kind: 'intent', text: 'probe the edge' })
  const tool = new InsertAssetsTool()
  const result = await tool.execute({ intent_id: intent.id, assets: ['https://admin.example.com/login', '10.0.0.9:8080'] }, contextWith(graph))
  assert.equal((result.data as any).ids.length, 2)
  const kinds = graph.toJSON().assets.map((asset) => asset.kind)
  assert.ok(kinds.includes('endpoint') && kinds.includes('service'))
  assert.ok(intent.assetIds.length >= 2, 'the anchor reached the intent node')
})

test('add_intent anchors to existing facts only, batch mode included', async () => {
  const graph = new ReconGraph()
  const fact = graph.addNode({ kind: 'fact', text: 'login accepts POST', assets: ['api.example.com'] })
  const tool = new AddIntentTool()
  const result = await tool.execute({
    intents: [
      { summary: 'try default creds', assets: ['api.example.com'], parent_ids: [fact.id], priority: 8 },
      { summary: 'orphan direction' },
    ],
  }, contextWith(graph))
  const ids = (result.data as any).ids as string[]
  assert.equal(ids.length, 2)
  assert.deepEqual(graph.node(ids[0])!.derivedFrom, [fact.id], 'anchored to the confirmed fact')
  assert.equal(graph.node(ids[0])!.priority, 8)
  assert.equal(graph.node(ids[1])!.derivedFrom.length, 1, 'parentless intents hang off origin')
})

test('prove_goal marks met and the last one closes the task; goal_met closes globally', async () => {
  const graph = new ReconGraph()
  const asset = graph.addAsset('api.example.com')
  const goalA = graph.addNode({ kind: 'goal', text: 'goal a', assets: ['api.example.com'] })
  const goalB = graph.addNode({ kind: 'goal', text: 'goal b', assets: ['api.example.com'] })
  const finding = graph.addNode({ kind: 'finding', text: 'auth bypass', assets: ['api.example.com'] })
  const tool = new ProveGoalTool()
  const first = await tool.execute({ goal_id: goalA.id, evidence_id: finding.id }, contextWith(graph))
  assert.equal(graph.node(goalA.id)!.status, 'met')
  assert.equal((first.data as any).note, undefined, 'the task is not over while a goal is open')
  const second = await tool.execute({ goal_id: goalB.id, evidence_id: finding.id }, contextWith(graph))
  assert.ok((second.data as any).note, 'the last proven goal announces completion')

  const graph2 = new ReconGraph()
  graph2.addNode({ kind: 'goal', text: 'the only goal', assets: ['x.com'] })
  const met = new GoalMetTool()
  const closed = await met.execute({ reason: 'all flags captured' }, contextWith(graph2))
  assert.equal(closed.success, true)
  assert.equal(graph2.toJSON().nodes.filter((node) => node.kind === 'goal' && node.status === 'met').length, 1)
})

test('set_constraints mutates the live constraints array the planner reads', async () => {
  const graph = new ReconGraph()
  const constraints: string[] = []
  const tool = new SetConstraintsTool()
  const result = await tool.execute({ constraints: ['no port scanning', 'read-only on prod'] }, contextWith(graph, new TraceStore(), constraints))
  assert.equal(result.success, true)
  assert.deepEqual(constraints, ['no port scanning', 'read-only on prod'])
})

test('graph_overview and trace search answer from the run context', async () => {
  const graph = new ReconGraph()
  graph.addAsset('example.com')
  const traces = new TraceStore()
  traces.record({ intentId: 'i1', worker: 'w', action: 'sqlmap', detail: 'GET /item?id=1 → 500', ok: true })
  const context = contextWith(graph, traces)
  const overview = await new GraphOverviewTool().execute({}, context)
  assert.equal((overview.data as any).assetsByKind.root_domain, 1)
  const search = await new SearchAllWorkerTracesTool().execute({ q: 'sqlmap' }, context)
  assert.equal((search.data as any).hits.length, 1)
})

test('kill_work stops an open intent', async () => {
  const graph = new ReconGraph()
  const intent = graph.addNode({ kind: 'intent', text: 'runaway' })
  await new KillWorkTool().execute({ intent_id: intent.id }, contextWith(graph))
  assert.equal(graph.node(intent.id)!.status, 'stopped')
})

test('without a run context the tools fail with a pointer to the fallback', async () => {
  const result = await new RecordFactTool().execute({ summary: 'x' }, { cwd: process.cwd(), taskId: 't', agentType: 'general' } as unknown as ToolContext)
  assert.equal(result.success, false)
  assert.match(result.error || '', /run context unavailable/)
})

test('add_company_scope claims assets for an owner and puts that owner in scope', async () => {
  const graph = new ReconGraph()
  const tool = new AddCompanyScopeTool()
  const result = await tool.execute({
    company: 'Acme',
    assets: ['https://api.acme.test/login', 'acme.test', '10.9.0.0/24'],
  }, contextWith(graph))
  assert.equal(result.success, true, result.error)
  const data = result.data as any
  assert.equal(data.claimed, 2, 'domains and URLs are assets')
  assert.deepEqual(data.cidrs, ['10.9.0.0/24'], 'a CIDR range is a scope entry, not an asset')
  assert.ok(data.scope.includes('company:Acme'), 'the owner became a scope row')
  assert.ok(data.scope.some((row: string) => row.endsWith('10.9.0.0/24')), 'the range is in scope too')
  const owned = graph.toJSON().assets.filter((asset) => asset.company === 'Acme')
  assert.ok(owned.length >= 2, 'the tag reached the assets')
  assert.equal(graph.coverage().scope.denominator >= 1, true, 'scope has a denominator')
})

test('get_worker_output reports what an intent produced and how it ended', async () => {
  const graph = new ReconGraph()
  const traces = new TraceStore()
  const intent = graph.addNode({ kind: 'intent', text: 'probe the api', assets: ['api.acme.test'] })
  const fact = graph.addNode({ kind: 'fact', text: 'the api answers json', assets: ['api.acme.test'], derivedFrom: [intent.id] })
  graph.addNode({ kind: 'fact', text: 'unrelated', derivedFrom: [] })
  traces.record({ intentId: intent.id, worker: 'w1', action: 'curl', detail: 'POST /auth → 200', ok: true })
  const tool = new GetWorkerOutputTool()

  const result = await tool.execute({ intentId: intent.id }, contextWith(graph, traces))
  assert.equal(result.success, true, result.error)
  const data = result.data as any
  assert.equal(data.steps, 1)
  assert.equal(data.lastStep.action, 'curl')
  assert.deepEqual(data.produced.map((node: any) => node.id), [fact.id])

  const empty = await tool.execute({ intentId: 'i_missing' }, contextWith(graph, traces))
  assert.equal(empty.success, true)
  assert.match((empty.data as any).note, /no execution trace/)
})

test('list_worker_traces returns an index, or the steps of one intent', async () => {
  const graph = new ReconGraph()
  const traces = new TraceStore()
  const intent = graph.addNode({ kind: 'intent', text: 'probe' })
  traces.record({ intentId: intent.id, worker: 'w1', action: 'nmap', detail: '22/tcp open', ok: true })
  traces.record({ intentId: intent.id, worker: 'w1', action: 'curl', detail: '200', ok: true })
  const tool = new ListWorkerTracesTool()

  const index = await tool.execute({}, contextWith(graph, traces))
  assert.equal((index.data as any).intents, 1)
  assert.equal((index.data as any).entries[0].steps, 2)

  const steps = await tool.execute({ intentId: intent.id, limit: 1 }, contextWith(graph, traces))
  assert.equal((steps.data as any).steps, 1)
  assert.equal((steps.data as any).entries[0].action, 'curl', 'the limit keeps the newest step')
})
