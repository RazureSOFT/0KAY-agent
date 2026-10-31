// The cacheable part of a request.
//
// Providers with prefix caching (DeepSeek, Anthropic, OpenAI) bill the first
// N tokens at full price and everything after a byte-identical prefix at a
// large discount. That only pays off if the prefix really is byte-identical
// between turns, and it silently stops paying off when something volatile —
// an iteration counter, a timestamp, a reordered tool list — creeps into the
// system prompt.
//
// `prefixHash` gives one cheap fingerprint of the parts that should be stable,
// so a drift can be observed instead of guessed at.

import { createHash } from 'node:crypto';

/** JSON with object keys sorted at every level, so ordering never changes the hash. */
export function stableStringify(value: unknown): string {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      const source = node as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(source).sort()) out[key] = walk(source[key]);
      return out;
    }
    return node;
  };
  return JSON.stringify(walk(value)) ?? '';
}

export interface PrefixParts {
  system: string;
  tools: unknown;
}

/** Short, stable fingerprint of the cacheable prefix. */
export function prefixHash(parts: PrefixParts): string {
  const payload = stableStringify({ system: String(parts.system ?? ''), tools: parts.tools ?? [] });
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}
