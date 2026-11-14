// Vector search over a codebase, without a vector database.
//
// The question this answers is "where in this repository is the thing I mean",
// which keyword search answers badly: a function called `readable` and one
// called `extractContent` are the same idea and share no words. Embeddings fix
// that, and the usual answer is a vector database — which is a second service to
// run, a second thing to page in, and for a repository of a few thousand files,
// several orders of magnitude more machinery than the arithmetic needs.
//
// So the arithmetic is here: unit-normalise once at index time, then a scan with
// a dot product is a cosine similarity, and a scan over 100k vectors is a few
// milliseconds. Everything is a pure function so it can be tested without a
// model or a network.
//
// Three decisions worth stating:
//
//   - Vectors are normalised on the way in, not on every query. Normalising at
//     query time costs a division per candidate and is how a "fast" scan becomes
//     a slow one.
//   - A dimension mismatch is an error, not a truncation. Two vectors of
//     different widths come from two different models, and comparing them
//     produces a number that means nothing while looking like it means
//     something.
//   - Scores are kept as cosine, which is bounded and comparable across queries.
//     Squashing it into 0-1 with `(1+cos)/2` would make every score look like a
//     probability, and a 0.51 would read as "half relevant" when the truth is
//     "unrelated".

export interface VectorRecord {
  /** Stable id: the chunk's path plus an offset, so a re-index is idempotent. */
  id: string;
  /** File the chunk came from, relative to the root. */
  file: string;
  /** 1-based first line of the chunk in that file. */
  line: number;
  /** The chunk's text, returned to the caller so a hit is readable. */
  text: string;
  /** Unit-length embedding. */
  vector: number[];
}

export interface SearchHit {
  id: string;
  file: string;
  line: number;
  text: string;
  /** Cosine similarity in [-1, 1]. */
  score: number;
}

export class VectorError extends Error {}

/** Unit-normalise a vector. A zero vector keeps its zeros: it has no direction. */
export function normalize(vector: number[]): number[] {
  let sum = 0;
  for (const value of vector) sum += value * value;
  if (sum === 0) return [...vector];
  const length = Math.sqrt(sum);
  return vector.map((value) => value / length);
}

/** Is this a usable embedding: finite numbers, non-empty, not all zero? */
export function isUsableVector(vector: unknown): vector is number[] {
  if (!Array.isArray(vector) || vector.length === 0) return false;
  let nonZero = false;
  for (const value of vector) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return false;
    if (value !== 0) nonZero = true;
  }
  return nonZero;
}

/**
 * Cosine similarity between two unit vectors.
 *
 * Assumes both are normalised; the index does that once so this stays a loop of
 * multiplications. A dimension mismatch throws rather than returning a wrong
 * number.
 */
export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new VectorError(`cannot compare a ${a.length}-dimension vector with a ${b.length}-dimension one: they come from different models`);
  }
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i];
  // Floating point can land a hair outside the domain; clamp so callers can
  // trust the stated bound.
  return Math.max(-1, Math.min(1, dot));
}

/** Chunk a file into overlapping windows, because a hit should be quotable. */
export function chunkText(text: string, options: { maxChars?: number; overlapLines?: number } = {}): Array<{ line: number; text: string }> {
  const maxChars = Math.max(200, options.maxChars ?? 1200);
  const overlap = Math.max(0, options.overlapLines ?? 2);
  const lines = String(text).split('\n');
  const chunks: Array<{ line: number; text: string }> = [];

  let start = 0;
  while (start < lines.length) {
    let chars = 0;
    let end = start;
    while (end < lines.length && chars + lines[end].length + 1 <= maxChars) {
      chars += lines[end].length + 1;
      end += 1;
    }
    // A single line longer than the budget is still one chunk: splitting mid-line
    // would break the code the hit is about.
    if (end === start) end = start + 1;
    chunks.push({ line: start + 1, text: lines.slice(start, end).join('\n') });
    if (end >= lines.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return chunks;
}

export class VectorIndex {
  private records: VectorRecord[] = [];
  private dimensions = 0;

  /** Replace the whole index. Re-indexing a file is a rebuild, not a merge. */
  load(records: VectorRecord[]): void {
    const dimensions = records.length ? records[0].vector.length : 0;
    for (const record of records) {
      if (!isUsableVector(record.vector)) throw new VectorError(`record ${record.id} has an unusable vector`);
      if (record.vector.length !== dimensions) {
        throw new VectorError(`record ${record.id} has ${record.vector.length} dimensions, the index has ${dimensions}`);
      }
    }
    this.records = records.map((record) => ({ ...record, vector: normalize(record.vector) }));
    this.dimensions = dimensions;
  }

  size(): number {
    return this.records.length;
  }

  /** The width of this index, so a caller can refuse a mismatched query early. */
  width(): number {
    return this.dimensions;
  }

  /**
   * The best `limit` chunks for a query vector.
   *
   * The scan is linear. For a repository-sized index that is the right shape —
   * an ANN structure would add build time, memory and a recall curve to tune, to
   * save milliseconds nobody notices.
   */
  search(query: number[], limit = 8): SearchHit[] {
    if (!this.records.length) return [];
    if (!isUsableVector(query)) throw new VectorError('the query vector is empty or not finite');
    if (query.length !== this.dimensions) {
      throw new VectorError(`the query has ${query.length} dimensions, the index has ${this.dimensions}: it was built by a different model`);
    }
    const unit = normalize(query);
    const scored: SearchHit[] = this.records.map((record) => ({
      id: record.id,
      file: record.file,
      line: record.line,
      text: record.text,
      score: cosine(unit, record.vector),
    }));
    scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return scored.slice(0, Math.max(1, Math.min(50, limit)));
  }
}

/**
 * Keep one chunk per file in the top results.
 *
 * A single large file can otherwise take every slot, and the caller learns one
 * thing about one file instead of one thing about five. Applied after scoring,
 * so the ranking is still the ranking.
 */
export function diversify(hits: SearchHit[], perFile = 2, limit = hits.length): SearchHit[] {
  const counts = new Map<string, number>();
  const kept: SearchHit[] = [];
  for (const hit of hits) {
    const seen = counts.get(hit.file) || 0;
    if (seen >= perFile) continue;
    counts.set(hit.file, seen + 1);
    kept.push(hit);
    if (kept.length >= limit) break;
  }
  return kept;
}