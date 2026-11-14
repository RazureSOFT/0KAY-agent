import test from 'node:test';
import assert from 'node:assert/strict';
import { TrafficStore, EvidenceStore, redactHeaders, boundedBody, snapshotHash } from './records.js';
import { RuleSet, Notifier, matchesRule, searchableText } from './policy.js';
import { LlmPool, SideQuestionBus } from './llm.js';
import { enrichAsset, buildReport } from './report.js';
import { resetRuntime, RUNTIME_TOOLS } from '../../tools/packages/runtime.js';
import { createDefaultRegistry } from '../../tools/tools.js';
import type { ToolContext } from '../../tools/types.js';

const ctx = (extra: Partial<ToolContext> = {}): ToolContext => ({
  cwd: process.cwd(), taskId: 't', agentType: 'general', sessionId: 'test-session', ...extra,
}) as ToolContext;

test('traffic redacts credential containers and bounds bodies', () => {
  const headers = redactHeaders({
    Authorization: 'Bearer sk-live-123', Cookie: 'session=abc', 'X-Trace': 'ok',
    'X-Api-Key': 'xyz', Accept: 'application/json',
  });
  assert.equal(headers.Authorization, '[redacted]');
  assert.equal(headers.Cookie, '[redacted]');
  assert.equal(headers['X-Api-Key'], '[redacted]');
  assert.equal(headers.Accept, 'application/json');
  assert.equal(headers['X-Trace'], 'ok');
  const big = boundedBody('x'.repeat(200_000), 32);
  assert.equal(big.truncated, true);
  assert.equal(big.text.length, 32);
});

test('traffic records, filters and searches without leaking secrets', () => {
  let now = 1000;
  const store = new TrafficStore({ now: () => now, max: 3 });
  const first = store.record({
    method: 'post', url: 'https://a.example.com/login',
    requestHeaders: { Authorization: 'Bearer secret' }, requestBody: 'user=admin',
    status: 200, responseHeaders: {}, responseBody: 'token=abc123', tags: ['login'],
  });
  assert.equal(first.requestHeaders.Authorization, '[redacted]');
  assert.equal(first.method, 'POST');
  assert.equal(first.host, 'a.example.com');
  now += 10;
  store.record({ method: 'GET', url: 'https://b.example.com/health', status: 503 });
  store.record({ method: 'GET', url: 'https://a.example.com/admin', status: 403 });
  store.record({ method: 'GET', url: 'https://a.example.com/', status: 200 });
  assert.equal(store.list({ limit: 100 }).length, 3, 'the ring keeps only the newest three');
  assert.equal(store.get(first.id), undefined, 'evicted rows are gone');
  assert.equal(store.list({ host: 'b.example.com' }).length, 1);
  assert.equal(store.search('token=abc123').length, 0, 'the evicted body is gone too');
  assert.equal(store.list({ status: 403 }).length, 1);
  assert.equal(store.list({ tag: 'login' }).length, 0, 'the tagged row was evicted');
  assert.equal(store.search('admin').length, 1);
  assert.equal(store.search('Bearer secret').length, 0, 'secrets are not searchable');
  assert.equal(store.stats().byStatus['2xx'], 1);
});

test('evidence is write-once and detects a modified snapshot', () => {
  const store = new EvidenceStore(() => 42);
  const row = store.save({ findingId: 'f_1', kind: 'http', request: { url: 'https://a/x' }, response: { status: 200 } });
  assert.equal(row.at, 42);
  assert.equal(store.verify(row.id).ok, true);
  assert.equal(snapshotHash({ b: 1, a: 2 }), snapshotHash({ a: 2, b: 1 }), 'key order must not change the hash');
  const mutable = store.get(row.id) as { snapshot: { response: { status: number } } };
  mutable.snapshot.response.status = 500;
  const check = store.verify(row.id);
  assert.equal(check.ok, false);
  assert.match(check.reason || '', /modified/);
  assert.equal(store.list('f_1').length, 1);
  assert.equal(store.list('f_2').length, 0);
  assert.equal(store.verify('missing').ok, false);
});

test('a block rule wins over an allow, and an unmatched request still prompts', () => {
  const rules = new RuleSet();
  rules.add({ action: 'allow', match: { host: 'example.com' }, note: 'allow-list' });
  rules.add({ action: 'block', match: { pathEndsWith: '/admin' } });
  const decision = rules.evaluate({ method: 'GET', url: 'https://example.com/admin' });
  assert.equal(decision.verdict, 'block', 'a block must be checked before the first allow');
  assert.equal(rules.evaluate({ method: 'GET', url: 'https://example.com/' }).verdict, 'allow');
  assert.equal(rules.evaluate({ method: 'GET', url: 'https://other.test/' }).verdict, 'prompt');
});

