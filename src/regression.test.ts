import test from 'node:test';
import assert from 'node:assert/strict';
import * as grpc from '@grpc/grpc-js';
import * as loader from '@grpc/proto-loader';
import { Agent } from './agent/agent.js';
import { MocrProvider } from './provider/mocr.js';
import { ShellTool } from './tools/tools.js';
import { ApprovalManager } from './task/approvals.js';

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
  for (const failure of ['iterations', 'transport', 'finish']) {
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

test('budget exhaustion gives a final no-tool explanation and remains failed', async () => {
  const agent = new Agent();
  (agent as any).recorder.run = async (_k: any, _p: any, _id: any, _s: any, operation: any) => operation();
  agent.applySettings({ model_id: 'mock', max_iterations: 1 });
  let summarized = false;
  (agent as any).mocr = { async *generate(request: any) {
    if (request.toolChoice === 'none') { summarized = true; yield { chunk: 'Created script; network probe timed out.', done: true }; }
    else yield { done: true, toolCalls: [{ id: 'c', name: 'missing', arguments: '{}' }] };
  }};
  await assert.rejects(agent.executeTask('budget', 'test',undefined,{permission_mode:'full_access'}), /Created script; network probe timed out/);
  assert.equal(summarized, true);
  assert.equal(agent.getTaskManager().getTask('budget')?.state, 'FAILED');
});

test('per-turn workspace, model and thinking override global settings', async () => {
  const agent = new Agent();
  agent.applySettings({model_id:'global-model'});
  let request: any;
  let selected = false;
  (agent as any).mocr = {
    async chooseModels(_prompt: string, thinking: boolean, difficulty: number) { selected = true; assert.equal(thinking,true); assert.equal(difficulty,1); return 'auto-model'; },
    async *generate(value: any) { request = value; yield {chunk:'ok',done:true}; },
  };
  await agent.executeTask('overrides','test','general',{workdir:process.cwd(),model_id:'chosen-model',thinking_intensity:'high'});
  assert.equal(request.modelId,'chosen-model'); assert.equal(request.thinking,true);
  assert.ok(request.systemPrompt.includes(process.cwd()));
  await agent.executeTask('auto','test','general',{model_id:'MOCR',thinking_intensity:'max'});
  assert.equal(selected,true); assert.equal(request.modelId,'auto-model');
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
