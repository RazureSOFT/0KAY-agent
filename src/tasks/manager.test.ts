import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { TaskManager, type TaskNotification } from './manager.js'

// These tests spawn real processes: the whole point of the manager is what a
// detached child does with its stdout, which a fake cannot answer.
function makeManager() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), '0kay-tasks-test-'))
  const notes: TaskNotification[] = []
  const manager = new TaskManager({ root, sessionId: 'test', onNotify: (event) => notes.push(event) })
  return { manager, notes }
}

const isWindows = process.platform === 'win32'

test('captures output and reports completion', async () => {
  const { manager, notes } = makeManager()
  const started = manager.start(isWindows ? 'Write-Output hello' : 'echo hello')
  assert.equal(started.id, 'task_1')

  assert.equal(await manager.wait(started.id, 15000), 'completed')
  assert.match(manager.output(started.id) || '', /hello/)
  assert.equal(manager.get(started.id)?.exitCode, 0)
  // The notification must arrive only after the file is closed, so a consumer
  // that reads on notify always sees the whole output.
  assert.deepEqual(notes.map((n) => n.taskId), ['task_1'])
  assert.equal(notes[0].status, 'completed')
  manager.dispose()
})

test('marks a failing command as failed and keeps the exit code', async () => {
  const { manager } = makeManager()
  const started = manager.start('exit 3')
  await manager.wait(started.id, 15000)
  const info = manager.get(started.id)!
  assert.equal(info.status, 'failed')
  assert.equal(info.exitCode, 3)
  manager.dispose()
})

test('lists tasks in start order', async () => {
  const { manager } = makeManager()
  const a = manager.start(isWindows ? 'Write-Output a' : 'echo a')
  const b = manager.start(isWindows ? 'Write-Output b' : 'echo b')
  await manager.wait(b.id, 15000)
  assert.deepEqual(manager.list().map((t) => t.id), [a.id, b.id])
  manager.dispose()
})

test('stops a long-running task', async () => {
  const { manager } = makeManager()
  const started = manager.start(isWindows ? 'Start-Sleep -Seconds 30' : 'sleep 30', 'monitor')
  assert.equal(manager.get(started.id)?.status, 'running')
  assert.equal(manager.stop(started.id), true)
  await manager.wait(started.id, 15000)
  assert.ok(['killed', 'failed'].includes(manager.get(started.id)!.status))
  manager.dispose()
})

test('returns a trimmed tail for large output', async () => {
  const { manager } = makeManager()
  const command = isWindows
    ? '1..200 | ForEach-Object { "line $_ padded to make this reasonably long" }'
    : 'for i in $(seq 1 200); do echo "line $i padded to make this reasonably long"; done'
  const started = manager.start(command)
  await manager.wait(started.id, 15000)
  const tail = manager.output(started.id, 120)!
  assert.match(tail, /bytes trimmed/)
  assert.match(tail, /line 200/)
  manager.dispose()
})

test('rejects unknown task ids instead of pretending', () => {
  const { manager } = makeManager()
  assert.equal(manager.get('task_999'), undefined)
  assert.equal(manager.output('task_999'), undefined)
  assert.equal(manager.stop('task_999'), false)
  manager.dispose()
})
