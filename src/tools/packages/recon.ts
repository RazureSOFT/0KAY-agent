import { promises as dns } from 'node:dns'
import { Tool } from '../types.js'
import type { ToolResult } from '../types.js'
import { success, failure } from '../helpers.js'

// strix's reconnaissance step, without the shelling out to a dozen CLI tools:
// what does this host resolve to, and what does its edge say about itself.
//
// Both halves are facts a report can quote. "It runs nginx" is an observation;
// "it might be vulnerable" is not, and this tool refuses to produce the second.

export interface Fingerprint {
  status: number
  server?: string
  poweredBy?: string
  via?: string
  generator?: string
  title?: string
  technologies: string[]
  redirectsTo?: string
}

export interface OsintResult {
  host: string
  addresses: string[]
  cname: string[]
  mx: Array<{ exchange: string; priority: number }>
  ns: string[]
  txt: string[]
  http?: Fingerprint
  notes: string[]
}

export interface ResolverLike {
  resolve4(host: string): Promise<string[]>
  resolve6(host: string): Promise<string[]>
  resolveCname(host: string): Promise<string[]>
  resolveMx(host: string): Promise<Array<{ exchange: string; priority: number }>>
  resolveNs(host: string): Promise<string[]>
  resolveTxt(host: string): Promise<string[][]>
}

export interface OsintOptions {
  resolver?: ResolverLike
  fetchImpl?: typeof fetch
  timeoutMs?: number
  /** Skip the HTTP probe. */
  dnsOnly?: boolean
}

const TECH_SIGNATURES: Array<{ name: string; test: RegExp }> = [
  { name: 'cloudflare', test: /cloudflare/i },
  { name: 'akamai', test: /akamai|ghost/i },
  { name: 'fastly', test: /fastly/i },
  { name: 'nginx', test: /nginx/i },
  { name: 'apache', test: /apache/i },
  { name: 'iis', test: /microsoft-iis/i },
  { name: 'caddy', test: /caddy/i },
  { name: 'envoy', test: /envoy/i },
  { name: 'wordpress', test: /wordpress|wp-/i },
  { name: 'drupal', test: /drupal/i },
  { name: 'next.js', test: /next\.js|__next/i },
  { name: 'react', test: /react/i },
  { name: 'vue', test: /vue/i },
  { name: 'php', test: /php/i },
  { name: 'asp.net', test: /asp\.net/i },
  { name: 'express', test: /express/i },
  { name: 'grafana', test: /grafana/i },
  { name: 'jenkins', test: /jenkins/i },
  { name: 'gitlab', test: /gitlab/i },
]

/** Pull what the response says about itself, without guessing beyond it. */
export function fingerprint(headers: Headers, body: string, status: number): Fingerprint {
  const server = headers.get('server') || undefined
  const poweredBy = headers.get('x-powered-by') || undefined
  const via = headers.get('via') || undefined
  const generator = headers.get('x-generator') || undefined
  const location = headers.get('location') || undefined
  const title = /<title[^>]*>([^<]{1,200})<\/title>/i.exec(body)?.[1]?.trim()

  const haystack = [server, poweredBy, via, generator, headers.get('x-aspnet-version'), headers.get('set-cookie'), body.slice(0, 4000)]
    .filter(Boolean)
    .join(' ')
  const technologies = TECH_SIGNATURES.filter((entry) => entry.test.test(haystack)).map((entry) => entry.name)

  return {
    status,
    ...(server ? { server } : {}),
    ...(poweredBy ? { poweredBy } : {}),
    ...(via ? { via } : {}),
    ...(generator ? { generator } : {}),
    ...(title ? { title } : {}),
    ...(location ? { redirectsTo: location } : {}),
    technologies,
  }
}

async function settle<T>(work: Promise<T>, fallback: T): Promise<T> {
  try {
    return await work
  } catch {
    return fallback
  }
}

export async function gather(hostOrUrl: string, options: OsintOptions = {}): Promise<OsintResult> {
  const raw = String(hostOrUrl || '').trim()
  if (!raw) throw new Error('host is required')

  let host = raw
  let url: URL | null = null
  if (/^https?:\/\//i.test(raw)) {
    url = new URL(raw)
    host = url.hostname
  } else if (/^[a-z0-9.-]+(:\d+)?$/i.test(raw)) {
    host = raw.split(':')[0]
    url = new URL(`https://${raw}`)
  } else {
    throw new Error(`not a host or URL: ${raw}`)
  }

  const resolver: ResolverLike = options.resolver || (dns as unknown as ResolverLike)
  const notes: string[] = []

  const [addresses, ipv6, cname, mx, ns, txt] = await Promise.all([
    settle(resolver.resolve4(host), []),
    settle(resolver.resolve6(host), []),
    settle(resolver.resolveCname(host), []),
    settle(resolver.resolveMx(host), []),
    settle(resolver.resolveNs(host), []),
    settle(resolver.resolveTxt(host), []),
  ])

  const all = [...addresses, ...ipv6]
  if (!all.length && !cname.length) notes.push(`${host} did not resolve: no A/AAAA/CNAME record`)

  const result: OsintResult = {
    host,
    addresses: all,
    cname,
    mx: mx.sort((a, b) => a.priority - b.priority),
    ns,
    txt: txt.map((parts) => parts.join('')),
    notes,
  }

  if (options.dnsOnly || !url) return result

  const doFetch = options.fetchImpl || fetch
  try {
    const response = await doFetch(url.toString(), {
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      headers: { 'user-agent': '0kay-agent/osint' },
    })
    const body = await response.text().catch(() => '')
    result.http = fingerprint(response.headers, body, response.status)
  } catch (error: any) {
    // The edge did not answer. Say that; do not turn it into "no web server".
    notes.push(`http probe failed: ${error?.name === 'TimeoutError' ? 'timed out' : error?.message || String(error)}`)
  }
  return result
}

export class OsintTool extends Tool {
  get name(): string { return 'osint'; }
  get description(): string {
    return [
      'Resolve a host and fingerprint its edge: A/AAAA, CNAME, MX, NS, TXT, plus server, x-powered-by and detected technologies.',
      'Accepts a hostname or a URL. DNS and HTTP are reported separately — a failed probe is a note, not an empty answer.',
      'Use dnsOnly to skip the HTTP request when the target must not be touched.',
    ].join(' ')
  }
  get parameters(): Record<string, any> {
    return {
      type: 'object',
      required: ['host'],
      properties: {
        host: { type: 'string' },
        dnsOnly: { type: 'boolean' },
        timeoutMs: { type: 'integer', minimum: 1000, maximum: 60000 },
      },
    }
  }
  async execute(args: Record<string, any>): Promise<ToolResult> {
    try {
      const result = await gather(String(args.host || ''), {
        dnsOnly: args.dnsOnly === true,
        timeoutMs: args.timeoutMs,
      })
      return success(result)
    } catch (error) {
      return failure(error)
    }
  }
}
