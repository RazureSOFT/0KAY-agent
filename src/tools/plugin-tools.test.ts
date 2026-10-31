import test from 'node:test'
import assert from 'node:assert/strict'
import { planPluginTools } from './plugin-tools.js'

test('an uncontested name is registered as declared', () => {
  const plan = planPluginTools([{ plugin: 'life', name: 'remember' }])
  assert.equal(plan.register.length, 1)
  assert.equal(plan.register[0].name, 'remember')
  assert.equal(plan.register[0].renamed, false)
  assert.equal(plan.skipped.length, 0)
})

test('a name that collides with a built-in is namespaced instead of dropped', () => {
  const plan = planPluginTools([{ plugin: 'acme', name: 'read' }], ['read', 'write'])
  assert.equal(plan.register.length, 1)
  assert.equal(plan.register[0].name, 'acme.read')
  assert.equal(plan.register[0].declared, 'read')
  assert.equal(plan.register[0].renamed, true)
})

test('two plugins offering the same tool both survive', () => {
  const plan = planPluginTools([
    { plugin: 'alpha', name: 'search' },
    { plugin: 'beta', name: 'search' },
  ])
  assert.deepEqual(plan.register.map((entry) => entry.name), ['search', 'beta.search'])
  assert.equal(plan.skipped.length, 0)
})

test('a duplicated declaration from the same plugin is skipped with a reason', () => {
  const plan = planPluginTools([
    { plugin: 'alpha', name: 'search' },
    { plugin: 'alpha', name: 'search' },
  ])
  assert.deepEqual(plan.register.map((entry) => entry.name), ['search'])
  assert.equal(plan.skipped.length, 1)
  assert.equal(plan.skipped[0].reason, 'declared twice by the same plugin')
})

test('a plugin prefix with punctuation is made callable', () => {
  const plan = planPluginTools([{ plugin: '@acme/kit', name: 'read' }], ['read'])
  assert.equal(plan.register[0].name, '_acme_kit.read')
})

test('an empty name is skipped rather than registered as a blank tool', () => {
  const plan = planPluginTools([{ plugin: 'alpha', name: '   ' }])
  assert.equal(plan.register.length, 0)
  assert.equal(plan.skipped[0].reason, 'no name')
})

test('the input list is not mutated', () => {
  const defs = [{ plugin: 'alpha', name: 'a' }]
  const before = JSON.stringify(defs)
  planPluginTools(defs, ['a'])
  assert.equal(JSON.stringify(defs), before)
})
