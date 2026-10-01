/**
 * Retry/backoff and stream idle-timeout helpers, adapted (not copied) from
 * ZCode's retry-policy and stream-idle-timeout modules. Bounds are env-tunable
 * so a deployment can widen or disable retries without a code change.
 */
import { classifyFailure, type ClassifiedFailure } from './failure.js'

export interface RetryOptions {
  maxAttempts: number
  baseDelayMs: number
  backoffFactor: number
  maxDelayMs: number
  jitter: boolean
}

const DEFAULTS: RetryOptions = {
  maxAttempts: 6, // includes the first attempt
  baseDelayMs: 1000,
  backoffFactor: 2,
  maxDelayMs: 30_000,
  jitter: true,
}

const DEFAULT_STREAM_IDLE_MS = 90_000
const IDLE_INCREMENT_MS = 30_000

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.floor(parsed)
}

/** Resolve retry bounds from options/env (OKAY_AGENT_MODEL_RETRY_*). */
export function resolveRetryOptions(env: Record<string, string | undefined> = process.env): RetryOptions {
  return {
    maxAttempts: positiveInt(env.OKAY_AGENT_MODEL_RETRY_MAX_RETRIES, DEFAULTS.maxAttempts - 1) + 1,
    baseDelayMs: positiveInt(env.OKAY_AGENT_MODEL_RETRY_BASE_DELAY_MS, DEFAULTS.baseDelayMs),
    backoffFactor: (() => {
      const parsed = Number(env.OKAY_AGENT_MODEL_RETRY_BACKOFF_FACTOR)
      return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULTS.backoffFactor
    })(),
    maxDelayMs: positiveInt(env.OKAY_AGENT_MODEL_RETRY_MAX_DELAY_MS, DEFAULTS.maxDelayMs),
    jitter: env.OKAY_AGENT_MODEL_RETRY_JITTER === '0' ? false : DEFAULTS.jitter,
  }
}

/** Delay before the next attempt, honouring Retry-After when present. */
export function retryDelayMs(attempt: number, options: RetryOptions, retryAfterMs?: number): number {
  if (retryAfterMs && retryAfterMs > 0) return Math.min(retryAfterMs, options.maxDelayMs)
  const base = Math.min(options.baseDelayMs * options.backoffFactor ** attempt, options.maxDelayMs)
  return options.jitter ? Math.floor(base * (0.5 + Math.random() * 0.5)) : base
}

/** Idle timeout for stream attempt N (grows so long generations are not cut). */
export function streamIdleTimeoutMs(retryNumber = 0, env: Record<string, string | undefined> = process.env): number {
  const base = Number(env.OKAY_AGENT_STREAM_IDLE_MS)
  const baseMs = Number.isFinite(base) && base >= 0 ? base : DEFAULT_STREAM_IDLE_MS
  if (baseMs <= 0) return 0
  return baseMs + Math.max(0, Math.floor(retryNumber)) * IDLE_INCREMENT_MS
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason ?? new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export class ModelStreamIdleTimeoutError extends Error {
  readonly code = 'MODEL_STREAM_IDLE_TIMEOUT'
  constructor(readonly timeoutMs: number) {
    super(`Model stream stalled: no event for ${timeoutMs}ms`)
    this.name = 'ModelStreamIdleTimeoutError'
  }
}

/** A completion with no text and no tool calls; worth one clean retry. */
export class ModelEmptyCompletionError extends Error {
  readonly code = 'MODEL_EMPTY_COMPLETION'
  constructor() {
    super('Model returned an empty completion')
    this.name = 'ModelEmptyCompletionError'
  }
}

/**
 * Await the next value from an async iterator, aborting when it stalls longer
 * than `idleMs`. On timeout it invokes `onTimeout` (e.g. stream.cancel) and
 * throws ModelStreamIdleTimeoutError.
 */
export async function nextWithIdleTimeout<T>(
  iterator: AsyncIterator<T>,
  idleMs: number,
  onTimeout: () => void,
): Promise<IteratorResult<T>> {
  if (!Number.isFinite(idleMs) || idleMs <= 0) return iterator.next()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout()
      reject(new ModelStreamIdleTimeoutError(idleMs))
    }, idleMs)
  })
  try {
    return await Promise.race([iterator.next(), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Decide whether a failed stream attempt should be retried. */
export function shouldRetry(
  failure: ClassifiedFailure,
  attempt: number,
  options: RetryOptions,
  emitted: boolean,
): boolean {
  // Never retry after partial output (would duplicate tokens) or on cancel/auth.
  return failure.retryable && !emitted && attempt + 1 < options.maxAttempts
}

export { classifyFailure }
