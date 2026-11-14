import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { ForgeTool, forgeTokenFromSettings } from './forge.js';
import type { ToolContext } from './types.js';

/**
 * A stand-in Core that forwards to a stand-in forge.
 *
 * The tool reaches out through `egressOrDirect`, which in this system POSTs to
 * Core's egress endpoint and lets Core make the request. Standing up that one
 * endpoint (the trick the pentest tests already use) keeps the tool's own code
 * path intact — it still serialises a request and reads back a response —
 * while the forge's answers are controlled precisely.
 *
 * The handler receives the tool's request (url, method, headers, parsed body)
 * and answers with `reply(status, jsonBody)`.
 */
async function withForge<T>(
  handler: (request: { url: string; method: string; headers: Record<string, string>; body: any }, reply: (status: number, body: unknown) => void) => void,
  run: (hits: Array<{ url: string; method: string; headers: Record<string, string>; body: any }>) => Promise<T>,
): Promise<T> {
  const hits: Array<{ url: string; method: string; headers: Record<string, string>; body: any }> = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    const request = {
      url: String(payload.url || ''),
      method: String(payload.method || 'GET'),
      headers: (payload.headers || {}) as Record<string, string>,
      body: payload.body ? JSON.parse(payload.body) : undefined,
    };
    hits.push(request);
    let answered = false;
    const reply = (status: number, body: unknown) => {
      answered = true;
      res.writeHead(200, { 'content-type': 'application/json' });
      // The real endpoint reports the upstream status inside a 200 envelope:
      // the request to Core succeeded even when the target answered 404.
      res.end(JSON.stringify({
        status,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }));
    };
    try {
      handler(request, reply);
    } catch (error) {
      reply(500, { message: String(error) });
    }
    if (!answered) reply(200, {});
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  const saved = { CORE_HTTP_ADDR: process.env.CORE_HTTP_ADDR, CORE_HTTP: process.env.CORE_HTTP };
  process.env.CORE_HTTP_ADDR = `http://127.0.0.1:${port}`;
  delete process.env.CORE_HTTP;
  try {
    return await run(hits);
  } finally {
    if (saved.CORE_HTTP_ADDR === undefined) delete process.env.CORE_HTTP_ADDR;
    else process.env.CORE_HTTP_ADDR = saved.CORE_HTTP_ADDR;
    if (saved.CORE_HTTP !== undefined) process.env.CORE_HTTP = saved.CORE_HTTP;
    server.close();
  }
}

/** Answer with a fixed status and body, as the egress endpoint would. */
function answer(reply: (status: number, body: unknown) => void, status: number, body: unknown) {
  reply(status, body);
}

/**
 * Read a header without caring about its case.
 *
 * HTTP header names are case-insensitive and `Headers` normalises them to lower
 * case on the way out, so asserting on `Authorization` would be asserting on
 * something the transport is free to change.
 */
