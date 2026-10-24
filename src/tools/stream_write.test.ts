import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { streamWriteFile } from './stream_write.js';

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), '0kay-stream-'));
}

test('publishes the file progressively, then finishes with the exact content', async () => {
  const dir = await tempDir();
  const target = path.join(dir, 'grow.txt');
  const content = 'x'.repeat(4000);

  const observed: number[] = [];
  let running = true;
  const poller = (async () => {
    while (running) {
      try { observed.push((await fs.stat(target)).size); } catch { }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  })();

  const result = await streamWriteFile(target, content, undefined, { targetMs: 300, steps: 20 });
  running = false;
  await poller;

  assert.equal(await fs.readFile(target, 'utf8'), content);
  assert.equal(result.bytes, Buffer.byteLength(content));
  const intermediate = observed.filter((size) => size > 0 && size < Buffer.byteLength(content));
  assert.ok(intermediate.length > 0, `expected partial sizes, saw ${observed.slice(0, 20).join(',')}`);
  assert.ok(result.paced, 'should have been paced');
});

test('pacing is bounded: large content does not stall the tool', async () => {
  const dir = await tempDir();
  const target = path.join(dir, 'big.txt');
  const content = 'y'.repeat(200_000);
  const started = Date.now();
  await streamWriteFile(target, content, undefined, { targetMs: 100, steps: 10, maxStreamedChars: 40_000 });
  const elapsed = Date.now() - started;
  assert.equal(await fs.readFile(target, 'utf8'), content);
  assert.ok(elapsed < 2_000, `too slow for a large write: ${elapsed}ms`);
});

test('a zero budget writes everything without delay', async () => {
  const dir = await tempDir();
  const target = path.join(dir, 'instant.txt');
  const content = 'z'.repeat(5000);
  const started = Date.now();
  const result = await streamWriteFile(target, content, undefined, { targetMs: 0 });
  assert.ok(Date.now() - started < 1_000);
  assert.equal(result.paced, false);
  assert.equal(await fs.readFile(target, 'utf8'), content);
});

test('abort restores the previous file', async () => {
  const dir = await tempDir();
  const target = path.join(dir, 'keep.txt');
  const original = 'original contents\n';
  await fs.writeFile(target, original);

  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error('cancelled by user')), 40);
  await assert.rejects(
    () => streamWriteFile(target, 'replacement'.repeat(500), controller.signal, { targetMs: 2_000, steps: 40 }),
    /cancelled by user/,
  );
  assert.equal(await fs.readFile(target, 'utf8'), original);
});

test('abort removes a partially written new file', async () => {
  const dir = await tempDir();
  const target = path.join(dir, 'new.txt');
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error('stop')), 40);
  await assert.rejects(
    () => streamWriteFile(target, 'a'.repeat(20_000), controller.signal, { targetMs: 2_000, steps: 40 }),
    /stop/,
  );
  await assert.rejects(() => fs.stat(target), /ENOENT/);
});

test('works with multi-byte text and reports byte length', async () => {
  const dir = await tempDir();
  const target = path.join(dir, 'cjk.txt');
  const content = '第一行\n第二行 — done\n';
  const result = await streamWriteFile(target, content, undefined, { targetMs: 60, steps: 6 });
  assert.equal(await fs.readFile(target, 'utf8'), content);
  assert.equal(result.bytes, Buffer.byteLength(content, 'utf8'));
});

test('empty content produces an empty file', async () => {
  const dir = await tempDir();
  const target = path.join(dir, 'empty.txt');
  await streamWriteFile(target, '', undefined, { targetMs: 100 });
  assert.equal(await fs.readFile(target, 'utf8'), '');
});

test('a concurrent reader can observe partial content, not just a partial size', async () => {
  const dir = await tempDir();
  const target = path.join(dir, 'readable.txt');
  const content = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n') + '\n';

  const snapshots: string[] = [];
  let running = true;
  const reader = (async () => {
    while (running) {
      try {
        const text = await fs.readFile(target, 'utf8');
        if (text) snapshots.push(text);
      } catch { }
      await new Promise((resolve) => setTimeout(resolve, 8));
    }
  })();

  await streamWriteFile(target, content, undefined, { targetMs: 400, steps: 25 });
  running = false;
  await reader;

  assert.equal(await fs.readFile(target, 'utf8'), content);
  assert.ok(snapshots.length > 0, 'a concurrent reader saw nothing');
  const partial = snapshots.filter((text) => text.length < content.length);
  assert.ok(partial.length > 0, 'reader never saw an in-progress state');
  for (const text of snapshots) {
    assert.ok(content.startsWith(text), `reader saw content that is not a prefix: ${JSON.stringify(text.slice(0, 40))}`);
  }
});

test('does not leave scratch files behind', async () => {
  const dir = await tempDir();
  await streamWriteFile(path.join(dir, 'a.txt'), 'hello world', undefined, { targetMs: 30, steps: 4 });
  const names = await fs.readdir(dir);
  assert.deepEqual(names, ['a.txt']);
});