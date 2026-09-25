import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import {coreHeaders,coreFetch} from '../connection.js';

export class TaskRecorder {
  private file = path.join(process.env.AGENT_DATA_DIR || './data/agent', 'task-outbox.json');
  private chain: Promise<void> = Promise.resolve();
  private pending: any[] | null = null;
  async record(event?: any): Promise<void> {
    const operation = this.chain.then(async () => {
      if (!this.pending) {
        try { this.pending = JSON.parse(await fs.readFile(this.file, 'utf8')); }
        catch (error: any) { if (error.code !== 'ENOENT') throw error; this.pending = []; }
      }
        if (event) {
          event={...event};for(const key of ['prompt','result','error','args']) if(typeof event[key]==='string' && event[key].length>200000) event[key]=event[key].slice(0,200000)+'\n[record truncated]';
        this.pending!.push(event);
      }
      await this.save();
      const base = process.env.CORE_HTTP_ADDR || process.env.CORE_HTTP || 'http://127.0.0.1:8080';
      while (this.pending!.length) {
        try {
          const response = await coreFetch(`${base}/api/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json',...coreHeaders() }, body: JSON.stringify(this.pending![0]), signal: AbortSignal.timeout(2000) });
          if (!response.ok && response.status !== 409) {
            if([400,413,422].includes(response.status)) {
              await fs.appendFile(`${this.file}.rejected.jsonl`,JSON.stringify({event:this.pending![0],status:response.status})+'\n','utf8');
            } else break;
          }
        } catch { break; }
        this.pending!.shift();
        await this.save();
      }
    });
    this.chain = operation.catch(error => console.error('Task ledger persistence failed:', error));
    return operation;
  }
  private async save() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(`${this.file}.tmp`, JSON.stringify(this.pending), 'utf8');
    await fs.rename(`${this.file}.tmp`, this.file);
  }
  async run<T>(kind: string, prompt: string, parentId: string, sessionId: string, operation: () => Promise<T>, taskId?: string, args?: string): Promise<T> {
    const event = { task_id: taskId || `agent-${kind}:${randomUUID()}`, caller_id: 'agent', kind, prompt, args: args || '', parent_id: parentId, session_id: sessionId, state: 'running' };
    await this.record(event);
    try {
      const result: any = await operation();
      await this.record({ ...event, state: result?.success === false ? 'failed' : 'done', result: JSON.stringify(result), error: result?.error || '' });
      return result;
    } catch (error: any) {
      await this.record({ ...event, state: error.name === 'AbortError' || /cancelled/i.test(error.message) ? 'cancelled' : 'failed', error: error.message });
      throw error;
    }
  }
}

export const taskRecorder = new TaskRecorder();
