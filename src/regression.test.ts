import test from 'node:test';
import assert from 'node:assert/strict';
import * as grpc from '@grpc/grpc-js';
import * as loader from '@grpc/proto-loader';
import { Agent } from './agent/agent.js';
import { MocrProvider } from './provider/mocr.js';
import { ShellTool } from './tools/tools.js';
import { ApprovalManager } from './task/approvals.js';
import {QuestionManager} from './task/questions.js';

const tick = () => new Promise(resolve => setImmediate(resolve));

test('concurrency queues tasks; cancelling queued and running tasks preserves terminal state', async () => {
  const agent = new Agent();
  (agent as any).recorder.run = async (_k: any, _p: any, _id: any, _s: any, operation: any) => operation();
  agent.applySettings({ model_id: 'mock', max_concurrent_tasks: 1 });
  const gates: Array<() => void> = [];
  (agent as any).mocr = { async *generate() {
    await new Promise<void>(resolve => gates.push(resolve));
    yield { chunk: 'done', done: true };
  }};
  const first = agent.executeTask('first', 'first');
  const firstRejected = assert.rejects(first, /cancelled/);
  const second = agent.executeTask('second', 'second');
  const secondRejected = assert.rejects(second, /cancelled/);
  while (gates.length === 0) await tick();
  assert.equal(agent.getTaskManager().getTask('first')?.state, 'RUNNING');
  assert.equal(agent.getTaskManager().getTask('second')?.state, 'PENDING');
  assert.equal(gates.length, 1);
  agent.getTaskManager().cancelTask('second');
  agent.getTaskManager().cancelTask('first');
  gates[0]();
  await Promise.all([firstRejected, secondRejected]);
  assert.equal(agent.getTaskManager().getTask('first')?.state, 'CANCELLED');
  assert.equal(agent.getTaskManager().getTask('second')?.state, 'CANCELLED');
});

test('iteration exhaustion and model failure are FAILED, not DONE', async () => {
  for (const failure of ['transport', 'finish']) {
    const agent = new Agent();
    (agent as any).recorder.run = async (_k: any, _p: any, _id: any, _s: any, operation: any) => operation();
    agent.applySettings({ model_id: 'mock', max_iterations: 1 });
    (agent as any).mocr = { async *generate() {
      if (failure === 'transport') throw new Error('unavailable');
      if (failure === 'finish') yield { done: true, finishReason: 'FINISH_REASON_ERROR' };
      else yield { done: true, toolCalls: [{ id: 'c', name: 'missing', arguments: '{}' }] };
    }};
    await assert.rejects(agent.executeTask(failure, 'test',undefined,{permission_mode:'full_access'}));
    assert.equal(agent.getTaskManager().getTask(failure)?.state, 'FAILED');
  }
});

