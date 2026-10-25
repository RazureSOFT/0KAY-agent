import test from 'node:test'
import assert from 'node:assert/strict'
import { ReconGraph, classify } from './graph.js'

// The graph decides what a raw observation is, so the classifier carries most of
// the risk: a wrong parent makes the tree lie about what a target is.

test('a URL path is an endpoint, and its parent is the service', () => {
  const result = classify('https://a.example.com/login')
  assert.equal(result.kind, 'endpoint')
  assert.equal(result.key, 'https://a.example.com/login')
  assert.equal(result.parentKey, 'a.example.com:443')
})

test('a bare origin is a service, not an endpoint', () => {
  const result = classify('https://a.example.com')
  assert.equal(result.kind, 'service')
  assert.equal(result.key, 'a.example.com:443')
})

test('host:port is a service over an IP or a subdomain', () => {
  const overIp = classify('10.0.0.5:8443')
  assert.equal(overIp.kind, 'service')
  assert.equal(overIp.parentKey, '10.0.0.5')
  assert.equal(overIp.parentKind, 'ip')

  const overHost = classify('api.example.com:443')
  assert.equal(overHost.kind, 'service')
  assert.equal(overHost.parentKey, 'api.example.com')
  assert.equal(overHost.parentKind, 'subdomain')
})

test('hostnames split into a registrable domain and its subdomains', () => {
  assert.equal(classify('example.com').kind, 'root_domain')
  assert.equal(classify('api.example.com').kind, 'subdomain')
  assert.equal(classify('api.example.com').parentKey, 'example.com')
  assert.equal(classify('a.b.example.com').parentKey, 'b.example.com')
})

test('an out-of-range port is refused rather than stored', () => {
  assert.throws(() => classify('example.com:99999'), /port out of range/)
})

test('nonsense is refused', () => {
  assert.throws(() => classify('not an asset at all'), /cannot classify/)
})

test('adding a child adds the parents it needs', () => {
  const graph = new ReconGraph()
  const endpoint = graph.addAsset('https://api.example.com/users')
  const json = graph.toJSON()
  assert.equal(json.assets.length, 4, 'endpoint, service, subdomain, root domain')
  const service = json.assets.find((asset) => asset.kind === 'service')
  assert.equal(endpoint.parentId, service?.id)
  const subdomain = json.assets.find((asset) => asset.kind === 'subdomain')
  assert.equal(service?.parentId, subdomain?.id)
})

test('the same asset submitted twice is stored once', () => {
  const graph = new ReconGraph()
  const first = graph.addAsset('https://api.example.com/users')
  const second = graph.addAsset('https://api.example.com/users')
  assert.equal(first.id, second.id)
  assert.equal(graph.toJSON().assets.filter((asset) => asset.kind === 'endpoint').length, 1)
})

test('coverage counts facts, not intentions', () => {
  const graph = new ReconGraph()
  graph.addAsset('example.com')
  graph.addAsset('api.example.com')

  graph.addNode({ kind: 'intent', text: 'try the login form', assets: ['api.example.com'] })
  assert.equal(graph.coverage().tested, 0, 'an open intent has not tested anything')

  graph.addNode({ kind: 'fact', text: 'login accepts POST with json', assets: ['api.example.com'] })
  const coverage = graph.coverage()
  assert.equal(coverage.tested, 1)
  assert.deepEqual(coverage.untested.map((asset) => asset.key), ['example.com'])
})

test('history answers "what have we tried against this asset"', () => {
  const graph = new ReconGraph()
  const intent = graph.addNode({ kind: 'intent', text: 'fuzz the parameter', assets: ['https://a.example.com/q'] })
  graph.complete(intent.id, 'done')
  graph.addNode({ kind: 'finding', text: 'reflected XSS in q', assets: ['https://a.example.com/q'] })

  const asset = graph.addAsset('https://a.example.com/q')
  const history = graph.history(asset.id)
  assert.equal(history.length, 2)
  assert.deepEqual(history.map((node) => node.kind), ['intent', 'finding'])
  assert.equal(history[0].status, 'done')
})

test('provenance survives the round trip', () => {
  const graph = new ReconGraph()
  const fact = graph.addNode({ kind: 'fact', text: 'server is nginx 1.24', assets: ['a.example.com'] })
  const finding = graph.addNode({ kind: 'finding', text: 'CVE-2023-44487', assets: ['a.example.com'], derivedFrom: [fact.id] })
  assert.deepEqual(finding.derivedFrom, [fact.id])
  assert.ok(graph.toJSON().nodes.some((node) => node.id === finding.id && node.derivedFrom.includes(fact.id)))
})

