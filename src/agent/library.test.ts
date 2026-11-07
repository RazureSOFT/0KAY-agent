import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { classifyTurn, extractRule, RuleLibrary, buildInjection, RED_LINE } from './library.js';
import { FactMemory } from './facts.js';
import { PermissionLedger } from './permission.js';

test('greetings and thanks are chat, not tasks', () => {
  for (const message of ['hi', 'hello there', 'thanks!', '好的', '在吗', '晚安']) {
    assert.equal(classifyTurn(message).kind, 'chat', message);
  }
});

test('a request with an action verb is a task', () => {
  for (const message of ['fix the login redirect', '帮我改一下这个按钮的颜色', 'add a test for the parser']) {
    assert.equal(classifyTurn(message).kind, 'task', message);
  }
});

test('a message that names a file is a task even when short', () => {
  assert.equal(classifyTurn('main.ts').kind, 'task');
  assert.equal(classifyTurn('看下 store.ts').kind, 'task');
});

test('a long message is treated as a request', () => {
  assert.equal(classifyTurn('x'.repeat(150)).kind, 'task');
});

test('only explicit corrections become rules', () => {
  assert.ok(extractRule('不是这个意思，我是说不要用 localStorage'));
  assert.ok(extractRule('I meant the gateway, not the proxy'));
  assert.equal(extractRule('nice work'), null);
  assert.equal(extractRule('ok'), null);
  assert.equal(extractRule('the build is slow'), null);
});

test('the red line is always injected, even with no learned rules', () => {
  const block = buildInjection([]);
  assert.ok(block.includes(RED_LINE));
  assert.match(block, /Never report work as done/);
  assert.doesNotMatch(block, /learned from earlier corrections/);
});

test('learned rules are matched by word overlap and injected', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'okay-rules-'));
  const library = new RuleLibrary(dir);
  await library.load();
  library.add('Do not use localStorage for session state', 'not right, do not use localStorage');
  library.add('Always run vue-tsc before committing', 'run vue-tsc first');
  const matched = library.match('the session state is stored in localStorage, fix it');
  assert.equal(matched.length, 1);
  assert.match(matched[0].text, /localStorage/);
  const block = buildInjection(matched);
  assert.match(block, /localStorage/);
  await library.flush();
  await fs.rm(dir, { recursive: true, force: true });
});

test('rules survive a reload from disk', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'okay-rules2-'));
  const first = new RuleLibrary(dir);
  await first.load();
  first.add('Pin the Node version in .nvmrc', 'pin the node version', 'manual');
  await first.flush();
  const second = new RuleLibrary(dir);
  await second.load();
  assert.equal(second.list().length, 1);
  assert.match(second.list()[0].text, /nvmrc/i);
  await fs.rm(dir, { recursive: true, force: true });
});

test('the same rule is not learned twice', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'okay-rules3-'));
  const library = new RuleLibrary(dir);
  await library.load();
  library.add('Use pnpm, not npm', 'use pnpm');
  library.add('Use pnpm, not npm', 'use pnpm');
  assert.equal(library.list().length, 1);
  await library.flush();
  await fs.rm(dir, { recursive: true, force: true });
});

test('facts keep the newest ten and recall them newest first', () => {
  const memory = new FactMemory();
  const ledger = new PermissionLedger(process.cwd());
  for (let i = 1; i <= 12; i++) {
    memory.write({ text: `fact number ${i}`, proof: 'tool: bash exit 0' }, 'task', ledger);
  }
  const facts = memory.list();
  assert.equal(facts.length, 10);
  assert.match(facts[0].text, /fact number 12/);
  assert.match(facts[9].text, /fact number 3/);
  assert.equal(facts[0].slot, 'fact_1');
});

test('a fact write without proof is refused with what is missing', () => {
  const memory = new FactMemory();
  const ledger = new PermissionLedger(process.cwd());
  const result = memory.write({ text: 'the port is 8080' }, 'task', ledger);
  assert.equal((result as any).ok, false);
  assert.match(String((result as any).needs), /proof/);
  assert.equal(memory.list().length, 0);
});

test('a path proof outside the workspace is refused', () => {
  const ledger = new PermissionLedger(process.cwd());
  const decision = ledger.check({ kind: 'memory', scope: '', proof: 'path: C:/Windows/system.ini', actor: 'agent' });
  assert.equal((decision as any).ok, false);
  assert.match(String((decision as any).reason), /outside the workspace/);
});

test('a path proof inside the workspace is accepted', () => {
  const ledger = new PermissionLedger(process.cwd());
  const decision = ledger.check({ kind: 'memory', scope: '', proof: 'path: src/main.ts', actor: 'agent' });
  assert.equal((decision as any).ok, true);
});

test('an agent may not rewrite its own experience without an instruction', () => {
  const ledger = new PermissionLedger(process.cwd());
  const blocked = ledger.check({ kind: 'experience', scope: '', proof: 'tool: self-check', actor: 'agent' });
  assert.equal((blocked as any).ok, false);
  const allowed = ledger.check({ kind: 'experience', scope: '', proof: 'user: the user asked for this rule', actor: 'agent' });
  assert.equal((allowed as any).ok, true);
});

test('re-stating a fact moves it to the front instead of duplicating', () => {
  const memory = new FactMemory();
  const ledger = new PermissionLedger(process.cwd());
  memory.write({ text: 'a', proof: 'tool: x' }, 'task', ledger);
  memory.write({ text: 'b', proof: 'tool: x' }, 'task', ledger);
  memory.write({ text: 'a', proof: 'tool: y' }, 'task', ledger);
  const facts = memory.list();
  assert.equal(facts.length, 2);
  assert.equal(facts[0].text, 'a');
});

test('the recall block names each slot so the model can refer to one', () => {
  const memory = new FactMemory();
  const ledger = new PermissionLedger(process.cwd());
  memory.write({ text: 'the gateway listens on 8080', proof: 'tool: netstat', source: 'bash' }, 'task', ledger);
  const block = memory.promptBlock();
  assert.match(block, /fact_1: the gateway listens on 8080/);
});
