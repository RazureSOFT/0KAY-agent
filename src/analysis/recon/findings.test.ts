import test from 'node:test'
import assert from 'node:assert/strict'
import { FindingStore, isActive } from './findings.js'

const base = { taskId: 'as_1', sessionId: 's1', text: 'auth bypass with empty password', assets: ['example.test'] }

test('a finding gets an id that outlives the task', () => {
  const store = new FindingStore()
  const finding = store.add(base)
  assert.match(finding.id, /^fi_/)
  assert.equal(store.get(finding.id)?.text, base.text)
  assert.equal(store.forTask('as_1').length, 1)
  assert.equal(store.forTask('other').length, 0)
})

test('empty text is refused rather than stored as a blank row', () => {
  const store = new FindingStore()
  assert.throws(() => store.add({ ...base, text: '   ' }), /text is required/)
})

test('a retest cannot start twice on the same finding', () => {
  const store = new FindingStore()
  const finding = store.add(base)
  const first = store.startRetest(finding.id)
  assert.equal(isActive(first), true)
  assert.throws(() => store.startRetest(finding.id), /already running/)
  // Once it concludes, a new attempt is allowed: that is the point of retesting.
  store.complete(first.id, { verdict: 'reproduced' })
  const second = store.startRetest(finding.id)
  assert.equal(second.status, 'pending')
})

test('completing requires a verdict, so a retest cannot end without an answer', () => {
  const store = new FindingStore()
  const finding = store.add(base)
  const retest = store.startRetest(finding.id)
  store.markRunning(retest.id)
  const done = store.complete(retest.id, { verdict: 'fixed', summary: 'payload now rejected' })
  assert.equal(done.status, 'completed')
  assert.equal(done.verdict, 'fixed')
  assert.ok(done.finishedAt)
})

test('a failed retest keeps its reason and is not counted as active', () => {
  const store = new FindingStore()
  const finding = store.add(base)
  const retest = store.startRetest(finding.id)
  const failed = store.fail(retest.id, 'target unreachable')
  assert.equal(failed.status, 'failed')
  assert.equal(failed.error, 'target unreachable')
  assert.equal(isActive(failed), false)
})

test('history is newest first, so the latest verdict is the first row', () => {
  const store = new FindingStore()
  const finding = store.add(base)
  const first = store.startRetest(finding.id)
  store.complete(first.id, { verdict: 'reproduced' })
  const second = store.startRetest(finding.id)
  store.complete(second.id, { verdict: 'fixed' })
  const history = store.forFinding(finding.id)
  assert.equal(history[0].id, second.id)
})

test('a snapshot restores findings and their retests', () => {
  const store = new FindingStore()
  const finding = store.add(base)
  const retest = store.startRetest(finding.id)
  const snapshot = JSON.parse(JSON.stringify(store.toJSON()))
  const restored = new FindingStore()
  restored.restore(snapshot)
  assert.equal(restored.get(finding.id)?.text, base.text)
  assert.equal(restored.retest(retest.id)?.status, 'pending')
  assert.equal(restored.activeRetests().length, 1)
})
