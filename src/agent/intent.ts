// The four numbers the gate refuses to guess.
//
// An intent is one thing the user asked for, and an agent that never writes its
// intents down cannot be checked against them. The ledger is updated only through
// the intent tool, so the completion score is something the model had to spell out,
// one line per item, with a reason for every claim.
//
// The rules are deliberately mechanical. A rule the model can satisfy by talking
// is not a gate, so if a rule blocks a legitimate finish the score moves, never the rules:
//   - completion_rate = 100 only holds when it is derived from every intent
//     being marked done — a self-declared 100 with open items is rejected;
//   - "done" needs evidence: a recorded tool call, or a filled-in method line.
//     Reasoning alone is not evidence.

export const INTENT_STATUSES = ['pending', 'in_progress', 'done', 'blocked'] as const;
export type IntentStatus = typeof INTENT_STATUSES[number];

export type IntentSource = 'agent' | 'reviewer' | 'user';

export interface Intent {
  id: string;
  /** What the user gets. Written in the user's own words where possible. */
  description: string;
  /** How this build intends to deliver it. */
  method: string;
  status: IntentStatus;
  /** Why it is not done, or what proves it is. */
  evidence: string;
  source: IntentSource;
  updatedAt: number;
}

export interface IntentState {
  intents: Intent[];
  completionRate: number;
  /** The one-line plan of attack, shown to the user next to the intents. */
  approach: string;
}

export interface IntentCheck {
  ok: boolean;
  problems: string[];
  derived: number;
}

const DONE = 1;
const HALF = 0.5;

function clean(value: unknown, max: number): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function intentScore(intent: Intent): number {
  switch (intent.status) {
    case 'done': return DONE;
    case 'in_progress': return HALF;
    case 'blocked': return 0;
    default: return 0;
  }
}

/** Weighted by intent status; each intent counts the same. */
export function deriveCompletion(intents: Intent[]): number {
  if (!intents.length) return 0;
  const total = intents.reduce((sum, intent) => sum + intentScore(intent), 0);
  return Math.round((total / intents.length) * 100);
}

export class IntentLedger {
  private state: IntentState = { intents: [], completionRate: 0, approach: '' };

  get current(): IntentState {
    return { intents: this.state.intents.map((intent) => ({ ...intent })), completionRate: this.state.completionRate, approach: this.state.approach };
  }

  get empty(): boolean {
    return this.state.intents.length === 0;
  }

  /**
   * Apply an update from the intent tool. Unknown ids are new intents; an entry
   * with the same description is merged rather than duplicated, because models
   * re-send their list on every step instead of sending a diff.
   */
  update(raw: Array<Record<string, any>>, approach = '', source: IntentSource = 'agent'): IntentCheck {
    const now = Date.now();
    for (const entry of Array.isArray(raw) ? raw : []) {
      const description = clean(entry?.description, 400);
      if (!description) continue;
      const id = clean(entry?.id, 64) || `i${this.state.intents.length + 1}`;
      const status: IntentStatus = INTENT_STATUSES.includes(entry?.status) ? entry.status : 'pending';
      const method = clean(entry?.method, 600);
      const evidence = clean(entry?.evidence, 600);
      const existing = this.state.intents.find((intent) => intent.id === id)
        ?? this.state.intents.find((intent) => intent.description.toLowerCase() === description.toLowerCase());
      if (existing) {
        existing.description = description;
        if (method) existing.method = method;
        if (evidence) existing.evidence = evidence;
        existing.status = status;
        existing.source = source;
        existing.updatedAt = now;
      } else {
        this.state.intents.push({ id, description, method, status, evidence, source, updatedAt: now });
      }
    }
    if (approach) this.state.approach = clean(approach, 600);
    return this.check();
  }

  /** Applies the reviewer's correction: it may add intents the agent missed. */
  addMissing(descriptions: string[]): Intent[] {
    const added: Intent[] = [];
    const now = Date.now();
    for (const raw of descriptions || []) {
      const description = clean(raw, 400);
      if (!description) continue;
      if (this.state.intents.some((intent) => intent.description.toLowerCase() === description.toLowerCase())) continue;
      const intent: Intent = {
        id: `r${this.state.intents.length + 1}`,
        description,
        method: '',
        status: 'pending',
        evidence: 'added by the reviewer: the user asked for this and no intent covered it',
        source: 'reviewer',
        updatedAt: now,
      };
      this.state.intents.push(intent);
      added.push({ ...intent });
    }
    this.check();
    return added;
  }

