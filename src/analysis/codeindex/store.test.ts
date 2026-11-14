import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { applyPlan, emptyIndex, hashContent, indexStats, planIndex, readIndex, toRecords, writeIndex } from './store.js';
import { chunkText } from './vectors.js';

async function cwd(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'codeindex-'));
}

const MODEL = 'embed-1';

test('a file is embedded once and reused on the second run', () => {
  // This is the whole point of the cache: embedding is a model call per chunk.
  const files = [{ file: 'a.ts', text: 'export const a = 1' }];
  const first = planIndex(files, emptyIndex('/r', MODEL), MODEL);
  assert.equal(first.toEmbed.length, 1);
  assert.equal(first.reused, 0);

  const stored = applyPlan(emptyIndex('/r', MODEL), first, [
    { file: 'a.ts', text: 'export const a = 1', model: MODEL, vectors: [[1, 0]] },
  ], MODEL, '/r');
  const second = planIndex(files, stored, MODEL);
  assert.equal(second.toEmbed.length, 0, 'an unchanged file must not be re-embedded');
  assert.equal(second.reused, 1);
});

test('a changed file is re-embedded', () => {
  const before = applyPlan(emptyIndex('/r', MODEL),
    planIndex([{ file: 'a.ts', text: 'one' }], emptyIndex('/r', MODEL), MODEL),
    [{ file: 'a.ts', text: 'one', model: MODEL, vectors: [[1, 0]] }], MODEL, '/r');
  const plan = planIndex([{ file: 'a.ts', text: 'two' }], before, MODEL);
  assert.equal(plan.toEmbed.length, 1);
  assert.equal(plan.reused, 0);
});

test('a file that disappeared is dropped from the index', () => {
  // An index that keeps a deleted file answers with code that is not there.
  const stored = applyPlan(emptyIndex('/r', MODEL), planIndex([{ file: 'gone.ts', text: 'x' }], emptyIndex('/r', MODEL), MODEL),
    [{ file: 'gone.ts', text: 'x', model: MODEL, vectors: [[1, 0]] }], MODEL, '/r');
  const plan = planIndex([{ file: 'kept.ts', text: 'y' }], stored, MODEL);
  assert.deepEqual(plan.dropped, ['gone.ts']);
  const next = applyPlan(stored, plan, [{ file: 'kept.ts', text: 'y', model: MODEL, vectors: [[0, 1]] }], MODEL, '/r');
  assert.equal(Object.keys(next.files).includes('gone.ts'), false);
  assert.equal(Object.keys(next.files).includes('kept.ts'), true);
});

test('a model change forces a full re-index', () => {
  // Vectors from two models cannot be compared, so keeping the old ones would
  // produce a mixed index whose scores mean nothing.
  const stored = applyPlan(emptyIndex('/r', MODEL), planIndex([{ file: 'a.ts', text: 'x' }], emptyIndex('/r', MODEL), MODEL),
    [{ file: 'a.ts', text: 'x', model: MODEL, vectors: [[1, 0]] }], MODEL, '/r');
  const plan = planIndex([{ file: 'a.ts', text: 'x' }], stored, 'embed-2');
  assert.equal(plan.toEmbed.length, 1);
});

test('a vector count that disagrees with the chunk count is not stored', () => {
  // The vectors could not be attributed to lines, so a hit would land on the
  // wrong one.
  const text = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
  const plan = planIndex([{ file: 'a.ts', text }], emptyIndex('/r', MODEL), MODEL);
  const next = applyPlan(emptyIndex('/r', MODEL), plan, [{ file: 'a.ts', text, model: MODEL, vectors: [[1, 0]] }], MODEL, '/r');
  assert.equal(next.files['a.ts'], undefined, 'a mismatched file must be skipped, not half-stored');
});

