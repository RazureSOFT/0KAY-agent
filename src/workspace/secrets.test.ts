import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { checkReadable, assertReadable, filterListing } from './secrets.js';

// These lock in the gate that closed the reported exfiltration chain:
// read a credential file, send it somewhere. The read half is what is tested
// here; http_request and egress are covered by their own tests.

async function withTempTree(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'okay-secrets-'));
  await fs.mkdir(path.join(root, '.ssh'), { recursive: true });
  await fs.writeFile(path.join(root, '.ssh', 'id_rsa'), 'PRIVATE KEY');
  await fs.mkdir(path.join(root, '.0kay', 'data'), { recursive: true });
  await fs.writeFile(path.join(root, '.0kay', 'data', 'providers.json'), '{"api_key":"sk-secret"}');
  await fs.writeFile(path.join(root, '.env'), 'TOKEN=abc');
  await fs.writeFile(path.join(root, 'readme.md'), '# hi');
  await fs.writeFile(path.join(root, 'server.pem'), 'cert');
  return root;
}

test('a credential file is refused by name wherever it lives', async () => {
  const root = await withTempTree();
  for (const name of ['.env', 'server.pem']) {
    const check = await checkReadable(path.join(root, name));
    assert.equal(check.blocked, true, name);
  }
  await fs.rm(root, { recursive: true, force: true });
});

test('ssh keys and Core data are refused by directory', async () => {
  const root = await withTempTree();
  assert.equal((await checkReadable(path.join(root, '.ssh', 'id_rsa'))).blocked, true);
  assert.equal((await checkReadable(path.join(root, '.0kay', 'data', 'providers.json'))).blocked, true);
  await fs.rm(root, { recursive: true, force: true });
});

test('an ordinary file in the same tree is still readable', async () => {
  const root = await withTempTree();
  assert.equal((await checkReadable(path.join(root, 'readme.md'))).blocked, false);
  await fs.rm(root, { recursive: true, force: true });
});

test('a symlink into a secret directory is judged on its target', async () => {
  const root = await withTempTree();
  const link = path.join(root, 'innocent.txt');
  try {
    await fs.symlink(path.join(root, '.ssh', 'id_rsa'), link);
  } catch {
    await fs.rm(root, { recursive: true, force: true });
    return; // symlinks need elevation on Windows; nothing to assert here
  }
  assert.equal((await checkReadable(link)).blocked, true);
  await fs.rm(root, { recursive: true, force: true });
});

test('assertReadable throws with a reason the model can act on', async () => {
  const root = await withTempTree();
  await assert.rejects(() => assertReadable(path.join(root, '.env')), /read refused/);
  await fs.rm(root, { recursive: true, force: true });
});

test('a directory listing hides credential entries but not the rest', async () => {
  const root = await withTempTree();
  const names = await fs.readdir(root);
  const visible = await filterListing(root, names);
  assert.ok(visible.includes('readme.md'));
  assert.ok(!visible.includes('.env'));
  await fs.rm(root, { recursive: true, force: true });
});
