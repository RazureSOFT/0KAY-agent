import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { Tool, type ToolContext, type ToolResult } from './types.js';
import { success, failure } from './helpers.js';

const run = promisify(execFile);

interface EvolveState {
  slug: string;
  repo: string;
  worktree: string;
  branch: string;
  commits: number;
}

const sessions = new Map<string, EvolveState>();

function keyOf(context: ToolContext): string {
  return context.sessionId || context.taskId || 'default';
}

function slugify(value: string): string {
  const slug = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || `iter-${Date.now().toString(36)}`;
}

async function git(repo: string, args: string[], timeout = 60_000): Promise<{ ok: boolean; out: string; err: string }> {
  try {
    const { stdout, stderr } = await run('git', args, { cwd: repo, timeout, maxBuffer: 16 * 1024 * 1024 });
    return { ok: true, out: stdout.trim(), err: stderr.trim() };
  } catch (error: any) {
    return { ok: false, out: String(error?.stdout || '').trim(), err: String(error?.stderr || error?.message || error) };
  }
}

function repoRoot(context: ToolContext, configured: string): string {
  if (configured && configured.trim()) return path.resolve(configured.trim());
  const candidate = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../..');
  return existsSync(path.join(candidate, '.git')) ? candidate : context.cwd;
}

// every write goes into a worktree on a self/<slug> branch. that one rule is
// what makes "no PR, no change" true instead of a fucking promise.
export class EvolveBeginTool extends Tool {
  get name(): string { return 'evolve_begin'; }

  get description(): string {
    return 'Start a self-iteration: create an isolated git worktree on a `self/<slug>` branch so edits never touch the working tree. Returns the worktree path to edit.';
  }

  get parameters(): Record<string, any> {
    return {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Short kebab-case name for the iteration, e.g. "faster-startup".' },
        repo: { type: 'string', description: 'Repository to evolve. Defaults to the agent checkout.' },
        base: { type: 'string', description: 'Base ref (default: origin/main if it exists, else HEAD).' },
      },
    };
  }

  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    const key = keyOf(context);
    const existing = sessions.get(key);
    if (existing) {
      return success({
        reused: true,
        worktree: existing.worktree,
        branch: existing.branch,
        note: `iteration ${existing.slug} is already open in this session; finish it or reuse it`,
      });
    }
    const repo = repoRoot(context, String(args.repo || ''));
    if (!existsSync(path.join(repo, '.git'))) return failure(`not a git repository: ${repo}`);

    const slug = slugify(args.slug);
    const branch = `self/${slug}`;
    const worktree = path.join(repo, '.evolve', slug);

    const requested = String(args.base || '').trim();
    const hasOriginMain = (await git(repo, ['rev-parse', '--verify', '--quiet', 'origin/main'])).ok;
    const base = requested || (hasOriginMain ? 'origin/main' : 'HEAD');
    const created = await git(repo, ['worktree', 'add', '-B', branch, worktree, base], 120_000);
    if (!created.ok) return failure(`could not create the worktree: ${created.err || created.out}`);

    sessions.set(key, { slug, repo, worktree, branch, commits: 0 });
    return success({
      worktree,
      branch,
      base,
      note: 'edit files inside the worktree only; the main checkout is untouched',
    });
  }
}

export class EvolveCommitTool extends Tool {
  get name(): string { return 'evolve_commit'; }

  get description(): string {
    return 'Commit the changes made inside the current iteration worktree. Returns the file list so you can check nothing unexpected was swept in.';
  }

  get parameters(): Record<string, any> {
    return {
      type: 'object',
      required: ['message'],
      properties: {
        message: { type: 'string', description: 'Commit message (imperative, one line + optional body).' },
        paths: { type: 'array', items: { type: 'string' }, description: 'Only stage these paths instead of everything.' },
      },
    };
  }

  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    const state = sessions.get(keyOf(context));
    if (!state) return failure('no open iteration; call evolve_begin first');
    const message = String(args.message || '').trim();
    if (!message) return failure('message is required');

    const stage = Array.isArray(args.paths) && args.paths.length
      ? ['add', '--', ...args.paths.map((p: any) => String(p))]
      : ['add', '-A'];
    const added = await git(state.worktree, stage);
    if (!added.ok) return failure(`git add failed: ${added.err}`);

    const status = await git(state.worktree, ['status', '--porcelain']);
    if (!status.out.trim()) return failure('nothing to commit: the worktree is clean');

