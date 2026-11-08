import test from 'node:test';
import assert from 'node:assert/strict';
import { IntentLedger, deriveCompletion } from './intent.js';
import { QualityGate, resolveGateMode, type GateInput } from './gate.js';
import type { LlmCaller } from '../tools/types.js';

function gateInput(overrides: Partial<GateInput> = {}): GateInput {
  return {
    taskId: 'task-1',
    sessionId: 'session-1',
    cwd: process.cwd(),
    userIntent: 'Add a login form to the settings page',
    claim: 'Done: the login form is in place.',
    // The default gate has plan-before-code on, and this fixture is a mutating
    // task, so it carries the plan a real run would have recorded.
    approach: 'edit SettingsPage.vue, then run vue-tsc',
    completionRate: 100,
    trace: [],
    delivery: { status: 'GREEN', reasons: [], warnings: [], evidence: [], mutations: 1, repeats: 0 },
    transcript: '',
    touched: ['src/SettingsPage.vue'],
    ...overrides,
  };
}

test('an empty intent ledger blocks a 100% claim without calling the reviewer', async () => {
  let calls = 0;
  const llm: LlmCaller = async () => { calls++; return '{"verdict":"pass"}' };
  const gate = new QualityGate({ settings: { mode: 'full' } });
  const outcome = await gate.evaluate(gateInput(), llm);
  assert.equal(outcome.pass, false);
  assert.equal(outcome.payload.status, 'reject');
  assert.equal(calls, 0, 'the mechanical rules must reject before paying for a review');
  assert.match(String(outcome.payload.fix_feedback), /intent/i);
});

test('a done intent without evidence is rejected', async () => {
  const gate = new QualityGate({ settings: { mode: 'full' } });
  gate.updateIntents([{ id: 'i1', description: 'login form', status: 'done' }]);
  const llm: LlmCaller = async () => { throw new Error('reviewer must not run') };
  const outcome = await gate.evaluate(gateInput(), llm);
  assert.equal(outcome.pass, false);
  assert.match(String(outcome.payload.fix_feedback), /evidence/i);
});

test('open intents keep the completion rate below 100 and are listed as missing', async () => {
  const gate = new QualityGate({ settings: { mode: 'full' } });
  gate.updateIntents([
    { id: 'i1', description: 'login form', status: 'done', evidence: 'edit src/SettingsPage.vue:40' },
    { id: 'i2', description: 'password reset link', status: 'pending' },
  ]);
  const outcome = await gate.evaluate(gateInput(), async () => '{"verdict":"pass"}');
  assert.equal(outcome.pass, false);
  assert.equal(outcome.payload.actual_completion, '50%');
  assert.deepEqual(outcome.payload.missing_intents, ['password reset link']);
});

test('a reviewer pass returns status success as the tool response', async () => {
  const gate = new QualityGate({ settings: { mode: 'full' } });
  gate.updateIntents([{ id: 'i1', description: 'login form', status: 'done', evidence: 'src/SettingsPage.vue:40' }]);
  const seen: string[] = [];
  const llm: LlmCaller = async (request) => {
    seen.push(String(request.systemPrompt).slice(0, 40));
    return '{"verdict":"pass","actual_completion":100,"missing_intents":[],"fix_feedback":"","audit":"read SettingsPage.vue"}';
  };
  const outcome = await gate.evaluate(gateInput(), llm);
  assert.equal(outcome.pass, true);
  assert.deepEqual(outcome.payload.status, 'success');
  assert.equal(seen.length, 1, 'the reviewer runs once');
});

test('a reviewer reject returns the structured payload and increments the counter', async () => {
  const gate = new QualityGate({ settings: { mode: 'full' } });
  gate.updateIntents([{ id: 'i1', description: 'login form', status: 'done', evidence: 'src/SettingsPage.vue:40' }]);
  const llm: LlmCaller = async () => JSON.stringify({
    verdict: 'reject',
    actual_completion: 60,
    missing_intents: ['the form does not submit'],
    fix_feedback: 'wire the submit handler',
    audit: 'read the component',
  });
  const outcome = await gate.evaluate(gateInput(), llm);
  assert.equal(outcome.pass, false);
  assert.equal(outcome.payload.status, 'reject');
  assert.equal(outcome.payload.actual_completion, '60%');
  assert.equal(outcome.rejectCount, 1);
  // The reviewer's missing intent became a real intent, so the next claim has
  // to account for it.
  assert.ok(gate.ledger.current.intents.some((intent) => intent.description === 'the form does not submit'));
});

