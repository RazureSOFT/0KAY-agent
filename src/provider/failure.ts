/**
 * Model failure classification, adapted (not copied) from ZCode's
 * failure-classifier: turn any thrown provider/gRPC error into a stable
 * {retryable, reason, retryAfterMs, statusCode} so the retry layer and the
 * agent loop can make consistent decisions.
 */

export type FailureReason =
  | 'cancelled'
  | 'timeout'
  | 'idle-timeout'
  | 'rate-limited'
  | 'overloaded'
  | 'server'
  | 'network'
  | 'auth'
  | 'not-found'
  | 'invalid-request'
  | 'context-exceeded'
  | 'empty-completion'
  | 'unknown'

export interface ClassifiedFailure {
  reason: FailureReason
  retryable: boolean
  message: string
  statusCode?: number
  retryAfterMs?: number
}

const CONTEXT_EXCEEDED = /context length|context window|maximum context|exceeded.*token|too many tokens|context_exceeded|reduce the length|prompt is too long/i
const NETWORK = /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|connection refused|connection reset|network error|fetch failed|TLS|certificate/i

// gRPC status codes (numeric) → retry behaviour.
function classifyGrpcCode(code: number): Omit<ClassifiedFailure, 'message'> | null {
  switch (code) {
    case 1: // CANCELLED
      return { reason: 'cancelled', retryable: false }
    case 4: // DEADLINE_EXCEEDED
      return { reason: 'timeout', retryable: true }
    case 8: // RESOURCE_EXHAUSTED
      return { reason: 'rate-limited', retryable: true }
    case 10: // ABORTED
      return { reason: 'server', retryable: true }
    case 13: // INTERNAL
    case 15: // DATA_LOSS
      return { reason: 'server', retryable: true }
    case 14: // UNAVAILABLE
      return { reason: 'network', retryable: true }
    default:
      return null
  }
}

function parseHttpStatus(message: string): number | undefined {
  const match = message.match(/\b(400|401|403|404|408|409|422|429|500|502|503|504|529)\b/)
  return match ? Number(match[1]) : undefined
}

function parseRetryAfterMs(message: string): number | undefined {
  const header = message.match(/retry[-_ ]?after["':=\s]+(\d+(?:\.\d+)?)\s*(ms|s)?/i)
  if (header) {
    const value = Number(header[1])
    if (Number.isFinite(value)) return header[2] === 's' || header[2] === undefined ? value * 1000 : value
  }
  return undefined
}

function classifyStatus(status: number): Omit<ClassifiedFailure, 'message'> | null {
  switch (status) {
    case 401:
    case 403:
      return { reason: 'auth', retryable: false, statusCode: status }
    case 404:
      return { reason: 'not-found', retryable: false, statusCode: status }
    case 400:
    case 422:
      return { reason: 'invalid-request', retryable: false, statusCode: status }
    case 408:
      return { reason: 'timeout', retryable: true, statusCode: status }
    case 429:
      return { reason: 'rate-limited', retryable: true, statusCode: status }
    case 529:
      return { reason: 'overloaded', retryable: true, statusCode: status }
    default:
      if (status >= 500) return { reason: 'server', retryable: true, statusCode: status }
      return null
  }
}

/** Classify a thrown error into a stable failure descriptor. */
export function classifyFailure(error: unknown, signal?: AbortSignal): ClassifiedFailure {
  const err = error as { code?: unknown; name?: string; message?: string; statusCode?: number; details?: string } | undefined
  const message = String(err?.message || err?.details || error || 'model request failed')

  if (signal?.aborted || err?.name === 'AbortError' || (err?.code as string) === 'MODEL_STREAM_ABORTED') {
    return { reason: 'cancelled', retryable: false, message }
  }
  if ((err?.code as string) === 'MODEL_STREAM_IDLE_TIMEOUT') {
    return { reason: 'idle-timeout', retryable: true, message }
  }
  if ((err?.code as string) === 'MODEL_EMPTY_COMPLETION') {
    return { reason: 'empty-completion', retryable: true, message }
  }
  if (CONTEXT_EXCEEDED.test(message)) {
    return { reason: 'context-exceeded', retryable: false, message }
  }

  // gRPC numeric status codes.
  if (typeof err?.code === 'number') {
    const classified = classifyGrpcCode(err.code)
    if (classified) return { ...classified, message }
  }

  const status = err?.statusCode || parseHttpStatus(message)
  const retryAfterMs = parseRetryAfterMs(message)
  if (status) {
    const classified = classifyStatus(status)
    if (classified) {
      if (classified.reason === 'invalid-request' && CONTEXT_EXCEEDED.test(message)) {
        return { reason: 'context-exceeded', retryable: false, statusCode: status, message }
      }
      return { ...classified, retryAfterMs, message }
    }
  }
  if (NETWORK.test(message)) {
    return { reason: 'network', retryable: true, retryAfterMs, message }
  }
  if (/timed? ?out|deadline exceeded/i.test(message)) {
    return { reason: 'timeout', retryable: true, retryAfterMs, message }
  }
  return { reason: 'unknown', retryable: false, retryAfterMs, message }
}
