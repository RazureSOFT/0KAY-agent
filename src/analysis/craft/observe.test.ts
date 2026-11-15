import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { encodePng, type Raster } from './pixels.js'
import {
  compareAt, compareAll, extractElements, checkAll, checkReportMarkdown,
  summarizeObservation, observeAt, CHECK_WIDTHS, DEFAULT_CRAFT_STATES,
  type Observation, type InteractionSnapshot,
} from './observe.js'

// "1:1" is a claim about measurement, not about appearance. These tests are the
// measurement: a missing section, a drifted colour, a moved block and a dropped
// paragraph each have to be detected, and none of them may pass as "close".

const page = (html: string, width = 1280): Observation => ({
  url: 'file:///x', width, height: 900, title: '', text: '', elements: extractElements(html),
})

test('the three comparison widths are the ones the prompt promises', () => {
  assert.deepEqual([...CHECK_WIDTHS], [390, 768, 1280])
})

test('extractElements keeps the style properties that decide how it looks', () => {
  const elements = extractElements('<div style="background-color:#2563eb;font-size:16px;position:absolute;top:3px"></div>')
  assert.equal(elements.length, 1)
  assert.equal(elements[0].style['background-color'], '#2563eb')
  assert.equal(elements[0].style['font-size'], '16px')
  // `top` is not in the visual set; inventing it would produce noise, not signal.
  assert.equal(elements[0].style.top, undefined)
})

test('class rules fold into the resolved style', () => {
  const html = '<style>.hero{background-color:#fff;padding:24px}</style><section class="hero">Hi</section>'
  const [section] = extractElements(html)
  assert.equal(section.style['background-color'], '#fff')
  assert.equal(section.style.padding, '24px')
  assert.equal(section.text, 'Hi')
})

test('an identical rebuild is 100 and has no differences', () => {
  const html = '<div style="color:#111">Hello</div><p style="margin:8px">World</p>'
  const comparison = compareAt(page(html), page(html))
  assert.equal(comparison.differences.length, 0)
  assert.equal(comparison.similarity, 100)
})

test('a missing section costs far more than a slightly wrong colour', () => {
  const original = '<header style="background-color:#2563eb">A</header><main style="padding:16px">B</main><footer style="color:#666">C</footer>'
  const missingFooter = '<header style="background-color:#2563eb">A</header><main style="padding:16px">B</main>'
  const wrongColour = '<header style="background-color:#3b82f6">A</header><main style="padding:16px">B</main><footer style="color:#666">C</footer>'

  const missing = compareAt(page(original), page(missingFooter))
  const colour = compareAt(page(original), page(wrongColour))

  assert.ok(missing.differences.some((row) => row.kind === 'missing'), 'the dropped footer must be reported')
  assert.ok(missing.similarity < colour.similarity, 'a missing section must score worse than a wrong colour')
})

test('a drifted colour names the property and both values', () => {
  const comparison = compareAt(
    page('<div style="background-color:#2563eb">x</div>'),
    page('<div style="background-color:#3b82f6">x</div>'),
  )
  const style = comparison.differences.find((row) => row.kind === 'style')
  assert.ok(style)
  assert.equal(style.original, 'background-color: #2563eb')
  assert.equal(style.rebuilt, 'background-color: #3b82f6')
})

test('changed wording is reported as text, not as a layout difference', () => {
  const comparison = compareAt(page('<h1 style="font-size:32px">Buy now</h1>'), page('<h1 style="font-size:32px">Order now</h1>'))
  const text = comparison.differences.find((row) => row.kind === 'text')
  assert.ok(text)
  assert.equal(text.original, 'Buy now')
  assert.equal(text.rebuilt, 'Order now')
})

test('an extra element in the rebuild is reported too', () => {
  const comparison = compareAt(page('<div>x</div>'), page('<div>x</div><div>extra</div>'))
  assert.ok(comparison.differences.some((row) => row.kind === 'extra'))
})

