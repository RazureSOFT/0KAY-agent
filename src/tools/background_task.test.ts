import test from 'node:test';
import assert from 'node:assert/strict';
import { BackgroundTaskTool } from './background_task.js';

const context = { cwd: process.cwd(), taskId: 'test', agentType: 'agent' } as any;

test('background_task start -> output -> kill', async () => {
  const tool = new BackgroundTaskTool();
  const started: any = await tool.execute({ action: 'start', command: 'node -e "console.log(\'bg-hello\')"' }, context);
  assert.ok(started.success, started.error);
  const id = started.data.id;

  let text = '';
  for (let attempt = 0; attempt < 50; attempt++) {
    const out: any = await tool.execute({ action: 'output', id }, context);
    text = out.data.text;
    if (text.includes('bg-hello')) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(text.includes('bg-hello'), `expected bg-hello, got: ${text}`);

  const killed: any = await tool.execute({ action: 'kill', id }, context);
  assert.ok(killed.success, killed.error);
});

test('background_task rejects unknown jobs', async () => {
  const tool = new BackgroundTaskTool();
  const result: any = await tool.execute({ action: 'output', id: 'nope' }, context);
  assert.equal(result.success, false);
});
