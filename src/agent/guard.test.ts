import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AuditLog,
  evaluateRules,
  parseRules,
  ruleMatches,
  searchableText,
  summarizeCall,
  type GuardRule,
} from './guard.js';

const rule = (over: Partial<GuardRule> = {}): GuardRule => ({
  name: 'r', tool: 'bash', verdict: 'block', reason: 'no', ...over,
});

test('a call summary never quotes anything credential-shaped', () => {
  // An audit log that leaks a token is worse than no audit log.
  const summary = summarizeCall('http_request', {
    url: 'https://api.example/x',
    headers: { Authorization: 'Bearer sk-live-abc' },
    token: 'sk-live-abc',
    api_key: 'sk-live-abc',
    password: 'hunter2',
    cookie: 'session=1',
  });
  assert.match(summary, /<redacted>/);
  assert.doesNotMatch(summary, /sk-live-abc/);
  assert.doesNotMatch(summary, /hunter2/);
  assert.doesNotMatch(summary, /session=1/);
  // The non-secret part is still there, or the entry would say nothing.
  assert.match(summary, /api\.example/);
});

test('a summary is clipped so one call cannot fill the log', () => {
  const summary = summarizeCall('write', { content: 'x'.repeat(5000) });
  assert.ok(summary.length <= 170, `summary was ${summary.length} chars`);
  assert.match(summary, /…$/);
});

test('a call with no arguments summarises to its tool name', () => {
  assert.equal(summarizeCall('finish', undefined), 'finish');
  assert.equal(summarizeCall('finish', {}), 'finish');
});

test('a blocking rule matches a command inside any argument', () => {
  // The operator writes down a substring, not a field path: "rm -rf" has to be
  // caught whether it arrives as `command` or as `args`.
  assert.equal(ruleMatches(rule({ contains: 'rm -rf' }), 'bash', { command: 'sudo rm -rf /' }), true);
  assert.equal(ruleMatches(rule({ contains: 'rm -rf' }), 'bash', { args: ['rm', '-rf', '/'] }), true);
  assert.equal(ruleMatches(rule({ contains: 'rm -rf' }), 'bash', { command: 'ls -la' }), false);
});

test('a rule for one tool does not fire for another', () => {
  assert.equal(ruleMatches(rule({ tool: 'bash' }), 'write', { path: '/x' }), false);
  assert.equal(ruleMatches(rule({ tool: 'bash' }), 'bash', {}), true);
});

test('a wildcard tool rule applies to every tool', () => {
  assert.equal(ruleMatches(rule({ tool: '*', contains: 'secret' }), 'anything', { q: 'secret' }), true);
});

test('a rule with no conditions matches every call of that tool', () => {
  // This is how "never let this tool run" is written.
  assert.equal(ruleMatches(rule({ tool: 'pentest' }), 'pentest', {}), true);
  assert.equal(ruleMatches(rule({ tool: 'pentest' }), 'pentest', { url: 'x' }), true);
});

test('a path rule matches the end of a path, on either slash', () => {
  assert.equal(ruleMatches(rule({ tool: 'write', pathEndsWith: '.env' }), 'write', { filePath: 'C:\\app\\.env' }), true);
  assert.equal(ruleMatches(rule({ tool: 'write', pathEndsWith: '/.git/config' }), 'write', { filePath: '/repo/.git/config' }), true);
  assert.equal(ruleMatches(rule({ tool: 'write', pathEndsWith: '.env' }), 'write', { filePath: '/app/.env.example' }), false);
});

test('a path rule does not fire when there is no path', () => {
  assert.equal(ruleMatches(rule({ tool: 'write', pathEndsWith: '.env' }), 'write', { content: 'x' }), false);
});

test('matching is case-insensitive in both directions', () => {
  assert.equal(ruleMatches(rule({ tool: 'Bash', contains: 'RM -RF' }), 'bash', { command: 'rm -rf /' }), true);
});

test('a block beats an allow, whatever the order', () => {
  // An operator who writes both meant the block; the other order would quietly
  // do the opposite.
  const allow = rule({ name: 'allow-all', tool: 'bash', contains: 'rm', verdict: 'allow' });
  const block = rule({ name: 'no-rm-rf', tool: 'bash', contains: 'rm -rf', verdict: 'block' });
  const first = evaluateRules([allow, block], 'bash', { command: 'rm -rf /' });
  assert.equal(first.verdict, 'block');
  assert.equal(first.rule, 'no-rm-rf');
  const reversed = evaluateRules([block, allow], 'bash', { command: 'rm -rf /' });
  assert.equal(reversed.verdict, 'block');
});

test('an allow rule is reported, so the audit entry has a reason', () => {
  const decision = evaluateRules([rule({ name: 'trusted', tool: 'bash', contains: 'npm test', verdict: 'allow', reason: 'the test suite is safe' })], 'bash', { command: 'npm test' });
  assert.equal(decision.verdict, 'allow');
  assert.equal(decision.reason, 'the test suite is safe');
  assert.equal(decision.rule, 'trusted');
});

