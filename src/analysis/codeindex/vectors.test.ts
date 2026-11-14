import test from 'node:test';
import assert from 'node:assert/strict';
import { VectorError, VectorIndex, chunkText, cosine, diversify, isUsableVector, normalize } from './vectors.js';

test('normalize gives a unit vector', () => {
  const unit = normalize([3, 4]);
  assert.equal(Math.hypot(unit[0], unit[1]).toFixed(6), '1.000000');
  assert.deepEqual(unit, [0.6, 0.8]);
});

test('a zero vector keeps its zeros instead of becoming NaN', () => {
  // It has no direction; dividing by its length would produce NaN for every
  // component and poison whatever compared against it.
  assert.deepEqual(normalize([0, 0, 0]), [0, 0, 0]);
});

test('isUsableVector rejects what cannot be embedded', () => {
  assert.equal(isUsableVector([1, 2]), true);
  assert.equal(isUsableVector([]), false);
  assert.equal(isUsableVector(undefined), false);
  assert.equal(isUsableVector([1, NaN]), false);
  assert.equal(isUsableVector([1, Infinity]), false);
  assert.equal(isUsableVector([1, '2']), false);
  assert.equal(isUsableVector([0, 0]), false, 'an all-zero vector carries no direction');
});

test('cosine is 1 for the same direction and 0 for orthogonal', () => {
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.equal(cosine([1, 0], [-1, 0]), -1);
});

test('cosine refuses to compare different widths', () => {
  // Two widths mean two models, and a number computed across them means nothing
  // while looking like it means something.
  assert.throws(() => cosine([1, 0], [1, 0, 0]), VectorError);
  assert.throws(() => cosine([1, 0], [1, 0, 0]), /different models/);
});

test('cosine stays inside its stated bounds', () => {
  // Floating point can land a hair outside; callers are told the bounds hold.
  const noisy = [0.5773502691, 0.5773502693, 0.5773502691];
  const score = cosine(noisy, noisy);
  assert.ok(score <= 1 && score >= -1, `${score} is outside [-1, 1]`);
});

test('chunkText splits a long file into overlapping windows', () => {
  const text = Array.from({ length: 40 }, (_, i) => `line ${i + 1} of the file`).join('\n');
  const chunks = chunkText(text, { maxChars: 200, overlapLines: 2 });
  assert.ok(chunks.length > 1, 'a 40-line file should not be one chunk at 200 chars');
  // The first chunk starts at line 1 and the offsets are 1-based.
  assert.equal(chunks[0].line, 1);
  // Overlap: the second chunk restarts before the first one ended, so a hit
  // spanning the boundary is quotable from one chunk.
  const firstEnd = chunks[0].text.split('\n').length;
  assert.ok(chunks[1].line <= firstEnd, `chunk 2 starts at ${chunks[1].line}, chunk 1 ended at ${firstEnd}`);
});

test('chunkText keeps a very long single line whole', () => {
  // Splitting mid-line would break the code the hit is about.
  const long = 'x'.repeat(5000);
  const chunks = chunkText(long, { maxChars: 400 });
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].text.length, 5000);
});

test('chunkText of empty text yields nothing to index', () => {
  assert.deepEqual(chunkText(''), [{ line: 1, text: '' }]);
});

test('the index finds the nearest vector', () => {
  const index = new VectorIndex();
  index.load([
    { id: 'a:1', file: 'a.ts', line: 1, text: 'alpha', vector: [1, 0, 0] },
    { id: 'b:1', file: 'b.ts', line: 1, text: 'beta', vector: [0, 1, 0] },
    { id: 'c:1', file: 'c.ts', line: 1, text: 'gamma', vector: [0.9, 0.1, 0] },
  ]);
  const hits = index.search([1, 0, 0], 2);
  assert.equal(hits.length, 2);
  assert.equal(hits[0].id, 'a:1');
  assert.equal(hits[1].id, 'c:1');
  assert.ok(hits[0].score > hits[1].score);
});