test('toRecords flattens files into one record per chunk', () => {
  const text = Array.from({ length: 120 }, (_, i) => `line ${i} padded out a bit`).join('\n');
  const plan = planIndex([{ file: 'big.ts', text }], emptyIndex('/r', MODEL), MODEL);
  // The vector count has to match the chunk count exactly, so it is derived the
  // same way the store derives it rather than guessed — a hand-written number
  // here would be asserting on the test's arithmetic, not the code's.
  const chunkCount = chunkText(text, {}).length;
  assert.ok(chunkCount > 1, 'this fixture is supposed to span several chunks');

  const stored = applyPlan(emptyIndex('/r', MODEL), plan,
    [{ file: 'big.ts', text, model: MODEL, vectors: Array.from({ length: chunkCount }, () => [1, 0]) }], MODEL, '/r');
  const records = toRecords(stored);
  assert.equal(records.length, chunkCount);
  for (const record of records) {
    assert.match(record.id, /^big\.ts:\d+$/);
    assert.equal(record.file, 'big.ts');
    assert.ok(record.line >= 1);
  }
});

test('an index round-trips through disk', async () => {
  const dir = await cwd();
  const index = applyPlan(emptyIndex(dir, MODEL), planIndex([{ file: 'a.ts', text: 'x' }], emptyIndex(dir, MODEL), MODEL),
    [{ file: 'a.ts', text: 'x', model: MODEL, vectors: [[1, 0]] }], MODEL, dir);
  const written = await writeIndex(dir, index);
  assert.ok(written.endsWith('code-index.json'));
  const read = await readIndex(dir, dir, MODEL);
  assert.deepEqual(Object.keys(read.files), ['a.ts']);
  assert.deepEqual(indexStats(read), { files: 1, chunks: 1 });
});

test('a missing index reads as empty', async () => {
  const dir = await cwd();
  const read = await readIndex(dir, dir, MODEL);
  assert.deepEqual(read.files, {});
});

test('a corrupt index reads as empty rather than throwing', async () => {
  // It is a cache; losing it costs one rebuild.
  const dir = await cwd();
  await fs.mkdir(path.join(dir, '.0kay-agent'), { recursive: true });
  await fs.writeFile(path.join(dir, '.0kay-agent', 'code-index.json'), '{not json', 'utf8');
  assert.deepEqual((await readIndex(dir, dir, MODEL)).files, {});
});

test('an index written by a different model reads as empty', async () => {
  const dir = await cwd();
  await writeIndex(dir, emptyIndex(dir, 'embed-old'));
  assert.deepEqual((await readIndex(dir, dir, 'embed-new')).files, {});
});

test('an index at a different version reads as empty', async () => {
  const dir = await cwd();
  await fs.mkdir(path.join(dir, '.0kay-agent'), { recursive: true });
  await fs.writeFile(path.join(dir, '.0kay-agent', 'code-index.json'), JSON.stringify({ version: 0, model: MODEL, files: { a: {} } }), 'utf8');
  assert.deepEqual((await readIndex(dir, dir, MODEL)).files, {});
});

test('the content hash is stable and content-sensitive', () => {
  assert.equal(hashContent('abc'), hashContent('abc'));
  assert.notEqual(hashContent('abc'), hashContent('abd'));
  assert.equal(hashContent(''), hashContent(''));
});

test('an unchanged file survives a rebuild that re-embeds another', () => {
  const stored = applyPlan(emptyIndex('/r', MODEL),
    planIndex([{ file: 'keep.ts', text: 'keep' }, { file: 'change.ts', text: 'before' }], emptyIndex('/r', MODEL), MODEL),
    [
      { file: 'keep.ts', text: 'keep', model: MODEL, vectors: [[1, 0]] },
      { file: 'change.ts', text: 'before', model: MODEL, vectors: [[0, 1]] },
    ], MODEL, '/r');

  const files = [{ file: 'keep.ts', text: 'keep' }, { file: 'change.ts', text: 'after' }];
  const plan = planIndex(files, stored, MODEL);
  assert.deepEqual(plan.toEmbed.map((entry) => entry.file), ['change.ts']);

  const next = applyPlan(stored, plan, [{ file: 'change.ts', text: 'after', model: MODEL, vectors: [[1, 1]] }], MODEL, '/r');
  // The reused file's vectors are carried over untouched, not recomputed.
  assert.deepEqual(next.files['keep.ts'].chunks[0].vector, [1, 0]);
  assert.deepEqual(next.files['change.ts'].chunks[0].vector, [1, 1]);
});