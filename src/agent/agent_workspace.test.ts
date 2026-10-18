import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { AGENT_DIR, ensureAgentWorkspace, appendAgentNote } from './agent_workspace.js';

test('ensureAgentWorkspace creates the files and gitignores the dir', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'okay-ws-'));
  await ensureAgentWorkspace(dir);
  for (const name of ['memory.md', 'plan.md', 'review.md']) {
    const body = await readFile(join(dir, AGENT_DIR, name), 'utf8');
    assert.ok(body.length > 0, `${name} should not be empty`);
  }
  const ignore = await readFile(join(dir, '.gitignore'), 'utf8');
  assert.ok(ignore.includes('.0kay-agent/'));
  // Idempotent: running again must not duplicate the entry.
  await ensureAgentWorkspace(dir);
  const again = await readFile(join(dir, '.gitignore'), 'utf8');
  assert.equal(again.split('.0kay-agent/').length - 1, 1);
});

test('appendAgentNote appends a timestamped entry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'okay-ws-'));
  await appendAgentNote(dir, 'memory', 'remember this fact');
  const body = await readFile(join(dir, AGENT_DIR, 'memory.md'), 'utf8');
  assert.ok(body.includes('remember this fact'));
  assert.ok(body.includes('## '));
});

test('existing .gitignore is preserved', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'okay-ws-'));
  await (await import('fs/promises')).writeFile(join(dir, '.gitignore'), 'node_modules/\n', 'utf8');
  await ensureAgentWorkspace(dir);
  const ignore = await readFile(join(dir, '.gitignore'), 'utf8');
  assert.ok(ignore.startsWith('node_modules/'));
  assert.ok(ignore.includes('.0kay-agent/'));
});
