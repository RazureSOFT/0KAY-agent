import test from 'node:test';
import assert from 'node:assert/strict';
import { DeliverySupervisor, supervisionDirective } from './supervision.js';

test('doom-loop: repeated identical calls escalate delivery to RED', () => {
  const s = new DeliverySupervisor({ repeatThreshold: 3 });
  for (let i = 0; i < 3; i++) s.recordToolCall('shell', { command: 'ls -la' }, false);
  const report = s.evaluateDelivery('done');
  assert.equal(report.status, 'RED');
  assert.ok(report.repeats >= 3);
  assert.ok(report.reasons.some((r) => r.includes('Suspect loop')));
});

test('unverified mutation: edits with no evidence yield YELLOW', () => {
  const s = new DeliverySupervisor();
  s.recordToolCall('edit', { path: 'a.ts', oldString: 'x', newString: 'y' }, true);
  s.recordToolCall('write', { path: 'b.ts', content: 'z'.repeat(500) }, true);
  const report = s.evaluateDelivery('implemented');
  assert.equal(report.status, 'YELLOW');
  assert.equal(report.mutations, 2);
  assert.deepEqual(report.evidence, []);
});

test('verified mutation: a test run turns the delivery GREEN', () => {
  const s = new DeliverySupervisor();
  s.recordToolCall('edit', { path: 'a.ts', oldString: 'x', newString: 'y' }, true);
  s.recordToolCall('shell', { command: 'npm test' }, true);
  s.recordToolCall('shell', { command: 'npx tsc --noEmit' }, true);
  const report = s.evaluateDelivery('done');
  assert.equal(report.status, 'GREEN');
  assert.ok(report.evidence.includes('test'));
  assert.ok(report.evidence.includes('typecheck'));
});

test('evidence detection is case-insensitive and covers go/python/cargo', () => {
  const s = new DeliverySupervisor();
  s.recordToolCall('shell', { command: 'cd core && go test ./...' }, true);
  s.recordToolCall('shell', { command: 'python -m pytest tests -q' }, true);
  s.recordToolCall('shell', { command: 'cargo test' }, true);
  s.recordToolCall('shell', { command: 'gofmt -l .' }, true);
  assert.deepEqual(new Set(s.evaluateDelivery('x').evidence), new Set(['test', 'lint']));
});

test('mutating-tool classification and arg normalization are stable', () => {
  const s = new DeliverySupervisor();
  s.recordToolCall('write', '{"path":"a","content":"' + 'A'.repeat(1000) + '"}', true);
  s.recordToolCall('read', '{"path":"a"}', true);
  assert.equal(s.toolCallCount, 2);
  assert.equal(s.report().mutations, 1);
});

test('no-mutation, no-evidence delivery is GREEN with an informational warning', () => {
  const s = new DeliverySupervisor();
  s.recordToolCall('read', { path: 'README.md' }, true);
  const report = s.evaluateDelivery('the file describes X');
  assert.equal(report.status, 'GREEN');
  assert.equal(report.warnings.length, 1);
});

test('reset clears the trace', () => {
  const s = new DeliverySupervisor();
  s.recordToolCall('edit', { path: 'a' }, true);
  s.reset();
  assert.equal(s.toolCallCount, 0);
});

test('directive carries the runtime delivery gate belief', () => {
  const d = supervisionDirective();
  assert.ok(d.includes('Delivery rules'));
  assert.ok(d.includes('evidence'));
});
