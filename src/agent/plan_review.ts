// The plan reviewer: a second model that reads a plan before anyone builds it.
//
// The delivery reviewer (reviewer.ts) audits work that is already done. This is
// the earlier gate, and it is a different job: judging whether a plan is worth
// executing at all, while changing it is still cheap. A plan that scores below
// the user's threshold goes back to the planner with specific edits, not with a
// verdict.
//
// The persona is deliberate. A reviewer that nitpicks gets ignored; a reviewer
// that never objects is decoration. So it is told to push back hard on anything
// that would waste the build — an unstated assumption, a step that cannot be
// verified, a piece of the request with no step that delivers it — and to say
// nothing about style, naming or formatting. It also has to say what is right,
// because a plan with real strengths should not be rewritten to chase a score.
//
// The score is three separate numbers rather than one, because they fail
// differently. A plan can be feasible but incomplete (misses half the request),
// or complete but low-confidence (guesses at an API it never checked). Averaging
// them into one number hides which problem needs fixing.

import type { LlmCaller } from '../tools/types.js';

export interface PlanReviewRequest {
  /** The user's request, verbatim. The plan is judged against this. */
  userIntent: string;
  /** The plan as markdown. */
  plan: string;
  /** Optional constraints the user set (deadline, must-not-break, stack). */
  constraints?: string;
  /** Where the plan will be built — a directory listing helps judge feasibility. */
  workspaceNote?: string;
  budgetMs?: number;
}

/** One thing the reviewer objects to, with enough context to act on it. */
export interface PlanObjection {
  /** Which part of the plan this is about — a heading or the step text. */
  where: string;
  /** Why it is a problem, in one sentence. */
  problem: string;
  /** What to do instead. Empty when the fix is obvious from the problem. */
  suggestion: string;
  severity: 'blocker' | 'concern'
}

export interface PlanReview {
  /** Can this be built as written? 0–100. */
  feasibility: number;
  /** How sure is the reviewer that the plan is correct, not just buildable? 0–100. */
  confidence: number;
  /** How much of the user's request does the plan actually deliver? 0–100. */
  completeness: number;
  /** The lowest of the three: what the threshold is compared against. */
  score: number;
  objections: PlanObjection[];
  /** What the plan gets right, so a good plan is not rewritten to chase a score. */
  strengths: string[];
  /** Concrete instructions for the planner's next attempt. */
  revise: string;
  /** Set when the reviewer could not be reached; the plan proceeds unreviewed. */
  degraded?: string;
  elapsedMs: number;
}

export type PlanVerdict = 'pass' | 'revise';

const PLAN_REVIEWER_SYSTEM = `You are the plan reviewer for an autonomous coding agent. You read a plan BEFORE it is built, while changing it is still free, and you decide whether it is worth building.

You are not there to approve. The planner is optimistic about its own plan; your value is in the objections it did not think of.

Push hard on:
- ASSUMPTIONS stated as fact. "The API accepts a batch parameter" is a claim; if the plan never checks it and the build depends on it, say so.
- STEPS THAT CANNOT BE VERIFIED. A step with no way to tell success from failure is not a step, it is a hope. Name what the check should be.
- MISSING PARTS OF THE REQUEST. Compare the plan to the user's words item by item. Something asked for with no step that delivers it is incomplete, however good the rest is.
- HIDDEN COUPLING. Does step 4 quietly depend on step 2 having changed a file a different way? Ordering that is not stated is a plan that fails halfway.
- SCOPE CREEP. Work the user did not ask for, that spends the budget on something else.

Do NOT object to: naming, formatting, code style, file organisation preferences, or the choice of a reasonable library. Those do not change whether the plan works, and raising them buries the real problems.

Score three things separately, each 0-100:
- feasibility: can this be built as written, in this workspace, with the steps given?
- confidence: how sure are you the result would be correct, not merely buildable? Guessing at a signature you could have checked scores low.
- completeness: how much of the user's request does the plan have a step for?

Also state what the plan gets right. A plan with a sound approach should keep it; your revise note must be edits, not a rewrite.

Reply with one JSON object and nothing else:
{"feasibility":0-100,"confidence":0-100,"completeness":0-100,"strengths":["..."],"objections":[{"where":"...","problem":"...","suggestion":"...","severity":"blocker"|"concern"}],"revise":"..."}

where names the part of the plan (a heading or a step's own words). revise is what the planner should change, addressed to the planner, specific enough to act on without re-reading this review.`;

function clip(value: string, max: number): string {
  const text = String(value ?? '');
  return text.length <= max ? text : `${text.slice(0, max)}\n[truncated ${text.length - max} chars]`;
}

function clampPercent(value: unknown, fallback: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(100, Math.round(number)));
}

/**
 * The lowest of the three scores.
 *
 * The threshold is a floor, not an average: a plan that is complete and
 * confident but cannot be built is not 70% good, it is unbuildable. Taking the
 * minimum means the weakest dimension is the one that has to reach the bar.
 */
