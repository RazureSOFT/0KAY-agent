/**
 * Work postures — a 0kay adaptation of Tianshu-harness's "Star Domain".
 *
 * A posture does NOT add capability. It only biases how the agent works by
 * changing the prompt belief (and optionally the tool surface / thresholds) —
 * "the same model, walking into a different posture, lights up a different
 * working tendency." Dependency-free and side-effect free.
 */

export type Intensity = 'off' | 'low' | 'medium' | 'high' | 'max';

export interface Posture {
  id: string;
  /** Short display name (Chinese). */
  name: string;
  /** One-line intent. */
  summary: string;
  /** Prompt-layer belief injected when this posture is active. */
  belief: string;
  /** Tool allow-list; undefined/empty means "all tools". */
  tools?: string[];
  /** Bias the delivery gate toward blocking (verifier posture). */
  strictDelivery?: boolean;
  /** Suggested reasoning intensity. */
  intensity?: Intensity;
}

export const POSTURES: Record<string, Posture> = {
  default: {
    id: 'default',
    name: 'Lumen',
    summary: 'Light the way: probe one step in the fog so the next step is clear',
    belief: 'Probe before acting: when information is missing, do read-only reconnaissance first to make the next step clear, rather than rushing to write code.',
  },
  cautious: {
    id: 'cautious',
    name: 'Taiyi',
    summary: 'Pause first: stabilize this step before the next',
    belief: 'Confirm boundaries and blast radius before acting; when ambiguous, stop and ask. Better to do one step less than to redo it.',
    intensity: 'high',
  },
  bold: {
    id: 'bold',
    name: 'Pojun',
    summary: 'Charge the unknown: failure shrinks the map and leaves a path',
    belief: 'Prefer the smallest experiment to hit the unknown and get real feedback fast; do not ruminate without evidence.',
    intensity: 'low',
  },
  auditor: {
    id: 'auditor',
    name: 'Tianquan',
    summary: 'Weigh both sides: see the cost and the benefit, and say so',
    belief: 'State the benefit/cost trade-off before acting; when a plan is worse, say so directly and offer an alternative.',
  },
  verifier: {
    id: 'verifier',
    name: 'Yaoguang',
    summary: 'Green is not enough: only a reproduced fix counts',
    belief: 'Only complete when the original problem can be reproduced and is fixed; every conclusion needs re-runnable verification evidence.',
    strictDelivery: true,
    intensity: 'high',
  },
  minimalist: {
    id: 'minimalist',
    name: 'Wenqu',
    summary: 'Remove the superfluous: minimal change, intent laid bare',
    belief: 'Satisfy the need with the smallest change: fewest files, fewest lines; no unrelated refactors, renames or comments.',
  },
};

export const DEFAULT_POSTURE_ID = 'default';

/** Resolve a posture by id (case-insensitive); unknown ids fall back to default. */
export function resolvePosture(id?: string): Posture {
  const key = String(id || '').trim().toLowerCase();
  return POSTURES[key] || POSTURES[DEFAULT_POSTURE_ID];
}

export function listPostures(): Posture[] {
  return Object.values(POSTURES);
}

/** Prompt-layer directive for a posture (empty for the default posture). */
export function postureDirective(posture: Posture): string {
  if (!posture || posture.id === DEFAULT_POSTURE_ID) return '';
  const tools = posture.tools && posture.tools.length ? `\nTools limited to: ${posture.tools.join(', ')}.` : '';
  return `Work posture "${posture.name}": ${posture.belief}${tools}`;
}
