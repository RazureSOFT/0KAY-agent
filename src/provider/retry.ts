import { classifyFailure, type ClassifiedFailure } from './failure.js'

export interface RetryOptions {
  maxAttempts: number
  baseDelayMs: number
  backoffFactor: number
  maxDelayMs: number
  jitter: boolean
}

const DEFAULTS: RetryOptions = {
  maxAttempts: 6,
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

export function retryDelayMs(attempt: number, options: RetryOptions, retryAfterMs?: number): number {
  if (retryAfterMs && retryAfterMs > 0) return Math.min(retryAfterMs, options.maxDelayMs)
  const base = Math.min(options.baseDelayMs * options.backoffFactor ** attempt, options.maxDelayMs)
  return options.jitter ? Math.floor(base * (0.5 + Math.random() * 0.5)) : base
}

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

export class ModelEmptyCompletionError extends Error {
  readonly code = 'MODEL_EMPTY_COMPLETION'
  constructor() {
    super('Model returned an empty completion')
    this.name = 'ModelEmptyCompletionError'
  }
}

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

export function shouldRetry(
  failure: ClassifiedFailure,
  attempt: number,
  options: RetryOptions,
  emitted: boolean,
): boolean {
  return failure.retryable && !emitted && attempt + 1 < options.maxAttempts
}

export { classifyFailure }
