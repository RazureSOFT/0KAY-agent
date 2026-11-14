import test from 'node:test';
import assert from 'node:assert/strict';
import { IdleEvolve, parseIdleAction } from './evolve_idle.js';

function harness(action: 'off' | 'notify' | 'auto' = 'notify', idleMinutes = 30) {
  let now = 0;
  const fired: number[] = [];
  const idle = new IdleEvolve({
    action,
    idleMinutes,
    now: () => now,
    onIdle: (info) => { fired.push(info.idleMs); },
  });
  return {
    idle,
    fired,
    advance(minutes: number) { now += minutes * 60_000; },
    setNow(value: number) { now = value; },
    get now() { return now; },
  };
}

test('off never proposes anything', () => {
  const h = harness('off');
  h.advance(600);
  h.idle.tick();
  assert.deepEqual(h.fired, []);
});

test('a proposal fires only after the idle window', () => {
  const h = harness('notify', 30);
  h.advance(29);
  h.idle.tick();
  assert.deepEqual(h.fired, [], 'not idle long enough');
  h.advance(2);
  h.idle.tick();
  assert.equal(h.fired.length, 1);
  assert.equal(h.fired[0], 31 * 60_000);
});

test('a cooldown stops the same idle period from proposing twice', () => {
  const h = harness('notify', 30);
  h.advance(31);
  h.idle.tick();
  h.advance(1);
  h.idle.tick();
  assert.equal(h.fired.length, 1, 'cooldown holds');
  h.advance(360);
  h.idle.tick();
  assert.equal(h.fired.length, 2, 'after the cooldown it may propose again');
});

test('activity restarts the clock', () => {
  const h = harness('notify', 30);
  h.advance(25);
  h.idle.touch();
  h.advance(20);
  h.idle.tick();
  assert.deepEqual(h.fired, [], 'the clock restarted on activity');
  h.advance(11);
  h.idle.tick();
  assert.equal(h.fired.length, 1);
});

test('configure can turn it on at runtime', () => {
  const h = harness('off');
  h.advance(120);
  h.idle.tick();
  assert.deepEqual(h.fired, []);
  h.idle.configure({ action: 'auto', idleMinutes: 5 });
  h.idle.tick();
  assert.equal(h.fired.length, 1);
  assert.equal(h.idle.status().action, 'auto');
});

test('a throwing proposal does not break the timer', () => {
  const idle = new IdleEvolve({
    action: 'notify', idleMinutes: 1, now: () => 1e9,
    onIdle: () => { throw new Error('boom'); },
  });
  assert.doesNotThrow(() => idle.tick());
});

test('the setting parses to a known action', () => {
  assert.equal(parseIdleAction('auto'), 'auto');
  assert.equal(parseIdleAction('NOTIFY'), 'notify');
  assert.equal(parseIdleAction(''), 'off');
  assert.equal(parseIdleAction('true'), 'off', 'a bare boolean is not an action');
});