test('three consecutive rejects exhaust the gate and stop the task', async () => {
  const gate = new QualityGate({ settings: { mode: 'full', maxRejects: 3 } });
  gate.updateIntents([{ id: 'i1', description: 'login form', status: 'done', evidence: 'file' }]);
  const llm: LlmCaller = async () => '{"verdict":"reject","actual_completion":40,"missing_intents":["submit"],"fix_feedback":"wire it"}';
  // Each rejection adds the reviewer's missing intent, and the mechanical rules
  // reject an open intent before the reviewer runs. The agent's fix is to mark
  // it done with evidence, which is exactly what the loop is supposed to do.
  const closeGap = () => gate.updateIntents(gate.ledger.current.intents.map((intent) => ({
    id: intent.id,
    description: intent.description,
    status: 'done',
    evidence: 'src/SettingsPage.vue:88',
  })));
  const first = await gate.evaluate(gateInput(), llm);
  closeGap();
  const second = await gate.evaluate(gateInput(), llm);
  closeGap();
  const third = await gate.evaluate(gateInput(), llm);
  assert.equal(first.exhausted, false);
  assert.equal(second.exhausted, false);
  assert.equal(third.exhausted, true);
  assert.equal(third.payload.status_final, 'human_takeover');
});

test('a passing review resets the reject counter', async () => {
  const gate = new QualityGate({ settings: { mode: 'full', maxRejects: 3 } });
  gate.updateIntents([{ id: 'i1', description: 'x', status: 'done', evidence: 'file' }]);
  let verdict = 'reject';
  const llm: LlmCaller = async () => JSON.stringify({ verdict, actual_completion: verdict === 'pass' ? 100 : 40, missing_intents: [], fix_feedback: 'fix', audit: '' });
  await gate.evaluate(gateInput(), llm);
  verdict = 'pass';
  const pass = await gate.evaluate(gateInput(), llm);
  assert.equal(pass.pass, true);
  assert.equal(gate.stats.rejects, 0);
});

test('rules mode never calls a model', async () => {
  const gate = new QualityGate({ settings: { mode: 'rules' } });
  gate.updateIntents([{ id: 'i1', description: 'x', status: 'done', evidence: 'file' }]);
  let calls = 0;
  const outcome = await gate.evaluate(gateInput(), async () => { calls++; return '{"verdict":"reject"}' });
  assert.equal(calls, 0);
  assert.equal(outcome.pass, true);
  assert.equal(outcome.payload.source, 'rules');
});

test('an unreachable reviewer passes the task with the degradation recorded', async () => {
  const gate = new QualityGate({ settings: { mode: 'full' } });
  gate.updateIntents([{ id: 'i1', description: 'x', status: 'done', evidence: 'file' }]);
  const outcome = await gate.evaluate(gateInput(), async () => { throw new Error('model offline') });
  assert.equal(outcome.pass, true);
  assert.match(String(outcome.payload.degraded), /offline/);
});

test('off mode disables the gate entirely', () => {
  const gate = new QualityGate({ settings: { mode: 'off' } });
  assert.equal(gate.enabled, false);
  assert.equal(gate.directive(), '');
});

test('gate modes parse from the settings strings a human types', () => {
  assert.equal(resolveGateMode('off'), 'off');
  assert.equal(resolveGateMode('0'), 'off');
  assert.equal(resolveGateMode('rules'), 'rules');
  assert.equal(resolveGateMode('1'), 'rules');
  assert.equal(resolveGateMode('full'), 'full');
  assert.equal(resolveGateMode('strict'), 'full');
  assert.equal(resolveGateMode('nonsense', 'rules'), 'rules');
});

