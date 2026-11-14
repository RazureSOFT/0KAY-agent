// Issues and pull requests, for the two forges this project talks to.
//
// The existing `github_search` finds repositories. That answers "is there a
// library for this"; it does not answer the question that actually blocks work:
// "is this bug known, is the fix already proposed, and on which of the two
// forges". Those live in issues and merge requests, and they were reachable only
// by shelling out to `gh` — which needs the CLI installed, a login, and a
// network path that the egress guard does not see.
//
// So this goes over HTTP through `egressOrDirect`, the same path as every other
// outbound call, which means the SSRF guard applies and a token never leaves the
// process except as a header.
//
// GitHub and GitLab are one tool rather than two because the questions are the
// same and the answers only differ in shape. The adapter is where they differ;
// above it, `list` / `get` / `create` read the same.

import { Tool, type ToolContext, type ToolResult } from './types.js';
import { clamp, egressOrDirect, failure, success } from './helpers.js';

export type Forge = 'github' | 'gitlab';
export type ForgeKind = 'issue' | 'pr';

export interface ForgeTarget {
  forge: Forge;
  /** "owner/repo" on GitHub, "group/project" (or deeper) on GitLab. */
  repo: string;
  host?: string;
}

export interface ForgeItem {
  number: number;
  title: string;
  state: string;
  author: string;
  url: string;
  /** Issues carry labels; merge requests carry the same shape, so one type. */
  labels: string[];
  updatedAt: string;
  /** Set for merge requests: whether it is a draft. */
  draft?: boolean;
  /** Body, only when asked for. */
  body?: string;
  kind: ForgeKind;
}

