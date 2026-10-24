// The one rule from strix worth keeping: a finding is not a finding until a
// proof-of-concept reproduces it.
//
// Scanners report "potentially vulnerable" and call it a day, which is why
// triage is expensive. A PoC that runs the exploit and checks the outcome has
// three answers, not two:
//
//   reproduced      the expectation held — this is a real finding
//   fixed           we reached the target and the expectation did not hold
//   cannot_confirm  we never got a usable answer (timeout, connection refused,
//                   blocked by a WAF, wrong credentials)
//
// The third one matters most. Collapsing it into "fixed" is how a scan claims a
// clean bill of health for an app it could not reach.

import { compactOutput } from '../../tools/compact.js'

export interface PocRequest {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
}

export interface PocExpectation {
  /** Any of these status codes counts as reproduced. */
  statusIn?: number[]
  /** Every one of these must appear in the body. */
  bodyContains?: string[]
  /** None of these may appear in the body. */
  bodyAbsent?: string[]
}

export interface PocSpec {
  /** What the finding is about, for the record. */
  target: string
  request: PocRequest
  expect: PocExpectation
  label?: string
}

export interface PocEvidence {
  status: number
  bytes: number
  matched: string[]
  missed: string[]
  excerpt: string
  elapsedMs: number
}

export type Conclusion = 'reproduced' | 'fixed' | 'cannot_confirm'

export interface Verdict {
  conclusion: Conclusion
  reason: string
  evidence?: PocEvidence
}

export interface ValidateOptions {
  timeoutMs?: number
  /** Injected in tests. */
  fetchImpl?: typeof fetch
}

const DEFAULT_TIMEOUT = 15_000

function excerptOf(body: string): string {
  return compactOutput(body, { maxChars: 600, maxLines: 20, maxLineLength: 300 }).text
}

export async function validatePoc(spec: PocSpec, options: ValidateOptions = {}): Promise<Verdict> {
  const request = spec.request
  if (!request?.url) return { conclusion: 'cannot_confirm', reason: 'no request URL' }

  const expected = spec.expect || {}
  const hasExpectation = Boolean(expected.statusIn?.length || expected.bodyContains?.length || expected.bodyAbsent?.length)
  if (!hasExpectation) {
    return { conclusion: 'cannot_confirm', reason: 'no expectation given: a PoC without a check proves nothing' }
  }

  const doFetch = options.fetchImpl || fetch
  const started = Date.now()
  let response: Response
  let body = ''
  try {
    response = await doFetch(request.url, {
      method: request.method || 'GET',
      headers: request.headers,
      body: request.body,
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT),
      redirect: 'manual',
    })
    body = await response.text().catch(() => '')
  } catch (error: any) {
    // We never saw the target. That is not evidence of a fix.
    return {
      conclusion: 'cannot_confirm',
      reason: `request failed: ${error?.name === 'TimeoutError' ? 'timed out' : error?.message || String(error)}`,
    }
  }

  const matched: string[] = []
  const missed: string[] = []
  const statusOk = expected.statusIn?.length ? expected.statusIn.includes(response.status) : true
  if (expected.statusIn?.length) (statusOk ? matched : missed).push(`status ${response.status}`)
  for (const needle of expected.bodyContains || []) {
    ;(body.includes(needle) ? matched : missed).push(`body has "${needle}"`)
  }
  for (const needle of expected.bodyAbsent || []) {
    ;(body.includes(needle) ? missed : matched).push(`body lacks "${needle}"`)
  }

  const evidence: PocEvidence = {
    status: response.status,
    bytes: body.length,
    matched,
    missed,
    excerpt: excerptOf(body),
    elapsedMs: Date.now() - started,
  }

  const satisfied = statusOk && missed.length === 0
  return satisfied
    ? { conclusion: 'reproduced', reason: `expectation held (${matched.join(', ')})`, evidence }
    : { conclusion: 'fixed', reason: `reached the target but ${missed.join(', ')}`, evidence }
}

/** The one-line summary a report needs. */
export function verdictLine(verdict: Verdict, label?: string): string {
  const prefix = label ? `${label}: ` : ''
  if (verdict.conclusion === 'reproduced') return `${prefix}REPRODUCED — ${verdict.reason}`
  if (verdict.conclusion === 'fixed') return `${prefix}FIXED — ${verdict.reason}`
  return `${prefix}CANNOT CONFIRM — ${verdict.reason}`
}
