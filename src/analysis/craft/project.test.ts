import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { encodePng, type Raster } from './pixels.js'
import { CHECK_WIDTHS, type Observation, type ObserveOptions } from './observe.js'
import { CraftProject, CRAFT_STAGES, DEFAULT_THRESHOLD, type CraftIO } from './project.js'

// The project is the loop. These tests drive Study -> Build -> Check -> Ready
// end to end with an injected observer, so the state machine and the files on
// disk are checked together rather than by mocking the file system away.

const raster = (fill: number, size = 8): Raster => ({
  width: size, height: size, data: new Uint8Array(size * size * 4).fill(fill),
})

interface FakePage {
  fill?: number
  colour?: string
  text?: string
  markup?: string
}

function fakeIO(page: FakePage = {}, byUrl: Record<string, FakePage> = {}): CraftIO {
  return {
    observeAll: async (url: string, options: ObserveOptions): Promise<Observation[]> => {
      const variant = byUrl[url] || page
      const dir = options.screenshotDir!
      await fs.mkdir(dir, { recursive: true })
      return Promise.all([...CHECK_WIDTHS].map(async (width) => {
        const shot = path.join(dir, `${width}.png`)
        await fs.writeFile(shot, encodePng(raster(variant.fill ?? 255)))
        return {
          url, width, height: 900,
          title: 'Example',
          text: variant.text ?? 'Buy now',
          elements: [{
            path: 'div#1', tag: 'div',
            style: { 'background-color': variant.colour ?? '#2563eb' },
            rect: { x: 0, y: 0, width: 100, height: 20 },
          }],
          screenshot: shot,
          states: [],
          interactions: [{ label: 'base', states: [], text: '', elementCount: 1 }],
          evidence: { source: 'live', confidence: 92, coverage: 100, limitations: ['clean room: source markup is not evidence'] },
          ...(variant.markup ? { markup: variant.markup } : {}),
        } as Observation
      }))
    },
  }
}

async function workspace(): Promise<{ dir: string; root: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), '0kay-craft-project-'))
  return { dir, root: path.join(dir, 'page') }
}

async function exists(file: string): Promise<boolean> {
  try { await fs.access(file); return true } catch { return false }
}

