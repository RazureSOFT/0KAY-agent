/**
 * github_search — find open-source repositories on GitHub.
 *
 * Uses the public search API (10 requests/min unauthenticated). Set GITHUB_TOKEN
 * or GH_TOKEN for the higher authenticated rate limit. Routes through the same
 * egress path as the other web tools so a configured proxy is respected.
 */

import { Tool, type ToolContext, type ToolResult } from './types.js';
import { clamp, egressOrDirect, failure, success } from './helpers.js';

interface RepoSummary {
  name: string;
  url: string;
  description: string;
  stars: number;
  language: string;
  updated: string;
  topics: string[];
  fork: boolean;
}

export class GitHubSearchTool extends Tool {
  get name(): string {
    return 'github_search';
  }

  get description(): string {
    return 'Search open-source repositories on GitHub by keyword, language or stars. ' +
      'Returns name, description, stars, language and URL — useful for finding libraries, ' +
      'reference implementations or prior art. Read-only.';
  }

  get parameters(): Record<string, any> {
    return {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search keywords, e.g. "markdown parser" or "react virtual list"' },
        language: { type: 'string', description: 'Optional language filter, e.g. typescript, python, rust' },
        limit: { type: 'number', description: 'Max results (1-20, default 8)' },
        sort: { type: 'string', enum: ['stars', 'updated', 'best-match'], description: 'Sort order (default best-match)' },
      },
      required: ['query'],
    };
  }

  async execute(args: Record<string, any>, _context: ToolContext): Promise<ToolResult> {
    const query = String(args.query || '').trim();
    if (!query) return failure('query is required');
    const limit = clamp(args.limit, 8, 1, 20);
    const language = String(args.language || '').trim();
    const sort = ['stars', 'updated'].includes(String(args.sort)) ? String(args.sort) : '';

    const q = language ? `${query} language:${language}` : query;
    const params = new URLSearchParams({ q, per_page: String(limit) });
    if (sort) params.set('sort', sort);

    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': '0kay-agent',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (token) headers.Authorization = `Bearer ${token}`;

    try {
      const response = await egressOrDirect(
        `https://api.github.com/search/repositories?${params.toString()}`,
        { headers },
        20000,
      );
      if (!response.ok) {
        const body = await response.text();
        return failure(`GitHub API ${response.status}: ${body.slice(0, 300)}`);
      }
      const payload = await response.json() as any;
      const results: RepoSummary[] = (payload.items || []).map((item: any) => ({
        name: String(item.full_name || ''),
        url: String(item.html_url || ''),
        description: String(item.description || ''),
        stars: Number(item.stargazers_count || 0),
        language: String(item.language || ''),
        updated: String(item.updated_at || ''),
        topics: Array.isArray(item.topics) ? item.topics.slice(0, 8) : [],
        fork: Boolean(item.fork),
      }));

      const lines = results.map((repo, index) => {
        const stars = repo.stars >= 1000 ? `${(repo.stars / 1000).toFixed(1)}k` : String(repo.stars);
        return `${index + 1}. ${repo.name} ★ ${stars}${repo.language ? ` · ${repo.language}` : ''}\n   ${repo.description || '(no description)'}\n   ${repo.url}`;
      });

      return success({
        query: q,
        total: Number(payload.total_count || 0),
        results,
        text: lines.length ? lines.join('\n') : 'No repositories found.',
      });
    } catch (error: any) {
      return failure(`github_search failed: ${error?.message || String(error)}`);
    }
  }
}