test('overview is the whole situation in one call', () => {
  const graph = new ReconGraph()
  graph.addAsset('api.example.com')
  const goal = graph.addNode({ kind: 'goal', text: 'find auth bypass', assets: ['api.example.com'] })
  graph.addNode({ kind: 'intent', text: 'try default creds', assets: ['api.example.com'] })
  graph.addNode({ kind: 'fact', text: 'login is at /auth', assets: ['api.example.com'] })

  const overview = graph.overview()
  assert.equal(overview.coverage.total, 2)
  assert.equal(overview.coverage.tested, 1)
  assert.equal(overview.openIntents.length, 1)
  assert.equal(overview.recent[0].text, 'login is at /auth')
  assert.deepEqual(overview.goals.map((entry) => entry.id), [goal.id])
  assert.equal(overview.assetsByKind.root_domain, 1)
})

test('a goal cannot be proven without a finding anchored to it', () => {
  const graph = new ReconGraph()
  const goal = graph.addNode({ kind: 'goal', text: 'prove the login is bypassable', assets: ['api.example.com'] })
  graph.addNode({ kind: 'fact', text: 'login is at /auth', assets: ['api.example.com'] })
  assert.throws(() => graph.prove(goal.id), /no finding is anchored/)

  graph.addNode({ kind: 'finding', text: 'auth bypass with empty password', assets: ['api.example.com'] })
  const proven = graph.prove(goal.id)
  assert.equal(proven.status, 'met')
})

test('proving a node that is not a goal is refused', () => {
  const graph = new ReconGraph()
  const fact = graph.addNode({ kind: 'fact', text: 'x', assets: ['api.example.com'] })
  assert.throws(() => graph.prove(fact.id), /is not a goal/)
  assert.throws(() => graph.prove('nope'), /unknown node/)
})

test('an intent nobody discovered hangs off the origin fact', () => {
  const graph = new ReconGraph()
  const intent = graph.addNode({ kind: 'intent', text: 'port scan the edge' })
  assert.equal(intent.derivedFrom.length, 1, 'provenance must reach a root')
  const origin = graph.node(intent.derivedFrom[0])!
  assert.equal(origin.kind, 'fact')
  assert.equal(origin.status, 'origin')
  assert.equal(graph.coverage().tested, 0, 'the origin fact tests nothing')
})

test('scope turns coverage into a fraction of the target, not of everything seen', () => {
  const graph = new ReconGraph()
  graph.setScope(['example.com', '192.168.8.0/24'])
  graph.addAsset('api.example.com')
  graph.addAsset('other.example.net')
  graph.addAsset('192.168.8.7')
  graph.addAsset('192.168.9.7')

  const before = graph.coverage()
  assert.equal(before.scope.rows, 2)
  // api.example.com, its auto-added root example.com, and the in-range ip.
  assert.equal(before.scope.denominator, 3)
  assert.equal(before.scope.pct, 0)

  graph.addNode({ kind: 'fact', text: 'dns resolves', assets: ['api.example.com'] })
  const after = graph.coverage()
  assert.equal(after.tested, 1)
  assert.equal(after.scope.pct, 33.3)
  assert.deepEqual(after.untested.map((asset) => asset.key), ['example.com', '192.168.8.7'])
})

test('a cidr scope matches the ip behind a service', () => {
  const graph = new ReconGraph()
  graph.setScope(['10.0.0.0/30'])
  graph.addAsset('10.0.0.1:443')
  assert.equal(graph.coverage().scope.denominator, 2, 'the service and its ip are both in range')
  graph.addAsset('10.0.0.5:443')
  assert.equal(graph.coverage().scope.denominator, 2, 'the second service is out of range')
})

test('the coverage gate refuses to prove a goal on an untested scope', () => {
  const graph = new ReconGraph()
  graph.setScope(['example.com'])
  graph.addAsset('a.example.com')
  graph.addAsset('b.example.com')
  const goal = graph.addNode({ kind: 'goal', text: 'own the domain', assets: ['a.example.com'] })
  graph.addNode({ kind: 'finding', text: 'panel creds in html', assets: ['a.example.com'] })

  // three assets in scope (a, b, and the auto-added root), one tested.
  assert.throws(() => graph.prove(goal.id, undefined, 80), /coverage gate: 33\.3%.*80%/)
  const proven = graph.prove(goal.id, undefined, 30)
  assert.equal(proven.status, 'met')
})

