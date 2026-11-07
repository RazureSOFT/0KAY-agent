// One event stream for everything that happens inside a task.
//
// The loop used to be a straight line: call the model, run the tools, repeat.
// Nothing could watch that line, so nothing could react to it — not the
// progress meter, not the reviewer, not a plugin. This bus is the join point:
// the loop emits, and every listener decides for itself what to do.
//
// Two rules keep it from becoming a source of bugs:
//   - a listener that throws must never take the task down with it, so every
//     call is wrapped;
//   - emission is synchronous, so a listener sees events in the exact order the
//     loop produced them. Long work belongs in a listener's own queue, not here.

export type AgentEventType =
  | 'task.started'
  | 'intent.updated'
  | 'turn.started'
  | 'reasoning.delta'
  | 'text.delta'
  | 'tool.called'
  | 'tool.result'
  | 'review.started'
  | 'review.verdict'
  | 'fact.written'
  | 'gate.passed'
  | 'gate.rejected'
  | 'task.finished';

export interface AgentEvent {
  type: AgentEventType;
  taskId: string;
  sessionId: string;
  /** Milliseconds since the task started; the UI uses it to draw a timeline. */
  at: number;
  data: Record<string, any>;
}

export type AgentListener = (event: AgentEvent) => void;

export class AgentEventBus {
  private listeners = new Set<AgentListener>();
  private history = new Map<string, AgentEvent[]>();
  private static readonly MAX_HISTORY = 400;

  on(listener: AgentListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener) };
  }

  emit(event: AgentEvent): void {
    const log = this.history.get(event.taskId) ?? [];
    log.push(event);
    if (log.length > AgentEventBus.MAX_HISTORY) log.splice(0, log.length - AgentEventBus.MAX_HISTORY);
    this.history.set(event.taskId, log);
    for (const listener of this.listeners) {
      try { listener(event) } catch (error: any) {
        console.warn(`[Agent] event listener failed on ${event.type}: ${error?.message || error}`);
      }
    }
  }

  /** Everything one task emitted, oldest first. Empty once the task is pruned. */
  timeline(taskId: string): AgentEvent[] {
    return [...(this.history.get(taskId) ?? [])];
  }

  forget(taskId: string): void {
    this.history.delete(taskId);
  }

  /** Listeners are process-wide; tests use this to start from a clean bus. */
  clear(): void {
    this.listeners.clear();
    this.history.clear();
  }
}

export const agentEvents = new AgentEventBus();
