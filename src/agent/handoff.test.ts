import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHandoffDoc, fromHandoffJson } from './handoff.js';

test('buildHandoffDoc renders all sections with placeholders when empty', () => {
  const doc = buildHandoffDoc({ taskId: 't1', prompt: 'do X', result: 'did X' });
  for (const heading of ['## 目标', '## 结果', '## 产物', '## 验证证据', '## 未决 / 限制', '## 下一步']) {
    assert.ok(doc.includes(heading), `missing ${heading}`);
  }
  assert.ok(doc.includes('do X'));
  assert.ok(doc.includes('did X'));
  assert.ok(doc.includes('(无)'));
});

test('buildHandoffDoc lists artifacts and evidence', () => {
  const doc = buildHandoffDoc({
    taskId: 't2',
    prompt: 'p',
    result: 'r',
    artifacts: [{ path: 'src/a.ts', usage: 'entry' }],
    evidence: ['test', 'typecheck'],
    next: ['wire into loop'],
  });
  assert.ok(doc.includes('`src/a.ts` — entry'));
  assert.ok(doc.includes('- test'));
  assert.ok(doc.includes('- wire into loop'));
});

test('fromHandoffJson maps the compact JSON handoff and tolerates garbage', () => {
  const mapped = fromHandoffJson('t3', 'prompt', '{"artifacts":[{"path":"x","usage":"u"}],"outcome":"ok","limitations":"none"}');
  assert.equal(mapped.taskId, 't3');
  assert.equal(mapped.result, 'ok');
  assert.equal(mapped.limitations, 'none');
  assert.deepEqual(mapped.artifacts, [{ path: 'x', usage: 'u' }]);

  const broken = fromHandoffJson('t4', 'p', 'not json');
  assert.deepEqual(broken.artifacts, []);
  assert.equal(broken.result, '');
});

test('long fields are clipped', () => {
  const doc = buildHandoffDoc({ taskId: 't5', prompt: 'A'.repeat(5000), result: 'r' });
  assert.ok(doc.includes('(truncated)'));
});
