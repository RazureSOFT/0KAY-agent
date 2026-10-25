import test from 'node:test'
import assert from 'node:assert/strict'
import { SessionDirectives } from './directives.js'

// Directives are cosmetics with a queue: the cap drops the oldest, the ack
// removes exactly what was applied, and the list filters by session.

test('a directive queues with an id and lists per session', () => {
  const directives = new SessionDirectives()
  const title = directives.add({ session_id: 's1', kind: 'title', title: 'Fix login loop' })
  const toast = directives.add({ session_id: 's2', kind: 'toast', text: 'build green', level: 'success' })
  assert.ok(title.id && toast.id && title.id !== toast.id)
  assert.equal(directives.list('s1').length, 1)
  assert.equal(directives.list('s2')[0].text, 'build green')
  assert.equal(directives.list().length, 2)
  assert.equal(directives.list('s3').length, 0)
})

test('the cap drops the oldest, not the newest', () => {
  const directives = new SessionDirectives()
  for (let i = 0; i < 55; i++) directives.add({ session_id: 's', kind: 'toast', text: `n${i}` })
  assert.equal(directives.size, 50)
  const listed = directives.list()
  assert.equal(listed[0].text, 'n5', 'the first five were dropped')
  assert.equal(listed[listed.length - 1].text, 'n54')
})

test('ack removes exactly the ids it was given', () => {
  const directives = new SessionDirectives()
  const first = directives.add({ session_id: 's', kind: 'title', title: 'a' })
  const second = directives.add({ session_id: 's', kind: 'toast', text: 'b' })
  assert.equal(directives.ack([first.id, 'nope']), 1)
  assert.equal(directives.list().length, 1)
  assert.equal(directives.ack([second.id]), 1)
  assert.equal(directives.size, 0)
})
