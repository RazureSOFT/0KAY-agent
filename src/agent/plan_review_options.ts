// How the plan tool learns the threshold and the user's own words.
//
// The plan tool runs inside the model's tool loop, where the only context it
// gets is `ToolContext`. The threshold is a setting and the user intent is task
// metadata, so both are handed over in the tool context's `options` map — the
// same channel other per-turn overrides already use. They are read through one
// small module so the key names exist in exactly one place; a typo in a string
// key is otherwise a silent "review never runs".

export interface PlanReviewSettings {
  /** The floor a plan must reach. 0 turns the check off. */
  threshold: number;
  /** The user's request, verbatim, so the plan can be judged against it. */
  userIntent: string;
  /** Optional constraints the user set. */
  constraints?: string;
}

export const PLAN_THRESHOLD_KEY = 'plan_threshold';
export const PLAN_USER_INTENT_KEY = 'user_intent';
export const PLAN_CONSTRAINTS_KEY = 'plan_constraints';

/**
 * Read the settings out of a task's options map.
 *
 * A missing threshold is 0, not a default: silent reviewing is worse than no
 * reviewing, because it spends a model call and can send a plan back without
 * anyone having asked for that. The agent always writes the setting, so the
 * default only matters when the tool is driven directly.
 */
export function reviewOptions(options: Record<string, string> | undefined): PlanReviewSettings {
  const raw = Number(options?.[PLAN_THRESHOLD_KEY]);
  const threshold = Number.isFinite(raw) ? Math.max(0, Math.min(100, Math.round(raw))) : 0;
  return {
    threshold,
    userIntent: String(options?.[PLAN_USER_INTENT_KEY] || ''),
    constraints: options?.[PLAN_CONSTRAINTS_KEY] || undefined,
  };
}

/** The options a task carries so its plan tool can review. */
export function planReviewOptions(threshold: number, userIntent: string, constraints?: string): Record<string, string> {
  return {
    [PLAN_THRESHOLD_KEY]: String(threshold),
    [PLAN_USER_INTENT_KEY]: userIntent,
    ...(constraints ? { [PLAN_CONSTRAINTS_KEY]: constraints } : {}),
  };
}
