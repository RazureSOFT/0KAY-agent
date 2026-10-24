import { Tool } from '../types.js'
import type { ToolContext, ToolResult } from '../types.js'
import { success, failure, clamp } from '../helpers.js'
import { coreFetch, coreHeaders, coreHttpBase } from '../../connection.js'

// Literature and API-doc search. Both go through Core's search gateway rather
// than calling arXiv or MDN directly, so the network policy and the cache live
// in one place.
//
// These two moved out of tools.ts first because they are the cleanest example
// of the shape: no shared state, no shell, one dependency on Core.

function readSearchResults(body: any, limit: number): Array<Record<string, any>> {
  if (!Array.isArray(body?.results)) return []
  return body.results.slice(0, limit).map((item: any) => ({
    title: item.title || '',
    url: item.url || '',
    snippet: item.snippet || '',
    source: item.engine || '',
    ...(item.authors?.length ? { authors: item.authors } : {}),
    ...(item.year ? { year: item.year } : {}),
    ...(item.venue ? { venue: item.venue } : {}),
  }))
}

export class PaperSearchTool extends Tool {
  get name(): string { return 'papersearch'; }
  get description(): string { return 'Search academic papers (arXiv, Crossref, OpenAlex). Returns title, authors, year, venue, URL and an abstract snippet so results can be cited.'; }
  get parameters(): Record<string, any> {
    return { type: 'object', required: ['query'], properties: {
      query: { type: 'string' }, numResults: { type: 'integer', minimum: 1, maximum: 20 },
    }};
  }
  async execute(args: Record<string, any>, context?: ToolContext): Promise<ToolResult> {
    try {
      if (typeof args.query !== 'string' || !args.query.trim()) throw new Error('query is required');
      const limit = clamp(args.numResults, 6, 1, 20);
      const endpoint = new URL(`${coreHttpBase()}/api/search/papers`);
      endpoint.searchParams.set('q', args.query);
      endpoint.searchParams.set('n', String(limit));
      const timeout = AbortSignal.timeout(30000);
      const signal = context?.signal ? AbortSignal.any([timeout, context.signal]) : timeout;
      const response = await coreFetch(endpoint.toString(), { headers: coreHeaders(), signal });
      if (!response.ok) throw new Error(`paper search returned ${response.status}`);
      return success({ query: args.query, results: readSearchResults(await response.json(), limit) });
    } catch (error) { return failure(error); }
  }
}

export class ApiDocSearchTool extends Tool {
  get name(): string { return 'apidocsearch'; }
  get description(): string { return 'Search API documentation (MDN, Microsoft Learn, Stack Overflow, official doc sites). Use for library/API signatures, usage and examples.'; }
  get parameters(): Record<string, any> {
    return { type: 'object', required: ['query'], properties: {
      query: { type: 'string' }, numResults: { type: 'integer', minimum: 1, maximum: 20 },
    }};
  }
  async execute(args: Record<string, any>, context?: ToolContext): Promise<ToolResult> {
    try {
      if (typeof args.query !== 'string' || !args.query.trim()) throw new Error('query is required');
      const limit = clamp(args.numResults, 6, 1, 20);
      const endpoint = new URL(`${coreHttpBase()}/api/search/apidocs`);
      endpoint.searchParams.set('q', args.query);
      endpoint.searchParams.set('n', String(limit));
      const timeout = AbortSignal.timeout(30000);
      const signal = context?.signal ? AbortSignal.any([timeout, context.signal]) : timeout;
      const response = await coreFetch(endpoint.toString(), { headers: coreHeaders(), signal });
      if (!response.ok) throw new Error(`api docs search returned ${response.status}`);
      return success({ query: args.query, results: readSearchResults(await response.json(), limit) });
    } catch (error) { return failure(error); }
  }
}
