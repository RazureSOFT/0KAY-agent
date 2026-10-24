import test from 'node:test'
import assert from 'node:assert/strict'
import { compactOutput, stripAnsi, compactionNote } from './compact.js'

// The compactor is allowed to lose information, but only the kind nobody reads,
// and it must always say when it did.

test('colour codes are removed', () => {
  assert.equal(stripAnsi('\u001B[32mok\u001B[0m'), 'ok')
  assert.equal(stripAnsi('\u001B]8;;https://x\u0007link\u001B]8;;\u0007'), 'link')
})

test('a progress bar keeps its last frame', () => {
  const result = compactOutput('10%\r50%\r99%\ndone')
  assert.equal(result.text, '99%\ndone')
})

test('blank padding collapses to one separator', () => {
  const result = compactOutput('a\n\n\n\n\n\nb')
  assert.equal(result.text, 'a\n\nb')
})

test('a single huge line is cut and the size is noted', () => {
  const line = 'x'.repeat(5000)
  const result = compactOutput(line)
  assert.ok(result.text.length < 2500)
  assert.match(result.text, /\+3000 chars/)
})

test('the middle is dropped, the head and the tail survive', () => {
  const text = Array.from({ length: 1000 }, (_, index) => `line ${index}`).join('\n')
  const result = compactOutput(text, { maxLines: 100, tailShare: 0.3 })
  assert.match(result.text, /lines omitted/)
  assert.match(result.text, /^line 0/)
  assert.match(result.text, /line 999$/)
  assert.ok(result.droppedLines > 0)
})

test('a large character count is capped from both ends', () => {
  const text = 'A'.repeat(20_000) + 'B'.repeat(20_000)
  const result = compactOutput(text, { maxChars: 4_000, maxLineLength: 40_000 })
  assert.ok(result.text.length < 4_200)
  assert.match(result.text, /chars omitted/)
  assert.ok(result.text.startsWith('A'))
  assert.ok(result.text.endsWith('B'))
})

test('small clean output passes through untouched', () => {
  const text = 'hello\nworld'
  const result = compactOutput(text)
  assert.equal(result.text, text)
  assert.equal(result.changed, false)
  assert.equal(compactionNote(result), null)
})

test('the note says what was dropped, not just that something was', () => {
  const result = compactOutput(`\u001B[31mred\u001B[0m`)
  assert.equal(result.changed, true)
  assert.match(compactionNote(result) || '', /compacted/)
})

test('empty output is empty, not an artefact', () => {
  assert.equal(compactOutput('').text, '')
  assert.equal(compactOutput('   \n\n  ').text, '')
})

test('CRLF is a line ending, not a progress bar', () => {
  // Getting this wrong empties every line Windows produces, which is how a
  // passing shell test turned into "stdout: ''".
  const result = compactOutput('✅\r\nsecond line\r\n')
  assert.equal(result.text.trim(), '✅\nsecond line')
})
