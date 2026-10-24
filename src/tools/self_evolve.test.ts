import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { EvolveBeginTool, EvolveCommitTool, EvolveFinishTool, EvolveUpstreamTool, resetEvolveSessions } from './self_evolve.js';
import type { ToolContext } from './types.js';

function gitRepo(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'evolve-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.test');
  git('config', 'user.name', 'Test');
  writeFileSync(path.join(root, 'README.md'), '# base\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return root;
}

function ctx(sessionId = 's1'): ToolContext {
  return { cwd: process.cwd(), taskId: 't1', sessionId, agentType: 'general' } as ToolContext;
}

test('an iteration lands on its own branch and leaves the checkout alone', async () => {
  resetEvolveSessions();
  const repo = gitRepo();
  const begin = await new EvolveBeginTool().execute({ slug: 'faster-startup', repo }, ctx());
  assert.equal(begin.success, true, begin.error);
  const worktree: string = begin.data.worktree;
  assert.equal(begin.data.branch, 'self/faster-startup');
  assert.ok(existsSync(worktree));

  writeFileSync(path.join(worktree, 'feature.txt'), 'hello\n');
  const commit = await new EvolveCommitTool().execute({ message: 'feat: add a feature' }, ctx());
  assert.equal(commit.success, true, commit.error);
  assert.deepEqual(commit.data.files, ['feature.txt']);

  assert.equal(existsSync(path.join(repo, 'feature.txt')), false);
  assert.equal(readFileSync(path.join(repo, 'README.md'), 'utf8'), '# base\n');

  const finish = await new EvolveFinishTool().execute({ open_pr: false }, ctx());
  assert.equal(finish.success, true, finish.error);
  assert.equal(finish.data.pushed, false);
  assert.equal(finish.data.commits, 1);
  assert.equal(existsSync(path.join(repo, 'feature.txt')), false);
});

test('a second begin in the same session reuses the open iteration', async () => {
  resetEvolveSessions();
  const repo = gitRepo();
  const first = await new EvolveBeginTool().execute({ slug: 'one', repo }, ctx('same'));
  const second = await new EvolveBeginTool().execute({ slug: 'two', repo }, ctx('same'));
  assert.equal(second.data.reused, true);
  assert.equal(second.data.worktree, first.data.worktree);
});

test('commit refuses an empty worktree', async () => {
  resetEvolveSessions();
  const repo = gitRepo();
  await new EvolveBeginTool().execute({ slug: 'empty', repo }, ctx('empty'));
  const commit = await new EvolveCommitTool().execute({ message: 'nothing' }, ctx('empty'));
  assert.equal(commit.success, false);
  assert.match(String(commit.error), /nothing to commit/);
});

test('upstream merge brings the branch forward and keeps local work', async () => {
  resetEvolveSessions();
  const repo = gitRepo();
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  await new EvolveBeginTool().execute({ slug: 'merge-me', repo }, ctx('m'));
  const worktree: string = (await new EvolveCommitTool().execute({ message: 'x' }, ctx('m'))).error ? '' : '';

  writeFileSync(path.join(repo, '.evolve', 'merge-me', 'local.txt'), 'mine\n');
  await new EvolveCommitTool().execute({ message: 'feat: local work' }, ctx('m'));
  writeFileSync(path.join(repo, 'upstream.txt'), 'theirs\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: upstream');

  const merge = await new EvolveUpstreamTool().execute({ remote: '', branch: 'main' }, ctx('m'));
  assert.equal(merge.success, true, merge.error);
  assert.equal(merge.data.merged, true, JSON.stringify(merge.data));
  assert.ok(existsSync(path.join(repo, '.evolve', 'merge-me', 'upstream.txt')));
  assert.ok(existsSync(path.join(repo, '.evolve', 'merge-me', 'local.txt')));
  void worktree;
});

test('the tools are inert without an open iteration', async () => {
  resetEvolveSessions();
  const commit = await new EvolveCommitTool().execute({ message: 'x' }, ctx('none'));
  assert.equal(commit.success, false);
  assert.match(String(commit.error), /no open iteration/);
  const finish = await new EvolveFinishTool().execute({ open_pr: true }, ctx('none'));
  assert.equal(finish.success, false);
});
