import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveShell } from './shell_choice.js'

// The tool is called `bash`. On Windows it used to run cmd.exe, which is why
// every POSIX command came back mangled and a translation table had to explain
// that `ls` means `dir`. These tests pin the choice.

test('posix prefers bash and falls back to sh', () => {
  const withBash = resolveShell('linux', (file) => file === '/bin/bash')
  assert.equal(withBash.kind, 'bash')
  assert.equal(withBash.file, '/bin/bash')
  assert.deepEqual(withBash.args('ls -la'), ['-c', 'ls -la'])

  const withoutBash = resolveShell('linux', () => false)
  assert.equal(withoutBash.kind, 'sh')
  assert.equal(withoutBash.file, '/bin/sh')
})

test('windows uses Git bash when it can find one', () => {
  const shell = resolveShell('win32', (file) => /bash\.exe$/i.test(file))
  assert.equal(shell.kind, 'bash')
  assert.match(shell.file, /bash\.exe$/i)
  assert.deepEqual(shell.args('echo "$HOME"'), ['-c', 'echo "$HOME"'])
  assert.match(shell.describe(), /bash/)
})

test('windows falls back to cmd when there is no bash, and says so', () => {
  const shell = resolveShell('win32', () => false)
  assert.equal(shell.kind, 'cmd')
  assert.equal(shell.file, 'cmd.exe')
  assert.deepEqual(shell.args('dir'), ['/d', '/s', '/c', 'dir'])
  assert.match(shell.describe(), /cmd\.exe/)
})

test('OKAY_SHELL wins when it points at something real', () => {
  const previous = process.env.OKAY_SHELL
  process.env.OKAY_SHELL = 'C:\\tools\\bash.exe'
  try {
    const shell = resolveShell('win32', (file) => file === 'C:\\tools\\bash.exe')
    assert.equal(shell.file, 'C:\\tools\\bash.exe')
    assert.match(shell.describe(), /C:\\tools\\bash\.exe/)
  } finally {
    if (previous === undefined) delete process.env.OKAY_SHELL
    else process.env.OKAY_SHELL = previous
  }
})

test('a bogus OKAY_SHELL is ignored rather than breaking every command', () => {
  const previous = process.env.OKAY_SHELL
  process.env.OKAY_SHELL = 'C:\\nope\\bash.exe'
  try {
    // Only the real install locations exist; the bogus override must not match.
    const shell = resolveShell('win32', (file) => file.startsWith('C:\\Program Files\\Git'))
    assert.notEqual(shell.file, 'C:\\nope\\bash.exe')
  } finally {
    if (previous === undefined) delete process.env.OKAY_SHELL
    else process.env.OKAY_SHELL = previous
  }
})
