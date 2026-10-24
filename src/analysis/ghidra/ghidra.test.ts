import test from 'node:test'
import assert from 'node:assert/strict'
import { findGhidra, parseFacts, analyzeBinary, missingGhidraHint } from './ghidra.js'

// Ghidra is not installed on most machines, so the interesting cases are the
// ones without it: a clear refusal, and a parser that survives the analyzer's log
// output wrapped around the JSON.

const SAMPLE = [
  'INFO  Using log file ...',
  'INFO  Opening project: /tmp/x/0kay',
  'WARN  Some unrelated analyzer complaint',
  '0KAY-JSON-BEGIN',
  '{"functions":[{"name":"main","entry":"00401000","size":64},{"name":"check","entry":"00401040","size":32}],"strings":["/etc/passwd","admin"],"truncated":false}',
  '0KAY-JSON-END',
  'INFO  Done',
].join('\n')

test('findGhidra looks at GHIDRA_HOME first', () => {
  const found = findGhidra({ GHIDRA_HOME: 'C:\\ghidra_11.1' }, (candidate) => candidate.includes('analyzeHeadless'))
  assert.ok(found)
  assert.equal(found?.home, 'C:\\ghidra_11.1')
  assert.match(found!.headless, /analyzeHeadless/)
})

test('findGhidra returns null rather than guessing a path', () => {
  assert.equal(findGhidra({}, () => false), null)
})

test('the JSON block is found inside the analyzer log', () => {
  const facts = parseFacts(SAMPLE)
  assert.ok(facts)
  assert.equal(facts?.functions.length, 2)
  assert.equal(facts?.functions[1].name, 'check')
  assert.deepEqual(facts?.strings, ['/etc/passwd', 'admin'])
})

test('no markers means null, not an empty success', () => {
  assert.equal(parseFacts('INFO nothing here'), null)
})

test('analyzeBinary parses a run and truncates to the requested caps', async () => {
  const report = await analyzeBinary(
    { home: 'C:\\ghidra', headless: 'analyzeHeadless.bat', version: '11.1' },
    'C:\\samples\\a.exe',
    {
      maxFunctions: 1,
      maxStrings: 1,
      runner: async () => ({ code: 0, stdout: SAMPLE, stderr: '' }),
      workDir: process.cwd(),
    },
  )
  assert.equal(report.functions.length, 1)
  assert.equal(report.strings.length, 1)
  assert.equal(report.truncated, true)
  assert.equal(report.binary, 'C:\\samples\\a.exe')
})

test('a run with no facts block reports what the analyzer said', async () => {
  await assert.rejects(
    analyzeBinary(
      { home: 'C:\\ghidra', headless: 'analyzeHeadless.bat', version: '11.1' },
      'C:\\samples\\a.exe',
      { runner: async () => ({ code: 0, stdout: 'ERROR: could not import', stderr: '' }), workDir: process.cwd() },
    ),
    /produced no 0KAY-JSON-BEGIN block[\s\S]*could not import/,
  )
})

test('a non-zero exit is an error, not an empty report', async () => {
  await assert.rejects(
    analyzeBinary(
      { home: 'C:\\ghidra', headless: 'analyzeHeadless.bat', version: '11.1' },
      'C:\\samples\\a.exe',
      { runner: async () => ({ code: 3, stdout: 'java.lang.OutOfMemoryError', stderr: '' }), workDir: process.cwd() },
    ),
    /Ghidra exited 3/,
  )
})

test('the missing-install message says what to do and what still works', () => {
  const hint = missingGhidraHint()
  assert.match(hint, /GHIDRA_HOME/)
  assert.match(hint, /reverse_engineer/)
})
