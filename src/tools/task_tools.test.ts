import test from 'node:test'
import assert from 'node:assert/strict'
import { SleepTool, MonitorTool, TaskOutputTool, TaskStopTool, resetTaskManagers } from './task_tools.js'
import type { ToolContext } from './types.js'

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return { cwd: process.cwd(), taskId: 't', sessionId: `s-${Math.random()}`, agentType: 'general', ...overrides }
}

test('sleep returns after the requested seconds', async () => {
  const started = Date.now()
  const result = await new SleepTool().execute({ seconds: 1 }, context())
  assert.equal(result.success, true)
  assert.equal(result.data, 'slept 1s')
  assert.ok(Date.now() - started >= 900)
})

test('sleep clamps out-of-range input instead of hanging', async () => {
  // 0 must become 1s, not an instant return or an unbounded wait.
  const result = await new SleepTool().execute({ seconds: 0 }, context())
  assert.equal(result.data, 'slept 1s')

  const started = Date.now()
  const aborted = new AbortController()
  aborted.abort()
  // An already-aborted run never waits at all, even for a big number.
  const interrupted = await new SleepTool().execute({ seconds: 3600 }, context({ signal: aborted.signal }))
  assert.equal(interrupted.data, 'sleep interrupted')
  assert.ok(Date.now() - started < 500)
})

test('sleep stops early when the run is aborted', async () => {
  const controller = new AbortController()
  const promise = new SleepTool().execute({ seconds: 30 }, context({ signal: controller.signal }))
  setTimeout(() => controller.abort(), 50)
  const result = await promise
  assert.equal(result.data, 'sleep interrupted')
})

test('monitor starts a background task that TaskOutput can read and TaskStop ends', async () => {
  const ctx = context()
  try {
    const started = await new MonitorTool().execute(
      { command: process.platform === 'win32' ? '1..3 | ForEach-Object { "tick $_"; Start-Sleep -Milliseconds 100 }' : 'for i in 1 2 3; do echo "tick $i"; sleep 0.1; done' },
      ctx,
    )
    assert.equal(started.success, true)
    const id = (started.data as any).task_id as string
    assert.match(id, /^task_\d+$/)

    // Let it produce a line, then read through the same session's manager.
    await new SleepTool().execute({ seconds: 1 }, ctx)
    const output = await new TaskOutputTool().execute({ task_id: id }, ctx)
    assert.equal(output.success, true)
    assert.match(String((output.data as any).output), /tick/)

    await new TaskStopTool().execute({ task_id: id }, ctx)
  } finally {
    resetTaskManagers()
  }
})

test('monitor refuses an empty command', async () => {
  const result = await new MonitorTool().execute({ command: '  ' }, context())
  assert.equal(result.success, false)
  assert.match(String(result.error), /required/)
})
