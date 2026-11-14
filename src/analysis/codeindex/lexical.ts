// Lexical vectors: TF-IDF over the corpus itself, built from the code.
//
// The plan asked for embedding-based code search, and the honest finding is that
// this system has no embedding model: mocr has no embeddings endpoint, the
// provider layer has no embeddings call, and `KindEmbedding` in the provider
// store is a label with nothing behind it. Embeddings would mean adding a model
// to run, and a retrieval feature that only works once somebody configures an
// extra service is a retrieval feature nobody uses.
//
// So this builds the vectors from the corpus, which is a real vector-space
// retrieval — same cosine, same index, same ranking — with the weights learned
// from the code instead of from a model. For code in particular that is not a
// downgrade: identifiers are exact words, and `parsePorcelain` should match
// `parsePorcelain` rather than whatever is distributionally near it. What it
// gives up is synonymy — a search for "extract text" will not find
// `readable()` — and that is the trade being made, stated rather than hidden.
//
// The rest of the design exists to make TF-IDF behave on a codebase:
//
//   - Identifiers are split on case and underscore, so `parsePorcelain` is also
//     indexed as `parse` and `porcelain`. Searching either finds the function.
//   - Very common tokens are not stopped by a hand-written list. A stop list for
//     English is wrong for code (`if`, `for`, `in` are tokens but `const` and
//     `return` are noise while `map` is not), so IDF does the work: a term in
//     every file carries no information and the weight falls out of the maths.
//   - Sublinear term frequency (1 + log(tf)) stops one token repeated fifty times
//     in a generated file from dominating its own chunk.

/** A test file, by the conventions every project here uses. */
export function isTestPath(file: string): boolean {
  const base = file.split('/').pop() || file;
  return /\.(test|spec)\.[^.]+$/.test(base)
    || /(^|\/)(test|tests|__tests__|spec|specs)\//.test(file)
    || /^test_/.test(base)
    || /_test\.[^.]+$/.test(base);
}

/**
 * Weight applied to a file's contribution to the corpus.
 *
 * A test file names every identifier in the implementation it exercises, often
 * more densely than the implementation does — so without this, a search for a
 * function finds the test that calls it before the function itself, on every
 * query. That is a real failure mode, seen on this repository: `parse porcelain`
 * ranked a test file above the code it tests.
 *
 * Down-weighted rather than excluded, because a test is often the only place
 * that says how something is meant to be used, and dropping it would lose the
 * answer to "how do I call this".
 */
export function pathWeight(file: string): number {
  return isTestPath(file) ? 0.5 : 1;
}

export interface LexicalVector {
  /** Term to weight. Kept sparse: a code chunk uses a small fraction of terms. */
  weights: Map<string, number>;
  /** Vector length before normalisation, kept so callers can normalise once. */
  magnitude: number;
}

/** Split an identifier or a line into searchable tokens. */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  // Split camelCase and snake_case, then keep alphanumerics. A single pass with
  // a replace would lose the boundary information.
  const parts = String(text || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9_]+/);
  for (const part of parts) {
    for (const piece of part.split('_')) {
      const token = piece.toLowerCase();
      // One character matches nearly everything; keep two and up.
      if (token.length >= 2) tokens.push(token);
    }
  }
  return tokens;
}

/**
 * Inverse document frequency for every term in the corpus.
 *
 * Smoothed, so a term appearing in every document has weight near zero rather
 * than dividing by zero.
 */
export function computeIdf(documents: string[]): Map<string, number> {
  const total = Math.max(1, documents.length);
  const seen = new Map<string, number>();
  for (const document of documents) {
    // A term counts once per document however often it appears; that is the
    // whole point of IDF.
    for (const token of new Set(tokenize(document))) {
      seen.set(token, (seen.get(token) || 0) + 1);
    }
  }
  const idf = new Map<string, number>();
  for (const [token, count] of seen) {
    idf.set(token, Math.log((total + 1) / (count + 1)) + 1);
  }
  return idf;
}

/** A sparse TF-IDF vector for one document, given the corpus's IDF. */
export function tfidfVector(text: string, idf: Map<string, number>): LexicalVector {
  const counts = new Map<string, number>();
  for (const token of tokenize(text)) counts.set(token, (counts.get(token) || 0) + 1);

  const weights = new Map<string, number>();
  let sumSquares = 0;
  for (const [token, count] of counts) {
    // Sublinear tf: a token repeated fifty times in one chunk is not fifty times
    // more about that token.
    const tf = 1 + Math.log(count);
    const weight = tf * (idf.get(token) ?? 1);
    weights.set(token, weight);
    sumSquares += weight * weight;
  }
  return { weights, magnitude: Math.sqrt(sumSquares) };
}

/**
 * Turn sparse lexical vectors into the dense arrays the shared index compares.
 *
 * The index needs same-width vectors, so the vocabulary is fixed once per index
 * build and every vector is laid out against it. Terms outside the vocabulary
 * are dropped: that is a new word in a query, and a word the corpus has never
 * seen cannot identify anything in it.
 */
export class Vocabulary {
  private readonly terms: string[] = [];
  private readonly index = new Map<string, number>();

  constructor(terms: Iterable<string>) {
    for (const term of terms) {
      if (this.index.has(term)) continue;
      this.index.set(term, this.terms.length);
      this.terms.push(term);
    }
  }

  get size(): number {
    return this.terms.length;
  }

  /** The dense vector for one document, normalised to unit length. */
  vectorize(text: string, idf: Map<string, number>): number[] {
    const dense = new Array(this.terms.length).fill(0);
    const { weights, magnitude } = tfidfVector(text, idf);
    if (magnitude === 0) return dense;
    for (const [token, weight] of weights) {
      const position = this.index.get(token);
      if (position === undefined) continue;
      dense[position] = weight / magnitude;
    }
    return dense;
  }

  /** Kept for diagnostics and for a stable order across rebuilds. */
  terms_(): string[] {
    return [...this.terms];
  }
}

/**
 * Cap the vocabulary by document frequency.
 *
 * A term that appears in almost every document carries nearly no information but
 * costs a slot in every vector, so the upper cap is what matters and is on by
 * default.
 *
 * The lower floor defaults to OFF, which took getting wrong to see: with a floor
 * of two, a corpus of ten files loses every identifier unique to one file — and
 * in code, a term that appears in exactly one file is usually the function
 * somebody is searching for. The floor exists for a caller who knows their
 * corpus is full of one-off literals; it is not a sensible default.
 */
export function vocabularyFrom(documents: string[], options: { maxTerms?: number; minDocuments?: number; maxDocumentRatio?: number } = {}): string[] {
  const maxTerms = Math.max(64, options.maxTerms ?? 20_000);
  const minDocuments = Math.max(1, options.minDocuments ?? 1);
  const maxRatio = Math.min(1, Math.max(0.1, options.maxDocumentRatio ?? 0.6));

  const frequency = new Map<string, number>();
  for (const document of documents) {
    for (const token of new Set(tokenize(document))) {
      frequency.set(token, (frequency.get(token) || 0) + 1);
    }
  }

  const total = Math.max(1, documents.length);
  const kept = [...frequency.entries()]
    .filter(([, count]) => count >= minDocuments)
    .filter(([, count]) => count / total <= maxRatio)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, maxTerms)
    .map(([term]) => term);

  return kept;
}