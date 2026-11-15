import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { ReconGraph } from './graph.js'
import { AssessmentManager } from './tasks.js'
import type { LoopRuntime } from './loop.js'

// A craft task is the RECON loop wired to a project on disk. The important
// property is that the planner does not invent the next build step: every round
// reads the project's stage, score and mismatch list, and the worker receives
// the exact tool calls. This test drives a real task with a fake model.

const GOALS = JSON.stringify({ constraints: ['stay in scope'], goals: [{ text: 'recreate the page', assets: ['https://example.test'] }] })
const INTENTS = JSON.stringify({ intents: [{ text: 'study the original surface', assets: ['https://example.test'] }] })

const waitFor = async (condition: () => boolean | Promise<boolean>, timeoutMs = 6000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the craft task to move')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/**
 * Remove a temp workspace on Windows.
 *
 * A task persists its ledger asynchronously, so a directory can still be open
 * when the test finishes and `rm` reports EBUSY. That is a test-harness race, not
 * a product failure: retry briefly and give up quietly, because a leftover temp
 * directory must not turn a green suite red.
 */
const cleanup = async (dir: string): Promise<void> => {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try { await fs.rm(dir, { recursive: true, force: true }); return }
    catch { await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1))) }
  }
}

test('a craft task owns a project and feeds it to the planner and worker', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), '0kay-craft-loop-'))
  try {
    const graph = new ReconGraph()
    const plannerContents: string[] = []
    const briefs: string[] = []
    let round = 0
    const runtime: LoopRuntime = {
      llm: async (request) => {
        const content = String(request.messages[0]?.content || '')
        if (content.includes('"reviewer":true')) return JSON.stringify({ verdict: 'accept', dimensions: [] })
        if (content.includes('"targets"')) return GOALS
        if (content.includes('"openIntents"')) {
          plannerContents.push(content)
          return round++ === 0 ? INTENTS : JSON.stringify({ intents: [] })
        }
        return '{"facts":[]}'
      },
      subagent: async (prompt) => { briefs.push(prompt); return '{"steps":[],"note":"done"}' },
    }
    const manager = new AssessmentManager(async () => graph, path.join(dir, 'assessments'))
    const state = await manager.create({
      objective: 'recreate the landing page',
      targets: ['https://example.test'],
      kind: 'craft',
      craftMode: 'clean_room',
      craftThreshold: 90,
      rounds: 1,
      intents: 2,
    }, 'session-craft', runtime)

    assert.ok(state.craftRoot, 'a craft task must own exactly one project')
    const saved = JSON.parse(await fs.readFile(path.join(state.craftRoot!, 'craft.json'), 'utf8'))
    assert.equal(saved.mode, 'clean_room')
    assert.equal(saved.threshold, 90)
    assert.equal(saved.stage, 'study')

    await waitFor(() => plannerContents.length > 0)
    const detail = await manager.get(state.id)
    assert.ok(detail.craft, 'get() exposes the project to the task page')
    assert.equal(detail.craft.taskId, state.id)
    assert.equal(detail.craft.stage, 'study')
    assert.equal(detail.craft.stages.length, 4)
    assert.ok(detail.craft.guide.includes('craft'))
    assert.equal(path.isAbsolute(state.craftRoot!), true, 'a resumed task must land on the same folder whatever the cwd')

    const withCraft = plannerContents.find((row) => row.includes('"craft"'))
    assert.ok(withCraft, 'every planner round carries the live project read')
    assert.ok(withCraft.includes('"stage":"study"'))
    assert.ok(withCraft.includes('"checklist"'))

    await waitFor(() => briefs.length > 0)
    const brief = briefs[0]
    assert.ok(brief.includes('复刻项目'), 'the worker gets the project frame')
    assert.ok(brief.includes('operation:"study"'))
    assert.ok(brief.includes('operation:"check"'))
    assert.ok(brief.includes(state.id), 'the worker gets the real task id, not a placeholder')
    assert.ok(brief.includes('app/index.html'))

    await waitFor(async () => (await manager.get(state.id)).state.status !== 'running')
    // finalize() persists asynchronously; let it land before removing the dir.
  } finally {
    await cleanup(dir)
  }
})

test('a non-craft task has no project and no craft read', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), '0kay-craft-recon-'))
  try {
    const graph = new ReconGraph()
    const runtime: LoopRuntime = {
      llm: async (request) => {
        const content = String(request.messages[0]?.content || '')
        if (content.includes('"reviewer":true')) return JSON.stringify({ verdict: 'accept', dimensions: [] })
        if (content.includes('"targets"')) return GOALS
        if (content.includes('"openIntents"')) return JSON.stringify({ intents: [] })
        return '{"facts":[]}'
      },
    }
    const manager = new AssessmentManager(async () => graph, path.join(dir, 'assessments'))
    const state = await manager.create({ objective: 'find one hole', targets: ['https://example.test'], rounds: 1 }, 'session-recon', runtime)
    assert.equal(state.craftRoot, undefined)
    assert.equal((await manager.get(state.id)).craft, undefined)
    await waitFor(async () => (await manager.get(state.id)).state.status !== 'running')
  } finally {
    await cleanup(dir)
  }
})

test('deleting a craft task removes its project folder, and only that folder', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), '0kay-craft-delete-'))
  try {
    const graph = new ReconGraph()
    const runtime: LoopRuntime = {
      llm: async (request) => {
        const content = String(request.messages[0]?.content || '')
        if (content.includes('"reviewer":true')) return JSON.stringify({ verdict: 'accept', dimensions: [] })
        if (content.includes('"targets"')) return GOALS
        if (content.includes('"openIntents"')) return JSON.stringify({ intents: [] })
        return '{"facts":[]}'
      },
    }
    const manager = new AssessmentManager(async () => graph, path.join(dir, 'assessments'))
    const state = await manager.create({ objective: 'recreate', targets: ['https://example.test'], kind: 'craft', rounds: 1, intents: 1 }, 'session-del', runtime)
    const root = state.craftRoot!
    assert.ok(await fs.stat(root).then(() => true).catch(() => false), 'the project exists while the task does')

    // A sibling folder that is NOT this task's project must survive: the guard
    // is an identity check, not "delete whatever is next door".
    const sibling = path.join(dir, 'craft', 'keep-me')
    await fs.mkdir(sibling, { recursive: true })

    await waitFor(async () => (await manager.get(state.id)).state.status !== 'running')
    await manager.control(state.id, 'delete')
    assert.equal(await fs.stat(root).then(() => true).catch(() => false), false, 'the project folder goes with the task')
    assert.equal(await fs.stat(sibling).then(() => true).catch(() => false), true)
  } finally {
    await cleanup(dir)
  }
})