test('the index normalises on load, so a scaled vector ranks the same', () => {
  // Without this a long vector would outrank a short one purely by magnitude.
  const index = new VectorIndex();
  index.load([
    { id: 'small', file: 'a', line: 1, text: '', vector: [1, 0] },
    { id: 'large', file: 'b', line: 1, text: '', vector: [100, 0] },
  ]);
  const hits = index.search([1, 0], 2);
  assert.equal(hits[0].score, hits[1].score, 'direction is what counts, not length');
});

test('the query is normalised too', () => {
  const index = new VectorIndex();
  index.load([{ id: 'a', file: 'a', line: 1, text: '', vector: [1, 0] }]);
  assert.equal(index.search([50, 0], 1)[0].score, 1);
});

test('an empty index returns nothing rather than throwing', () => {
  const index = new VectorIndex();
  index.load([]);
  assert.deepEqual(index.search([1, 0], 5), []);
  assert.equal(index.size(), 0);
});

test('a query of the wrong width is refused with both widths named', () => {
  const index = new VectorIndex();
  index.load([{ id: 'a', file: 'a', line: 1, text: '', vector: [1, 0] }]);
  assert.throws(() => index.search([1, 0, 0], 1), /3 dimensions, the index has 2/);
  assert.equal(index.width(), 2);
});

test('loading a record with a bad vector fails whole, not partly', () => {
  // A half-loaded index would answer queries with a silently incomplete corpus.
  const index = new VectorIndex();
  assert.throws(() => index.load([
    { id: 'ok', file: 'a', line: 1, text: '', vector: [1, 0] },
    { id: 'bad', file: 'b', line: 1, text: '', vector: [1, NaN] },
  ]), VectorError);
  assert.equal(index.size(), 0);
});

test('mismatched widths inside one load are refused', () => {
  const index = new VectorIndex();
  assert.throws(() => index.load([
    { id: 'a', file: 'a', line: 1, text: '', vector: [1, 0] },
    { id: 'b', file: 'b', line: 1, text: '', vector: [1, 0, 0] },
  ]), /3 dimensions, the index has 2/);
});

test('the limit is clamped to something answerable', () => {
  const index = new VectorIndex();
  index.load(Array.from({ length: 60 }, (_, i) => ({ id: `r${i}`, file: `f${i}`, line: 1, text: '', vector: [1, 0] })));
  assert.equal(index.search([1, 0], 999).length, 50);
  assert.equal(index.search([1, 0], 0).length, 1);
});

test('ties break by id, so the same query gives the same order', () => {
  const index = new VectorIndex();
  index.load([
    { id: 'z', file: 'z', line: 1, text: '', vector: [1, 0] },
    { id: 'a', file: 'a', line: 1, text: '', vector: [1, 0] },
  ]);
  assert.deepEqual(index.search([1, 0], 2).map((hit) => hit.id), ['a', 'z']);
});

test('diversify stops one file taking every slot', () => {
  const hits = [
    { id: 'big:1', file: 'big.ts', line: 1, text: '', score: 0.9 },
    { id: 'big:2', file: 'big.ts', line: 50, text: '', score: 0.89 },
    { id: 'big:3', file: 'big.ts', line: 90, text: '', score: 0.88 },
    { id: 'other:1', file: 'other.ts', line: 1, text: '', score: 0.8 },
  ];
  const kept = diversify(hits, 1, 3);
  assert.deepEqual(kept.map((hit) => hit.id), ['big:1', 'other:1']);
});

test('diversify preserves the ranking it was given', () => {
  const hits = [
    { id: 'a:1', file: 'a', line: 1, text: '', score: 0.9 },
    { id: 'b:1', file: 'b', line: 1, text: '', score: 0.8 },
  ];
  assert.deepEqual(diversify(hits, 2, 2).map((hit) => hit.score), [0.9, 0.8]);
});
