// fact_1 .. fact_10: the ten things worth remembering about this task.
//
// The transcript already holds every fact, but the transcript gets compacted and
// the model loses the middle of it. These are the survivors: ten slots, newest
// first, recalled into the prompt on demand. A slot is a statement of fact about
// the work ("the gateway listens on 8080", "the build needs --ignore-scripts"),
// not a plan and not a todo item — those have their own tools.
//
// Two guards, both learned from how these lists usually rot:
//   - slots are capped and use LIFO, so the latest fact is the one that survives;
//   - writing requires proof and permission. `fact` is the tool for the model,
//     and it can only write inside the workspace unless the policy allows more,
//     because "memory" that escapes the task boundary is how one project's rules
//     end up silently governing another.

import type { PermissionLedger, Proposal, Refusal } from './permission.js';

export const FACT_SLOTS = 10;

export interface Fact {
  slot: string;
  text: string;
  /** Where the fact came from: a tool call, a file, the user. */
  source: string;
  /** What authorises the write, checked before it lands. */
  proof: string;
  taskId: string;
  createdAt: number;
}

export interface FactWrite extends Partial<Proposal> {
  text: string;
  source?: string;
  proof?: string;
  slot?: string;
}

export class FactMemory {
  private facts: Fact[] = [];
  private readonly limit: number;

  constructor(limit = FACT_SLOTS) {
    this.limit = Math.max(1, Math.min(FACT_SLOTS, limit));
  }

  list(): Fact[] {
    return this.facts.map((fact) => ({ ...fact }));
  }

  /** LIFO: the most recent fact is recalled first, because it is the current state. */
  recall(limit = this.limit): Fact[] {
    return this.facts.slice(0, limit).map((fact) => ({ ...fact }));
  }

  get empty(): boolean {
    return this.facts.length === 0;
  }

  /**
   * Write a fact. Returns the refusal object instead when the write has no
   * permission, so the tool can hand the reason to the model instead of
   * silently dropping the fact.
   */
  write(write: FactWrite, taskId: string, ledger: PermissionLedger): Fact | Refusal {
    const text = String(write.text || '').replace(/\s+/g, ' ').trim();
    if (!text) return { ok: false, reason: 'a fact needs text' };
    const decision = ledger.check({
      kind: 'memory',
      scope: write.scope || '',
      proof: write.proof || '',
      actor: 'agent',
    });
    if (!decision.ok) return decision;
    const dedupe = this.facts.find((fact) => fact.text.toLowerCase() === text.toLowerCase());
    if (dedupe) {
      dedupe.createdAt = Date.now();
      // Re-insert at the head: re-stating a fact is a signal it is still current.
      this.facts = [dedupe, ...this.facts.filter((fact) => fact !== dedupe)];
      this.renumber();
      return { ...dedupe };
    }
    const fact: Fact = {
      slot: write.slot || `fact_${this.facts.length + 1}`,
      text: text.slice(0, 600),
      source: String(write.source || 'agent').slice(0, 120),
      proof: String(write.proof || '').slice(0, 400),
      taskId,
      createdAt: Date.now(),
    };
    this.facts = [fact, ...this.facts].slice(0, this.limit);
    this.renumber();
    return { ...fact };
  }

  remove(slot: string): boolean {
    const index = this.facts.findIndex((fact) => fact.slot === slot);
    if (index < 0) return false;
    this.facts.splice(index, 1);
    this.renumber();
    return true;
  }

  /** Slots are positional, so they are reassigned after every change. */
  private renumber(): void {
    this.facts = this.facts.map((fact, index) => ({ ...fact, slot: `fact_${index + 1}` }));
  }

  promptBlock(): string {
    if (!this.facts.length) return '';
    return [
      'Facts recalled for this task (most recent first; these are established, do not re-derive them):',
      ...this.facts.map((fact) => `- ${fact.slot}: ${fact.text}${fact.source ? ` (from ${fact.source})` : ''}`),
    ].join('\n');
  }
}
