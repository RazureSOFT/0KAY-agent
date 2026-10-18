import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import { allowedWorkspaceRoots, isPathAllowed, refreshWorkspaceRoots } from './paths.js';

function gitTop(): string {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return '';
  }
}

// The agent is launched from <repo>/agent, so a cwd-only default root set makes
// the repository the user is actually editing — the directory the WebUI offers
// as the workspace — outside its own boundary, and every write fails with
// "path not allowed: outside workspace roots".
test('the repository containing cwd is an allowed workspace root', () => {
  const repo = gitTop();
  if (!repo) return; // not a git checkout: nothing to assert
  const resolved = path.resolve(repo);
  const roots = allowedWorkspaceRoots().map((root) => path.resolve(root));
  assert.ok(
    roots.some((root) => (process.platform === 'win32' ? root.toLowerCase() === resolved.toLowerCase() : root === resolved)),
    `repository root ${resolved} missing from ${JSON.stringify(roots)}`,
  );
  assert.ok(isPathAllowed(path.join(resolved, 'src', 'main.go')), 'a file in the repository must be writable');
});

test('a path outside every root is still rejected', () => {
  const roots = allowedWorkspaceRoots().map((root) => path.resolve(root));
  // Find a drive/dir no root covers; on POSIX this is outside home and temp too.
  const outside = process.platform === 'win32' ? 'Q:\\definitely-not-allowed\\x.ts' : '/definitely-not-allowed/x.ts';
  if (roots.some((root) => outside.toLowerCase().startsWith(root.toLowerCase() + path.sep))) return;
  assert.equal(isPathAllowed(outside), false);
});

// Settings → 工作区 is the UI-side allow-list. Core enforces it for git; the
// agent has to read the same list or a folder allowed in the UI would still be
// refused by write/edit ("path not allowed: outside workspace roots").
test('roots allowed in Core settings widen the write policy', async () => {
  const extra = path.resolve(os.tmpdir(), 'okay-allowed-by-settings');
  const server = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    // Comma + newline + padding: operators paste either form.
    res.end(JSON.stringify({ values: { allowed_roots: `/nope,\n  ${extra}  \n` } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const saved = process.env.CORE_HTTP_ADDR;
  process.env.CORE_HTTP_ADDR = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await refreshWorkspaceRoots();
    assert.ok(allowedWorkspaceRoots().includes(extra), `missing ${extra} in ${JSON.stringify(allowedWorkspaceRoots())}`);
    assert.ok(isPathAllowed(path.join(extra, 'src', 'main.go')));
  } finally {
    if (saved === undefined) delete process.env.CORE_HTTP_ADDR;
    else process.env.CORE_HTTP_ADDR = saved;
    server.close();
  }
});
