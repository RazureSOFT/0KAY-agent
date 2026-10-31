import test from 'node:test'
import assert from 'node:assert/strict'
import * as os from 'node:os'
import { ShellSession } from './shell_session.js'

const win = process.platform === 'win32'

test('state survives between commands', async () => {
  const session = new ShellSession(os.tmpdir())
  try {
    await session.run(win ? 'Set-Location $env:TEMP' : 'cd /tmp')
    // A bare expression is not echoed in stdin mode; a pipeline always is.
    const where = await session.run(win ? 'Get-Location | Select-Object -ExpandProperty Path' : 'pwd')
    assert.match(where.output.toLowerCase(), /temp/)
  } finally {
    session.dispose()
  }
})

test('captures output and exit code', async () => {
  const session = new ShellSession(os.tmpdir())
  try {
    const ok = await session.run(win ? 'Write-Output hi' : 'echo hi')
    assert.match(ok.output, /hi/)
    assert.equal(ok.exitCode, 0)
    assert.equal(ok.timedOut, false)
  } finally {
    session.dispose()
  }
})

test('a command that outlives the timeout drops the session', async () => {
  const session = new ShellSession(os.tmpdir())
  try {
    const slow = await session.run(win ? 'Start-Sleep -Seconds 10' : 'sleep 10', 1000)
    assert.equal(slow.timedOut, true)
    assert.equal(session.alive, false)
  } finally {
    session.dispose()
  }
})
