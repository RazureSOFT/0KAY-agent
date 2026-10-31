// How much context a model actually has, and when to start folding.
//
// The old behaviour was: a hand-typed `context_window` setting, and if that was
// empty, ask the provider once per iteration. In practice the setting is usually
// 0, the provider often does not answer, and the loop then never compacts until
// the upstream returns a 400 — which costs a full round trip and a retry.
//
// So: resolve the window from the cheapest source that knows it, and derive the
// compaction thresholds from the window instead of hard-coding 0.85.

export type WindowSource = 'configured' | 'provider' | 'inferred' | 'default'

export interface WindowInfo {
  tokens: number
  source: WindowSource
}

/** Fallback when nothing else knows. Large enough to be safe, small enough to be useful. */
export const DEFAULT_CONTEXT_WINDOW = 128_000

// Ordered most-specific first. These are families, not exact models: an unknown
// suffix on a known family is still better than the global default.
const FAMILIES: Array<[RegExp, number]> = [
  [/gemini/i, 1_000_000],
  [/gpt-4\.1|gpt-5|o3|o4/i, 400_000],
  [/claude/i, 200_000],
  [/kimi|moonshot/i, 256_000],
  [/qwen|tongyi/i, 131_072],
  [/deepseek/i, 128_000],
  [/glm|chatglm/i, 128_000],
  [/gpt-4o|gpt-4-turbo|gpt-4|o1/i, 128_000],
  [/llama/i, 131_072],
  [/mistral|mixtral|devstral/i, 32_768],
];

// An explicit `-32k` / `_128k` / `-1m` suffix beats the family table: vendors
// ship the same name at several window sizes.
const SUFFIX = /(?:^|[^a-z0-9])(\d{1,3})\s*k(?![a-z])|(?:^|[^a-z0-9])1m(?![a-z])/i;

export function inferContextWindow(modelId: string, configured = 0, providerValue = 0): WindowInfo {
  if (configured > 0) return { tokens: Math.floor(configured), source: 'configured' };
  if (providerValue > 0) return { tokens: Math.floor(providerValue), source: 'provider' };

  const id = String(modelId || '');
  const suffix = SUFFIX.exec(id);
  if (suffix) {
    if (/1m/i.test(suffix[0])) return { tokens: 1_000_000, source: 'inferred' };
    const thousands = Number(suffix[1]);
    if (Number.isFinite(thousands) && thousands >= 4 && thousands <= 2000) {
      return { tokens: thousands * 1024, source: 'inferred' };
    }
  }
  for (const [pattern, tokens] of FAMILIES) {
    if (pattern.test(id)) return { tokens, source: 'inferred' };
  }
  return { tokens: DEFAULT_CONTEXT_WINDOW, source: 'default' };
}

/**
 * How expensive it is to reshape history for this model.
 *
 * `cache-preserving` is for providers with a persistent exact-prefix cache
 * (DeepSeek and friends): compacting rewrites the prefix, so every compaction
 * throws away a cache that was still paying off. Wait longer, but keep the hard
 * ceiling so a runaway turn cannot blow the window.
 */
export type CacheProfile = 'cache-preserving' | 'balanced' | 'aggressive';

export function cacheProfileFor(modelId: string): CacheProfile {
  const id = String(modelId || '').toLowerCase();
  if (/deepseek|moonshot|kimi/.test(id)) return 'cache-preserving';
  if (/local|ollama|lmstudio|llama\.cpp/.test(id)) return 'aggressive';
  return 'balanced';
}

export interface CompactPolicy {
  /** Warn in the context meter. */
  watch: number;
  /** Fold history before the next request. */
  compact: number;
  /** Fold mid-turn, even between tool calls. */
  reactive: number;
  /** Never let a single request exceed this share of the window. */
  ceiling: number;
}

const RATIOS: Record<CacheProfile, CompactPolicy> = {
  'cache-preserving': { watch: 0.72, compact: 0.86, reactive: 0.92, ceiling: 0.95 },
  balanced: { watch: 0.6, compact: 0.78, reactive: 0.88, ceiling: 0.95 },
  aggressive: { watch: 0.5, compact: 0.68, reactive: 0.8, ceiling: 0.92 },
};

export function compactPolicy(modelId: string, profile?: CacheProfile): CompactPolicy {
  return { ...RATIOS[profile || cacheProfileFor(modelId)] };
}

export type CompactTier = 'none' | 'watch' | 'compact' | 'reactive' | 'ceiling';

/** Which tier a token count falls into. `ratio` is used/limit. */
export function decideCompactTier(used: number, window: number, policy: CompactPolicy): CompactTier {
  if (window <= 0) return 'none';
  const ratio = used / window;
  if (ratio >= policy.ceiling) return 'ceiling';
  if (ratio >= policy.reactive) return 'reactive';
  if (ratio >= policy.compact) return 'compact';
  if (ratio >= policy.watch) return 'watch';
  return 'none';
}
