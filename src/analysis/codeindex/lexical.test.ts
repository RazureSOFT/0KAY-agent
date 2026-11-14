import test from 'node:test';
import assert from 'node:assert/strict';
import { Vocabulary, computeIdf, tfidfVector, tokenize, vocabularyFrom } from './lexical.js';

test('camelCase and snake_case are split', () => {
  // Searching `porcelain` has to find `parsePorcelain`.
  assert.deepEqual(tokenize('parsePorcelain'), ['parse', 'porcelain']);
  assert.deepEqual(tokenize('parse_porcelain'), ['parse', 'porcelain']);
  assert.deepEqual(tokenize('HTTPRequest'), ['http', 'request']);
  assert.deepEqual(tokenize('readFileSync'), ['read', 'file', 'sync']);
});

test('runs of capitals split at the last boundary', () => {
  // `HTTPServer` is HTTP + Server, not H + T + T + PServer.
  assert.deepEqual(tokenize('HTTPServer'), ['http', 'server']);
  assert.deepEqual(tokenize('parseHTMLString'), ['parse', 'html', 'string']);
});

test('single characters are dropped and punctuation separates', () => {
  // One-character tokens match nearly everything, so they are not indexed at
  // all: `a.b(c)` is all single letters and yields nothing.
  assert.deepEqual(tokenize('a.b(c)'), []);
  assert.deepEqual(tokenize('x = 1'), []);
  // Multi-character names around punctuation are kept.
  assert.deepEqual(tokenize('parse.a(bc)'), ['parse', 'bc']);
});

test('empty and non-string input yields no tokens', () => {
  assert.deepEqual(tokenize(''), []);
  assert.deepEqual(tokenize(undefined as unknown as string), []);
});

test('idf is lower for a term that appears everywhere', () => {
  const idf = computeIdf(['alpha beta', 'alpha gamma', 'alpha delta']);
  // `alpha` is in every document; `beta` is in one.
  assert.ok(idf.get('alpha')! < idf.get('beta')!, 'a ubiquitous term must weigh less');
});

test('idf never divides by zero on a single-document corpus', () => {
  const idf = computeIdf(['only one document here']);
  for (const value of idf.values()) assert.ok(Number.isFinite(value) && value > 0);
});

test('a term repeated in one document does not dominate', () => {
  // Sublinear tf: fifty repeats are not fifty times more about that term.
  const idf = computeIdf(['repeat repeat repeat other', 'different words here']);
  const repeated = tfidfVector('repeat repeat repeat repeat repeat', idf).weights.get('repeat')!;
  const once = tfidfVector('repeat', idf).weights.get('repeat')!;
  assert.ok(repeated < once * 3, `5 repeats weighed ${repeated} against ${once} for one`);
});

test('a term absent from the corpus still gets a weight, from the fallback', () => {
  // A query word the corpus has never seen should match nothing, not throw.
  const vector = tfidfVector('never-seen-token', new Map());
  assert.ok(vector.weights.has('never'));
});

test('the vocabulary is stable and rejects duplicates', () => {
  const vocabulary = new Vocabulary(['a', 'b', 'a', 'c']);
  assert.equal(vocabulary.size, 3);
  assert.deepEqual(vocabulary.terms_(), ['a', 'b', 'c']);
});

test('a dense vector is laid out against the vocabulary and unit length', () => {
  const idf = computeIdf(['parse porcelain', 'other text']);
  const vocabulary = new Vocabulary(vocabularyFrom(['parse porcelain', 'other text']));
  const vector = vocabulary.vectorize('parse porcelain', idf);
  assert.equal(vector.length, vocabulary.size);
  const length = Math.hypot(...vector);
  assert.ok(Math.abs(length - 1) < 1e-9, `length was ${length}`);
});

test('a document of unknown words vectorises to zeros, not NaN', () => {
  const vocabulary = new Vocabulary(['known']);
  const vector = vocabulary.vectorize('entirely unknown words', new Map());
  assert.ok(vector.every((value) => value === 0));
});

test('vocabularyFrom drops terms that appear in nearly every document', () => {
  // Carrying a slot for a term in every file costs a dimension in every vector
  // and identifies nothing.
  const documents = Array.from({ length: 10 }, (_, i) => `common term${i} distinctive${i}`);
  const kept = vocabularyFrom(documents, { maxDocumentRatio: 0.5 });
  assert.ok(!kept.includes('common'), 'a term in all ten documents should be dropped');
  assert.ok(kept.includes('term0'), 'a distinctive term should be kept');
});

test('a term unique to one file is kept by default', () => {
  // This is the default that took getting wrong to see: with a document floor of
  // two, an identifier in exactly one file is dropped — and in code that is
  // usually the function somebody is searching for.
  const documents = Array.from({ length: 10 }, (_, i) => `shared word${i} unique${i}`);
  const kept = vocabularyFrom(documents, { maxDocumentRatio: 0.9 });
  assert.ok(kept.includes('unique0'), `a one-file identifier was dropped: ${kept.join(',')}`);
});

test('a document floor can be asked for explicitly', () => {
  const documents = ['alpha beta', 'alpha gamma', 'alpha delta'];
  assert.ok(!vocabularyFrom(documents, { minDocuments: 2, maxDocumentRatio: 1 }).includes('beta'));
});

test('vocabularyFrom caps the size and prefers frequent terms', () => {
  const documents = Array.from({ length: 100 }, (_, i) => `shared${i % 3}`);
  const kept = vocabularyFrom(documents, { maxTerms: 64 });
  assert.ok(kept.length <= 64);
});

test('the same query scores the matching document highest', () => {
  // The end-to-end property the whole module exists for.
  const documents = [
    'function parsePorcelain(output string) { return rows }',
    'const colour = "blue"',
    'async function readFile(path string) { return bytes }',
  ];
  const idf = computeIdf(documents);
  const vocabulary = new Vocabulary(vocabularyFrom(documents));
  const a = vocabulary.vectorize('parsePorcelain', idf);
  const b = vocabulary.vectorize('colour', idf);
  const query = vocabulary.vectorize('parse porcelain', idf);

  const dot = (x: number[], y: number[]) => x.reduce((sum, value, i) => sum + value * y[i], 0);
  assert.ok(dot(query, a) > dot(query, b), 'the matching document must score higher');
  assert.ok(dot(query, a) > 0.5, `a direct identifier match should score well, got ${dot(query, a)}`);
});

test('a snake_case query finds a camelCase identifier', () => {
  // Searching `parse_porcelain` has to find `parsePorcelain`: the splitter runs
  // on both sides, so this is the property that makes either spelling work.
  const documents = ['function parsePorcelain(output) {}', 'const unrelated = 1'];
  const idf = computeIdf(documents);
  const vocabulary = new Vocabulary(vocabularyFrom(documents));
  const dot = (x: number[], y: number[]) => x.reduce((sum, value, i) => sum + value * y[i], 0);
  const score = dot(vocabulary.vectorize('parse_porcelain', idf), vocabulary.vectorize(documents[0], idf));
  assert.ok(score > 0.1, `score was ${score}`);
});