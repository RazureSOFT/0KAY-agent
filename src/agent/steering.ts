// Things the user says while the agent is already working.
//
// The agent cannot be interrupted mid-tool-call — a build in progress is not a
// good place to apply new instructions, and aborting the turn throws away work
// that may be nearly finished. So an interjection is queued instead, and the
// loop drains the queue at the only moment the conversation is quiet: after a
// tool call returns, before the next model turn. That is exactly the point
// where the previous instruction's result is known and the next one is not yet
// chosen.
//
// The queue lives in memory, keyed by task. An interjection for a task that has
// already finished is dropped with a reason the UI can show, rather than being
// silently applied to the next task in the session.

import type { AgentEventBus } from './events.js';

export interface Interjection {
  taskId: string;
  sessionId: string;
  text: string;
  createdAt: number;
}

const MAX_PER_TASK = 8;
const MAX_TEXT = 4000;

export class SteeringQueue {
  private queues = new Map<string, Interjection[]>();
  private readonly events?: AgentEventBus;

  constructor(events?: AgentEventBus) {
    this.events = events;
  }

  /** Returns false when the task is not running here, which lets the caller 409. */
  push(taskId: string, sessionId: string, text: string): { ok: boolean; queued: number; reason?: string } {
    const clean = String(text || '').replace(/\u0000/g, '').trim().slice(0, MAX_TEXT);
    if (!clean) return { ok: false, queued: 0, reason: 'empty message' };
    const queue = this.queues.get(taskId);
    if (!queue) return { ok: false, queued: 0, reason: 'task is not running on this executor' };
    if (queue.length >= MAX_PER_TASK) return { ok: false, queued: queue.length, reason: 'too many queued instructions for this task' };
    queue.push({ taskId, sessionId, text: clean, createdAt: Date.now() });
    return { ok: true, queued: queue.length };
  }

  /** Registers a running task so interjections have somewhere to land. */
  open(taskId: string): void {
    this.queues.set(taskId, []);
  }

  close(taskId: string): Interjection[] {
    const leftovers = this.queues.get(taskId) ?? [];
    this.queues.delete(taskId);
    return leftovers;
  }

  /**
   * Drain, as one block. Several instructions that arrive during one long tool
   * call are one interruption, not several: the model should see them together.
   */
  drain(taskId: string): Interjection[] {
    const queue = this.queues.get(taskId);
    if (!queue || !queue.length) return [];
    const drained = queue.splice(0, queue.length);
    return drained;
  }

  pending(taskId: string): number {
    return this.queues.get(taskId)?.length ?? 0;
  }

  get activeTasks(): string[] {
    return [...this.queues.keys()];
  }
}

export const steering = new SteeringQueue();