test('with no rules the decision is a plain allow and says nothing', () => {
  // No built-in dangerous-command list: a policy nobody can see is always wrong
  // for somebody.
  const decision = evaluateRules([], 'bash', { command: 'rm -rf /' });
  assert.equal(decision.verdict, 'allow');
  assert.equal(decision.reason, '');
  assert.equal(decision.rule, undefined);
});

test('a blocking rule with no reason still names itself', () => {
  const decision = evaluateRules([rule({ name: 'no-writes', reason: '' })], 'bash', {});
  assert.equal(decision.verdict, 'block');
  assert.match(decision.reason, /no-writes/);
});

test('rules are parsed from the JSON an operator saved', () => {
  const rules = parseRules(JSON.stringify([
    { name: 'no-rm-rf', tool: 'bash', contains: 'rm -rf', verdict: 'block', reason: 'never' },
    { tool: 'write', pathEndsWith: '.env', verdict: 'block' },
  ]));
  assert.equal(rules.length, 2);
  assert.equal(rules[0].name, 'no-rm-rf');
  // A rule with no name still gets one, so the audit entry can cite it.
  assert.equal(rules[1].name, 'write:block');
});

test('malformed rule input yields no rules rather than throwing', () => {
  // Settings are hand-editable, and a typo must not take the agent down.
  assert.deepEqual(parseRules(''), []);
  assert.deepEqual(parseRules('{not json'), []);
  assert.deepEqual(parseRules('{"tool":"bash"}'), []);
  assert.deepEqual(parseRules('[1,2,3]'), []);
});

test('a rule without a tool or a verdict is dropped, not applied to everything', () => {
  const rules = parseRules(JSON.stringify([
    { contains: 'rm -rf', verdict: 'block' },
    { tool: 'bash' },
    { tool: 'bash', verdict: 'maybe' },
  ]));
  assert.deepEqual(rules, []);
});

test('the audit log records and reads back an entry', () => {
  const log = new AuditLog();
  log.record({ at: 1, tool: 'bash', verdict: 'block', reason: 'rm -rf', summary: 'command=rm -rf /' });
  const { entries, total } = log.list();
  assert.equal(total, 1);
  assert.equal(entries[0].tool, 'bash');
  assert.equal(entries[0].verdict, 'block');
});

test('the audit log is bounded and says how much it dropped', () => {
  // A log that grows without limit is a memory leak with a nice name; a reader
  // has to know it is not the whole story rather than assuming it is.
  const log = new AuditLog(3);
  for (let i = 0; i < 10; i += 1) {
    log.record({ at: i, tool: 'bash', verdict: 'allow', reason: '', summary: `call ${i}` });
  }
  const { entries, dropped, total } = log.list();
  assert.equal(entries.length, 3);
  assert.equal(total, 3);
  assert.equal(dropped, 7);
  // The newest survive, because those are what a reader is asking about.
  assert.equal(entries[2].summary, 'call 9');
});

test('the audit log can be filtered by tool, verdict and time', () => {
  const log = new AuditLog();
  log.record({ at: 100, tool: 'bash', verdict: 'allow', reason: '', summary: 'a' });
  log.record({ at: 200, tool: 'write', verdict: 'block', reason: 'no', summary: 'b' });
  log.record({ at: 300, tool: 'bash', verdict: 'block', reason: 'no', summary: 'c' });

  assert.equal(log.list({ tool: 'bash' }).entries.length, 2);
  assert.equal(log.list({ verdict: 'block' }).entries.length, 2);
  assert.equal(log.list({ since: 200 }).entries.length, 2);
  assert.equal(log.list({ tool: 'bash', verdict: 'block' }).entries.length, 1);
  assert.equal(log.list({ limit: 1 }).entries[0].summary, 'c', 'the limit keeps the newest');
});

test('the audit summary counts both verdicts', () => {
  const log = new AuditLog();
  log.record({ at: 1, tool: 'bash', verdict: 'allow', reason: '', summary: '' });
  log.record({ at: 2, tool: 'bash', verdict: 'block', reason: '', summary: '' });
  log.record({ at: 3, tool: 'bash', verdict: 'block', reason: '', summary: '' });
  assert.deepEqual(log.summary(), { allowed: 1, blocked: 2, dropped: 0 });
});

test('clearing the log resets the dropped count too', () => {
  // Leaving `dropped` behind after a clear would report a loss that no longer
  // exists.
  const log = new AuditLog(1);
  log.record({ at: 1, tool: 'a', verdict: 'allow', reason: '', summary: '' });
  log.record({ at: 2, tool: 'a', verdict: 'allow', reason: '', summary: '' });
  assert.equal(log.summary().dropped, 1);
  log.clear();
  assert.deepEqual(log.summary(), { allowed: 0, blocked: 0, dropped: 0 });
});

test('searchable text includes nested argument values', () => {
  // A command can arrive nested, and a rule that only sees the top level would
  // miss it.
  const text = searchableText('http_request', { headers: { 'X-Thing': 'rm -rf' } });
  assert.match(text, /rm -rf/);
});