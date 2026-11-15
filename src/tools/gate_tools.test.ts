import test from 'node:test';
import assert from 'node:assert/strict';
import { IntentTool } from './gate_tools.js';
import { QualityGate } from '../agent/gate.js';
import { Agent } from '../agent/agent.js';

// A chat turn closes the completion gate, but the tool registry is shared by
// every task in the process. "count to 30" used to get an intent strip anyway:
// the model could still see `intent`, whose description told it to call the
// tool as soon as it understood the request. These pin both halves of the fix.

test('an ungated turn writes no intents even when the tool is called by name', async () => {
  const gate = new QualityGate({ settings: { mode: 'off' } });
  const result = await new IntentTool().execute(
    { intents: [{ id: 'i1', description: 'count to 30', status: 'done' }] },
    { gate, taskId: 't1', sessionId: 's1' } as any,
  );
  assert.equal(result.success, true);
  assert.equal(result.data?.skipped, true);
  assert.equal(gate.ledger.current.intents.length, 0);
});

test('a gated turn still records its intents', async () => {
  const gate = new QualityGate({ settings: { mode: 'full' } });
  const result = await new IntentTool().execute(
    { intents: [{ id: 'i1', description: 'fix the login redirect', status: 'in_progress' }] },
    { gate, taskId: 't2', sessionId: 's1' } as any,
  );
  assert.equal(result.success, true);
  assert.equal(gate.ledger.current.intents.length, 1);
});

test('the intent tool is hidden for the ungated task only', () => {
  // toolVisible is private and per-task; calling it with a minimal `this`
  // exercises the real predicate without constructing a whole Agent runtime.
  const visibleFor = (ungated: string[], taskId: string) => (Agent.prototype as any).toolVisible.call({
    extensions: undefined,
    settings: { tool_disclosure: 'groups' },
    ungatedTasks: new Set(ungated),
    loadedGroups: () => new Set(['core']),
  }, taskId);
  assert.equal(visibleFor(['t1'], 't1')('intent'), false);
  assert.equal(visibleFor(['t1'], 't1')('read'), true);
  assert.equal(visibleFor(['t1'], 't2')('intent'), true);
});
