import { Tool } from '../types.js'
import type { ToolResult } from '../types.js'
import { success, failure } from '../helpers.js'

// strix's "Vulnerability Knowledge Base": a finding should leave with a severity
// that someone else can check, not an adjective.
//
// The scoring is CVSS 3.1 base, computed from the vector rather than looked up,
// because a lookup table is wrong the moment the vector is unusual. The OWASP
// mapping is keyword-based on purpose: it is a hint for the report, not a
// classification anyone should trust blindly.

const AV: Record<string, number> = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 }
const AC: Record<string, number> = { L: 0.77, H: 0.44 }
const PR_UNCHANGED: Record<string, number> = { N: 0.85, L: 0.62, H: 0.27 }
const PR_CHANGED: Record<string, number> = { N: 0.85, L: 0.68, H: 0.5 }
const UI: Record<string, number> = { N: 0.85, R: 0.62 }
const CIA: Record<string, number> = { H: 0.56, L: 0.22, N: 0 }

export type Severity = 'none' | 'low' | 'medium' | 'high' | 'critical'

export interface CvssResult {
  score: number
  severity: Severity
  metrics: Record<string, string>
}

/** CVSS 3.1 appends: round up to one decimal, never to the nearest. */
function roundUp(value: number): number {
  const scaled = Math.round(value * 100000)
  if (scaled % 10000 === 0) return scaled / 100000
  return (Math.floor(scaled / 10000) + 1) / 10
}

function severityOf(score: number): Severity {
  if (score === 0) return 'none'
  if (score < 4) return 'low'
  if (score < 7) return 'medium'
  if (score < 9) return 'high'
  return 'critical'
}