test('a digest folds finished work and is superseded when a member moves', () => {
  const graph = new ReconGraph()
  const first = graph.addNode({ kind: 'intent', text: 'probe /admin', assets: ['a.example.com'] })
  graph.setStatus(first.id, 'done')
  const fact = graph.addNode({ kind: 'fact', text: '/admin is gone', assets: ['a.example.com'], derivedFrom: [first.id] })
  const second = graph.addNode({ kind: 'intent', text: 're-check /admin', assets: ['a.example.com'] })

  assert.throws(() => graph.digest('too small', [first.id]), /at least two/)
  const digest = graph.digest('the /admin thread was probed and closed', [first.id, fact.id])
  assert.equal(digest.kind, 'digest')
  assert.equal(graph.digests()[0].memberIds.length, 2)

  graph.setStatus(second.id, 'done')
  assert.equal(graph.digests().length, 1, 'unrelated work does not touch the digest')
  graph.setStatus(first.id, 'paused')
  assert.equal(graph.digests().length, 0, 'a member coming back to life supersedes the digest')
  assert.equal(graph.node(digest.id)!.status, 'superseded')
})

test('statuses are validated per kind, and the legacy words still close a node', () => {
  const graph = new ReconGraph()
  const intent = graph.addNode({ kind: 'intent', text: 'x' })
  assert.throws(() => graph.setStatus(intent.id, 'met' as any), /invalid status/)
  graph.complete(intent.id, 'failed')
  assert.equal(graph.node(intent.id)!.status, 'blocked')

  const fact = graph.addNode({ kind: 'fact', text: 'y' })
  assert.equal(fact.status, 'confirmed')
  graph.complete(fact.id, 'failed')
  assert.equal(graph.node(fact.id)!.status, 'dismissed')

  const goal = graph.addNode({ kind: 'goal', text: 'z' })
  graph.complete(goal.id, 'done')
  assert.equal(graph.node(goal.id)!.status, 'met')
})

test('the frontier is priority first, then oldest', () => {
  const graph = new ReconGraph()
  const low = graph.addNode({ kind: 'intent', text: 'low', priority: 2 })
  const high = graph.addNode({ kind: 'intent', text: 'high', priority: 9 })
  const defaultPriority = graph.addNode({ kind: 'intent', text: 'default' })
  assert.deepEqual(graph.frontier().map((node) => node.id), [high.id, defaultPriority.id, low.id])
  graph.setStatus(high.id, 'paused')
  assert.deepEqual(graph.frontier().map((node) => node.id), [defaultPriority.id, low.id], 'paused work leaves the queue')
  graph.setStatus(high.id, 'open')
  graph.setStatus(high.id, 'stopped')
  assert.equal(graph.frontier().length, 2, 'stopped work never returns')
})

test('a graph survives serialization, including an old export without edges', () => {
  const graph = new ReconGraph()
  graph.setScope(['example.com'])
  const intent = graph.addNode({ kind: 'intent', text: 'enumerate', assets: ['api.example.com'] })
  graph.setStatus(intent.id, 'done')
  const finding = graph.addNode({ kind: 'finding', text: 'open bucked', assets: ['api.example.com'], derivedFrom: [intent.id] })
  const goal = graph.addNode({ kind: 'goal', text: 'find one hole', assets: ['api.example.com'] })
  graph.prove(goal.id, finding.id)

  const restored = ReconGraph.fromJSON(JSON.parse(JSON.stringify(graph.toJSON())))
  assert.equal(restored.coverage().tested, 1)
  assert.equal(restored.scope().length, 1)
  assert.equal(restored.node(goal.id)!.status, 'met')
  assert.ok(restored.edgesOut().some((edge) => edge.rel === 'proves' && edge.dst === goal.id))
  const next = restored.addNode({ kind: 'intent', text: 'carry on' })
  assert.notEqual(next.id, intent.id, 'id sequence must continue after the restore')
})

test('a v1 export (no edges, old status words) is translated, not rejected', () => {
  const restored = ReconGraph.fromJSON({
    assets: [{ id: 'a_1', kind: 'root_domain', key: 'example.com', raw: 'example.com', createdAt: '2026-01-01T00:00:00.000Z' }],
    nodes: [
      { id: 'i_1', kind: 'intent', text: 'old intent', status: 'failed', assetIds: ['a_1'], derivedFrom: [], createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'n_2', kind: 'fact', text: 'old observation', status: 'done', assetIds: ['a_1'], derivedFrom: ['i_1'], createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'n_1', kind: 'goal', text: 'old goal', status: 'done', assetIds: ['a_1'], derivedFrom: [], createdAt: '2026-01-01T00:00:00.000Z' },
    ],
  } as any)
  assert.equal(restored.node('n_1')!.status, 'met')
  assert.equal(restored.node('i_1')!.status, 'blocked')
  assert.equal(restored.node('n_2')!.status, 'confirmed')
  assert.ok(restored.edgesOut().some((edge) => edge.rel === 'yields' && edge.src === 'i_1'), 'edges are rebuilt from provenance')
})

test('garbage is refused at the restore boundary', () => {
  assert.throws(() => ReconGraph.fromJSON({ assets: 'nope' } as any), /not a serialized recon graph/)
})