test('native tool history survives real gRPC serialization; cancellation stops stream', async () => {
  const definition = loader.loadSync('../proto/mocr/v1/mocr.proto', { keepCase: false, defaults: true, enums: String });
  const pkg: any = grpc.loadPackageDefinition(definition);
  const server = new grpc.Server();
    let received: any;
  server.addService(pkg.mocr.v1.MocrService.service, {
    Generate(call: any) {
      received = call.request;
      call.write({ chunk: 'ok' });
      call.write({ done: true, finishReason: 'FINISH_REASON_STOP' });
      call.end();
    },
  });
  const port = await new Promise<number>((resolve, reject) => server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (err, port) => err ? reject(err) : resolve(port)));
  try {
    const provider = new MocrProvider({ grpcAddress: `127.0.0.1:${port}` });
    provider.recorder.record = async () => {};
    const chunks = [];
    for await (const chunk of provider.generate({ modelId: 'mock', baseUrl: 'http://mock', apiKey: 'mock', messages: [
      { role: 'assistant', content: '', toolCalls: [{ id: 'c', name: 'read', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'c', content: 'result' },
    ] })) chunks.push(chunk);
    assert.equal(received.messages[0].toolCalls[0].functionName, 'read');
    assert.equal(received.messages[0].toolCalls[0].type, 'function');
    assert.equal(received.messages[1].toolCallId, 'c');
    assert.equal(chunks.at(-1)?.done, true);
    const abort = new AbortController();
    abort.abort(new Error('cancelled'));
    await assert.rejects(async () => {
      for await (const chunk of provider.generate({ modelId: 'mock', baseUrl: 'http://mock', apiKey: 'mock', messages: [], signal: abort.signal })) void chunk;
    }, /cancelled/);
  } finally {
    server.forceShutdown();
  }
});

test('credentials follow model ownership and refresh after config changes', async () => {
  const original = globalThis.fetch;
  let key = 'first-key';
  globalThis.fetch = async () => new Response(JSON.stringify({ default_provider_id: 'a', providers: [
    { id: 'a', provider: 'openai', enabled: true, models: ['model-a'], api_key: 'wrong', base_url: 'http://a' },
    { id: 'b', provider: 'other', enabled: true, models: ['model-b'], api_key: key, base_url: 'http://b' },
  ] }));
  try {
    const provider: any = new MocrProvider({ grpcAddress: 'unused' });
    assert.equal((await provider.resolveCredentials('model-b')).apiKey, 'first-key');
    key = 'updated-key';
    assert.equal((await provider.resolveCredentials('model-b')).apiKey, 'updated-key');
    await assert.rejects(provider.resolveCredentials('unknown'), /No enabled provider/);
  } finally { globalThis.fetch = original; }
});

test('a synchronous subtask shares the parent slot without deadlocking at limit one', async () => {
  const agent = new Agent();
  (agent as any).recorder.run = async (_k: any, _p: any, _id: any, _s: any, operation: any) => operation();
  agent.applySettings({ model_id: 'mock', max_concurrent_tasks: 1 });
  (agent as any).mocr = { async *generate(request: any) {
    if (request.messages[0].content === 'parent' && request.messages.length === 1) {
      yield { done: true, toolCalls: [{ id: 'child', name: 'task', arguments: JSON.stringify({ prompt: 'child' }) }] };
    } else yield { chunk: 'completed', done: true };
  }};
  assert.equal(await agent.executeTask('parent', 'parent',undefined,{permission_mode:'full_access'}), 'completed');
  assert.equal(agent.getTaskManager().getAllTasks().length, 2);
  assert.ok(agent.getTaskManager().getAllTasks().every(task => task.state === 'DONE'));
});

test('Windows shell runs Python with UTF-8 output', { skip: process.platform !== 'win32' }, async () => {
  const result = await new ShellTool().execute({ command: 'python -c "print(chr(0x2705))"' }, { cwd: process.cwd(), taskId: 'encoding-test', agentType: 'code', todo: [] });
  assert.equal(result.success, true, result.error);
  assert.equal(result.data.stdout.trim(), '✅');
});

test('execution continues beyond the old iteration setting', async () => {
  const agent = new Agent();
  (agent as any).recorder.run = async (_k: any, _p: any, _id: any, _s: any, operation: any) => operation();
  agent.applySettings({ model_id: 'mock', max_iterations: 1 });
  let iterations = 0;
  (agent as any).mocr = { async *generate(request: any) {
    if (request.toolChoice === 'none' || iterations++>=12) yield {chunk:'completed',done:true};
    else yield { done: true, toolCalls: [{ id: `c${iterations}`, name: 'missing', arguments: '{}' }] };
  }};
  assert.equal(await agent.executeTask('budget', 'test',undefined,{permission_mode:'full_access'}),'completed');
  assert.ok(iterations>10);
});

test('per-turn workspace, model and thinking override global settings', async () => {
  const agent = new Agent();
  agent.applySettings({model_id:'global-model'});
  let request: any;
  let selected = false;
  (agent as any).mocr = {
    async chooseModels(_prompt: string, thinking: boolean, difficulty: number) { selected = true; assert.equal(thinking,true); assert.equal(difficulty,1); return 'auto-model'; },
    async *generate(value: any) { if(value.toolChoice!=='none')request = value; yield {chunk:'ok',done:true}; },
  };
  await agent.executeTask('overrides','test','general',{workdir:process.cwd(),model_id:'chosen-model',thinking_intensity:'high'});
  assert.equal(request.modelId,'chosen-model'); assert.equal(request.thinking,true);
  assert.ok(request.systemPrompt.includes(process.cwd()));
  await agent.executeTask('auto','test','general',{model_id:'MOCR',thinking_intensity:'max'});
  assert.equal(selected,true); assert.equal(request.modelId,'auto-model');
  await agent.executeTask('continuous','test','general',{model_id:'chosen-model',thinking_intensity:'83.7'});
  assert.ok(Math.abs(request.difficultyHint-0.837)<1e-12);assert.equal(request.thinking,true);
  await agent.executeTask('zero','test','general',{model_id:'chosen-model',thinking_intensity:'0'});
  assert.equal(request.difficultyHint,0);assert.equal(request.thinking,false);
  await agent.executeTask('off','test','general',{model_id:'chosen-model',thinking_intensity:'off'});
  assert.equal(request.thinking,false);
  await agent.executeTask('low','test','general',{model_id:'chosen-model',thinking_intensity:'low'});
  assert.equal(request.thinking,true);assert.equal(request.difficultyHint,0.2);
  await assert.rejects(agent.executeTask('bad-path','test','general',{workdir:'Z:/nonexistent-workspace-0kay'}));
});

test('workspace browser and host sampling return real executor information', async () => {
  const agent=new Agent();
  const response=await agent.runDirect('workspace_browse',JSON.stringify({path:process.cwd()}));
  assert.equal(response.success,true,response.error);
  const directory=JSON.parse(response.result);
  assert.equal(directory.path,process.cwd());
  assert.ok(directory.directories.some((entry:any)=>entry.name==='src'));
  const host=await agent.runDirect('host_status','{}');
  const usage=JSON.parse(host.result);
  assert.ok(usage.cpu_percent>=0 && usage.cpu_percent<=100);
  assert.ok(usage.memory_percent>=0 && usage.memory_percent<=100);
});

test('permissions wait, deny and cancel without executing tools', async()=>{
 const manager=new ApprovalManager();let executed=false;
 const pending=manager.request('t','s','bash',{command:'echo test'},process.cwd()).then(()=>{executed=true});
 await tick();assert.equal(executed,false);const item=manager.list()[0];assert.equal(item.tool,'bash');
 manager.decide(item.id,true);await pending;assert.equal(executed,true);assert.equal(manager.list().length,0);
 const denied=manager.request('t2','s','write',{},process.cwd());const check=assert.rejects(denied,/denied/);manager.decide(manager.list()[0].id,false);await check;
 const controller=new AbortController();const cancelled=manager.request('t3','s','bash',{},process.cwd(),controller.signal);const cancellation=assert.rejects(cancelled);controller.abort();await cancellation;assert.equal(manager.list().length,0);
});

test('normal Agent cannot run a tool before the user permits it',async()=>{
 const agent=new Agent();agent.applySettings({model_id:'mock'});let executed=false;
 (agent as any).recorder.run=async(_k:any,_p:any,_i:any,_s:any,op:any)=>op();
 (agent as any).tools.call=async()=>{executed=true;return {success:true,data:'ok'}};
 let turns=0;(agent as any).mocr={async *generate(){if(turns++===0)yield {done:true,toolCalls:[{id:'call',name:'bash',arguments:'{"command":"echo test"}'}]};else yield {done:true,chunk:'finished'}}};
 const execution=agent.executeTask('approval','test',undefined,{session_id:'session',permission_mode:'normal'});
 let pending:any[]=[];for(let i=0;i<100 && !pending.length;i++){await new Promise(r=>setTimeout(r,10));pending=JSON.parse((await agent.runDirect('approval_list','{}')).result)}
 assert.equal(executed,false);assert.equal(pending.length,1);
 await agent.runDirect('approval_decide',JSON.stringify({id:pending[0].id,allow:true}));
 assert.equal(await execution,'finished');assert.equal(executed,true);
});

test('question accepts custom reply and is removed on cancellation',async()=>{
  const manager=new QuestionManager(),controller=new AbortController();
  const pending=manager.ask('task','session',{question:'Choose?',options:['A','B']},controller.signal);
  const item=manager.list()[0];assert.deepEqual(item.options,['A','B']);manager.answer(item.id,'Custom C');assert.equal(await pending,'Custom C');assert.equal(manager.list().length,0);
  const aborted=manager.ask('task','session',{question:'Again?'},controller.signal);const checked=assert.rejects(aborted);controller.abort();await checked;assert.equal(manager.list().length,0);
});

test('subagent wrapper task_id equals children parent_id', async () => {
  const agent = new Agent();
  agent.applySettings({ model_id: 'mock' });
  let wrapperTaskId = '';
  let childModelTaskId = '';
  (agent as any).recorder.run = async (kind: string, _prompt: string, _parentId: string, _sessionId: string, operation: () => Promise<any>, taskId?: string) => {
    if (kind === 'subagent') wrapperTaskId = taskId || '';
    return operation();
  };
  (agent as any).mocr = {
    async *generate(request: any) {
      if (!childModelTaskId) {
        childModelTaskId = `pending:${request.messages.length}`;
        yield { done: true, toolCalls: [{ id: 'c', name: 'task', arguments: JSON.stringify({ prompt: 'child prompt' }) }] };
      } else if (childModelTaskId.startsWith('pending:')) {
        childModelTaskId = request.taskId || '';
        yield { chunk: 'child done', done: true };
      } else {
        yield { chunk: 'parent done', done: true };
      }
    },
  };
  await agent.executeTask('parent-task', 'parent prompt', undefined, { permission_mode: 'full_access', session_id: 's1' });
  assert.ok(wrapperTaskId.startsWith('parent-task:sub:'), wrapperTaskId);
  assert.equal(wrapperTaskId, childModelTaskId);
});

test('assistant reasoning_content is sent as reasoningContent', async () => {
  const definition = loader.loadSync('../proto/mocr/v1/mocr.proto', { keepCase: false, defaults: true, enums: String });
  const pkg: any = grpc.loadPackageDefinition(definition);
  const server = new grpc.Server();
  let received: any;
  server.addService(pkg.mocr.v1.MocrService.service, {
    Generate(call: any) {
      received = call.request;
      call.write({ chunk: 'ok' });
      call.write({ done: true, finishReason: 'FINISH_REASON_STOP', thinkingContent: 'next thought' });
      call.end();
    },
  });
  const port = await new Promise<number>((resolve, reject) => server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (err, port) => err ? reject(err) : resolve(port)));
  try {
    const provider = new MocrProvider({ grpcAddress: `127.0.0.1:${port}` });
    provider.recorder.record = async () => {};
    const chunks = [];
    for await (const chunk of provider.generate({
      modelId: 'mock',
      baseUrl: 'http://mock',
      apiKey: 'mock',
      messages: [
        { role: 'assistant', content: 'hello', toolCalls: [{ id: 'c', name: 'read', arguments: '{}' }], reasoningContent: 'prior thought' },
        { role: 'tool', toolCallId: 'c', content: 'result' },
      ],
    })) chunks.push(chunk);
    assert.equal(received.messages[0].reasoningContent, 'prior thought');
    assert.equal(received.messages[0].toolCallId, '');
    assert.equal(received.messages[1].toolCallId, 'c');
    assert.equal(chunks.find(chunk => chunk.done)?.thinkingContent, 'next thought');
  } finally {
    server.forceShutdown();
  }
});