test('a size difference under a pixel is noise, not a finding', () => {
  const comparison = compareAt(
    page('<div style="width:100px">x</div>'),
    page('<div style="width:100.4px">x</div>'),
  )
  assert.equal(comparison.differences.filter((row) => row.kind === 'size').length, 0)
})

test('compareAll averages the widths and reports each one', () => {
  const original = [page('<div style="color:#111">x</div>', 390), page('<div style="color:#111">x</div>', 1280)]
  const rebuild = [page('<div style="color:#111">x</div>', 390), page('<div style="color:#222">x</div>', 1280)]
  const result = compareAll(original, rebuild)
  assert.equal(result.comparisons.length, 2)
  assert.equal(result.comparisons[0].similarity, 100)
  assert.ok(result.similarity < 100)
})

test('a width the rebuild never rendered is skipped rather than scored as zero', () => {
  const result = compareAll([page('<div>x</div>', 390), page('<div>x</div>', 1280)], [page('<div>x</div>', 390)])
  assert.equal(result.comparisons.length, 1)
  assert.equal(result.similarity, 100)
})

// ---- live probe evidence ---------------------------------------------------

const live = (
  style: Record<string, string> = {},
  rect = { x: 0, y: 0, width: 100, height: 20 },
  width = 1280,
): Observation => ({
  url: 'file:///x', width, height: 900, title: '', text: '',
  elements: [{ path: 'div#1', tag: 'div', style, rect }],
})

const snapshot = (label: string, expanded: string): InteractionSnapshot => ({
  label, text: '', elementCount: 1,
  states: [{ tag: 'button', label: 'menu', expanded }],
})

test('a live rgb() reading and a static #hex value are not reported as a drift', () => {
  const comparison = compareAt(
    live({ 'background-color': '#2563eb' }),
    live({ 'background-color': 'rgb(37, 99, 235)' }),
  )
  assert.equal(comparison.differences.length, 0)
  assert.equal(comparison.similarity, 100)
})

test('a real colour drift is still named with both values', () => {
  const comparison = compareAt(
    live({ 'background-color': 'rgb(37, 99, 235)' }),
    live({ 'background-color': 'rgb(59, 130, 246)' }),
  )
  assert.ok(comparison.differences.some((row) => row.kind === 'style'))
})

test('a moved block is a position finding with the pixel delta', () => {
  const comparison = compareAt(
    live({}, { x: 0, y: 0, width: 100, height: 20 }),
    live({}, { x: 0, y: 40, width: 100, height: 20 }),
  )
  const moved = comparison.differences.find((row) => row.kind === 'position')
  assert.ok(moved)
  assert.equal(moved.delta, 40)
})

test('a two-pixel shift is noise, not a finding', () => {
  const comparison = compareAt(
    live({}, { x: 0, y: 0, width: 100, height: 20 }),
    live({}, { x: 0, y: 2, width: 100, height: 20 }),
  )
  assert.equal(comparison.differences.filter((row) => row.kind === 'position').length, 0)
})

test('a menu that never opens is reported as a state difference', () => {
  const comparison = compareAt(
    { ...live(), interactions: [snapshot('menu-open', 'true')] },
    { ...live(), interactions: [snapshot('menu-open', 'false')] },
  )
  assert.ok(comparison.differences.some((row) => row.kind === 'state' && row.original === 'expanded: true'))
})

test('a state the rebuild never observed is reported rather than skipped', () => {
  const comparison = compareAt(
    { ...live(), interactions: [snapshot('menu-open', 'true')] },
    { ...live(), interactions: [] },
  )
  assert.ok(comparison.differences.some((row) => row.kind === 'state' && row.rebuilt === 'state not observed'))
})

test('element state differences are measured too', () => {
  const original = live()
  const rebuilt = live()
  original.elements[0].state = { hidden: false, disabled: false, checked: false }
  rebuilt.elements[0].state = { hidden: false, disabled: true, checked: false }
  assert.ok(compareAt(original, rebuilt).differences.some((row) => row.kind === 'state'))
})

