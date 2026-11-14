import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import * as net from 'node:net';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { once } from 'node:events';
import { TrafficStore, EvidenceStore } from './records.js';
import { RecordingProxy } from './proxy.js';
import { LlmPool } from './llm.js';
import { resetRuntime, interceptFor, setNotifyTransport } from '../../tools/packages/runtime.js';
import { McpHttpServer } from '../../tools/mcp_server.js';
import { createDefaultRegistry } from '../../tools/tools.js';
import type { ToolContext } from '../../tools/types.js';

const ctx = (sessionId = 'wiring'): ToolContext => ({
  cwd: process.cwd(), taskId: 't', agentType: 'general', sessionId,
}) as ToolContext;

test('the recording proxy forwards, redacts and snapshots an exchange', async () => {
  const target = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      res.writeHead(201, { 'x-echo': body });
      res.end(`ok:${req.url}`);
    });
  });
  await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', () => resolve()));
  const targetPort = (target.address() as net.AddressInfo).port;
  const store = new TrafficStore();
  const evidence = new EvidenceStore();
  const proxy = new RecordingProxy({ store, evidence });
  const { port } = await proxy.start();

  const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1', port, method: 'POST',
      path: `http://127.0.0.1:${targetPort}/hello?x=1`,
      headers: { 'content-type': 'text/plain', authorization: 'Bearer secret' },
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode || 0, body }));
    });
    request.on('error', reject);
    request.end('payload');
  });
  assert.equal(response.status, 201);
  assert.equal(response.body, 'ok:/hello?x=1');

  const rows = store.list({ limit: 10 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].method, 'POST');
  assert.equal(rows[0].status, 201);
  assert.equal(rows[0].requestBody, 'payload');
  assert.equal(rows[0].requestHeaders.authorization, '[redacted]');
  assert.equal(rows[0].responseBody, 'ok:/hello?x=1');
  const snapshots = evidence.list('traffic');
  assert.equal(snapshots.length, 1);
  assert.equal(evidence.verify(snapshots[0].id).ok, true);

  await proxy.stop();
  await new Promise<void>((resolve) => target.close(() => resolve()));
});

test('a CONNECT tunnel is recorded without claiming to inspect it', async () => {
  const echo = net.createServer((socket) => socket.pipe(socket));
  await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', () => resolve()));
  const echoPort = (echo.address() as net.AddressInfo).port;
  const store = new TrafficStore();
  const proxy = new RecordingProxy({ store });
  const { port } = await proxy.start();

  const socket = net.connect(port, '127.0.0.1');
  await once(socket, 'connect');
  socket.write(`CONNECT 127.0.0.1:${echoPort} HTTP/1.1\r\nHost: 127.0.0.1:${echoPort}\r\n\r\n`);
  const [handshake] = await once(socket, 'data');
  assert.match(String(handshake), /200 Connection Established/);
  socket.write('ping');
  const [echoed] = await once(socket, 'data');
  assert.equal(String(echoed), 'ping');

  const tunnels = store.list({ tag: 'tunnel' });
  assert.equal(tunnels.length, 1);
  assert.equal(tunnels[0].method, 'CONNECT');
  assert.match(tunnels[0].responseBody, /not inspected/);

  socket.destroy();
  await proxy.stop();
  await new Promise<void>((resolve) => echo.close(() => resolve()));
});

test('an interception rule decides before the request leaves', async () => {
  resetRuntime();
  const context = ctx('intercept');
  const registry = createDefaultRegistry();
  await registry.get('intercept_rule')!.execute({
    action: 'add', ruleAction: 'block', match: { host: 'blocked.test' }, note: 'test block',
  }, context);

  assert.equal(interceptFor(context, { method: 'GET', url: 'https://blocked.test/x' }).verdict, 'block');
  assert.equal(interceptFor(context, { method: 'GET', url: 'https://ok.test/x' }).verdict, 'prompt');

  const refused = await registry.get('http_request')!.execute({ url: 'https://blocked.test/x' }, context);
  assert.equal(refused.success, false);
  assert.match(refused.error || '', /blocked by interception rule/);

  const ledger = await registry.get('traffic_log')!.execute({ action: 'list', tag: 'blocked' }, context);
  assert.equal(ledger.data.length, 1);
  assert.equal(ledger.data[0].url, 'https://blocked.test/x');
  resetRuntime();
});