test('thinking chunks are recorded on assistant history for the next turn', async () => {
  const agent = new Agent();
  agent.applySettings({ model_id: 'mock' });
  (agent as any).recorder.run = async (_k: any, _p: any, _i: any, _s: any, operation: any) => operation();
  (agent as any).tools.call = async () => ({ success: true, data: 'ok' });
  const requests: any[] = [];
  let turn = 0;
  (agent as any).mocr = {
    async *generate(request: any) {
      requests.push(request);
      if (turn++ === 0) {
        yield { done: true, thinkingContent: 'chain of thought', toolCalls: [{ id: 'c1', name: 'bash', arguments: '{"command":"echo hi"}' }] };
      } else {
        yield { chunk: 'completed', done: true };
      }
    },
  };
  await agent.executeTask('reason', 'go', undefined, { permission_mode: 'full_access', session_id: 's2' });
  const assistant = requests[1].messages.find((message: any) => message.role === 'assistant');
  assert.equal(assistant?.reasoningContent, 'chain of thought');
});

test('multiple native tool calls in one turn run in parallel with ordered results', async () => {
  const agent = new Agent();
  (agent as any).recorder.run = async (_k: any, _p: any, _i: any, _s: any, operation: any) => operation();
  agent.applySettings({ model_id: 'mock' });
  let active = 0;
  let maxActive = 0;
  const order: string[] = [];
  (agent as any).tools.call = async (name: string) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, name === 'alpha' ? 20 : 40));
    active--;
    order.push(name);
    return { success: true, data: name };
  };
  const requests: any[] = [];
  let turn = 0;
  (agent as any).mocr = {
    async *generate(request: any) {
      requests.push(request);
      if (turn++ === 0) {
        yield { done: true, toolCalls: [
          { id: 'a1', name: 'alpha', arguments: '{}' },
          { id: 'a2', name: 'beta', arguments: '{}' },
        ] };
      } else {
        yield { chunk: 'completed', done: true };
      }
    },
  };
  assert.equal(await agent.executeTask('parallel', 'go', undefined, { permission_mode: 'full_access', session_id: 's3' }), 'completed');
  assert.equal(maxActive, 2, 'tool calls should overlap');
  assert.deepEqual(order, ['alpha', 'beta']);
  const second = requests[1];
  const toolMessages = second.messages.filter((m: any) => m.role === 'tool');
  assert.deepEqual(toolMessages.map((m: any) => m.toolCallId), ['a1', 'a2']);
  assert.deepEqual(toolMessages.map((m: any) => JSON.parse(m.content).data), ['alpha', 'beta']);
});

