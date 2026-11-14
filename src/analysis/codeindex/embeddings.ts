// Embeddings, when there is a model for them, and an honest answer when there is
// not.
//
// The code index works without this: TF-IDF over the corpus is a real vector
// space and for identifiers it is the better one. What it cannot do is synonymy —
// a search for "extract text" will not find `readable()`. An operator who has an
// embeddings model configured gets that; an operator who does not gets a working
// index rather than a feature that waits for a service.
//
// So this module's most important behaviour is the one where it says no. It
// returns undefined when nothing is configured, and the caller falls back —
// rather than throwing, or worse, sending a request to a base URL of "" and
// reporting the resulting failure as "the index is broken".
//
// The wire shape is OpenAI's `/embeddings`, which is what every provider worth
// configuring speaks, including a local one.

import { coreFetch, coreHeaders } from '../../connection.js';
import type { LlmCaller } from '../../tools/types.js';

export interface EmbeddingConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** The provider's own name, for an error a person can act on. */
  provider: string;
}

export interface Embedder {
  /** The model, so the index can be keyed by it and rebuilt on a change. */
  readonly model: string;
  /** One vector per input, in the same order. */
  embed(texts: string[]): Promise<number[][]>;
}

export class EmbeddingError extends Error {
  constructor(message: string, readonly retryable = false) {
    super(message);
  }
}

/** Provider records, as Core hands them to a plugin. */
interface ProviderRecord {
  id?: string;
  provider?: string;
  kind?: string;
  base_url?: string;
  api_key?: string;
  models?: Array<string | { id?: string; model_id?: string }>;
  default_model?: string;
  disabled_models?: string[];
  enabled?: boolean;
}

function modelIds(record: ProviderRecord): string[] {
  return (record.models || [])
    .map((entry) => (typeof entry === 'string' ? entry : entry.id || entry.model_id || ''))
    .filter((id): id is string => Boolean(id));
}

/**
 * Find the embeddings provider, if there is one.
 *
 * A provider is usable only when its kind is `embedding` — an LLM provider that
 * happens to list a model named "embed-3" is not one, and sending text to a chat
 * endpoint expecting vectors is how a confusing 400 reaches a user.
 */
export async function resolveEmbeddingConfig(
  signal?: AbortSignal,
  options: { model?: string; provider?: string } = {},
): Promise<EmbeddingConfig | undefined> {
  const base = process.env.CORE_HTTP_ADDR || process.env.CORE_HTTP || 'http://127.0.0.1:8080';
  let data: any;
  try {
    const response = await coreFetch(`${base}/api/providers/credentials`, {
      headers: coreHeaders(),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000),
    });
    if (!response.ok) return undefined;
    data = await response.json();
  } catch {
    // Core unreachable is not an embedding misconfiguration and must not read as
    // one: the caller degrades either way, and a wrong reason sends somebody
    // looking in the wrong place.
    return undefined;
  }

  const list: ProviderRecord[] = (Array.isArray(data) ? data : data?.providers || []).filter((p: ProviderRecord) => p.enabled !== false);
  const embeddingProviders = list.filter((record) => String(record.kind || '').toLowerCase() === 'embedding');
  if (!embeddingProviders.length) return undefined;

  let chosen: ProviderRecord | undefined;
  if (options.provider) {
    chosen = embeddingProviders.find((record) => record.provider === options.provider || record.id === options.provider);
  }
  if (!chosen && options.model) {
    chosen = embeddingProviders.find((record) => modelIds(record).includes(options.model!) && !(record.disabled_models || []).includes(options.model!));
  }
  if (!chosen) {
    chosen = embeddingProviders.find((record) => record.id === data?.default_provider_id) || embeddingProviders[0];
  }
  if (!chosen) return undefined;

  const model = options.model && modelIds(chosen).includes(options.model)
    ? options.model
    : chosen.default_model || modelIds(chosen)[0] || '';
  // A base URL or a model with nothing in it means the provider record is
  // incomplete; falling back is better than a request that cannot succeed.
  if (!chosen.base_url || !model) return undefined;

  return {
    baseUrl: String(chosen.base_url).replace(/\/$/, ''),
    apiKey: String(chosen.api_key || ''),
    model,
    provider: String(chosen.provider || chosen.id || 'embedding'),
  };
}

