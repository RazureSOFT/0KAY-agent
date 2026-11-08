// The 100% gate.
//
// Flow:
//   agent calls progress or finish with completion_rate = 100
//     -> the gate checks the intent ledger (mechanical rules, no model call)
//     -> if the rules reject, the agent gets the reasons back as a tool result
//        and keeps working; no reviewer is paid for
//     -> if the rules pass, the reviewer runs, reads the files, and decides
//     -> PASS: {status:"success"}, the task ends
//        REJECT: {status:"reject", actual_completion, missing_intents, fix_feedback}
//        as the tool's response, so the loop continues with the correction
//        in hand rather than a user-facing scolding
//     -> three rejects in a row: stop, and hand control to the user.
//
// Below 100% nothing here runs. Ordinary work is not audited; only the claim of
// being finished is.

import { randomUUID } from 'crypto';
import { IntentLedger, type IntentState } from './intent.js';
import { reviewDelivery, type ReviewResult, type ReviewRequest } from './reviewer.js';
import type { DeliveryReport, ToolTraceEntry } from './supervision.js';
import type { LlmCaller } from '../tools/types.js';
import type { AgentEventBus } from './events.js';

export type GateMode = 'off' | 'rules' | 'full';

export interface GateSettings {
  mode: GateMode;
  /** Identifies the model to use for review; empty means the task's own model. */
  reviewerModel: string;
  maxRejects: number;
  maxToolSteps: number;
  budgetMs: number;
  /** Plans are checked before code: a mutating task needs an approach on record. */
  requirePlan: boolean;
  /** Patterns of files the review may look at but never grades on. */
  ignore: string[];
}

export const DEFAULT_GATE: GateSettings = {
  mode: 'full',
  reviewerModel: '',
  maxRejects: 3,
  maxToolSteps: 6,
  budgetMs: 120_000,
  requirePlan: true,
  ignore: ['node_modules', 'dist', 'out', '.git'],
};

export interface GateInput {
  taskId: string;
  sessionId: string;
  cwd: string;
  userIntent: string;
  claim: string;
  approach: string;
  completionRate?: number;
  trace: ToolTraceEntry[];
  delivery: DeliveryReport;
  transcript: string;
  touched: string[];
  /** Notes from enabled plugins, handed to the reviewer as context. */
  reviewerNotes?: string;
}

export interface GateOutcome {
  /** What goes back to the model as the tool result payload. */
  payload: Record<string, any>;
  pass: boolean;
  /** True when the loop must stop and the user has to take over. */
  exhausted: boolean;
  review?: ReviewResult;
  intent: IntentState;
  rejectCount: number;
}

export function resolveGateMode(value: unknown, fallback: GateMode = DEFAULT_GATE.mode): GateMode {
  const raw = String(value ?? '').trim().toLowerCase();
  if (raw === 'off' || raw === '0' || raw === 'false' || raw === 'none') return 'off';
  if (raw === 'rules' || raw === '1' || raw === 'true' || raw === 'basic') return 'rules';
  if (raw === 'full' || raw === '2' || raw === 'strict' || raw === 'reviewer') return 'full';
  return fallback;
}

export class QualityGate {
  private readonly intents: IntentLedger;
  private readonly settings: GateSettings;
  private readonly events?: AgentEventBus;
  private rejectCount = 0;
  private reviews = 0;

  constructor(options: {
    intents?: IntentLedger;
    settings?: Partial<GateSettings>;
    events?: AgentEventBus;
  } = {}) {
    this.intents = options.intents ?? new IntentLedger();
    this.settings = { ...DEFAULT_GATE, ...(options.settings || {}) };
    this.events = options.events;
  }

  get ledger(): IntentLedger {
    return this.intents;
  }

  get stats(): { reviews: number; rejects: number } {
    return { reviews: this.reviews, rejects: this.rejectCount };
  }

  get enabled(): boolean {
    return this.settings.mode !== 'off';
  }

  /**
   * Called for every intent tool update: records the state, and tells the UI the
   * score moved so the intent strip is live rather than end-of-task.
   */
  updateIntents(raw: Array<Record<string, any>>, approach = '', source: 'agent' | 'reviewer' | 'user' = 'agent', input?: { taskId: string; sessionId: string }): { derived: number; problems: string[]; ok: boolean } {
    const check = this.intents.update(raw, approach, source);
    if (input && this.events) {
      this.events.emit({
        type: 'intent.updated',
        taskId: input.taskId,
        sessionId: input.sessionId,
        at: Date.now(),
        data: { ...this.intents.serialize(), check: check.problems },
      });
    }
    return { derived: check.derived, problems: check.problems, ok: check.ok };
  }