test('skills_admin saves, lists and deletes skills; slash force-applies a skill', async () => {
  const agent = new Agent();
  agent.applySettings({ model_id: 'mock', enable_skills: true });
  const saved = await agent.runDirect('skills_admin', JSON.stringify({ action: 'save', name: 'Ui Smoke', content: '# ui-smoke\n\nAlways check contrast first.\n' }));
  assert.equal(saved.success, true);
  const listed = JSON.parse((await agent.runDirect('skills_admin', JSON.stringify({ action: 'list' }))).result);
  assert.ok(listed.skills.some((s: any) => s.name === 'ui-smoke' && s.source === 'file'));
  const missing = await agent.runDirect('skills_admin', JSON.stringify({ action: 'delete', name: 'no-such-skill' }));
  assert.equal(missing.success, false);
  const removed = await agent.runDirect('skills_admin', JSON.stringify({ action: 'delete', name: 'ui-smoke' }));
  assert.equal(removed.success, true);
  const after = JSON.parse((await agent.runDirect('skills_admin', JSON.stringify({ action: 'list' }))).result);
  assert.ok(!after.skills.some((s: any) => s.name === 'ui-smoke'));

  await agent.runDirect('skills_admin', JSON.stringify({ action: 'save', name: 'slash-probe', content: 'NEVER_INVENT_PATHS' }));
  const prompt = (agent as any).getSystemPrompt('/slash-probe do the thing', process.cwd(), 'slash-probe');
  assert.match(prompt, /NEVER_INVENT_PATHS/);
  const del = await agent.runDirect('skills_admin', JSON.stringify({ action: 'delete', name: 'slash-probe' }));
  assert.equal(del.success, true);
});