/** Parse and score a CVSS 3.0/3.1 vector. Throws on anything it cannot read. */
export function cvssBaseScore(vector: string): CvssResult {
  const text = String(vector || '').trim()
  if (!/^CVSS:3\.[01]\//i.test(text)) throw new Error('expected a CVSS:3.0/ or CVSS:3.1/ vector')
  const metrics: Record<string, string> = {}
  for (const part of text.split('/').slice(1)) {
    const [key, value] = part.split(':')
    if (!key || !value) continue
    metrics[key.toUpperCase()] = value.toUpperCase()
  }

  const need = (key: string, allowed: Record<string, number>) => {
    const value = metrics[key]
    if (!value) throw new Error(`vector is missing ${key}`)
    if (!(value in allowed)) throw new Error(`${key}=${value} is not one of ${Object.keys(allowed).join('/')}`)
    return allowed[value]
  }

  const scopeChanged = metrics.S === 'C'
  if (metrics.S !== 'C' && metrics.S !== 'U') throw new Error('S must be C or U')

  const av = need('AV', AV)
  const ac = need('AC', AC)
  const pr = need('PR', scopeChanged ? PR_CHANGED : PR_UNCHANGED)
  const ui = need('UI', UI)
  const c = need('C', CIA)
  const i = need('I', CIA)
  const a = need('A', CIA)

  const iss = 1 - (1 - c) * (1 - i) * (1 - a)
  const impact = scopeChanged
    ? 7.52 * (iss - 0.029) - 3.25 * Math.pow(iss - 0.02, 15)
    : 6.42 * iss
  const exploitability = 8.22 * av * ac * pr * ui

  if (impact <= 0) return { score: 0, severity: 'none', metrics }
  const combined = scopeChanged
    ? Math.min(1.08 * (impact + exploitability), 10)
    : Math.min(impact + exploitability, 10)
  const score = roundUp(combined)
  return { score, severity: severityOf(score), metrics }
}

export interface OwaspEntry {
  id: string
  name: string
  keywords: string[]
  fix: string
}

/** OWASP Top 10 (2021), with the words people actually use for each one. */
export const OWASP_TOP10: OwaspEntry[] = [
  { id: 'A01', name: 'Broken Access Control', keywords: ['idor', 'authorization', 'access control', 'privilege escalation', 'path traversal', 'forced browsing', 'cors misconfiguration'], fix: 'Authorise on the server for every object, by ownership, not by obscurity of the identifier.' },
  { id: 'A02', name: 'Cryptographic Failures', keywords: ['plaintext', 'weak cipher', 'md5', 'sha1', 'http without tls', 'hardcoded key', 'certificate'], fix: 'Use vetted libraries, current algorithms, and never store secrets in the codebase.' },
  { id: 'A03', name: 'Injection', keywords: ['sql injection', 'sqli', 'nosql injection', 'command injection', 'ldap injection', 'xpath', 'template injection', 'ssti', 'header injection', 'xss', 'cross-site scripting', 'script injection'], fix: 'Parameterise the query; never build it by concatenation, and never pass input to a shell.' },
  { id: 'A04', name: 'Insecure Design', keywords: ['business logic', 'rate limit', 'no throttling', 'design flaw', 'workflow bypass'], fix: 'Write the threat model before the feature; test the abuse case, not only the happy path.' },
  { id: 'A05', name: 'Security Misconfiguration', keywords: ['default password', 'debug enabled', 'directory listing', 'misconfiguration', 'unnecessary service', 'stack trace'], fix: 'Ship a hardened default, and treat configuration as code that gets reviewed.' },
  { id: 'A06', name: 'Vulnerable and Outdated Components', keywords: ['outdated', 'cve-', 'known vulnerability', 'unpatched', 'dependency'], fix: 'Track the inventory and the advisories; patching is the fix, not a rewrite.' },
  { id: 'A07', name: 'Identification and Authentication Failures', keywords: ['weak password', 'session fixation', 'credential stuffing', 'no mfa', 'authentication bypass', 'jwt none'], fix: 'Multi-factor where it matters, rotate sessions on login, and check the token, not just its presence.' },
  { id: 'A08', name: 'Software and Data Integrity Failures', keywords: ['deserialization', 'unsigned update', 'supply chain', 'ci compromise', 'insecure deserialization'], fix: 'Sign the artefacts and verify the signature; never deserialise untrusted input into live objects.' },
  { id: 'A09', name: 'Security Logging and Monitoring Failures', keywords: ['no logging', 'log injection', 'missing audit', 'monitoring'], fix: 'Log the security events, keep them where an attacker cannot edit them, and alert on them.' },
  { id: 'A10', name: 'Server-Side Request Forgery', keywords: ['ssrf', 'server-side request', 'metadata endpoint'], fix: 'Allow-list the destinations, and block link-local and metadata ranges explicitly.' },
]

export function classifyOwasp(text: string): OwaspEntry[] {
  const haystack = String(text || '').toLowerCase()
  if (!haystack.trim()) return []
  const scored = OWASP_TOP10
    .map((entry) => ({ entry, hits: entry.keywords.filter((keyword) => haystack.includes(keyword)).length }))
    .filter((item) => item.hits > 0)
    .sort((a, b) => b.hits - a.hits)
  return scored.map((item) => item.entry)
}

export class VulnKbTool extends Tool {
  get name(): string { return 'vuln_kb'; }
  get description(): string {
    return [
      'Turn a finding into a severity and a category.',
      'action=score takes a CVSS 3.1 vector (CVSS:3.1/AV:N/AC:L/...) and computes the base score — computed, not looked up, so unusual vectors still work.',
      'action=classify maps a description to OWASP Top 10 categories with a one-line fix; action=list shows the table.',
    ].join(' ')
  }
  get parameters(): Record<string, any> {
    return {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['score', 'classify', 'list'] },
        vector: { type: 'string', description: 'score: the CVSS 3.1 vector.' },
        text: { type: 'string', description: 'classify: the finding description.' },
      },
    }
  }
  async execute(args: Record<string, any>): Promise<ToolResult> {
    try {
      if (args.action === 'score') {
        const result = cvssBaseScore(String(args.vector || ''))
        return success({ ...result, vector: String(args.vector).trim() })
      }
      if (args.action === 'classify') {
        const matches = classifyOwasp(String(args.text || ''))
        return success({
          categories: matches.map((entry) => ({ id: entry.id, name: entry.name, fix: entry.fix })),
          ...(matches.length ? {} : { note: 'no OWASP keyword matched; score the vector instead of guessing a category' }),
        })
      }
      if (args.action === 'list') {
        return success({ categories: OWASP_TOP10.map(({ id, name, fix }) => ({ id, name, fix })) })
      }
      throw new Error('action must be score, classify or list')
    } catch (error) {
      return failure(error)
    }
  }
}
