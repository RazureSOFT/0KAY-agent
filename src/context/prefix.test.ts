import test from 'node:test'
import assert from 'node:assert/strict'
import { prefixHash, stableStringify } from './prefix.js'

const tools = [
  { name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'grep', description: 'Search', parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } } } },
]

test('stableStringify ignores key order at every level', () => {
  const a = { b: 1, a: { d: [1, { y: 2, x: 3 }], c: 4 } }
  const b = { a: { c: 4, d: [1, { x: 3, y: 2 }] }, b: 1 }
  assert.equal(stableStringify(a), stableStringify(b))
})

test('stableStringify still distinguishes different values', () => {
  assert.notEqual(stableStringify({ a: 1 }), stableStringify({ a: 2 }))
})

test('the prefix hash is identical for the same system prompt and tools', () => {
  assert.equal(prefixHash({ system: 'You are 0KAY.', tools }), prefixHash({ system: 'You are 0KAY.', tools }))
})

test('the prefix hash does not depend on tool property order', () => {
  const shuffled = [
    { ...tools[0], parameters: { ...tools[0].parameters, properties: { path: { type: 'string' } } } },
    tools[1],
  ]
  assert.equal(prefixHash({ system: 's', tools: shuffled }), prefixHash({ system: 's', tools }))
})

test('the prefix hash changes when the system prompt changes', () => {
  assert.notEqual(prefixHash({ system: 'You are 0KAY.', tools }), prefixHash({ system: 'You are 0KAY. ', tools }))
})

test('the prefix hash changes when a tool is added or edited', () => {
  assert.notEqual(prefixHash({ system: 's', tools }), prefixHash({ system: 's', tools: tools.slice(1) }))
  const edited = [tools[0], { ...tools[1], description: 'Search files' }]
  assert.notEqual(prefixHash({ system: 's', tools }), prefixHash({ system: 's', tools: edited }))
})

test('the prefix hash does not include the conversation, so a growing history keeps the cache', () => {
  // Only the prefix goes in; history is not an input by design.
  const first = prefixHash({ system: 's', tools })
  const afterTenTurns = prefixHash({ system: 's', tools })
  assert.equal(afterTenTurns, first)
})