test('open creates the whole project layout and starts at Study', async () => {
  const { dir, root } = await workspace()
  try {
    const project = await CraftProject.open(root, { objective: 'Recreate the landing page', target: 'https://example.test' }, fakeIO())
    assert.equal(project.state.stage, 'study')
    assert.equal(project.state.threshold, DEFAULT_THRESHOLD)
    assert.equal(project.state.round, 0)
    assert.deepEqual(CRAFT_STAGES, ['study', 'build', 'check', 'ready'])
    for (const folder of ['capture/study', 'capture/build', 'app', 'checks', 'investigation.cany', 'inbox']) {
      assert.ok((await fs.stat(path.join(root, folder))).isDirectory(), folder)
    }
    assert.ok(await exists(path.join(root, 'craft.json')))
    assert.equal((JSON.parse(await fs.readFile(path.join(root, 'craft.json'), 'utf8'))).objective, 'Recreate the landing page')
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test('Study captures every width once, with evidence and no source leakage in clean room', async () => {
  const { dir, root } = await workspace()
  try {
    const io = fakeIO({ markup: '<html>original source</html>' })
    const project = await CraftProject.open(root, { mode: 'clean_room' }, io)
    const study = await project.study('https://example.test')
    assert.equal(project.state.stage, 'build')
    assert.deepEqual(study.widths, [390, 768, 1280])
    assert.equal(study.screenshots.length, 3)
    assert.equal(study.errors.length, 0)
    assert.equal(study.evidence.length, 3)
    for (const width of CHECK_WIDTHS) assert.ok(await exists(path.join(root, 'capture', 'study', `${width}.png`)))
    const stored = await fs.readFile(path.join(root, 'investigation.cany', 'study.json'), 'utf8')
    assert.ok(!stored.includes('original source'), 'clean room must never persist the original markup')
    assert.ok(!stored.includes('screenshotDataUrl'))
    assert.ok((await fs.readFile(path.join(root, 'investigation.cany', 'study.md'), 'utf8')).includes('Buy now'))
    assert.ok((await fs.readFile(path.join(root, 'investigation.cany', 'evidence.md'), 'utf8')).includes('Confidence: 92%'))
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test('Deep mode keeps source markup as evidence, clean room does not', async () => {
  const { dir, root } = await workspace()
  try {
    const deep = await CraftProject.open(path.join(root, 'deep'), { mode: 'deep' }, fakeIO({ markup: '<html>source</html>' }))
    await deep.study('https://example.test', { mode: 'deep' })
    assert.ok((await fs.readFile(path.join(root, 'deep', 'investigation.cany', 'study.json'), 'utf8')).includes('<html>source</html>'))
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test('the study survives reopening the project from disk', async () => {
  const { dir, root } = await workspace()
  try {
    const io = fakeIO()
    const first = await CraftProject.open(root, {}, io)
    await first.study('https://example.test')
    const reopened = await CraftProject.open(root, {}, io)
    assert.equal(reopened.state.stage, 'build')
    const rows = await reopened.studyObservations()
    assert.equal(rows.length, 3)
    assert.ok(await exists(rows[0].screenshot!), 'relative screenshot paths must resolve after reopen')
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test('a matching rebuild writes a report, diff images and reaches Ready', async () => {
  const { dir, root } = await workspace()
  try {
    const project = await CraftProject.open(root, {}, fakeIO())
    await project.study('https://example.test')
    await fs.writeFile(project.paths().entry, '<div>rebuild</div>')
    await project.build('first build', [project.paths().entry])
    const row = await project.check()
    assert.equal(row.round, 1)
    assert.equal(row.overall, 100)
    assert.equal(row.ready, true)
    assert.equal(project.state.stage, 'ready')
    assert.ok(project.state.readyAt)
    assert.equal(project.state.best?.overall, 100)
    for (const file of ['checks/round-1/check.json', 'checks/round-1/check.md', 'checks/report.md', 'checks/latest.json']) {
      assert.ok(await exists(path.join(root, file)), file)
    }
    assert.equal(row.diffImages.length, 3)
    for (const image of row.diffImages) assert.ok((await fs.stat(path.join(root, image))).size > 0)
    assert.ok((await fs.readFile(project.paths().report, 'utf8')).includes('Overall: **100%**'))
    assert.ok((await project.checklist()).every((item) => item.pass))
    assert.equal((await project.summary()).stage, 'ready')
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test('a drifted rebuild stays in Check and produces an actionable mismatch list', async () => {
  const { dir, root } = await workspace()
  try {
    const io = fakeIO({}, {
      'https://example.test': { fill: 255, colour: '#2563eb', text: 'Buy now' },
      'file:///rebuild': { fill: 0, colour: '#3b82f6', text: 'Order now' },
    })
    const project = await CraftProject.open(root, {}, io)
    await project.study('https://example.test')
    const row = await project.check('file:///rebuild')
    assert.ok(row.overall < DEFAULT_THRESHOLD)
    assert.equal(row.ready, false)
    assert.equal(project.state.stage, 'check')
    const differences = await project.differences()
    assert.ok(differences.some((item) => item.kind === 'style' && item.original.includes('#2563eb')))
    assert.ok(differences.some((item) => item.kind === 'text'))
    assert.ok(differences.every((item) => item.width > 0 && item.path))
    assert.ok((await project.checklist()).every((item) => !item.pass))
    const report = await fs.readFile(project.paths().report, 'utf8')
    assert.ok(report.includes('Stage: **Check**'))
    assert.ok(report.includes('hotspot'))
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test('an open change request reopens Build and blocks Ready until it is applied', async () => {
  const { dir, root } = await workspace()
  try {
    const project = await CraftProject.open(root, {}, fakeIO())
    await project.study('https://example.test')
    await fs.writeFile(project.paths().entry, '<div>rebuild</div>')
    await project.check()
    assert.equal(project.state.stage, 'ready')

    const item = await project.request('Make the header darker')
    assert.equal(project.state.stage, 'build')
    assert.equal(project.state.readyAt, undefined)
    assert.equal((await project.pending()).length, 1)
    assert.ok(await exists(path.join(root, item.file)))
    assert.ok((await fs.readFile(path.join(root, item.file), 'utf8')).includes('Status: open'))

    await project.build('work on the note, not yet applied')
    const blocked = await project.check()
    assert.equal(blocked.ready, false, 'an unanswered change request must not be declared Ready')
    assert.equal(project.state.stage, 'check')

    assert.equal(await project.apply([item.id]), 1)
    assert.equal((await project.pending()).length, 0)
    const done = await project.check()
    assert.equal(done.round, 3)
    assert.equal(done.ready, true)
    assert.equal(project.state.stage, 'ready')
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test('check refuses to run before a study or without a build', async () => {
  const { dir, root } = await workspace()
  try {
    const project = await CraftProject.open(root, {}, fakeIO())
    await assert.rejects(() => project.check(), /study the surface/)
    await project.study('https://example.test')
    await assert.rejects(() => project.check(), /no rebuild at/)
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test('a failed capture at every width is an error, not a fabricated score', async () => {
  const { dir, root } = await workspace()
  try {
    const broken: CraftIO = {
      observeAll: async (url, _options) => [...CHECK_WIDTHS].map((width) => ({
        url, width, height: 900, title: '', text: '', elements: [], error: 'the browser could not render this page',
      })),
    }
    const project = await CraftProject.open(root, {}, broken)
    await assert.rejects(() => project.study('https://example.test'), /could not be rendered at any width/)
    assert.equal(project.state.stage, 'study')
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test('markReady records a human decision and artifacts lists the files to open', async () => {
  const { dir, root } = await workspace()
  try {
    const project = await CraftProject.open(root, {}, fakeIO())
    await project.study('https://example.test')
    await fs.writeFile(project.paths().entry, '<div>rebuild</div>')
    await project.build('draft')
    await project.markReady('accepted by the user')
    assert.equal(project.state.stage, 'ready')
    assert.ok((await fs.readFile(path.join(root, 'investigation.cany', 'ready.md'), 'utf8')).includes('accepted by the user'))
    const artifacts = await project.artifacts()
    for (const name of ['craft.json', 'study.md', 'evidence.md', '390.png', 'build.md', 'ready.md']) {
      assert.ok(artifacts.some((row) => row.name === name), name)
    }
    assert.ok(artifacts.some((row) => row.kind === 'app'))
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})
