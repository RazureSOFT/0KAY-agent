import test from 'node:test'
import assert from 'node:assert/strict'
import { TOOL_GROUPS, ALWAYS_LOADED, groupOf, isAlwaysLoaded, groupsFor, knownTools } from './groups.js'
import { createDefaultRegistry } from './tools.js'

// The index is what lets the prompt stay small. If a tool is registered but
// named in no group, it silently drops out of the prompt — so that is the one
// thing worth failing a build over.

test('every registered tool is named in exactly one group', () => {
  const registry = createDefaultRegistry()
  const registered = registry.names()
  const missing = registered.filter((name) => !groupOf(name))
  assert.deepEqual(missing, [], `tools with no group: ${missing.join(', ')}`)

  const seen = new Map<string, string>()
  for (const [group, definition] of Object.entries(TOOL_GROUPS)) {
    for (const tool of definition.tools) {
      const previous = seen.get(tool)
      assert.equal(previous, undefined, `${tool} is in both ${previous} and ${group}`)
      seen.set(tool, group)
    }
  }
})

test('a tool named in a group actually exists', () => {
  const registry = createDefaultRegistry()
  const phantom = knownTools().filter((name) => !registry.get(name))
  // `question` is injected by the loop rather than the registry, so it is the
  // one legitimate exception.
  assert.deepEqual(phantom, ['question'], `named but not registered: ${phantom.join(', ')}`)
})

test('core and agent ride along; the rest do not', () => {
  assert.equal(isAlwaysLoaded('read'), true)
  assert.equal(isAlwaysLoaded('bash'), true)
  assert.equal(isAlwaysLoaded('subagent'), true)
  assert.equal(isAlwaysLoaded('pentest'), false)
  assert.equal(isAlwaysLoaded('evolve_begin'), false)
  assert.deepEqual(ALWAYS_LOADED, ['core', 'agent'])
})

test('an ungrouped tool stays visible rather than disappearing', () => {
  assert.equal(isAlwaysLoaded('a-tool-nobody-classified'), true)
  assert.equal(groupOf('a-tool-nobody-classified'), undefined)
})

test('groupsFor maps tool names to the groups they need', () => {
  assert.deepEqual(groupsFor(['pentest', 'diagram']), ['analysis'])
  assert.deepEqual(groupsFor(['pentest', 'read', 'document']).sort(), ['analysis', 'core', 'docs'])
  assert.deepEqual(groupsFor(['not-a-tool']), [])
})