  /**
   * Rule check. `claimed` is what the agent reported for this finish; when it is
   * absent the score is purely derived.
   *
   * `options.requiresPlan` turns on the plan-before-code rule: when the task is
   * going to change something (a mutation is on record), an intent with no
   * method and no approach is a plan that was never written down. The work may
   * still be right — but the user cannot see the reasoning, and a correction
   * has nothing to correct. So the ledger itself asks for the missing line.
   *
   * `options.approach` is the plan the caller is finishing under. The loop passes
   * the same value the reviewer gets, so a plan stated once for the whole turn
   * counts even when it never reached the ledger row.
   */
  check(claimed?: number, options: { requiresPlan?: boolean; approach?: string } = {}): IntentCheck {
    const problems: string[] = [];
    if (!this.state.intents.length) {
      problems.push('No intents are recorded. Call the intent tool first with one entry per thing the user asked for.');
    }
    const statedPlan = (options.approach ?? '').trim() || this.state.approach.trim();
    if (options.requiresPlan && this.state.intents.length && !statedPlan) {
      const methodless = this.state.intents.filter((intent) => !intent.method.trim());
      if (methodless.length) {
        problems.push(`Plan first: ${methodless.length} intent(s) have no method and the ledger has no approach. Say how each one will be delivered before claiming it is done (${methodless.map((intent) => intent.id).join(', ')}).`);
      }
    }
    const open = this.state.intents.filter((intent) => intent.status !== 'done');
    if (open.length) {
      problems.push(`${open.length} intent(s) are not done: ${open.map((intent) => `${intent.id} "${intent.description}" (${intent.status})`).join('; ')}`);
    }
    const noEvidence = this.state.intents.filter((intent) => intent.status === 'done' && !intent.evidence && !intent.method);
    if (noEvidence.length) {
      problems.push(`Marked done without evidence: ${noEvidence.map((intent) => intent.id).join(', ')}. Put the command output, file path, or method that proves it in "evidence".`);
    }
    const derived = deriveCompletion(this.state.intents);
    this.state.completionRate = derived;
    if (typeof claimed === 'number' && Number.isFinite(claimed)) {
      const gap = Math.abs(claimed - derived);
      if (claimed >= 100 && derived < 100) {
        problems.push(`You reported ${Math.round(claimed)}% but the intents derive ${derived}%. A completion rate is not a declaration; it follows from the intent list.`);
      } else if (gap > 15) {
        problems.push(`You reported ${Math.round(claimed)}% but the intents derive ${derived}%.`);
      }
    }
    return { ok: problems.length === 0, problems, derived };
  }

  /** Short block for the system prompt; empty before the first update. */
  promptBlock(): string {
    if (!this.state.intents.length) return '';
    const lines = this.state.intents.map((intent) =>
      `- [${intent.status}] ${intent.id}: ${intent.description}${intent.method ? ` — method: ${intent.method}` : ''}${intent.evidence ? ` — evidence: ${intent.evidence}` : ''}`);
    return [
      `Intent ledger (derived completion: ${this.state.completionRate}%). This is the authoritative list of what the user asked for; finishing is judged against it, not against your own estimate.`,
      this.state.approach ? `Approach: ${this.state.approach}` : '',
      ...lines,
    ].filter(Boolean).join('\n');
  }

  serialize(): IntentState {
    return this.current;
  }

  restore(state: Partial<IntentState> | null | undefined): void {
    if (!state || !Array.isArray(state.intents)) return;
    this.state = {
      intents: state.intents.map((intent: any) => ({
        id: clean(intent?.id, 64) || 'i1',
        description: clean(intent?.description, 400),
        method: clean(intent?.method, 600),
        status: INTENT_STATUSES.includes(intent?.status) ? intent.status : 'pending',
        evidence: clean(intent?.evidence, 600),
        source: (['agent', 'reviewer', 'user'] as IntentSource[]).includes(intent?.source) ? intent.source : 'agent',
        updatedAt: Number(intent?.updatedAt) || Date.now(),
      })).filter((intent) => intent.description),
      completionRate: Math.max(0, Math.min(100, Math.round(Number(state.completionRate) || 0))),
      approach: clean(state.approach, 600),
    };
  }
}
