// Repository management for the two forges: create a repo, branch, file,
// release and webhook.
//
// `forge` answers "is this bug known". This answers "make the change": create
// the repository, cut a branch, commit a file, tag a release, register a hook.
// Same transport as `forge` — HTTP through `egressOrDirect`, so the SSRF guard
// applies and a token only ever appears as a header.
//
// GitHub and GitLab differ in every endpoint but not in the questions, so the
// actions are shared and the adapters live at the bottom.

import { Tool, type ToolContext, type ToolResult } from './types.js';
import { egressOrDirect, failure, success } from './helpers.js';
import { ForgeTool, apiBase, encodedRepo, headers, type Forge, type ForgeTarget } from './forge.js';

export type RepoAction =
  | 'repo_get' | 'repo_create' | 'repo_update'
  | 'branch_list' | 'branch_create' | 'branch_delete'
  | 'file_get' | 'file_put' | 'file_delete'
  | 'release_list' | 'release_create'
  | 'hook_list' | 'hook_create' | 'hook_delete';

function targetOf(args: Record<string, any>): ForgeTarget {
  const forge: Forge = String(args.forge || 'github').toLowerCase() === 'gitlab' ? 'gitlab' : 'github';
  return {
    forge,
    repo: String(args.repo || '').trim().replace(/^\/+|\/+$/g, ''),
    ...(args.host ? { host: String(args.host) } : {}),
  };
}

