import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { AssessmentsTool } from './assess.js'
import { CraftProject } from '../../analysis/craft/project.js'
import { CHECK_WIDTHS, type Observation } from '../../analysis/craft/observe.js'

// The craft actions are the bridge between a task id and its project folder.
// They are checked here without a browser: state transitions and the guard
// rails matter more than the render, which the project tests cover separately.

function contextFor(root: string, craftRoot = true): any {
  const manager = {
    rememberRuntime() { },
    async get(id: string) {
      return { state: { id, kind: 'craft', ...(craftRoot ? { craftRoot: root } : {}) } }
    },
  }
  return {
    assessments: manager,
    sessionId: 'session-craft',
    taskId: 'session-craft',
    llm: async () => null,
    cwd: root,
  }
}

const run = async (args: Record<string, any>, ctx: any) => new AssessmentsTool().execute(args, ctx)

/** A study without a browser, reused by the state-transition test below. */
const fakeStudy = {
  observeAll: async (url: string, options: any): Promise<Observation[]> => [...CHECK_WIDTHS].map((width) => ({
    url, width, height: 900, title: 'Example', text: 'Buy now', elements: [],
    screenshot: path.join(options.screenshotDir, `${width}.png`),
    evidence: { source: 'live', confidence: 92, coverage: 100, limitations: [] },
  })),
}

test('the tool advertises the craft loop and all of its operations', () => {
  const schema = new AssessmentsTool().parameters
  assert.ok(schema.properties.action.enum.includes('craft'))
  for (const op of ['project', 'study', 'build', 'check', 'request', 'apply', 'ready', 'differences', 'artifacts', 'mode', 'threshold']) {
    assert.ok(schema.properties.operation.enum.includes(op), op)
  }
  assert.ok(schema.properties.craft_mode)
  assert.ok(schema.properties.craft_threshold)
})

test('project reads the four-stage state and the artifact list', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), '0kay-assess-craft-'))
  try {
    const root = path.join(dir, 'page')
    await CraftProject.open(root, { objective: 'recreate', target: 'https://example.test' })
    const result = await run({ action: 'craft', operation: 'project', id: 'as_1' }, contextFor(root))
    assert.equal(result.success, true)
    assert.equal(result.data.stage, 'study')
    assert.equal(result.data.stages.length, 4)
    assert.equal(result.data.round, 0)
    assert.deepEqual(result.data.stages.map((row: any) => row.id), ['study', 'build', 'check', 'ready'])
    assert.ok(Array.isArray(result.data.artifacts))
    assert.equal(result.data.differences.length, 0)
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test('a change request reopens Build; apply, mode, threshold and Ready all persist', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), '0kay-assess-loop-'))
  try {
    const root = path.join(dir, 'page')
    const seeded = await CraftProject.open(root, { target: 'https://example.test' }, fakeStudy)
    await seeded.study('https://example.test')
    const ctx = contextFor(root)
    const asked = await run({ action: 'craft', operation: 'request', id: 'as_1', text: 'make the header darker' }, ctx)
    assert.equal(asked.data.stage, 'build')
    const item = asked.data.request

    const applied = await run({ action: 'craft', operation: 'apply', id: 'as_1', applied_ids: [item.id] }, ctx)
    assert.equal(applied.data.applied, 1)
    assert.equal(applied.data.pending.length, 0)

    const built = await run({ action: 'craft', operation: 'build', id: 'as_1', note: 'first draft', files: [path.join(root, 'app', 'index.html')] }, ctx)
    assert.equal(built.data.stage, 'build')
    assert.equal(built.data.build.round, 1)
    assert.ok(built.data.build.files[0].includes('index.html'))

    assert.equal((await run({ action: 'craft', operation: 'mode', id: 'as_1', mode: 'deep' }, ctx)).data.mode, 'deep')
    assert.equal((await run({ action: 'craft', operation: 'threshold', id: 'as_1', threshold: 88 }, ctx)).data.threshold, 88)

    const ready = await run({ action: 'craft', operation: 'ready', id: 'as_1', note: 'accepted by the user' }, ctx)
    assert.equal(ready.data.stage, 'ready')
    assert.ok(ready.data.readyAt)

    const reopened = await CraftProject.open(root)
    assert.equal(reopened.state.stage, 'ready')
    assert.equal(reopened.state.threshold, 88)
    assert.equal(reopened.state.mode, 'deep')
    assert.equal(reopened.state.inbox[0].applied, true)
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test('unknown operations and non-craft tasks fail with a readable reason', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), '0kay-assess-guard-'))
  try {
    const root = path.join(dir, 'page')
    await CraftProject.open(root)
    const unknown = await run({ action: 'craft', operation: 'explode', id: 'as_1' }, contextFor(root))
    assert.equal(unknown.success, false)
    assert.ok(String(unknown.error || '').includes('unknown craft operation'))
    const wrongKind = await run({ action: 'craft', operation: 'project', id: 'as_2' }, contextFor(root, false))
    assert.equal(wrongKind.success, false)
    assert.ok(String(wrongKind.error || '').includes('no craft project'))
    const noId = await run({ action: 'craft', operation: 'project' }, contextFor(root))
    assert.equal(noId.success, false)
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test('a study with no browser reports the failure instead of inventing evidence', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), '0kay-assest-nobrowser-'))
  const previous = process.env.OKAY_NO_BROWSER
  process.env.OKAY_NO_BROWSER = '1'
  try {
    const root = path.join(dir, 'page')
    await CraftProject.open(root, { target: 'https://example.test' })
    const result = await run({ action: 'craft', operation: 'study', id: 'as_1' }, contextFor(root))
    assert.equal(result.success, false)
    assert.ok(String(result.error || '').includes('could not be rendered'))
    const reopened = await CraftProject.open(root)
    assert.equal(reopened.state.stage, 'study')
  } finally {
    if (previous === undefined) delete process.env.OKAY_NO_BROWSER
    else process.env.OKAY_NO_BROWSER = previous
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('compare without a browser fails cleanly rather than returning a fake score', async () => {
  const previous = process.env.OKAY_NO_BROWSER
  process.env.OKAY_NO_BROWSER = '1'
  try {
    const result = await run(
      { action: 'compare', original_url: 'https://example.test', rebuilt_url: 'https://rebuild.test' },
      contextFor(process.cwd()),
    )
    assert.equal(result.success, false)
    assert.ok(String(result.error || '').includes('could not render'))
  } finally {
    if (previous === undefined) delete process.env.OKAY_NO_BROWSER
    else process.env.OKAY_NO_BROWSER = previous
  }
})
