import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { ReconGraph } from './graph.js'
import { AssessmentManager } from './tasks.js'
import type { LoopRuntime } from './loop.js'

// The task system is the ARTEX loop with a lifecycle: it starts on a tool call
// and keeps running without one. These tests fake the model side and check the
// lifecycle — start, steer, pause, resume, cancel, and what survives a restart.

const waitFor = async (condition: () => boolean | Promise<boolean>, timeoutMs = 5000, describe?: () => string): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for the assessment to move: ${describe?.() || ''}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const GOALS = JSON.stringify({ constraints: ['stay in scope'], goals: [{ text: 'find one hole', assets: ['example.com'] }] })
const INTENTS = (text: string) => JSON.stringify({ intents: [{ text, assets: ['example.com'] }] })

/**
 * A runtime whose llm answers by payload shape — goals calls carry "targets",
 * planner rounds carry "openIntents", worker calls carry "intent". A gate can
 * hold workers open so a test gets a window to pause the run mid-flight.
 */
function fakeRuntime(parts: { planner?: string[]; worker?: string | null; gate?: Promise<void>; onWorker?: () => void }): LoopRuntime {
  let round = 0
  const plannerReplies = parts.planner || []
  return {
    llm: async (request) => {
      const content = String(request.messages[0]?.content || '')
      if (content.includes('"targets"')) return GOALS
      if (content.includes('"openIntents"')) {
        const reply = plannerReplies[Math.min(round++, plannerReplies.length - 1)]
        return reply ?? JSON.stringify({ intents: [] })
      }
      // worker
      parts.onWorker?.()
      if (parts.gate) await parts.gate
      return parts.worker ?? '{"facts":[]}'
    },
  }
}

function managerFor(graph: ReconGraph, dir?: string): AssessmentManager {
  return new AssessmentManager(async () => graph, dir)
}

test('a task runs to done and records its report', async () => {
  const graph = new ReconGraph()
  const manager = managerFor(graph)
  const runtime = fakeRuntime({
    planner: [INTENTS('probe the login')],
    worker: '{"facts":[{"text":"login accepts POST"}],"findings":[{"text":"auth bypass with empty password"}]}',
  })
  const state = await manager.create({ objective: 'find one hole', targets: ['example.com'] }, 'session-1', runtime)
  assert.equal(state.status, 'running')
  assert.equal(state.goalTexts.length, 1)
  await waitFor(async () => (await manager.list('session-1'))[0]?.status !== 'running')
  const final = (await manager.list('session-1'))[0]
  assert.equal(final.status, 'done')
  assert.equal(final.stopped, 'goal-proven')
  assert.equal(final.report?.findings, 1)
  const live = await manager.get(state.id)
  assert.equal(live.live?.goals[0].status, 'met', 'the engine proved the goal from the finding')
  assert.equal(live.live?.coverage.total, 1)
})

test('a hint lands on the graph where the planner will read it', async () => {
  const graph = new ReconGraph()
  const manager = managerFor(graph)
  const state = await manager.create(
    { objective: 'find one hole', targets: ['example.com'] },
    'session-hint',
    fakeRuntime({ planner: [JSON.stringify({ intents: [] })] }),
  )
  await waitFor(async () => (await manager.list('session-hint'))[0]?.status !== 'running')
  await manager.hint(state.id, 'try the staging subdomain first')
  const hints = graph.hints()
  assert.equal(hints.length, 1)
  assert.equal(hints[0].text, 'try the staging subdomain first')
})

test('pause and resume carry the frontier across runs', async () => {
  const graph = new ReconGraph()
  const manager = managerFor(graph)
  let openGate = () => {}
  const gate = new Promise<void>((resolve) => { openGate = resolve })
  let workerCalls = 0
  const runtime = fakeRuntime({
    planner: [INTENTS('slow probe')],
    worker: '{"facts":[{"text":"slow probe observed something"}]}',
    gate,
    onWorker: () => { workerCalls += 1 },
  })
  const state = await manager.create({ objective: 'find one hole', targets: ['example.com'] }, 'session-pause', runtime)
  await waitFor(() => workerCalls > 0, 3000)
  await manager.control(state.id, 'pause')
  await waitFor(() => state.status === 'paused')
  assert.equal(state.status, 'paused')

  // The interrupted worker still owes its fact; let it finish before resuming,
  // the way a real worker would when its model call comes back.
  openGate()
  await waitFor(() => graph.toJSON().nodes.some((node) => node.kind === 'fact' && node.text.includes('slow probe')))

  // The resumed run needs model plumbing: the tool normally supplies it on
  // every call; the test supplies it directly.
  manager.rememberRuntime('session-pause', fakeRuntime({ planner: [JSON.stringify({ intents: [] })] }))
  await manager.control(state.id, 'resume')
  await waitFor(
    async () => (await manager.list('session-pause'))[0]?.status === 'done',
    5000,
    () => `status=${state.status} stopped=${state.stopped} error=${state.error}`,
  )
  assert.equal(state.stopped, 'planner-idle', 'the resumed run ends when the planner goes quiet')
})

