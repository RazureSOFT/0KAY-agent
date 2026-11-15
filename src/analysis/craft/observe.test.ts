import test from 'node:test'
import assert from 'node:assert/strict'
import { compareAt, compareAll, extractElements, CHECK_WIDTHS, type Observation } from './observe.js'

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
