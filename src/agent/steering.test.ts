import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SteeringQueue } from './steering.js';

/**
 * The box above the composer stops accepting text when the agent finishes.
 *
 * The queue used to stay open for the life of the process: a task that ended
 * still accepted interjections, and the map kept one entry per task ever run.
 * Both are the same defect — `close` existed but nothing called it — so this
 * covers the queue's own contract and the end-of-task call site separately.
 */
describe('steering queue', () => {
  it('queues for a task that is open', () => {
    const queue = new SteeringQueue();
    queue.open('t1');
    const result = queue.push('t1', 's1', 'also update the docs');
    assert.equal(result.ok, true);
    assert.equal(result.queued, 1);
    assert.ok(result.id);
  });

  it('refuses a task that is not running here', () => {
    const queue = new SteeringQueue();
    const result = queue.push('missing', 's1', 'hello');
    assert.equal(result.ok, false);
    assert.match(result.reason || '', /not running/);
  });

  it('refuses an empty line', () => {
    const queue = new SteeringQueue();
    queue.open('t1');
    assert.equal(queue.push('t1', 's1', '   ').ok, false);
  });

  it('caps the queue so one long build cannot collect forever', () => {
    const queue = new SteeringQueue();
    queue.open('t1');
    for (let i = 0; i < 8; i += 1) assert.equal(queue.push('t1', 's1', `line ${i}`).ok, true);
    assert.equal(queue.push('t1', 's1', 'line 8').ok, false);
  });

  it('drains as one block, because one tool call is one interruption', () => {
    const queue = new SteeringQueue();
    queue.open('t1');
    queue.push('t1', 's1', 'first');
    queue.push('t1', 's1', 'second');
    assert.deepEqual(queue.drain('t1').map((entry) => entry.text), ['first', 'second']);
    assert.equal(queue.pending('t1'), 0);
  });

  it('takes back one entry by id while it is still waiting', () => {
    const queue = new SteeringQueue();
    queue.open('t1');
    const kept = queue.push('t1', 's1', 'keep me');
    const gone = queue.push('t1', 's1', 'take this back');
    assert.equal(queue.remove('t1', gone.id!), true);
    assert.deepEqual(queue.list('t1').map((entry) => entry.text), ['keep me']);
    assert.equal(queue.pending('t1'), 1);
    assert.equal(queue.remove('t1', kept.id!), true);
  });

  it('will not take back an entry it already delivered', () => {
    const queue = new SteeringQueue();
    queue.open('t1');
    const entry = queue.push('t1', 's1', 'applied already');
    queue.drain('t1');
    assert.equal(queue.remove('t1', entry.id!), false);
  });

  it('closing a task empties it and reports what was dropped', () => {
    const queue = new SteeringQueue();
    queue.open('t1');
    queue.push('t1', 's1', 'never read');
    const dropped = queue.close('t1');
    assert.deepEqual(dropped.map((entry) => entry.text), ['never read']);
    assert.equal(queue.pending('t1'), 0);
    assert.equal(queue.push('t1', 's1', 'too late').ok, false);
    assert.deepEqual(queue.activeTasks, []);
  });

  it('keeps tasks apart', () => {
    const queue = new SteeringQueue();
    queue.open('a');
    queue.open('b');
    queue.push('a', 'sa', 'for a');
    queue.push('b', 'sb', 'for b');
    assert.deepEqual(queue.list('a').map((entry) => entry.text), ['for a']);
    assert.deepEqual(queue.list('b').map((entry) => entry.text), ['for b']);
  });
});