test('cancelling a paused task closes it without starting a run', async () => {
  const graph = new ReconGraph()
  const manager = managerFor(graph)
  let openGate = () => {}
  const gate = new Promise<void>((resolve) => { openGate = resolve })
  const state = await manager.create(
    { objective: 'find one hole', targets: ['example.com'] },
    'session-cancel',
    fakeRuntime({ planner: [INTENTS('hang')], gate }),
  )
  await waitFor(async () => (await manager.get(state.id)).live?.runningIntents === 1, 3000)
  await manager.control(state.id, 'pause')
  await waitFor(() => state.status === 'paused')
  await manager.control(state.id, 'cancel')
  assert.equal(state.status, 'cancelled')
  assert.ok(state.endedAt)
  openGate()
})

test('running-task caps hold: one per session, four overall', async () => {
  const graph = new ReconGraph()
  const manager = managerFor(graph)
  let openGate = () => {}
  const gate = new Promise<void>((resolve) => { openGate = resolve })
  const runtime = fakeRuntime({ planner: [INTENTS('hold')], gate })
  await manager.create({ objective: 'one', targets: ['example.com'] }, 'session-cap', runtime)
  // One engine per graph: a second concurrent assessment on the same session
  // would prove (and steal from) the first one's goals.
  await assert.rejects(
    () => manager.create({ objective: 'two', targets: ['example.com'] }, 'session-cap', runtime),
    /already has a running assessment/,
  )
  const second = await manager.create({ objective: 'elsewhere', targets: ['example.com'] }, 'session-other', runtime)
  const third = await manager.create({ objective: 'again', targets: ['example.com'] }, 'session-x', runtime)
  const fourth = await manager.create({ objective: 'room', targets: ['example.com'] }, 'session-y', runtime)
  await assert.rejects(
    () => manager.create({ objective: 'overflow', targets: ['example.com'] }, 'session-z', runtime),
    /too many running assessments/,
  )
  openGate()
  void second; void third; void fourth
  await waitFor(
    async () => (await manager.list()).every((entry) => entry.status !== 'running'),
    8000,
    () => [...manager['states'].values()].map((entry) => `${entry.objective}:${entry.status}:${entry.stopped}`).join(' | '),
  )
})

test('tasks survive a restart: paused on boot, resumable with the same plan', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assess-'))
  const graph = new ReconGraph()
  let openGate = () => {}
  const gate = new Promise<void>((resolve) => { openGate = resolve })
  const runtime = fakeRuntime({ planner: [INTENTS('enumerate')], gate })
  const first = new AssessmentManager(async () => graph, dir)
  const state = await first.create({ objective: 'find one hole', targets: ['example.com'] }, 'session-disk', runtime)
  await waitFor(async () => (await first.get(state.id)).live?.runningIntents === 1, 3000)

  // The process "dies" here: a brand-new manager over the same directory picks
  // the task up from disk, parks the running one, and can resume it.
  const second = new AssessmentManager(async () => graph, dir)
  const restored = await second.list('session-disk')
  assert.equal(restored.length, 1)
  assert.equal(restored[0].status, 'paused', 'a task found running at boot was parked, not lost')
  assert.equal(restored[0].objective, 'find one hole')

  second.rememberRuntime('session-disk', fakeRuntime({ planner: [JSON.stringify({ intents: [] })] }))
  await second.control(state.id, 'resume')
  await waitFor(async () => (await second.list()).some((entry) => entry.id === state.id && entry.status === 'done'))
  openGate()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('a task renders its graph into a markdown deliverable', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assess-report-'))
  const graph = new ReconGraph()
  const manager = managerFor(graph)
  const runtime = fakeRuntime({
    planner: [INTENTS('probe the login')],
    worker: '{"facts":[{"text":"login accepts POST"}],"findings":[{"text":"auth bypass with empty password"}]}',
  })
  const state = await manager.create({ objective: 'find one hole', targets: ['example.com'] }, 'session-report', runtime)
  await waitFor(async () => (await manager.list('session-report'))[0]?.status !== 'running')

  const out = path.join(dir, 'report.md')
  const result = await manager.report(state.id, out, dir)
  assert.equal(result.path, out)
  assert.equal(result.findings, 1)
  const markdown = fs.readFileSync(out, 'utf8')
  assert.ok(markdown.includes('# Assessment report — find one hole'), 'title carries the objective')
  assert.ok(markdown.includes('auth bypass with empty password'), 'findings carry their evidence chain section')
  assert.ok(markdown.includes('## Scope & coverage'))
  assert.ok(markdown.includes('domain:example.com'), 'the declared scope is in the report')
  assert.ok(markdown.includes('login accepts POST'), 'the observation log made it in')
  await manager.control(state.id, 'delete').catch(() => {})
  fs.rmSync(dir, { recursive: true, force: true })
})

test('an abort mid-run ends the engine as aborted', async () => {
  const { ReconEngine } = await import('./engine.js')
  const { Plan } = await import('./plan.js')
  const { TraceStore } = await import('./traces.js')
  const graph = new ReconGraph()
  graph.addAsset('example.com')
  const controller = new AbortController()
  let openGate = () => {}
  const gate = new Promise<void>((resolve) => { openGate = resolve })
  const engine = new ReconEngine(graph, new Plan(), new TraceStore(), {
    signal: controller.signal,
    concurrency: 1,
  })
  const run = engine.run(
    async () => [{ text: 'hang', assets: ['example.com'] }],
    async () => {
      await gate
      return {}
    },
  )
  await new Promise((resolve) => setTimeout(resolve, 20))
  controller.abort()
  const report = await run
  assert.equal(report.stopped, 'aborted')
  openGate()
})
