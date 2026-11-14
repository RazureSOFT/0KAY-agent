import test from 'node:test';
import assert from 'node:assert/strict';
import { ForgeRepoTool } from './forge_repo.js';
import { ForgeTool } from './forge.js';
import { withForge, answer, header } from './forge.test.js';
import type { ToolContext } from './types.js';

const ctx = { cwd: process.cwd(), taskId: 'forge-repo', agentType: 'general' } as ToolContext;

test('branch_create resolves the default branch to a sha first', async () => {
  ForgeTool.setTokenReader(() => 'token-1');
  const tool = new ForgeRepoTool();
  await withForge((request, reply) => {
    if (request.url.endsWith('/repos/acme/app')) return answer(reply, 200, { default_branch: 'trunk' });
    if (request.url.endsWith('/git/ref/heads/trunk')) return answer(reply, 200, { object: { sha: 'abc123' } });
    if (request.url.endsWith('/git/refs')) return answer(reply, 201, { ref: 'refs/heads/feature' });
    return answer(reply, 404, { message: 'unexpected ' + request.url });
  }, async (hits) => {
    const result = await tool.execute({ action: 'branch_create', repo: 'acme/app', branch: 'feature' }, ctx);
    assert.equal(result.success, true, result.error);
    const created = hits.find((hit) => hit.url.endsWith('/git/refs'));
    assert.ok(created);
    assert.deepEqual(created.body, { ref: 'refs/heads/feature', sha: 'abc123' });
    assert.equal(header(created.headers, 'authorization'), 'Bearer token-1');
  });
});

test('file_put sends base64 and the commit message', async () => {
  ForgeTool.setTokenReader(() => '');
  const tool = new ForgeRepoTool();
  await withForge((request, reply) => {
    if (request.method === 'PUT') return answer(reply, 200, { content: { sha: 'new' } });
    return answer(reply, 404, { message: 'unexpected' });
  }, async (hits) => {
    const result = await tool.execute({ action: 'file_put', repo: 'acme/app', path: 'src/a.ts', content: 'export const a = 1\n', message: 'add a' }, ctx);
    assert.equal(result.success, true, result.error);
    const put = hits[0];
    assert.equal(put.body.content, Buffer.from('export const a = 1\n').toString('base64'));
    assert.equal(put.body.message, 'add a');
  });
});

test('file_get decodes the contents api payload', async () => {
  const tool = new ForgeRepoTool();
  await withForge((_request, reply) => answer(reply, 200, {
    path: 'src/a.ts', sha: 's1', size: 3, content: Buffer.from('abc').toString('base64'),
  }), async () => {
    const result = await tool.execute({ action: 'file_get', repo: 'acme/app', path: 'src/a.ts' }, ctx);
    assert.equal(result.success, true, result.error);
    assert.equal((result.data as any).content, 'abc');
  });
});

test('hook_create posts the payload url and events', async () => {
  const tool = new ForgeRepoTool();
  await withForge((request, reply) => answer(reply, 201, { id: 7 }), async (hits) => {
    const result = await tool.execute({ action: 'hook_create', repo: 'acme/app', url: 'https://example.test/hook', events: ['push'] }, ctx);
    assert.equal(result.success, true, result.error);
    assert.deepEqual(hits[0].body.config, { url: 'https://example.test/hook', content_type: 'json' });
    assert.deepEqual(hits[0].body.events, ['push']);
  });
});
