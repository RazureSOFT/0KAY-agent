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
