import { randomUUID } from 'crypto';

export interface Approval {
  id: string; task_id: string; session_id: string; tool: string; args: Record<string, any>; cwd: string; created_at: string;
}
export class ApprovalManager {
  private pending = new Map<string, { value: Approval; settle: (allowed: boolean) => void }>();
  list(sessionId = ''): Approval[] {
    return [...this.pending.values()].map(item => item.value).filter(item => !sessionId || item.session_id === sessionId);
  }
  decide(id: string, allowed: boolean): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    entry.settle(allowed);
    return true;
  }
  async request(taskId: string, sessionId: string, tool: string, args: Record<string, any>, cwd: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const id = randomUUID();
    await new Promise<void>((resolve, reject) => {
      const clean = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); this.pending.delete(id); };
      const abort = () => { clean(); reject(signal?.reason || new Error('Task cancelled')); };
      const timer = setTimeout(() => { clean(); reject(new Error('Permission request expired after 10 minutes')); }, 600000);
      this.pending.set(id, {value:{ id, task_id:taskId, session_id:sessionId, tool, args, cwd, created_at:new Date().toISOString() },
        settle: allowed => { clean(); allowed ? resolve() : reject(new Error(`User denied permission for ${tool}`)); }});
      signal?.addEventListener('abort', abort, {once:true});
      if (signal?.aborted) abort();
    });
  }
}