test('the default study includes opened menus and hover states', () => {
  assert.deepEqual(DEFAULT_CRAFT_STATES.map((row) => row.label), ['menu-open', 'hover-nav'])
})

test('a page that cannot be rendered reports zero confidence instead of inventing evidence', async () => {
  const previous = process.env.OKAY_NO_BROWSER
  process.env.OKAY_NO_BROWSER = '1'
  try {
    const row = await observeAt('https://example.invalid', 390)
    assert.ok(row.error)
    assert.equal(row.evidence?.source, 'unavailable')
    assert.equal(row.evidence?.confidence, 0)
    assert.equal(row.elements.length, 0)
  } finally {
    if (previous === undefined) delete process.env.OKAY_NO_BROWSER
    else process.env.OKAY_NO_BROWSER = previous
  }
})

test('the public summary never leaks inline screenshots or clean-room source', () => {
  const row: Observation = {
    ...live(),
    markup: '<html>secret</html>',
    screenshotDataUrl: 'data:image/png;base64,AAAA',
  }
  const text = JSON.stringify(summarizeObservation(row))
  assert.ok(!text.includes('data:image/png'))
  assert.ok(!text.includes('secret'))
  assert.equal((summarizeObservation(row) as any).elements, 1)
})

// ---- screenshot checks -----------------------------------------------------

const raster = (fill: number, size = 8): Raster => ({
  width: size, height: size, data: new Uint8Array(size * size * 4).fill(fill),
})

test('checkAll blends element and pixel scores and writes difference images', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), '0kay-craft-check-'))
  try {
    const rows: Observation[] = []
    const rebuilt: Observation[] = []
    for (const [index, width] of [390, 1280].entries()) {
      const before = path.join(dir, `before-${width}.png`)
      const after = path.join(dir, `after-${width}.png`)
      await fs.writeFile(before, encodePng(raster(255)))
      // The second width is entirely wrong; the first is a perfect match.
      await fs.writeFile(after, encodePng(raster(index === 0 ? 255 : 0)))
      rows.push({ ...live({}, { x: 0, y: 0, width: 100, height: 20 }, width), screenshot: before })
      rebuilt.push({ ...live({}, { x: 0, y: 0, width: 100, height: 20 }, width), screenshot: after })
    }
    const checkDir = path.join(dir, 'checks')
    const result = await checkAll(rows, rebuilt, { checkDir })
    assert.equal(result.checks.length, 2)
    assert.equal(result.similarity, 100)
    assert.equal(result.pixelSimilarity, 50)
    assert.equal(result.overall, 75)
    assert.ok(result.checks.every((row) => row.differenceImage))
    for (const row of result.checks) {
      assert.ok((await fs.stat(row.differenceImage!)).size > 0)
    }
    assert.ok(result.checks[1].regions.length > 0, 'the wrong screenshot must point at a place')
    const report = checkReportMarkdown(result)
    assert.ok(report.includes('# How alike'))
    assert.ok(report.includes('Overall: **75%**'))
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('without screenshots the check says so and falls back to the element score', async () => {
  const result = await checkAll([live()], [live()])
  assert.equal(result.pixelSimilarity, undefined)
  assert.equal(result.overall, 100)
  assert.equal(result.checks.length, 0)
  assert.ok(result.limitations.some((row) => row.includes('no screenshots')))
})

test('an unreadable screenshot is a limitation, not a fabricated zero', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), '0kay-craft-broken-'))
  try {
    const before = path.join(dir, 'before.png')
    const after = path.join(dir, 'after.png')
    await fs.writeFile(before, encodePng(raster(255)))
    await fs.writeFile(after, 'this is not a png')
    const result = await checkAll(
      [{ ...live(), screenshot: before }],
      [{ ...live(), screenshot: after }],
      { checkDir: path.join(dir, 'checks') },
    )
    assert.equal(result.checks.length, 1)
    assert.ok(result.checks[0].error)
    assert.equal(result.pixelSimilarity, undefined)
    assert.equal(result.overall, 100)
    assert.ok(result.limitations.some((row) => row.includes('screenshot comparison failed')))
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
