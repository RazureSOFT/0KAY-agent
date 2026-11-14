import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { isRepository, originUrlFromConfig, ownership, remoteOwner, repositoryOwner } from './repo_identity.js';

/** Write a `.git/config` into a freshly made repo directory. */
async function repo(url: string | null): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'repo-id-'));
  await fs.mkdir(path.join(dir, '.git'), { recursive: true });
  const body = url === null
    ? '[core]\n\tbare = false\n'
    : `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`;
  await fs.writeFile(path.join(dir, '.git', 'config'), body, 'utf8');
  return dir;
}

test('both URL forms yield the owner', () => {
  // The two forms git writes, and the scp form a person is most likely to paste.
  assert.equal(remoteOwner('https://github.com/Owner/repo.git'), 'Owner');
  assert.equal(remoteOwner('git@github.com:Owner/repo.git'), 'Owner');
  assert.equal(remoteOwner('https://github.com/Owner/repo'), 'Owner');
});

test('a proxy-prefixed remote still yields the real owner', () => {
  // The segment that matters is still the last `owner/repo` pair; the proxy is
  // transport, not identity.
  assert.equal(remoteOwner('https://v4.gh-proxy.org/https://github.com/poenel/Claude-Code-rev.git'), 'poenel');
});

test('a remote with no owner is undefined, not a guess', () => {
  assert.equal(remoteOwner(''), undefined);
  assert.equal(remoteOwner('   '), undefined);
});

test('origin is read from a config body', () => {
  const config = '[core]\n\tbare = false\n[remote "origin"]\n\turl = git@github.com:A/b.git\n';
  assert.equal(originUrlFromConfig(config), 'git@github.com:A/b.git');
});

test('a non-origin remote is not mistaken for origin', () => {
  // Upstream is often somebody else's repository; reading it as origin would
  // classify the project's own code as foreign.
  const config = '[remote "upstream"]\n\turl = https://github.com/other/thing.git\n[remote "origin"]\n\turl = https://github.com/ours/thing.git\n';
  assert.equal(originUrlFromConfig(config), 'https://github.com/ours/thing.git');
});

test('a config with no origin yields undefined', () => {
  assert.equal(originUrlFromConfig('[core]\n\tbare = false\n'), undefined);
  assert.equal(originUrlFromConfig(''), undefined);
});

test('the owner is read from a repository directory', async () => {
  const dir = await repo('https://github.com/SomeOwner/project.git');
  assert.equal(await repositoryOwner(dir), 'SomeOwner');
});

test('a repository with no origin has no owner', async () => {
  const dir = await repo(null);
  assert.equal(await repositoryOwner(dir), undefined);
});

test('a .git file (worktree or submodule) is followed to its config', async () => {
  // A submodule's `.git` is a file containing `gitdir: <path>`; treating it as a
  // directory would make the check silently return "no owner".
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'repo-wt-'));
  const realGit = path.join(dir, 'actual-git-dir');
  await fs.mkdir(realGit, { recursive: true });
  await fs.writeFile(path.join(realGit, 'config'), '[remote "origin"]\n\turl = https://github.com/Worktree/owner.git\n', 'utf8');
  const work = path.join(dir, 'work');
  await fs.mkdir(work, { recursive: true });
  await fs.writeFile(path.join(work, '.git'), 'gitdir: ../actual-git-dir\n', 'utf8');
  assert.equal(await repositoryOwner(work), 'Worktree');
});

test('isRepository sees a .git directory and a .git file alike', async () => {
  const dir = await repo('https://github.com/a/b.git');
  assert.equal(await isRepository(dir), true);

  const plain = await fs.mkdtemp(path.join(os.tmpdir(), 'plain-'));
  assert.equal(await isRepository(plain), false);
});

test('a nested repository with the same owner as the root is ours', async () => {
  // The real case: the agent lives in its own repository under the same account.
  const root = await repo('https://github.com/RazureSOFT/0KAY.git');
  const nested = await repo('https://github.com/RazureSOFT/0KAY-agent.git');
  assert.equal(await ownership(nested, root), 'ours');
});

test('a nested repository with a different owner is foreign', async () => {
  // And this is the reference clone that must stay excluded.
  const root = await repo('https://github.com/RazureSOFT/0KAY.git');
  const nested = await repo('https://v4.gh-proxy.org/https://github.com/poenel/Claude-Code-rev.git');
  assert.equal(await ownership(nested, root), 'foreign');
});

test('owner comparison ignores case', async () => {
  const root = await repo('https://github.com/RazureSoft/0KAY.git');
  const nested = await repo('https://github.com/razuresoft/0KAY-agent.git');
  assert.equal(await ownership(nested, root), 'ours');
});

test('an unknown side falls through rather than guessing', async () => {
  // Hiding a real module and including a vendored copy are both wrong, and
  // neither is more wrong — so a repo with no readable origin decides nothing.
  const root = await repo('https://github.com/RazureSOFT/0KAY.git');
  const anonymous = await repo(null);
  assert.equal(await ownership(anonymous, root), 'unknown');
  assert.equal(await ownership(root, anonymous), 'unknown');
});

test('a directory with no repository at all is unknown', async () => {
  const root = await repo('https://github.com/a/b.git');
  const plain = await fs.mkdtemp(path.join(os.tmpdir(), 'plain2-'));
  assert.equal(await ownership(plain, root), 'unknown');
});