    const committed = await git(state.worktree, ['commit', '-m', message]);
    if (!committed.ok) return failure(`git commit failed: ${committed.err || committed.out}`);
    state.commits += 1;

    const files = status.out.split(/\r?\n/).map((line) => line.slice(3).trim()).filter(Boolean);
    return success({ branch: state.branch, worktree: state.worktree, files, commits: state.commits });
  }
}

export class EvolveUpstreamTool extends Tool {
  get name(): string { return 'evolve_upstream'; }

  get description(): string {
    return 'Bring the iteration branch up to date with upstream (fetch + merge origin/main inside the worktree). Reports conflicts instead of guessing.';
  }

  get parameters(): Record<string, any> {
    return {
      type: 'object',
      properties: {
        remote: { type: 'string', description: 'Remote name, default origin.' },
        branch: { type: 'string', description: 'Upstream branch, default main.' },
      },
    };
  }

  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    const state = sessions.get(keyOf(context));
    if (!state) return failure('no open iteration; call evolve_begin first');
    const remote = String(args.remote ?? 'origin').trim();
    const branch = String(args.branch || 'main');

    if (remote) {
      const fetched = await git(state.repo, ['fetch', remote], 180_000);
      if (!fetched.ok) return failure(`git fetch failed: ${fetched.err}`);
    }
    const target = remote ? `${remote}/${branch}` : branch;
    const merged = await git(state.worktree, ['merge', '--no-edit', target], 180_000);
    if (merged.ok) {
      return success({ merged: true, branch: state.branch, output: merged.out.split(/\r?\n/).slice(-5).join('\n') });
    }
    const conflicted = await git(state.worktree, ['diff', '--name-only', '--diff-filter=U']);
    return success({
      merged: false,
      conflicts: conflicted.out.split(/\r?\n/).filter(Boolean),
      detail: merged.err || merged.out,
      note: 'resolve the conflicts in the worktree, then evolve_commit',
    });
  }
}

export class EvolveFinishTool extends Tool {
  get name(): string { return 'evolve_finish'; }

  get description(): string {
    return 'Close the iteration. With open_pr=true it pushes the branch and (when the gh CLI is available) opens a pull request; otherwise the branch stays local and main is untouched.';
  }

  get parameters(): Record<string, any> {
    return {
      type: 'object',
      required: ['open_pr'],
      properties: {
        open_pr: { type: 'boolean', description: 'Ask the user first; only true when they said yes.' },
        title: { type: 'string' },
        body: { type: 'string' },
        keep_worktree: { type: 'boolean', description: 'Keep the worktree on disk (default true so the user can inspect it).' },
      },
    };
  }

  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    const key = keyOf(context);
    const state = sessions.get(key);
    if (!state) return failure('no open iteration; call evolve_begin first');
    if (!args.open_pr) {
      sessions.delete(key);
      return success({
        pushed: false,
        branch: state.branch,
        worktree: state.worktree,
        commits: state.commits,
        note: 'kept local: the main checkout was never touched, and the branch is the incremental delta to revisit later',
      });
    }

    const remote = (await git(state.repo, ['remote'])).out.split(/\r?\n/).filter(Boolean)[0] || 'origin';
    const pushed = await git(state.worktree, ['push', '-u', remote, state.branch], 180_000);
    if (!pushed.ok) return failure(`git push failed: ${pushed.err}`);

    const gh = await run('gh', ['--version'], { timeout: 15_000 }).then(() => true).catch(() => false);
    let prUrl = '';
    if (gh) {
      const title = String(args.title || `self-iteration: ${state.slug}`);
      const body = String(args.body || 'Generated by the agent during a self-iteration.');
      const pr = await run('gh', ['pr', 'create', '--head', state.branch, '--title', title, '--body', body], { cwd: state.worktree, timeout: 120_000 })
        .then(({ stdout }) => stdout.trim())
        .catch(() => '');
      prUrl = pr;
    }
    sessions.delete(key);
    return success({
      pushed: true,
      branch: state.branch,
      commits: state.commits,
      prUrl: prUrl || undefined,
      compareUrl: prUrl ? undefined : `open a PR from ${state.branch} on the remote`,
      note: prUrl ? 'pull request created' : 'branch pushed; open the PR from the compare page',
    });
  }
}

export function resetEvolveSessions(): void { sessions.clear(); }