export function planScore(feasibility: number, confidence: number, completeness: number): number {
  return Math.min(feasibility, confidence, completeness);
}

export function normalizeObjection(raw: unknown): PlanObjection | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const problem = String(value.problem || '').trim();
  const where = String(value.where || '').trim();
  // An objection with no problem is not actionable; an objection with no
  // location cannot be applied to a plan the planner has to edit.
  if (!problem || !where) return null;
  return {
    where,
    problem,
    suggestion: String(value.suggestion || '').trim(),
    severity: value.severity === 'blocker' ? 'blocker' : 'concern',
  };
}

/**
 * Read the reviewer's answer.
 *
 * Returns null when no verdict can be recovered, which the caller treats as a
 * degraded review rather than as a rejection — a reviewer that mumbles must not
 * be able to block a build.
 */
export function parsePlanReview(text: string, elapsedMs: number): PlanReview | null {
  const candidate = (() => {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text || '');
    return fenced ? fenced[1] : String(text || '');
  })();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed: any;
  try {
    parsed = JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const feasibility = clampPercent(parsed.feasibility, 0);
  const confidence = clampPercent(parsed.confidence, 0);
  const completeness = clampPercent(parsed.completeness, 0);
  const strengths = Array.isArray(parsed.strengths)
    ? parsed.strengths.map((item: any) => String(item || '').trim()).filter(Boolean).slice(0, 8)
    : [];
  const objections = Array.isArray(parsed.objections)
    ? parsed.objections.map(normalizeObjection).filter((item: PlanObjection | null): item is PlanObjection => !!item).slice(0, 20)
    : [];

  return {
    feasibility,
    confidence,
    completeness,
    score: planScore(feasibility, confidence, completeness),
    objections,
    strengths,
    revise: String(parsed.revise || '').trim(),
    elapsedMs,
  };
}

/**
 * Does this review clear the user's threshold?
 *
 * A review with an unaddressed blocker never passes, whatever it scored: a
 * planning model that rates its own plan 80 while listing a blocker is
 * contradicting itself, and the blocker is the honest half.
 */
export function planVerdict(review: PlanReview, threshold: number): PlanVerdict {
  if (review.degraded) return 'pass';
  if (review.score < threshold) return 'revise';
  if (review.objections.some((item) => item.severity === 'blocker')) return 'revise';
  return 'pass';
}

/** The planning model in the agent, or a dedicated model when one is configured. */
export type PlanReviewCaller = LlmCaller;

export async function reviewPlan(request: PlanReviewRequest, llm: PlanReviewCaller): Promise<PlanReview> {
  const started = Date.now();
  const plan = String(request.plan || '').trim();
  if (!plan) {
    return {
      feasibility: 0,
      confidence: 0,
      completeness: 0,
      score: 0,
      objections: [{ where: '(whole plan)', problem: 'the plan is empty', suggestion: 'Write the steps before submitting.', severity: 'blocker' }],
      strengths: [],
      revise: 'There is nothing to review; produce a plan with steps.',
      elapsedMs: Date.now() - started,
    };
  }

  const prompt = [
    `USER REQUEST (verbatim):\n${clip(request.userIntent, 6000)}`,
    request.constraints ? `\nCONSTRAINTS THE USER SET:\n${clip(request.constraints, 1500)}` : '',
    request.workspaceNote ? `\nWORKSPACE:\n${clip(request.workspaceNote, 1500)}` : '',
    `\nPLAN TO REVIEW:\n${clip(plan, 16_000)}`,
  ].filter(Boolean).join('\n');

  try {
    const reply = await llm({
      messages: [{ role: 'user', content: prompt }],
      systemPrompt: PLAN_REVIEWER_SYSTEM,
      temperature: 0.1,
      maxTokens: 2400,
    });
    if (!reply || !reply.trim()) {
      return degradedReview(request, 'the plan reviewer returned nothing', started);
    }
    const parsed = parsePlanReview(reply, Date.now() - started);
    if (!parsed) {
      return degradedReview(request, 'the plan reviewer did not return a usable verdict', started);
    }
    return parsed;
  } catch (error: any) {
    return degradedReview(request, `the plan reviewer failed: ${error?.message || error}`, started);
  }
}

/**
 * A review that could not happen.
 *
 * It passes, with the degradation recorded. A second opinion is a quality
 * control, not a dependency, and a reviewer that is down must not be able to
 * stop every build in the system.
 */
function degradedReview(request: PlanReviewRequest, reason: string, started: number): PlanReview {
  return {
    feasibility: 100,
    confidence: 100,
    completeness: 100,
    score: 100,
    objections: [],
    strengths: [],
    revise: '',
    degraded: reason,
    elapsedMs: Date.now() - started,
  };
}