test('rewrite returns a new request and matches flattened arguments', () => {
  const rules = new RuleSet();
  rules.add({ action: 'rewrite', match: { contains: 'rm -rf', method: 'POST' }, setHeaders: { 'X-Review': 'yes' }, setBody: 'echo safe' });
  const request = { method: 'POST', url: 'https://x.test/run', headers: { 'X-Plain': 'v' }, body: '["rm","-rf","/"]' };
  assert.equal(matchesRule(rules.list()[0], request), true);
  assert.match(searchableText(request), /rm -rf/);
  const decision = rules.evaluate(request);
  assert.equal(decision.verdict, 'rewrite');
  assert.equal(decision.request?.body, 'echo safe');
  assert.equal(decision.request?.headers?.['X-Plain'], 'v');
  assert.equal(request.body, '["rm","-rf","/"]', 'the caller request is not mutated');
  assert.equal(rules.remove(rules.list()[0].id), true);
  assert.equal(rules.evaluate(request).verdict, 'prompt');
});

test('an unusable judge answer falls back to approval, never to allow', async () => {
  const rules = new RuleSet();
  const request = { method: 'GET', url: 'https://x.test/' };
  const denied = await rules.judge(request, async () => 'deny');
  assert.equal(denied.verdict, 'block');
  const allowed = await rules.judge(request, async () => 'allow');
  assert.equal(allowed.verdict, 'allow');
  const vague = await rules.judge(request, async () => 'looks fine to me');
  assert.equal(vague.verdict, 'prompt');
  const broken = await rules.judge(request, async () => { throw new Error('model down'); });
  assert.equal(broken.verdict, 'prompt');
});

test('notices record duplicates, delivery failures and missing channels', async () => {
  const sent: string[] = [];
  const notifier = new Notifier({ now: () => 0, ratePerMinute: 20 });
  const deliver = async () => { sent.push('x'); };
  const a = await notifier.send({ title: 'found something' }, deliver);
  assert.equal(a.delivered, true);
  const b = await notifier.send({ title: 'found something' }, deliver);
  assert.equal(b.delivered, false);
  assert.match(b.error || '', /duplicate/);
  const failed = await notifier.send({ title: 'second' }, async () => { throw new Error('webhook 500'); });
  assert.equal(failed.delivered, false);
  assert.match(failed.error || '', /webhook 500/);
  const local = await notifier.send({ title: 'no channel' });
  assert.equal(local.delivered, false);
  assert.match(local.error || '', /no delivery channel/);
  assert.equal(sent.length, 1, 'only the first notice reached a channel');
  assert.equal(notifier.stats().suppressed, 1);
});

test('notice rate limiting is counted from delivered notices only', async () => {
  const limited = new Notifier({ now: () => 0, ratePerMinute: 2, dedupeMs: 0 });
  await limited.send({ title: 'a' }, async () => undefined);
  await limited.send({ title: 'b' }, async () => undefined);
  const third = await limited.send({ title: 'c' }, async () => undefined);
  assert.equal(third.delivered, false);
  assert.match(third.error || '', /rate limit/);
  assert.equal(limited.stats().delivered, 2);
  assert.equal(limited.stats().failed, 1);
});

test('the pool fails over, cools down a failing provider, and never invents an answer', async () => {
  let now = 0;
  const pool = new LlmPool({ now: () => now, failureThreshold: 2, cooldownMs: 100 });
  const calls: string[] = [];
  pool.register({ id: 'a', call: async () => { calls.push('a'); throw new Error('a down'); } });
  pool.register({ id: 'b', call: async () => { calls.push('b'); return 'answer'; } });
  const first = await pool.complete('hello');
  assert.equal(first.providerId, 'b');
  assert.equal(first.attempts, 2);
  assert.deepEqual(calls, ['a', 'b']);
  assert.equal(pool.records()[0].ok, true, 'the successful failover is the newest record');
  assert.equal(pool.records()[0].providerId, 'b');
  assert.equal(pool.records()[1].ok, false);
  assert.equal(pool.records()[1].providerId, 'a');
  await pool.complete('again');
  assert.equal(pool.status().find((p) => p.id === 'a')?.state, 'down', 'two failures trip the breaker');
  now = 101;
  await pool.complete('probe');
  assert.equal(pool.status().find((p) => p.id === 'a')?.state, 'down', 'a failed half-open probe stays down');
  pool.reset('a');
  assert.equal(pool.status().find((p) => p.id === 'a')?.state, 'healthy');
  const empty = new LlmPool();
  await assert.rejects(empty.complete('x'), /no provider registered/);
  const silent = new LlmPool();
  silent.register({ id: 'blank', call: async () => '   ' });
  await assert.rejects(silent.complete('x'), /no completion/);
});