test('intent scoring weights done, in progress and blocked', () => {
  const ledger = new IntentLedger();
  ledger.update([
    { id: 'i1', description: 'a', status: 'done', evidence: 'file' },
    { id: 'i2', description: 'b', status: 'in_progress' },
    { id: 'i3', description: 'c', status: 'blocked' },
  ]);
  assert.equal(deriveCompletion(ledger.current.intents), 50);
});

test('a re-sent intent list updates in place instead of duplicating', () => {
  const ledger = new IntentLedger();
  ledger.update([{ id: 'i1', description: 'login', status: 'pending' }]);
  ledger.update([{ id: 'i1', description: 'login', status: 'done', evidence: 'file:1' }]);
  assert.equal(ledger.current.intents.length, 1);
  assert.equal(ledger.current.intents[0].status, 'done');
});

test('an intent matched by description merges even when the id changed', () => {
  const ledger = new IntentLedger();
  ledger.update([{ id: 'i1', description: 'login form', status: 'pending' }]);
  ledger.update([{ id: 'x9', description: 'Login Form', status: 'in_progress' }]);
  assert.equal(ledger.current.intents.length, 1);
  assert.equal(ledger.current.intents[0].status, 'in_progress');
});

test('plan before code: a mutating task with no approach is rejected by the ledger', async () => {
  const gate = new QualityGate({ settings: { mode: 'full' } });
  gate.updateIntents([{ id: 'i1', description: 'login form', status: 'done', evidence: 'src/SettingsPage.vue:40' }]);
  let calls = 0;
  const outcome = await gate.evaluate(gateInput({ approach: '' }), async () => { calls++; return '{"verdict":"pass"}' });
  assert.equal(outcome.pass, false);
  assert.equal(calls, 0, 'an unplanned claim never reaches the reviewer');
  assert.match(String(outcome.payload.fix_feedback), /Plan first/);
});

test('plan before code: the approach line satisfies the rule', async () => {
  const gate = new QualityGate({ settings: { mode: 'full' } });
  gate.updateIntents([{ id: 'i1', description: 'login form', status: 'done', evidence: 'src/SettingsPage.vue:40' }], 'edit SettingsPage.vue, run vue-tsc');
  const outcome = await gate.evaluate(gateInput(), async () => '{"verdict":"pass"}');
  assert.equal(outcome.pass, true);
});

test('plan before code: every intent having a method also satisfies it', async () => {
  const gate = new QualityGate({ settings: { mode: 'full' } });
  gate.updateIntents([{ id: 'i1', description: 'login form', method: 'edit SettingsPage.vue', status: 'done', evidence: 'src/SettingsPage.vue:40' }]);
  const outcome = await gate.evaluate(gateInput(), async () => '{"verdict":"pass"}');
  assert.equal(outcome.pass, true);
});

test('plan before code: a read-only task owes no plan', async () => {
  const gate = new QualityGate({ settings: { mode: 'full' } });
  gate.updateIntents([{ id: 'i1', description: 'explain the gate', status: 'done', evidence: 'read gate.ts' }]);
  const outcome = await gate.evaluate(
    gateInput({ delivery: { status: 'GREEN', reasons: [], warnings: [], evidence: [], mutations: 0, repeats: 0 } }),
    async () => '{"verdict":"pass"}',
  );
  assert.equal(outcome.pass, true, 'answering a question is not a change and must not need a plan');
});

test('plan before code can be switched off for a project that does not want it', async () => {
  const gate = new QualityGate({ settings: { mode: 'rules', requirePlan: false } });
  gate.updateIntents([{ id: 'i1', description: 'login form', status: 'done', evidence: 'src/SettingsPage.vue:40' }]);
  const outcome = await gate.evaluate(gateInput(), async () => '{"verdict":"pass"}');
  assert.equal(outcome.pass, true);
});

test('the directive tells the model about the plan rule only when it is on', () => {
  const on = new QualityGate({ settings: { requirePlan: true } }).directive();
  const off = new QualityGate({ settings: { requirePlan: false } }).directive();
  assert.match(on, /Plan before code/);
  assert.doesNotMatch(off, /Plan before code/);
});