test('notifications reach a webhook or a file, and a failure stays visible', async () => {
  resetRuntime();
  const context = ctx('notify');
  const registry = createDefaultRegistry();
  const bodies: string[] = [];
  setNotifyTransport(async (_url, body) => { bodies.push(body); return { ok: true, status: 200 }; });
  const sent = await registry.get('notify')!.execute({
    action: 'send', title: 'scan finished', body: 'two findings', channel: 'webhook', url: 'https://hook.test/x',
  }, context);
  assert.equal(sent.data.delivered, true);
  assert.equal(bodies.length, 1);
  assert.match(bodies[0], /scan finished/);

  setNotifyTransport(async () => ({ ok: false, status: 500 }));
  const failed = await registry.get('notify')!.execute({
    action: 'send', title: 'second', channel: 'webhook', url: 'https://hook.test/x',
  }, context);
  assert.equal(failed.data.delivered, false);
  assert.match(failed.data.error || '', /500/);
  setNotifyTransport(null);

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), '0kay-notify-'));
  const previous = process.env.AGENT_DATA_DIR;
  process.env.AGENT_DATA_DIR = dir;
  try {
    const filed = await registry.get('notify')!.execute({ action: 'send', title: 'to a file', channel: 'file' }, context);
    assert.equal(filed.data.delivered, true);
    const text = await fs.readFile(path.join(dir, 'notices', 'notices.jsonl'), 'utf8');
    assert.match(text, /to a file/);
  } finally {
    if (previous === undefined) delete process.env.AGENT_DATA_DIR;
    else process.env.AGENT_DATA_DIR = previous;
    await fs.rm(dir, { recursive: true, force: true });
  }
  resetRuntime();
});

test('the MCP server requires its token and hides dangerous tools by default', async () => {
  const registry = createDefaultRegistry();
  const server = new McpHttpServer({ registry, context: () => ctx('mcp') });
  const started = await server.start();
  try {
    const unauthorized = await fetch(started.url, {
      method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    assert.equal(unauthorized.status, 401);

    const call = async (method: string, params: Record<string, any> = {}) => {
      const response = await fetch(started.url, {
        method: 'POST',
        headers: { authorization: `Bearer ${started.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      assert.equal(response.status, 200);
      return response.json() as Promise<any>;
    };

    const init = await call('initialize', { protocolVersion: '2024-11-05' });
    assert.equal(init.result.serverInfo.name, '0kay-agent');
    assert.ok(init.result.capabilities.tools);

    const list = await call('tools/list');
    assert.ok(list.result.tools.some((tool: any) => tool.name === 'traffic_log'));
    assert.ok(!list.result.tools.some((tool: any) => tool.name === 'traffic_proxy'), 'dangerous tools are hidden');

    const called = await call('tools/call', { name: 'traffic_log', arguments: { action: 'stats' } });
    assert.equal(called.result.isError, false);

    const unknown = await call('tools/call', { name: 'not-a-tool', arguments: {} });
    assert.equal(unknown.error.code, -32602);

    const blocked = await call('tools/call', { name: 'traffic_proxy', arguments: { action: 'status' } });
    assert.equal(blocked.error.code, -32602, 'a hidden tool is not callable either');
  } finally {
    await server.stop();
  }
});

test('the pool records payloads only when asked, and bounds them', async () => {
  const pool = new LlmPool({ captureLimit: 64 });
  pool.register({ id: 'a', call: async () => 'r'.repeat(200) });
  await pool.complete('p'.repeat(200));
  assert.equal(pool.records()[0].prompt, undefined, 'payload capture is opt-in');
  await pool.complete('p'.repeat(200), true);
  const record = pool.records()[0];
  assert.equal(record.prompt?.length, 64);
  assert.equal(record.response?.length, 64);
  assert.equal(record.capturedTruncated, true);
});