test('side questions stay out of the loop until explicitly read', async () => {
  const bus = new SideQuestionBus({ now: () => 7 });
  const q = bus.ask('is this in scope?', 'target: example.com');
  assert.equal(q.status, 'pending');
  assert.deepEqual(bus.answers(), [], 'a pending question is not an answer');
  await bus.resolve(q.id, async (prompt) => {
    assert.match(prompt, /target: example.com/);
    return 'yes';
  });
  assert.equal(bus.get(q.id)?.answer, 'yes');
  assert.equal(bus.answers().length, 1);
  const failed = bus.ask('and this?');
  await bus.resolve(failed.id, async () => null);
  assert.equal(bus.get(failed.id)?.status, 'failed');
  assert.match(bus.get(failed.id)?.error || '', /no answer/);
  assert.equal(bus.list('pending').length, 0);
  await assert.rejects(bus.resolve('nope', async () => 'x'), /not found/);
});

test('enrichment lists what it could not establish instead of guessing', () => {
  const asset = enrichAsset('example.com:8443', [
    { kind: 'dns', value: '10.0.0.5' },
    { kind: 'port', value: '443' },
    { kind: 'header', name: 'server', value: 'nginx' },
    { kind: 'http', name: 'title', value: 'Login' },
  ]);
  assert.equal(asset.host, 'example.com');
  assert.equal(asset.port, 8443);
  assert.equal(asset.ip, '10.0.0.5');
  assert.equal(asset.server, 'nginx');
  assert.deepEqual(asset.openPorts, [443]);
  assert.ok(asset.unknown.includes('poweredBy'));
  assert.equal(enrichAsset('https://a.test/x').scheme, 'https');
});

test('a report will not promote a finding without evidence', () => {
  const store = new EvidenceStore(() => 1);
  const evidence = store.save({ findingId: 'f_1', request: { url: 'https://a/x' } });
  const report = buildReport({
    title: 'Test', scope: ['a.test'],
    findings: [
      { id: 'f_1', title: 'Confirmed one' },
      { id: 'f_2', title: 'Unverified one' },
    ],
    evidence: [evidence],
  }, () => 0);
  assert.equal(report.summary.confirmed, 1);
  assert.equal(report.summary.unverified, 1);
  assert.match(report.markdown, /## Confirmed findings/);
  assert.match(report.markdown, /no evidence snapshot is attached/);
  const noScope = buildReport({ title: 'Bare', findings: [] }, () => 0);
  assert.match(noScope.markdown, /coverage has no denominator/);
  assert.match(noScope.markdown, /None\. A finding needs an attached evidence snapshot/);
});

test('the runtime tools are registered and work together end to end', async () => {
  resetRuntime();
  const registry = createDefaultRegistry();
  const names = ['traffic_log', 'evidence', 'intercept_rule', 'notify', 'llm_pool', 'side_question', 'asset_enrich', 'assessment_report'];
  for (const name of names) {
    assert.ok(registry.get(name), `${name} is not in the default registry`);
  }
  assert.equal(RUNTIME_TOOLS.length, names.length);

  const context = ctx();
  const record = await registry.get('traffic_log')!.execute({
    action: 'record', method: 'GET', url: 'https://a.test/admin',
    requestHeaders: { Authorization: 'Bearer secret' }, status: 200, responseBody: 'ok',
  }, context);
  assert.equal(record.success, true, record.error);
  assert.equal(record.data.requestHeaders.Authorization, '[redacted]');

  const saved = await registry.get('evidence')!.execute({
    action: 'save', findingId: 'f_1', request: { url: 'https://a.test/admin' },
    response: { status: 200 }, exchangeId: record.data.id,
  }, context);
  assert.equal(saved.success, true, saved.error);
  const verified = await registry.get('evidence')!.execute({ action: 'verify', id: saved.data.id }, context);
  assert.equal(verified.data.ok, true);

  const report = await registry.get('assessment_report')!.execute({
    action: 'build', title: 'Run', scope: ['a.test'], findings: [{ id: 'f_1', title: 'Admin is open' }],
  }, context);
  assert.equal(report.success, true, report.error);
  assert.equal(report.data.summary.confirmed, 1);
  assert.equal(report.data.summary.exchanges, 1);

  const check = await registry.get('intercept_rule')!.execute({ action: 'check', method: 'GET', url: 'https://a.test/' }, context);
  assert.equal(check.data.verdict, 'prompt', 'an empty rule set must not silently allow');
  resetRuntime();
});
