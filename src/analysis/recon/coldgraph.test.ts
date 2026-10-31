import test from 'node:test'
import assert from 'node:assert/strict'
import { adjacency, hotSet, advanceColdStreaks, groupEligible, defaultColdParams } from './coldgraph.js'

// The cold judgement decides what gets folded away, so it must be conservative
// in exactly one direction: anything live work can still reach stays hot.

const nodes = (list: Array<[string, string, string]>) => list.map(([id, kind, status]) => ({ id, kind, status }))
const edges = (list: Array<[string, string, string]>) => list.map(([src, rel, dst]) => ({ src, rel, dst }))

const graph1 = {
  nodes: nodes([
    ['origin', 'fact', 'origin'],
    ['i1', 'intent', 'done'],
    ['f1', 'fact', 'confirmed'],
    ['i2', 'intent', 'open'],
    ['f2', 'fact', 'confirmed'],
  ]),
  edgeList: [
    ['i1', 'yields', 'f1'],
    ['origin', 'derived_from', 'i2'],
    ['f1', 'derived_from', 'i2'],
    ['i2', 'yields', 'f2'],
  ] as Array<[string, string, string]>,
}

test('everything upstream of a live intent stays hot, its direct children too', () => {
  const adj = adjacency(graph1.nodes, edges(graph1.edgeList))
  const hot = hotSet(graph1.nodes, adj)
  // i2 is live; origin and f1 feed it (f1 directly, i1 transitively through
  // f1), and f2 is its output. Nothing is cold in this shape: finished work
  // that a live direction was built on stays visible.
  assert.deepEqual([...hot].sort(), ['f1', 'f2', 'i1', 'i2', 'origin'])
})

test('a covers edge never makes anything hot — the digest view is not causality', () => {
  const adj = adjacency(graph1.nodes, edges([...graph1.edgeList, ['d1', 'covers', 'f1']]))
  const hot = hotSet(graph1.nodes, adj)
  assert.ok(!hot.has('d1'))
  assert.deepEqual([...hot].sort(), ['f1', 'f2', 'i1', 'i2', 'origin'])
})

test('a streak must survive R consecutive rounds before the node is eligible', () => {
  // A side branch: i1 produced f1 and nothing live was built on either.
  const side = {
    nodes: nodes([
      ['origin', 'fact', 'origin'],
      ['i1', 'intent', 'done'],
      ['f1', 'fact', 'confirmed'],
      ['i2', 'intent', 'open'],
      ['f2', 'fact', 'confirmed'],
    ]),
    edgeList: [
      ['i1', 'yields', 'f1'],
      ['origin', 'derived_from', 'i2'],
      ['i2', 'yields', 'f2'],
    ] as Array<[string, string, string]>,
  }
  const adj = adjacency(side.nodes, edges(side.edgeList))
  const streaks = new Map<string, number>()
  const params = { ...defaultColdParams(), R: 3 }

  advanceColdStreaks(side.nodes, hotSet(side.nodes, adj), streaks, params)
  advanceColdStreaks(side.nodes, hotSet(side.nodes, adj), streaks, params)
  assert.equal(streaks.get('i1'), 2)
  const eligible = advanceColdStreaks(side.nodes, hotSet(side.nodes, adj), streaks, params)
  assert.ok(eligible.has('i1'), 'three cold rounds in a row')
  assert.ok(eligible.has('f1'))
  assert.ok(!eligible.has('f2'), 'f2 is the live intent\u2019s output — hot, streak reset')
  assert.equal(streaks.get('f2'), undefined)
})

test('the origin fact and digests themselves never fold', () => {
  const list = nodes([
    ['origin', 'fact', 'origin'],
    ['d1', 'digest', 'active'],
    ['h1', 'hint', 'active'],
    ['g1', 'goal', 'open'],
  ])
  const streaks = new Map<string, number>()
  const eligible = advanceColdStreaks(list, new Set(), streaks, { R: 1, K: 2 })
  assert.equal(eligible.size, 0)
})

test('eligible nodes group into blocks along causal edges, singletons are left alone', () => {
  const adj = adjacency(
    nodes([
      ['a', 'intent', 'done'], ['b', 'fact', 'confirmed'], ['c', 'intent', 'done'],
      ['d', 'fact', 'confirmed'], ['e', 'intent', 'done'],
    ]),
    edges([['a', 'yields', 'b'], ['c', 'yields', 'd']]),
  )
  const eligible = new Set(['a', 'b', 'c', 'd', 'e'])
  const blocks = groupEligible(eligible, adj, { R: 6, K: 2 })
  assert.deepEqual(blocks.map((block) => block.sort()).sort(), [['a', 'b'], ['c', 'd']], 'e has no edges: singleton, dropped')
})