function required(value: unknown, name: string): string {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${name} is required`);
  return text;
}

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

export class ForgeRepoTool extends Tool {
  get name(): string { return 'forge_repo'; }
  get description(): string {
    return [
      'Manage a GitHub or GitLab repository: read or create it, update its settings, list/create/delete branches, read/write/delete a file through the contents API, list/create releases, and list/create/delete webhooks.',
      'Write actions are visible to other people and can change a default branch or a hook; read the current state first.',
      'Token comes from the agent settings (github_token / gitlab_token). Without one, read actions work on public repos and writes fail.',
    ].join(' ');
  }
  get parameters(): Record<string, any> {
    return {
      type: 'object',
      required: ['action', 'repo'],
      properties: {
        action: {
          type: 'string',
          enum: [
            'repo_get', 'repo_create', 'repo_update',
            'branch_list', 'branch_create', 'branch_delete',
            'file_get', 'file_put', 'file_delete',
            'release_list', 'release_create',
            'hook_list', 'hook_create', 'hook_delete',
          ],
        },
        forge: { type: 'string', enum: ['github', 'gitlab'], description: 'Default github.' },
        repo: { type: 'string', description: 'owner/repo on GitHub, group/project on GitLab.' },
        host: { type: 'string', description: 'Self-hosted host, e.g. git.example.com.' },
        name: { type: 'string', description: 'repo_create: repository name.' },
        description: { type: 'string', description: 'repo_create/repo_update: description.' },
        private: { type: 'boolean', description: 'repo_create: private repository.' },
        branch: { type: 'string', description: 'branch_create/branch_delete/file_*: branch name.' },
        from: { type: 'string', description: 'branch_create: source branch (default: the repo default branch).' },
        path: { type: 'string', description: 'file_*: repository path, e.g. src/index.ts.' },
        content: { type: 'string', description: 'file_put: full file content (plain text; encoded here).' },
        message: { type: 'string', description: 'file_put/file_delete: commit message.' },
        sha: { type: 'string', description: 'file_put/file_delete: blob sha when updating an existing file.' },
        tag: { type: 'string', description: 'release_create: tag name.' },
        title: { type: 'string', description: 'release_create: release title.' },
        body: { type: 'string', description: 'release_create: release notes.' },
        url: { type: 'string', description: 'hook_create: payload URL.' },
        events: { type: 'array', items: { type: 'string' }, description: 'hook_create: events, e.g. ["push","pull_request"].' },
        hook_id: { type: 'string', description: 'hook_delete: hook id from hook_list.' },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
      },
    };
  }

  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    let target: ForgeTarget;
    try {
      target = targetOf(args);
      if (!target.repo) return failure('repo is required (owner/repo)');
      const action = String(args.action || '') as RepoAction;
      const token = ForgeTool.readToken(target.forge);
      const result = await this.run(target, token, action, args, context);
      return result.ok ? success(result.data) : failure(result.error);
    } catch (error) {
      return failure(error);
    }
  }

  private async run(
    target: ForgeTarget,
    token: string,
    action: RepoAction,
    args: Record<string, any>,
    context: ToolContext,
  ): Promise<{ ok: true; data: any } | { ok: false; error: string }> {
    const base = apiBase(target);
    const repo = encodedRepo(target);
    const limit = Math.max(1, Math.min(Number(args.limit) || 30, 200));

    switch (action) {
      case 'repo_get': {
        const path = target.forge === 'gitlab' ? `${base}/projects/${repo}` : `${base}/repos/${repo}`;
        return this.call(target, token, 'GET', path, undefined, context);
      }
      case 'repo_create': {
        const name = required(args.name, 'name');
        const visibility = args.private === true ? 'private' : 'public';
        if (target.forge === 'gitlab') {
          return this.call(target, token, 'POST', `${base}/projects`, {
            name,
            path: name,
            description: String(args.description || ''),
            visibility,
          }, context);
        }
        return this.call(target, token, 'POST', `${base}/user/repos`, {
          name,
          description: String(args.description || ''),
          private: args.private === true,
        }, context);
      }
      case 'repo_update': {
        const body: Record<string, any> = {};
        if (args.description != null) body.description = String(args.description);
        if (args.name != null) body.name = String(args.name);
        if (args.private != null) {
          if (target.forge === 'gitlab') body.visibility = args.private ? 'private' : 'public';
          else body.private = args.private === true;
        }
        const path = target.forge === 'gitlab' ? `${base}/projects/${repo}` : `${base}/repos/${repo}`;
        return this.call(target, token, 'PATCH', path, body, context);
      }
      case 'branch_list': {
        const path = target.forge === 'gitlab'
          ? `${base}/projects/${repo}/repository/branches?per_page=${limit}`
          : `${base}/repos/${repo}/branches?per_page=${limit}`;
        return this.call(target, token, 'GET', path, undefined, context, (raw) => (Array.isArray(raw) ? raw.map(summarizeBranch) : raw));
      }
      case 'branch_create': {
        const branch = required(args.branch, 'branch');
        if (target.forge === 'gitlab') {
          return this.call(target, token, 'POST', `${base}/projects/${repo}/repository/branches`, {
            branch,
            ref: String(args.from || 'HEAD'),
          }, context);
        }
        const from = String(args.from || '');
        const sha = from
          ? await this.refSha(target, token, from, context)
          : await this.defaultBranchSha(target, token, context);
        if (!sha.ok) return sha;
        return this.call(target, token, 'POST', `${base}/repos/${repo}/git/refs`, {
          ref: `refs/heads/${branch}`,
          sha: sha.data,
        }, context);
      }
      case 'branch_delete': {
        const branch = required(args.branch, 'branch');
        const path = target.forge === 'gitlab'
          ? `${base}/projects/${repo}/repository/branches/${encodeURIComponent(branch)}`
          : `${base}/repos/${repo}/git/refs/heads/${encodeURIComponent(branch)}`;
        return this.call(target, token, 'DELETE', path, undefined, context);
      }
      case 'file_get': {
        const path = required(args.path, 'path');
        const ref = args.branch ? `?ref=${encodeURIComponent(String(args.branch))}` : '';
        if (target.forge === 'gitlab') {
          return this.call(target, token, 'GET', `${base}/projects/${repo}/repository/files/${encodeURIComponent(path)}${ref}`, undefined, context, decodeGitlabFile);
        }
        return this.call(target, token, 'GET', `${base}/repos/${repo}/contents/${encodePath(path)}${ref}`, undefined, context, decodeGithubFile);
      }
      case 'file_put': {
        const path = required(args.path, 'path');
        const content = String(args.content ?? '');
        const message = String(args.message || `update ${path}`);
        const branch = args.branch ? String(args.branch) : undefined;
        if (target.forge === 'gitlab') {
          const body = { branch: branch || 'main', content, commit_message: message };
          const created = await this.call(target, token, 'POST', `${base}/projects/${repo}/repository/files/${encodeURIComponent(path)}`, body, context);
          if (created.ok) return created;
          // GitLab answers 400 when the file exists; PUT is the update path.
          return this.call(target, token, 'PUT', `${base}/projects/${repo}/repository/files/${encodeURIComponent(path)}`, body, context);
        }
        const body: Record<string, any> = {
          message,
          content: Buffer.from(content, 'utf8').toString('base64'),
          ...(branch ? { branch } : {}),
          ...(args.sha ? { sha: String(args.sha) } : {}),
        };
        return this.call(target, token, 'PUT', `${base}/repos/${repo}/contents/${encodePath(path)}`, body, context);
      }
      case 'file_delete': {
        const path = required(args.path, 'path');
        const message = String(args.message || `delete ${path}`);
        if (target.forge === 'gitlab') {
          return this.call(target, token, 'DELETE', `${base}/projects/${repo}/repository/files/${encodeURIComponent(path)}`, {
            branch: String(args.branch || 'main'),
            commit_message: message,
          }, context);
        }
        return this.call(target, token, 'DELETE', `${base}/repos/${repo}/contents/${encodePath(path)}`, {
          message,
          ...(args.branch ? { branch: String(args.branch) } : {}),
          ...(args.sha ? { sha: String(args.sha) } : {}),
        }, context);
      }
      case 'release_list': {
        const path = target.forge === 'gitlab'
          ? `${base}/projects/${repo}/releases?per_page=${limit}`
          : `${base}/repos/${repo}/releases?per_page=${limit}`;
        return this.call(target, token, 'GET', path, undefined, context, (raw) => (Array.isArray(raw) ? raw.map(summarizeRelease) : raw));
      }
      case 'release_create': {
        const tag = required(args.tag, 'tag');
        if (target.forge === 'gitlab') {
          return this.call(target, token, 'POST', `${base}/projects/${repo}/releases`, {
            tag_name: tag,
            name: String(args.title || tag),
            description: String(args.body || ''),
          }, context);
        }
        return this.call(target, token, 'POST', `${base}/repos/${repo}/releases`, {
          tag_name: tag,
          name: String(args.title || tag),
          body: String(args.body || ''),
        }, context);
      }
      case 'hook_list': {
        const path = target.forge === 'gitlab'
          ? `${base}/projects/${repo}/hooks?per_page=${limit}`
          : `${base}/repos/${repo}/hooks?per_page=${limit}`;
        return this.call(target, token, 'GET', path, undefined, context, (raw) => (Array.isArray(raw) ? raw.map(summarizeHook) : raw));
      }
      case 'hook_create': {
        const url = required(args.url, 'url');
        const events = Array.isArray(args.events) ? args.events.map(String) : ['push'];
        if (target.forge === 'gitlab') {
          return this.call(target, token, 'POST', `${base}/projects/${repo}/hooks`, {
            url,
            push_events: events.includes('push'),
            merge_requests_events: events.includes('merge_request'),
          }, context);
        }
        return this.call(target, token, 'POST', `${base}/repos/${repo}/hooks`, {
          config: { url, content_type: 'json' },
          events,
          active: true,
        }, context);
      }
      case 'hook_delete': {
        const id = required(args.hook_id, 'hook_id');
        const path = target.forge === 'gitlab'
          ? `${base}/projects/${repo}/hooks/${encodeURIComponent(id)}`
          : `${base}/repos/${repo}/hooks/${encodeURIComponent(id)}`;
        return this.call(target, token, 'DELETE', path, undefined, context);
      }
      default:
        return { ok: false, error: `unknown action "${action}"` };
    }
  }

  /** GitHub needs a commit SHA to create a ref; resolve a branch name to one. */
  private async refSha(target: ForgeTarget, token: string, branch: string, context: ToolContext) {
    const base = apiBase(target);
    const repo = encodedRepo(target);
    const result = await this.call(target, token, 'GET', `${base}/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`, undefined, context);
    if (!result.ok) return result;
    const sha = String(result.data?.object?.sha || '');
    return sha ? ({ ok: true, data: sha } as const) : ({ ok: false, error: `branch ${branch} has no sha` } as const);
  }

  private async defaultBranchSha(target: ForgeTarget, token: string, context: ToolContext) {
    const base = apiBase(target);
    const repo = encodedRepo(target);
    const info = await this.call(target, token, 'GET', `${base}/repos/${repo}`, undefined, context);
    if (!info.ok) return info;
    const branch = String(info.data?.default_branch || 'main');
    return this.refSha(target, token, branch, context);
  }

  private async call(
    target: ForgeTarget,
    token: string,
    method: string,
    url: string,
    body: unknown,
    context: ToolContext,
    shape?: (raw: any) => any,
  ): Promise<{ ok: true; data: any } | { ok: false; error: string }> {
    const response = await egressOrDirect(url, {
      method,
      headers: {
        ...headers(target, token),
        ...(body != null ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body != null ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20_000),
    }, 20_000);
    const text = await response.text().catch(() => '');
    let parsed: any = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    if (!response.ok) {
      const message = parsed?.message || parsed?.error || (typeof parsed === 'string' ? parsed : '') || `HTTP ${response.status}`;
      return { ok: false, error: `${method} ${url} → ${response.status}: ${String(message).slice(0, 300)}` };
    }
    return { ok: true, data: shape ? shape(parsed) : parsed };
  }
}

function summarizeBranch(raw: any) {
  return {
    name: String(raw?.name ?? ''),
    commit: String(raw?.commit?.sha ?? raw?.commit?.id ?? '').slice(0, 12),
    protected: Boolean(raw?.protected),
    ...(raw?.default ? { default: true } : {}),
  };
}

function summarizeRelease(raw: any) {
  return {
    tag: String(raw?.tag_name ?? ''),
    name: String(raw?.name ?? ''),
    draft: Boolean(raw?.draft ?? raw?.upcoming_release),
    prerelease: Boolean(raw?.prerelease),
    url: String(raw?.html_url ?? raw?._links?.self ?? ''),
    createdAt: String(raw?.created_at ?? ''),
  };
}

function summarizeHook(raw: any) {
  return {
    id: String(raw?.id ?? ''),
    url: String(raw?.config?.url ?? raw?.url ?? ''),
    events: Array.isArray(raw?.events) ? raw.events.map(String) : [],
    active: raw?.active !== false,
  };
}

function decodeGithubFile(raw: any) {
  const encoded = String(raw?.content || '').replace(/\n/g, '');
  const content = encoded ? Buffer.from(encoded, 'base64').toString('utf8') : '';
  return { path: String(raw?.path ?? ''), sha: String(raw?.sha ?? ''), size: Number(raw?.size) || content.length, content };
}

function decodeGitlabFile(raw: any) {
  const encoded = String(raw?.content || '');
  const content = encoded ? Buffer.from(encoded, 'base64').toString('utf8') : '';
  return { path: String(raw?.file_path ?? ''), sha: String(raw?.last_commit_id ?? ''), size: content.length, content };
}
