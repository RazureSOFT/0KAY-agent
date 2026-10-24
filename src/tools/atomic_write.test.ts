import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeFileAtomic } from './atomic_write.js';

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), '0kay-atomic-'));
}

test('writes new content and replaces an existing file', async () => {
  const dir = await tempDir();
  const target = path.join(dir, 'a.txt');

  await writeFileAtomic(target, 'first');
  assert.equal(await fs.readFile(target, 'utf8'), 'first');

  await writeFileAtomic(target, 'second');
  assert.equal(await fs.readFile(target, 'utf8'), 'second');
});

test('leaves no scratch file behind on success', async () => {
  const dir = await tempDir();
  await writeFileAtomic(path.join(dir, 'a.txt'), 'x');
  const names = await fs.readdir(dir);
  assert.deepEqual(names, ['a.txt']);
});

test('writes buffers without corruption', async () => {
  const dir = await tempDir();
  const target = path.join(dir, 'b.bin');
  const payload = Buffer.from([0x00, 0xff, 0x10, 0x80]);
  await writeFileAtomic(target, payload);
  assert.deepEqual(await fs.readFile(target), payload);
});

test('preserves the executable bit of an existing file', async () => {
  if (process.platform === 'win32') return;
  const dir = await tempDir();
  const target = path.join(dir, 'run.sh');
  await fs.writeFile(target, '#!/bin/sh\necho one\n', { mode: 0o755 });
  await writeFileAtomic(target, '#!/bin/sh\necho two\n');
  const mode = (await fs.stat(target)).mode & 0o777;
  assert.equal(mode, 0o755);
});

test('preserves a restrictive mode', async () => {
  if (process.platform === 'win32') return;
  const dir = await tempDir();
  const target = path.join(dir, 'secret.txt');
  await fs.writeFile(target, 'a', { mode: 0o600 });
  await writeFileAtomic(target, 'b');
  assert.equal((await fs.stat(target)).mode & 0o777, 0o600);
});

test('a failing write does not clobber the target and leaves no scratch file', async () => {
  const dir = await tempDir();
  const target = path.join(dir, 'keep.txt');
  await writeFileAtomic(target, 'original');

  const blocked = path.join(dir, 'blocked');
  await fs.mkdir(blocked);
  await assert.rejects(() => writeFileAtomic(blocked, 'nope'));

  assert.equal(await fs.readFile(target, 'utf8'), 'original');
  const leftovers = (await fs.readdir(dir)).filter((name) => name.includes('.okay-tmp'));
  assert.deepEqual(leftovers, []);
});

test('concurrent writes to the same path do not interleave', async () => {
  const dir = await tempDir();
  const target = path.join(dir, 'race.txt');
  await Promise.all(
    Array.from({ length: 20 }, (_, i) => writeFileAtomic(target, `payload-${i}`.padEnd(4000, '.'))),
  );
  const content = await fs.readFile(target, 'utf8');
  assert.match(content, /^payload-\d+\.+$/);
  const leftovers = (await fs.readdir(dir)).filter((name) => name.includes('.okay-tmp'));
  assert.deepEqual(leftovers, []);
});

test('writes UTF-8 including multi-byte characters', async () => {
  const dir = await tempDir();
  const target = path.join(dir, 'cjk.txt');
  const text = '中文内容 — ok';
  await writeFileAtomic(target, text);
  assert.equal(await fs.readFile(target, 'utf8'), text);
  assert.equal((await fs.readFile(target)).length, Buffer.byteLength(text, 'utf8'));
});