  /**
   * The gate proper. Returns the payload to hand back as the tool's response.
   */
  async evaluate(input: GateInput, llm: LlmCaller): Promise<GateOutcome> {
    // Plan-before-code only applies to a task that changed something. A question
    // answered without touching a file does not owe the user a plan, and asking
    // for one there would teach the model to write plans for everything.
    const planRequired = this.settings.requirePlan && input.delivery.mutations > 0;
    const check = this.intents.check(input.completionRate, { requiresPlan: planRequired, approach: input.approach });
    const intent = this.intents.serialize();

    // A 100% claim with open intents never reaches the reviewer: the ledger is
    // cheaper and more reliable than a second opinion on the agent's arithmetic.
    if (!check.ok && (input.completionRate ?? 100) >= 100) {
      const outcome: GateOutcome = {
        pass: false,
        exhausted: false,
        rejectCount: this.rejectCount,
        intent,
        payload: {
          status: 'reject',
          actual_completion: `${check.derived}%`,
          missing_intents: this.intents.current.intents.filter((entry) => entry.status !== 'done').map((entry) => entry.description),
          fix_feedback: check.problems.join(' '),
          source: 'intent_rules',
        },
      };
      this.events?.emit({ type: 'gate.rejected', taskId: input.taskId, sessionId: input.sessionId, at: Date.now(), data: outcome.payload });
      return outcome;
    }

    if (this.settings.mode !== 'full') {
      return {
        pass: true,
        exhausted: false,
        rejectCount: this.rejectCount,
        intent,
        payload: { status: 'success', source: 'rules', completion_rate: `${check.derived}%` },
      };
    }

    this.reviews++;
    const startedAt = Date.now();
    this.events?.emit({
      type: 'review.started',
      taskId: input.taskId,
      sessionId: input.sessionId,
      at: startedAt,
      data: { model: this.settings.reviewerModel || 'task model', intents: intent.intents.length },
    });

    const request: ReviewRequest = {
      taskId: input.taskId,
      sessionId: input.sessionId,
      cwd: input.cwd,
      userIntent: input.userIntent,
      intents: intent.intents,
      completionRate: intent.completionRate,
      approach: input.approach || intent.approach,
      claim: input.claim,
      trace: input.trace,
      delivery: input.delivery,
      transcript: input.transcript,
      touched: input.touched,
      reviewerNotes: input.reviewerNotes || '',
      maxToolSteps: this.settings.maxToolSteps,
      budgetMs: this.settings.budgetMs,
    };

    const review = await reviewDelivery(request, llm);
    if (review.verdict === 'reject' && review.missingIntents.length) {
      // Intents the reviewer found missing become real intents, so the next
      // claim has to account for them instead of being re-argued.
      this.intents.addMissing(review.missingIntents);
    }
    const current = this.intents.serialize();

    if (review.verdict === 'pass') {
      this.rejectCount = 0;
      const payload = {
        status: 'success',
        ...(review.degraded ? { degraded: review.degraded } : {}),
        ...(review.audit ? { audit: review.audit } : {}),
        completion_rate: `${current.completionRate}%`,
      };
      this.events?.emit({
        type: 'gate.passed',
        taskId: input.taskId, sessionId: input.sessionId, at: Date.now(),
        data: { ...payload, elapsed_ms: Date.now() - startedAt, steps: review.steps.length },
      });
      return { pass: true, exhausted: false, rejectCount: 0, review, intent: current, payload };
    }

    this.rejectCount++;
    const exhausted = this.rejectCount >= this.settings.maxRejects;
    const payload = {
      status: 'reject',
      actual_completion: `${review.actualCompletion}%`,
      missing_intents: review.missingIntents.length ? review.missingIntents : current.intents.filter((entry) => entry.status !== 'done').map((entry) => entry.description),
      fix_feedback: review.fixFeedback || 'The reviewer rejected the claim without detail. Re-read the request and check each intent against the files.',
      ...(review.audit ? { audit: review.audit } : {}),
      attempt: this.rejectCount,
      max_attempts: this.settings.maxRejects,
      ...(exhausted ? { status_final: 'human_takeover', next: 'Stop working. Tell the user what is still missing and ask them to take over.' } : {}),
    };
    this.events?.emit({
      type: 'gate.rejected',
      taskId: input.taskId, sessionId: input.sessionId, at: Date.now(),
      data: { ...payload, elapsed_ms: Date.now() - startedAt },
    });
    return { pass: false, exhausted, rejectCount: this.rejectCount, review, intent: current, payload };
  }

  /** The block the loop puts in front of the model, so the gate is not a surprise. */
  directive(): string {
    if (this.settings.mode === 'off') return '';
    return [
      'Completion gate (enforced, not advisory):',
      '- Record what the user asked for with the intent tool: one entry per request, each with id, description, method, and status. Update it when the list or the status changes.',
      ...(this.settings.requirePlan
        ? ['- Plan before code. Every intent needs a method (the file, the approach, the command) and the ledger needs an approach line before a change can be claimed as done. A task that writes files without a written plan is rejected by the ledger, not reviewed.']
        : []),
      '- Your completion rate is derived from those entries. Reporting 100% while any entry is open is rejected mechanically, before any review.',
      `- A 100% claim is reviewed by a second model that reads your files. It can reject you. After ${this.settings.maxRejects} rejections the task stops and the user takes over.`,
      '- A done entry needs evidence: the command output, the file and line, or the method that proves it. "I implemented it" is not evidence.',
    ].join('\n');
  }

  traceSummary(): string {
    return `${this.reviews} review(s), ${this.rejectCount} consecutive rejection(s)`;
  }

  newReviewId(): string {
    return randomUUID();
  }
}
