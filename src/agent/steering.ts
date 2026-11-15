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
// The queue lives in memory, keyed by task, and is closed when the task ends.
// Closing matters twice: a finished task must not keep accepting text that will
// never be read, and the map must not grow for every task the process ever ran.
// Anything still queued at that moment is returned to the caller so the UI can
// say what was dropped instead of pretending it was delivered.

import { randomUUID } from 'crypto';
import type { AgentEventBus } from './events.js';

export interface Interjection {
  /** Stable handle: the UI removes one entry by id, never by position. */
  id: string;
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

  /**
   * Returns false when the task is not running here, which lets the caller 409.
   *
   * `id` is echoed back on success so the browser can render the entry it just
   * created and later delete exactly that one.
   */
  push(taskId: string, sessionId: string, text: string): { ok: boolean; queued: number; id?: string; reason?: string } {
    const clean = String(text || '').replace(/\u0000/g, '').trim().slice(0, MAX_TEXT);
    if (!clean) return { ok: false, queued: 0, reason: 'empty message' };
    const queue = this.queues.get(taskId);
    if (!queue) return { ok: false, queued: 0, reason: 'task is not running on this executor' };
    if (queue.length >= MAX_PER_TASK) return { ok: false, queued: queue.length, reason: 'too many queued instructions for this task' };
    const entry: Interjection = { id: `steer_${randomUUID()}`, taskId, sessionId, text: clean, createdAt: Date.now() };
    queue.push(entry);
    return { ok: true, queued: queue.length, id: entry.id };
  }

  /** Registers a running task so interjections have somewhere to land. */
  open(taskId: string): void {
    this.queues.set(taskId, []);
  }

  /** Everything still waiting, oldest first. Empty for a task that is not open. */
  list(taskId: string): Interjection[] {
    return [...(this.queues.get(taskId) ?? [])];
  }

  /**
   * Drop one queued instruction.
   *
   * Undoing has to be possible before the drain: the whole point of the queue is
   * that the user typed faster than the agent moved, and a mis-sent line must be
   * retractable while it is still waiting.
   */
  remove(taskId: string, id: string): boolean {
    const queue = this.queues.get(taskId);
    if (!queue || !id) return false;
    const index = queue.findIndex((entry) => entry.id === id);
    if (index < 0) return false;
    queue.splice(index, 1);
    return true;
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