function header(headers: Record<string, string>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

const ctx = { cwd: process.cwd(), taskId: 'forge-1', agentType: 'general' } as ToolContext;

test('a github issue list is read into a common shape', async () => {
  await withForge((_req, reply) => answer(reply, 200, [
    { number: 12, title: 'Crash on empty input', state: 'open', user: { login: 'ada' }, html_url: 'https://github.com/o/r/issues/12', labels: [{ name: 'bug' }], updated_at: '2026-01-02T00:00:00Z' },
  ]), async (hits) => {
    const result = await new ForgeTool(() => 'tok').execute({ action: 'list', repo: 'o/r', kind: 'issue' }, ctx);
    assert.equal(result.success, true, result.error);
    assert.equal(result.data.count, 1);
    assert.deepEqual(result.data.items[0], {
      number: 12, title: 'Crash on empty input', state: 'open', author: 'ada',
      url: 'https://github.com/o/r/issues/12', labels: ['bug'], updatedAt: '2026-01-02T00:00:00Z', kind: 'issue',
    });
    assert.match(hits[0].url, /api\.github\.com\/repos\/o\/r\/issues/);
  });
});

test('github pull requests are filtered out of an issue list', async () => {
  // GitHub's issues endpoint returns PRs too. A caller asking about bugs does
  // not want a PR, and the API offers no filter for it.
  await withForge((_req, reply) => answer(reply, 200, [
    { number: 1, title: 'a real issue', user: { login: 'a' }, labels: [] },
    { number: 2, title: 'a pull request', pull_request: { url: 'x' }, user: { login: 'b' }, labels: [] },
  ]), async () => {
    const result = await new ForgeTool(() => 'tok').execute({ action: 'list', repo: 'o/r' }, ctx);
    assert.equal(result.data.count, 1);
    assert.equal(result.data.items[0].title, 'a real issue');
  });
});

test('the token is sent as a header and never in the url', async () => {
  await withForge((_req, reply) => answer(reply, 200, []), async (hits) => {
    await new ForgeTool(() => 'secret-token').execute({ action: 'list', repo: 'o/r' }, ctx);
    assert.equal(header(hits[0].headers, 'authorization'), 'Bearer secret-token');
    assert.doesNotMatch(hits[0].url, /secret-token/);
  });
});

test('gitlab uses the private-token header and an encoded project path', async () => {
  await withForge((_req, reply) => answer(reply, 200, []), async (hits) => {
    await new ForgeTool(() => 'glpat-1').execute({ action: 'list', repo: 'group/sub/project', forge: 'gitlab' }, ctx);
    assert.equal(header(hits[0].headers, 'private-token'), 'glpat-1');
    // The slashes are part of the identifier and have to be encoded.
    assert.match(hits[0].url, /project_id=group%2Fsub%2Fproject/);
    assert.match(hits[0].url, /gitlab\.com\/api\/v4\/issues/);
  });
});

test('gitlab merge requests read iid, not id', async () => {
  // GitLab has both; `iid` is the number in the URL a person sees.
  await withForge((_req, reply) => answer(reply, 200, [
    { id: 9999, iid: 7, title: 'Fix it', state: 'opened', author: { username: 'sam' }, web_url: 'u', labels: [], updated_at: 'd' },
  ]), async () => {
    const result = await new ForgeTool(() => 'tok').execute({ action: 'list', repo: 'g/p', forge: 'gitlab', kind: 'pr' }, ctx);
    assert.equal(result.data.items[0].number, 7);
  });
});

test('reading one issue includes its body', async () => {
  await withForge((_req, reply) => answer(reply, 200, {
    number: 5, title: 'Broken', state: 'open', body: 'Steps to reproduce…', user: { login: 'a' }, labels: [],
  }), async () => {
    const result = await new ForgeTool(() => 'tok').execute({ action: 'get', repo: 'o/r', number: 5 }, ctx);
    assert.equal(result.data.item.body, 'Steps to reproduce…');
  });
});

test('a list does not carry bodies, so a list stays cheap', async () => {
  await withForge((_req, reply) => answer(reply, 200, [
    { number: 1, title: 't', body: 'a very long body', user: { login: 'a' }, labels: [] },
  ]), async () => {
    const result = await new ForgeTool(() => 'tok').execute({ action: 'list', repo: 'o/r' }, ctx);
    assert.equal(result.data.items[0].body, undefined);
  });
});

test('a state filter and a label filter reach the query', async () => {
  await withForge((_req, reply) => answer(reply, 200, []), async (hits) => {
    await new ForgeTool(() => 'tok').execute({ action: 'list', repo: 'o/r', state: 'closed', labels: 'bug,urgent' }, ctx);
    assert.match(hits[0].url, /state=closed/);
    assert.match(hits[0].url, /labels=bug%2Curgent/);
  });
});

test('a search term filters by title without a second request', async () => {
  await withForge((_req, reply) => answer(reply, 200, [
    { number: 1, title: 'Crash on empty input', user: { login: 'a' }, labels: [] },
    { number: 2, title: 'Add a test', user: { login: 'b' }, labels: [] },
  ]), async (hits) => {
    const result = await new ForgeTool(() => 'tok').execute({ action: 'list', repo: 'o/r', search: 'crash' }, ctx);
    assert.equal(result.data.count, 1);
    assert.equal(hits.length, 1, 'filtering must not cost another request');
  });
});

test('creating an issue posts the title and body', async () => {
  await withForge((_req, reply) => answer(reply, 201, { number: 9, title: 'New', user: { login: 'a' }, labels: [], html_url: 'u' }), async (hits) => {
    const result = await new ForgeTool(() => 'tok').execute({ action: 'create', repo: 'o/r', title: 'New', body: 'detail' }, ctx);
    assert.equal(result.success, true, result.error);
    assert.equal(hits[0].method, 'POST');
    assert.deepEqual(hits[0].body, { title: 'New', body: 'detail' });
    assert.equal(result.data.created.number, 9);
  });
});

test('creating a pull request needs both branches, and says so', async () => {
  await withForge((_req, reply) => answer(reply, 200, {}), async (hits) => {
    const tool = new ForgeTool(() => 'tok');
    const missing = await tool.execute({ action: 'create', repo: 'o/r', kind: 'pr', title: 'Fix' }, ctx);
    assert.equal(missing.success, false);
    assert.match(String(missing.error), /head and base/);
    assert.equal(hits.length, 0, 'nothing should be sent for an incomplete request');

    await tool.execute({ action: 'create', repo: 'o/r', kind: 'pr', title: 'Fix', head: 'fix', base: 'main' }, ctx);
    assert.deepEqual(hits[0].body, { title: 'Fix', body: '', head: 'fix', base: 'main' });
  });
});

test('gitlab merge requests use source_branch and description', async () => {
  await withForge((_req, reply) => answer(reply, 201, { iid: 3, title: 'x', author: { username: 'a' }, labels: [] }), async (hits) => {
    await new ForgeTool(() => 'tok').execute(
      { action: 'create', repo: 'g/p', forge: 'gitlab', kind: 'pr', title: 'T', body: 'B', head: 'feat', base: 'main' }, ctx);
    assert.deepEqual(hits[0].body, { title: 'T', description: 'B', source_branch: 'feat', target_branch: 'main' });
  });
});

test('creating without a token is refused before anything is sent', async () => {
  // Otherwise the model writes the whole issue text and then bounces.
  await withForge((_req, reply) => answer(reply, 200, {}), async (hits) => {
    const result = await new ForgeTool(() => '').execute({ action: 'create', repo: 'o/r', title: 'T' }, ctx);
    assert.equal(result.success, false);
    assert.match(String(result.error), /needs a token/);
    assert.equal(hits.length, 0);
  });
});

test('reading without a token is allowed — public repositories', async () => {
  await withForge((_req, reply) => answer(reply, 200, []), async (hits) => {
    const result = await new ForgeTool(() => '').execute({ action: 'list', repo: 'o/r' }, ctx);
    assert.equal(result.success, true, result.error);
    assert.equal(header(hits[0].headers, 'authorization'), undefined);
  });
});

test('a forge error is reported with its own message and status', async () => {
  await withForge((_req, reply) => answer(reply, 404, { message: 'Not Found' }), async () => {
    const result = await new ForgeTool(() => 'tok').execute({ action: 'get', repo: 'o/r', number: 1 }, ctx);
    assert.equal(result.success, false);
    assert.match(String(result.error), /404/);
    assert.match(String(result.error), /Not Found/);
  });
});

test('a malformed repo is refused without a request', async () => {
  await withForge((_req, reply) => answer(reply, 200, []), async (hits) => {
    const tool = new ForgeTool(() => 'tok');
    for (const repo of ['', 'just-a-name', '../escape', 'a/../b']) {
      const result = await tool.execute({ action: 'list', repo }, ctx);
      assert.equal(result.success, false, `${repo} should be refused`);
    }
    // GitLab legitimately has deep groups, so a nested valid path is allowed.
    const ok = await tool.execute({ action: 'list', repo: 'a/b/c', forge: 'gitlab' }, ctx);
    assert.equal(ok.success, true, ok.error);
    assert.equal(hits.length, 1);
  });
});

test('an enterprise or self-hosted host replaces the api base', async () => {
  await withForge((_req, reply) => answer(reply, 200, []), async (hits) => {
    await new ForgeTool(() => 'tok').execute({ action: 'list', repo: 'o/r', host: 'git.corp.example' }, ctx);
    assert.match(hits[0].url, /^https:\/\/git\.corp\.example\/api\/v3\//);
    await new ForgeTool(() => 'tok').execute({ action: 'list', repo: 'o/r', host: 'https://gl.corp.example/', forge: 'gitlab' }, ctx);
    assert.match(hits[1].url, /^https:\/\/gl\.corp\.example\/api\/v4\//);
  });
});

test('an unknown action is refused with the valid ones named', async () => {
  await withForge((_req, reply) => answer(reply, 200, []), async () => {
    const result = await new ForgeTool(() => 'tok').execute({ action: 'merge', repo: 'o/r' }, ctx);
    assert.equal(result.success, false);
    assert.match(String(result.error), /list, get or create/);
  });
});

test('the token reader takes only the configured tokens', () => {
  const read = forgeTokenFromSettings({ github_token: ' ghp_1 ', gitlab_token: 'glpat-2' });
  assert.equal(read('github'), 'ghp_1');
  assert.equal(read('gitlab'), 'glpat-2');
  assert.equal(forgeTokenFromSettings({})('github'), '');
  assert.equal(forgeTokenFromSettings({ github_token: 42 })('github'), '');
});