/**
 * An embedder for a resolved config.
 *
 * Batches are sent as given: the caller decides the size, because a provider's
 * limit is the provider's business and guessing here would produce a mystery 413
 * on a corpus that happens to chunk differently.
 */
export function createEmbedder(config: EmbeddingConfig): Embedder {
  return {
    model: config.model,
    async embed(texts: string[]): Promise<number[][]> {
      if (!texts.length) return [];
      const url = `${config.baseUrl}/embeddings`;
      let response: Response;
      try {
        response = await coreFetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
          },
          body: JSON.stringify({ model: config.model, input: texts }),
          signal: AbortSignal.timeout(60_000),
        });
      } catch (error) {
        // A network failure is worth one retry by the caller; a 400 is not.
        throw new EmbeddingError(`could not reach the ${config.provider} embeddings endpoint: ${error instanceof Error ? error.message : error}`, true);
      }
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new EmbeddingError(`${config.provider} embeddings returned HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`, response.status >= 500 || response.status === 429);
      }
      const body: any = await response.json().catch(() => undefined);
      const vectors = extractVectors(body, texts.length);
      if (!vectors) {
        throw new EmbeddingError(`${config.provider} returned something that is not a list of embeddings`);
      }
      return vectors;
    },
  };
}

/**
 * Read the vectors out of a response.
 *
 * OpenAI returns `{data: [{embedding, index}]}` and the index is not guaranteed
 * to be in order, so the order is restored from it rather than trusted. Some
 * local servers return a bare array; that is accepted too.
 */
export function extractVectors(body: any, expected: number): number[][] | undefined {
  const rows: any[] = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : [];
  if (rows.length !== expected) return undefined;

  const ordered = rows.map((row, position) => {
    const vector = Array.isArray(row) ? row : row?.embedding;
    const index = typeof row?.index === 'number' ? row.index : position;
    return { index, vector };
  });
  if (ordered.some((entry) => !Array.isArray(entry.vector) || !entry.vector.length)) return undefined;
  if (ordered.some((entry) => !entry.vector.every((value: unknown) => typeof value === 'number' && Number.isFinite(value)))) return undefined;

  // Duplicate or out-of-range indices mean the response cannot be attributed to
  // the inputs, and a mis-attributed vector is a hit on the wrong file.
  const seen = new Set<number>();
  for (const entry of ordered) {
    if (entry.index < 0 || entry.index >= expected || seen.has(entry.index)) return undefined;
    seen.add(entry.index);
  }
  const out: number[][] = new Array(expected);
  for (const entry of ordered) out[entry.index] = entry.vector;
  return out;
}

/**
 * Embed texts in batches, so one oversized request does not fail the whole index.
 *
 * A batch that fails is not retried here: the caller decides whether to fall
 * back, and a silent retry loop inside an index build is a way to spend an hour
 * discovering that the API key is wrong.
 */
export async function embedInBatches(
  embedder: Embedder,
  texts: string[],
  batchSize = 64,
): Promise<{ vectors: number[][]; model: string }> {
  const size = Math.max(1, batchSize);
  const vectors: number[][] = [];
  for (let start = 0; start < texts.length; start += size) {
    const batch = texts.slice(start, start + size);
    const embedded = await embedder.embed(batch);
    if (embedded.length !== batch.length) {
      throw new EmbeddingError(`the embedder returned ${embedded.length} vectors for ${batch.length} inputs`);
    }
    vectors.push(...embedded);
  }
  return { vectors, model: embedder.model };
}

/**
 * The name an index is keyed by.
 *
 * Prefixed with the backend so that switching from embeddings to lexical (or
 * between two embedding models) invalidates the cache rather than mixing vectors
 * that cannot be compared — which would produce a plausible ranking built from
 * two incompatible spaces.
 */
export function indexerName(kind: 'embedding' | 'lexical', model = ''): string {
  return kind === 'embedding' ? `embedding:${model || 'unknown'}` : 'lexical-tfidf-1';
}

/** Kept for the tool's own signature; the caller passes one of these. */
export type EmbeddingCaller = LlmCaller;