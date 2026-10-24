import { Tool } from '../types.js'
import type { ToolContext, ToolResult } from '../types.js'
import { success, failure } from '../helpers.js'
import { compactOutput } from '../compact.js'

// strix's "HTTP interception proxy", reduced to what an agent actually needs from
// one: send exactly the request you meant to send, and see exactly what came
// back — status, headers, and a compacted body.
//
// The difference from webfetch is control. webfetch fetches a page and turns it
// into text; this one lets you set the method, the headers and the body, and
// choose whether a redirect is followed. That is the difference between reading a
// site and testing one.

const MAX_BODY = 200_000

export class HttpRequestTool extends Tool {
  get name(): string { return 'http_request'; }
  get description(): string {
    return [
      'Send one HTTP request and get status, headers and body back.',
      'Unlike webfetch this does not convert to text: set method, headers and body, and choose followRedirects (default false, so a 302 is a result).',
      'Body is compacted; the full text is saved to disk when large. Use it to reproduce a finding, not to read documentation.',
    ].join(' ')
  }
  get parameters(): Record<string, any> {
    return {
      type: 'object',
      required: ['url'],
      properties: {
        url: { type: 'string' },
        method: { type: 'string', description: 'Default GET.' },
        headers: { type: 'object', description: 'Request headers.' },
        body: { type: 'string' },
        followRedirects: { type: 'boolean', description: 'Default false: a redirect is reported, not followed.' },
        timeoutMs: { type: 'integer', minimum: 1000, maximum: 120000 },
        maxBodyChars: { type: 'integer', minimum: 200, maximum: 200000 },
      },
    }
  }
  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    const url = String(args.url || '').trim()
    if (!url) return failure('url is required')
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return failure(`not a valid URL: ${url}`)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return failure(`only http and https are allowed, got ${parsed.protocol}`)
    }

    const started = Date.now()
    try {
      const response = await fetch(url, {
        method: args.method ? String(args.method).toUpperCase() : 'GET',
        headers: args.headers && typeof args.headers === 'object' ? args.headers : undefined,
        body: args.body != null ? String(args.body) : undefined,
        redirect: args.followRedirects === true ? 'follow' : 'manual',
        signal: AbortSignal.timeout(Number(args.timeoutMs) || 30_000),
      })

      const raw = await response.text().catch(() => '')
      const headers: Record<string, string> = {}
      response.headers.forEach((value, key) => { headers[key] = value })
      const compacted = compactOutput(raw, { maxChars: Number(args.maxBodyChars) || 20_000 })

      return success({
        url,
        finalUrl: response.url || url,
        status: response.status,
        statusText: response.statusText,
        headers,
        body: compacted.text,
        bytes: raw.length,
        ...(compacted.changed ? { bodyNote: 'body compacted; re-run with a higher maxBodyChars for more' } : {}),
        elapsedMs: Date.now() - started,
        ...(response.status >= 300 && response.status < 400 && args.followRedirects !== true
          ? { note: `redirect to ${headers.location || '(no location header)'} not followed` }
          : {}),
      })
    } catch (error: any) {
      const reason = error?.name === 'TimeoutError' ? 'timed out' : error?.message || String(error)
      return failure(`${args.method || 'GET'} ${url} failed: ${reason}`)
    }
  }
}

/** Trim a body down to something a report can quote. */
export function bodyExcerpt(body: string, limit = 500): string {
  return compactOutput(body, { maxChars: limit, maxLines: 12, maxLineLength: 200 }).text
}
