import test from 'node:test'
import assert from 'node:assert/strict'
import { makeWorker } from './loop.js'
import type { LoopContext, LoopRuntime } from './loop.js'
import type { IntentSpec } from './engine.js'

// A task outlives the conversation that started it. Its permission mode therefore
// has to travel with the task: inheriting the caller's setting would mean a task
// started under full access loses it on resume, and one started under normal
// access silently gains it if the panel is switched later.

const intent: IntentSpec = { id: 'i1', text: 'probe the login', assets: ['example.test'] }

function runtimeCapturing(): { calls: Array<Record<string, string> | undefined>; runtime: LoopRuntime } {
  const calls: Array<Record<string, string> | undefined> = []
  const runtime = {
    llm: async () => '{"facts":[]}',
    subagent: async () => '{"facts":[{"text":"from plain runner"}]}',
    subagentWith: async (_prompt: string, _type: string | undefined, options: Record<string, string>) => {
      calls.push(options)
      return '{"facts":[{"text":"from overlay runner"}]}'
    },
  } as unknown as LoopRuntime
  return { calls, runtime }
}

function loopWith(mode?: 'normal' | 'full_access'): LoopContext {
  return {
    objective: 'probe',
    scopeLine: 'Scope: example.test',
    constraints: [],
    fallbackAssets: ['example.test'],
    ...(mode ? { permissionMode: mode } : {}),
  }
}

test('a full-access task tells the worker so', async () => {
  const { calls, runtime } = runtimeCapturing()
  await makeWorker(runtime, loopWith('full_access'))(intent, {} as any)
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.permission_mode, 'full_access')
})

test('a normal task says normal, rather than saying nothing', async () => {
  const { calls, runtime } = runtimeCapturing()
  await makeWorker(runtime, loopWith('normal'))(intent, {} as any)
  // Silence would mean "inherit the caller", which is the behaviour this field
  // exists to replace.
  assert.equal(calls[0]?.permission_mode, 'normal')
})

test('a task without a mode falls back to the plain runner', async () => {
  const { calls, runtime } = runtimeCapturing()
  const result = await makeWorker(runtime, loopWith())(intent, {} as any)
  assert.equal(calls.length, 0, 'no overlay is applied when the task never chose')
  assert.equal(result.facts?.[0]?.text, 'from plain runner')
})