export class ForgeError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function apiBase(target: ForgeTarget): string {
  if (target.forge === 'gitlab') {
    const host = (target.host || 'gitlab.com').replace(/^https?:\/\//, '').replace(/\/$/, '');
    return `https://${host}/api/v4`;
  }
  // A GitHub Enterprise host keeps the /api/v3 shape; github.com does not.
  const host = (target.host || 'github.com').replace(/^https?:\/\//, '').replace(/\/$/, '');
  return host === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`;
}

function encodedRepo(target: ForgeTarget): string {
  // GitLab wants the whole path URL-encoded, slashes included.
  return target.forge === 'gitlab' ? encodeURIComponent(target.repo) : target.repo;
}

function headers(target: ForgeTarget, token: string): Record<string, string> {
  const base: Record<string, string> = { Accept: 'application/json', 'User-Agent': '0kay-agent' };
  if (!token) return base;
  return target.forge === 'gitlab' ? { ...base, 'PRIVATE-TOKEN': token } : { ...base, Authorization: `Bearer ${token}` };
}

function asItem(target: ForgeTarget, kind: ForgeKind, raw: any, withBody: boolean): ForgeItem {
  if (target.forge === 'gitlab') {
    const item: ForgeItem = {
      number: Number(raw.iid ?? raw.id ?? 0),
      title: String(raw.title ?? ''),
      state: String(raw.state ?? ''),
      author: String(raw.author?.username ?? ''),
      url: String(raw.web_url ?? ''),
      labels: Array.isArray(raw.labels) ? raw.labels.map(String) : [],
      updatedAt: String(raw.updated_at ?? ''),
      kind,
      ...(raw.draft || raw.work_in_progress ? { draft: true } : {}),
    };
    if (withBody) item.body = String(raw.description ?? '');
    return item;
  }
  const item: ForgeItem = {
    number: Number(raw.number ?? 0),
    title: String(raw.title ?? ''),
    state: String(raw.state ?? ''),
    author: String(raw.user?.login ?? ''),
    url: String(raw.html_url ?? ''),
    labels: Array.isArray(raw.labels) ? raw.labels.map((label: any) => String(label?.name ?? label)) : [],
    updatedAt: String(raw.updated_at ?? ''),
    kind,
    ...(raw.draft ? { draft: true } : {}),
  };
  if (withBody) item.body = String(raw.body ?? '');
  return item;
}

/** The body a create request sends, per forge. */
function createBody(target: ForgeTarget, kind: ForgeKind, input: { title: string; body: string; head?: string; base?: string }): Record<string, any> {
  if (target.forge === 'gitlab') {
    return kind === 'pr'
      ? { title: input.title, description: input.body, source_branch: input.head, target_branch: input.base }
      : { title: input.title, description: input.body };
  }
  return kind === 'pr'
    ? { title: input.title, body: input.body, head: input.head, base: input.base }
    : { title: input.title, body: input.body };
}

export class ForgeTool extends Tool {
  /**
   * Where the token comes from.
   *
   * A setter rather than a constructor argument because the tool is built by
   * `createDefaultRegistry()` before any settings exist, and the same object has
   * to answer for every task. The agent installs the reader once when settings
   * are applied; a test installs its own, or leaves the default that returns
   * nothing so a developer's own credentials cannot make a test pass.
   */
  private static tokenReader: (forge: Forge) => string = () => '';

  static setTokenReader(reader: (forge: Forge) => string): void {
    ForgeTool.tokenReader = reader;
  }

  constructor(tokenFor?: (forge: Forge) => string) {
    super();
    // Resolved in the body, not as a default in the signature: a default value
    // cannot refer to the class's own static, because it is evaluated in a scope
    // where the parameter list is all that exists.
    this.tokenFor = tokenFor || ((forge) => ForgeTool.tokenReader(forge));
  }

  private readonly tokenFor: (forge: Forge) => string;

  get name(): string {
    return 'forge';
  }

  get description(): string {
    return 'Read and write issues and pull requests on GitHub or GitLab: list them, read one (with its body), or open a new one. Use this to check whether a bug is already reported, to read the discussion on a proposed fix, or to file what you found. Read-only actions (list, get) touch nothing; create opens an issue or pull request, which is visible to other people.';
  }

  get parameters(): Record<string, any> {
    return {
      type: 'object',
      required: ['action', 'repo'],
      properties: {
        action: { type: 'string', enum: ['list', 'get', 'create'], description: 'Default list.' },
        forge: { type: 'string', enum: ['github', 'gitlab'], description: 'Default github.' },
        repo: { type: 'string', description: 'owner/repo on GitHub; group/project (slashes allowed) on GitLab.' },
        host: { type: 'string', description: 'Self-hosted host for GitHub Enterprise or a private GitLab; default the public one.' },
        kind: { type: 'string', enum: ['issue', 'pr'], description: 'Issues or pull requests; default issue.' },
        state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Filter for list; default open.' },
        labels: { type: 'string', description: 'Comma-separated label filter for list.' },
        search: { type: 'string', description: 'Words to match in the title or body, for list.' },
        number: { type: 'integer', description: 'Item number, for get.' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Max items for list; default 10.' },
        title: { type: 'string', description: 'Title, for create.' },
        body: { type: 'string', description: 'Body markdown, for create.' },
        head: { type: 'string', description: 'Source branch, for create with kind=pr.' },
        base: { type: 'string', description: 'Target branch, for create with kind=pr.' },
      },
    };
  }

  async execute(args: Record<string, any>, _context: ToolContext): Promise<ToolResult> {
    const forge = (String(args.forge || 'github').toLowerCase() === 'gitlab' ? 'gitlab' : 'github') as Forge;
    const target: ForgeTarget = { forge, repo: String(args.repo || '').trim(), host: args.host ? String(args.host) : undefined };
    // A repo identifier is a path, so it has to be checked as one: `..` is not a
    // valid segment, and a value that escapes the API prefix would point the
    // request somewhere else entirely.
    const segments = target.repo.split('/');
    const validRepo = segments.length >= 2
      && segments.every((segment) => /^[\w.\-]+$/.test(segment) && segment !== '.' && segment !== '..');
    if (!target.repo || !validRepo) {
      return failure('repo is required and must look like owner/name (or group/project on GitLab), with no ".." segments');
    }
    const action = String(args.action || 'list').toLowerCase();
    const kind = (String(args.kind || 'issue').toLowerCase() === 'pr' ? 'pr' : 'issue') as ForgeKind;
    const token = this.tokenFor(forge);
    if (action === 'create' && !token) {
      // Opening an issue needs identity; guessing at one would file it as
      // nobody, or bounce with a 401 after the model already wrote the text.
      return failure(`creating a ${kind === 'pr' ? 'pull request' : 'issue'} on ${forge} needs a token: set it in Settings → Agent`);
    }

    try {
      if (action === 'list') return success(await this.list(target, kind, token, args));
      if (action === 'get') return success(await this.get(target, kind, token, args));
      if (action === 'create') {
        // Validation inside `create` returns a failure, so it must not be wrapped
        // in `success` — a refused request reported as a successful one is how a
        // model concludes an issue was filed when nothing was sent.
        const created = await this.create(target, kind, token, args);
        return created.ok ? success(created.data) : failure(created.error);
      }
      return failure(`unknown action "${action}"; expected list, get or create`);
    } catch (error) {
      if (error instanceof ForgeError) {
        return failure(`${forge} refused (HTTP ${error.status}): ${error.message}`);
      }
      return failure(error);
    }
  }

  private async request(target: ForgeTarget, token: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<any> {
    const url = `${apiBase(target)}${path}`;
    const response = await egressOrDirect(url, {
      method: init.method || 'GET',
      headers: {
        ...headers(target, token),
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(30_000),
    }, 30_000);
    const text = await response.text();
    if (!response.ok) {
      let detail = text.slice(0, 400);
      try {
        const parsed = JSON.parse(text);
        detail = String(parsed.message || parsed.error_description || parsed.error || detail);
      } catch { /* keep the raw body */ }
      throw new ForgeError(detail || `HTTP ${response.status}`, response.status);
    }
    if (!text.trim()) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new ForgeError('the forge returned something that is not JSON', response.status);
    }
  }

  private async list(target: ForgeTarget, kind: ForgeKind, token: string, args: Record<string, any>) {
    const limit = clamp(args.limit, 10, 1, 50);
    const state = ['open', 'closed', 'all'].includes(String(args.state)) ? String(args.state) : 'open';
    const labels = String(args.labels || '').trim();
    const search = String(args.search || '').trim().toLowerCase();

    let path: string;
    if (target.forge === 'gitlab') {
      const base = kind === 'pr' ? 'merge_requests' : 'issues';
      const query = new URLSearchParams({ per_page: String(limit), state: state === 'all' ? 'all' : state });
      if (labels) query.set('labels', labels);
      // GitLab scopes the project by query parameter for the collection endpoints.
      query.set('project_id', target.repo);
      path = `/${base}?${query}`;
    } else {
      const base = kind === 'pr' ? 'pulls' : 'issues';
      const query = new URLSearchParams({ per_page: String(limit), state: state === 'all' ? 'all' : state });
      if (labels) query.set('labels', labels);
      path = `/repos/${target.repo}/${base}?${query}`;
    }

    const raw = await this.request(target, token, path);
    let items = (Array.isArray(raw) ? raw : []).map((entry) => asItem(target, kind, entry, false));
    if (target.forge === 'github' && kind === 'issue') {
      // GitHub's issue list includes pull requests; they are a different thing to
      // a caller asking about bugs, and the API gives no filter for it.
      items = items.filter((item, index) => !(raw as any[])[index]?.pull_request);
    }
    if (search) {
      items = items.filter((item) => item.title.toLowerCase().includes(search));
    }
    return { kind, forge: target.forge, repo: target.repo, state, count: items.length, items };
  }

  private async get(target: ForgeTarget, kind: ForgeKind, token: string, args: Record<string, any>) {
    const number = Number(args.number);
    if (!Number.isInteger(number) || number <= 0) throw new ForgeError('number is required for get', 400);
    const path = target.forge === 'gitlab'
      ? (kind === 'pr' ? `/projects/${encodedRepo(target)}/merge_requests/${number}` : `/projects/${encodedRepo(target)}/issues/${number}`)
      : `/repos/${target.repo}/${kind === 'pr' ? 'pulls' : 'issues'}/${number}`;
    const raw = await this.request(target, token, path);
    return { kind, forge: target.forge, repo: target.repo, item: asItem(target, kind, raw, true) };
  }

  /**
   * Open an issue or a pull request.
   *
   * Returns `{ok}` rather than a ToolResult: the caller decides how to present a
   * refusal, and a refusal wrapped as success is how a model reports an issue it
   * never filed.
   */
  private async create(
    target: ForgeTarget,
    kind: ForgeKind,
    token: string,
    args: Record<string, any>,
  ): Promise<{ ok: true; data: any } | { ok: false; error: string }> {
    const title = String(args.title || '').trim();
    if (!title) return { ok: false, error: 'title is required for create' };
    const body = String(args.body || '');
    if (kind === 'pr') {
      const head = String(args.head || '').trim();
      const base = String(args.base || '').trim();
      // Both branches are structurally required: without them the forge would
      // answer with a 422 that says less than this does.
      if (!head || !base) return { ok: false, error: 'creating a pull request needs head and base branches' };
      return { ok: true, data: await this.openRequest(target, kind, token, { title, body, head, base }) };
    }
    return { ok: true, data: await this.openRequest(target, kind, token, { title, body }) };
  }

  private async openRequest(target: ForgeTarget, kind: ForgeKind, token: string, input: { title: string; body: string; head?: string; base?: string }) {
    const path = target.forge === 'gitlab'
      ? (kind === 'pr' ? `/projects/${encodedRepo(target)}/merge_requests` : `/projects/${encodedRepo(target)}/issues`)
      : `/repos/${target.repo}/${kind === 'pr' ? 'pulls' : 'issues'}`;
    const raw = await this.request(target, token, path, { method: 'POST', body: createBody(target, kind, input) });
    return { kind, forge: target.forge, repo: target.repo, created: asItem(target, kind, raw, false) };
  }
}

/** The token the agent holds for a forge, read from its own settings. */
export function forgeTokenFromSettings(settings: Record<string, any>): (forge: Forge) => string {
  return (forge) => {
    const value = forge === 'gitlab' ? settings.gitlab_token : settings.github_token;
    return typeof value === 'string' ? value.trim() : '';
  };
}