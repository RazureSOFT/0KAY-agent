// Code search: find the place in this repository that does the thing.
//
// The tool surface is two actions. `index` builds or refreshes; `search` asks.
// Searching without an index builds one first, because a search tool that
// answers "not indexed yet" is a tool the model tries once and never again.
//
// Retrieval is TF-IDF over the corpus rather than embeddings, and the reason is
// in lexical.ts: this system has no embedding model, and a feature that only
// works after somebody configures another service is a feature nobody uses. What
// that costs is stated there too — no synonymy — and what it buys is that
// `parsePorcelain` matches `parsePorcelain`, which for code is most of what
// anyone wants.
//
// The index is stored under `.0kay-agent/` with a hash per file, so re-indexing
// after an edit pays only for the files that changed.

import { Tool, type ToolContext, type ToolResult } from './types.js';
import { success, failure } from './helpers.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { VectorIndex, VectorError, chunkText, diversify, type VectorRecord } from '../analysis/codeindex/vectors.js';
import { Vocabulary, computeIdf, pathWeight, vocabularyFrom, tokenize } from '../analysis/codeindex/lexical.js';
import { hashContent, indexStats, planIndex, readIndex, writeIndex, type StoredIndex } from '../analysis/codeindex/store.js';
import { ownership, isRepository as isRepo } from '../analysis/arch/repo_identity.js';

/** The model name the index is keyed by. Lexical indexing is model-free, and
 * this constant is what makes a change to the tokenizer invalidate the cache. */
const INDEXER = 'lexical-tfidf-1';

const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', 'target', '.next', '.nuxt',
  'vendor', '__pycache__', '.venv', 'venv', '.tox', 'coverage', '.cache', '.turbo',
]);

const LANGUAGES = new Set([
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte',
  '.go', '.py', '.rs', '.java', '.kt', '.c', '.h', '.cc', '.cpp', '.hpp', '.cs',
  '.rb', '.php', '.swift', '.sh', '.sql', '.md', '.yaml', '.yml', '.toml', '.json',
]);

const MAX_FILES = 5_000;
const MAX_FILE_BYTES = 300_000;

interface CollectedFile {
  file: string;
  text: string;
}

/**
 * Collect the files worth indexing.
 *
 * Skips the same directories the architecture extractor skips, and for the same
 * reason: a reference clone next to the source would fill the index with code
 * that is not part of the project and then rank it against the project's own.
 */
async function collectFiles(root: string, options: { maxFiles?: number } = {}): Promise<CollectedFile[]> {
  const maxFiles = Math.max(1, options.maxFiles ?? MAX_FILES);
  const out: CollectedFile[] = [];
  const ignored = await loadIgnored(root);

  const walk = async (dir: string, rel: string, rules: Set<string>, projectRoot: string): Promise<void> => {
    if (out.length >= maxFiles) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) return;
      const abs = path.join(dir, entry.name);
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        if (isIgnoredPath(next, rules)) {
          // A module of the project's own can be excluded from the parent's
          // listing for release reasons; somebody else's clone cannot come in.
          const ours = (await isRepo(abs)) ? await ownership(abs, projectRoot) : 'unknown';
          if (ours !== 'ours') continue;
          await walk(abs, next, await loadIgnored(abs), abs);
          continue;
        }
        await walk(abs, next, rules, projectRoot);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!LANGUAGES.has(path.extname(entry.name).toLowerCase())) continue;
      const stat = await fs.stat(abs).catch(() => undefined);
      if (!stat || stat.size > MAX_FILE_BYTES) continue;
      const text = await fs.readFile(abs, 'utf8').catch(() => '');
      if (!text) continue;
      out.push({ file: next, text });
    }
  };

  await walk(path.resolve(root), '', ignored, path.resolve(root));
  return out;
}

async function loadIgnored(root: string): Promise<Set<string>> {
  const patterns = new Set<string>();
  const text = await fs.readFile(path.join(root, '.gitignore'), 'utf8').catch(() => '');
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    if (line.includes('*') || line.includes('?') || line.includes('[')) continue;
    const dir = line.replace(/^\/+/, '').replace(/\/+$/, '');
    if (!dir) continue;
    patterns.add(dir.includes('/') ? dir : `**/${dir}`);
  }
  return patterns;
}

function isIgnoredPath(rel: string, patterns: Set<string>): boolean {
  if (patterns.has(rel)) return true;
  for (const pattern of patterns) {
    if (!pattern.startsWith('**/')) continue;
    const name = pattern.slice(3);
    if (rel === name || rel.endsWith(`/${name}`)) return true;
  }
  return false;
}

/** Build the index from scratch for the given files. */
export function buildIndex(root: string, files: CollectedFile[], maxChunkChars?: number): { index: StoredIndex; vocabulary: Vocabulary; idf: Map<string, number> } {
  // Chunks are the unit that gets a vector and the unit a hit returns, so the
  // vocabulary is built over chunks rather than whole files: a term appearing in
  // one file's fortieth chunk is not a term appearing "everywhere".
  const perFile = new Map<string, Array<{ line: number; text: string }>>();
  const documents: string[] = [];
  for (const entry of files) {
    const chunks = chunkText(entry.text, { maxChars: maxChunkChars });
    perFile.set(entry.file, chunks);
    for (const chunk of chunks) documents.push(chunk.text);
  }

  const idf = computeIdf(documents);
  const vocabulary = new Vocabulary(vocabularyFrom(documents));

  const stored: StoredIndex = {
    version: 1,
    root,
    model: INDEXER,
    updatedAt: Date.now(),
    files: {},
  };
  for (const entry of files) {
    const chunks = perFile.get(entry.file) || [];
    stored.files[entry.file] = {
      hash: hashContent(entry.text),
      model: INDEXER,
      chunks: chunks.map((chunk) => ({ line: chunk.line, text: chunk.text, vector: vocabulary.vectorize(chunk.text, idf) })),
    };
  }
  return { index: stored, vocabulary, idf };
}

/** Rebuild the sparse vectors from a stored index, against a fresh vocabulary. */
export function vocabularyFromIndex(index: StoredIndex): { vocabulary: Vocabulary; idf: Map<string, number> } {
  const documents: string[] = [];
  for (const entry of Object.values(index.files)) {
    for (const chunk of entry.chunks) documents.push(chunk.text);
  }
  const idf = computeIdf(documents);
  return { vocabulary: new Vocabulary(vocabularyFrom(documents)), idf };
}

export class CodeSearchTool extends Tool {
  get name(): string {
    return 'code_search';
  }

  get description(): string {
    return 'Find where in this repository something is done, by meaning rather than by exact text: "where do we normalise a vector", "what handles a porcelain status". Returns the file, the line and the chunk, ranked. Use this before grep when you know what the code is for but not what it is called. Actions: search (default; builds the index on first use), index (build or refresh without searching), status (what the index covers).';
  }

  get parameters(): Record<string, any> {
    return {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['search', 'index', 'status'], description: 'Default search.' },
        query: { type: 'string', description: 'What to look for, in words. Identifiers work too — they are split on case and underscore.' },
        path: { type: 'string', description: 'Repository root; defaults to the task working directory.' },
        limit: { type: 'integer', minimum: 1, maximum: 30, description: 'Max results; default 8.' },
        perFile: { type: 'integer', minimum: 1, maximum: 10, description: 'Max results from one file; default 2, so one large file does not take every slot.' },
        rebuild: { type: 'boolean', description: 'Force a full re-index, ignoring the cache.' },
      },
    };
  }

  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    try {
      const action = String(args.action || 'search').toLowerCase();
      const root = path.resolve(String(args.path || context.cwd || process.cwd()));
      if (!['search', 'index', 'status'].includes(action)) {
        return failure(`unknown action "${action}"; expected search, index or status`);
      }

      let stored = await readIndex(root, root, INDEXER);
      const cached = indexStats(stored);

      if (action === 'status') {
        return success({
          root,
          indexed: cached.files > 0,
          files: cached.files,
          chunks: cached.chunks,
          updatedAt: stored.updatedAt ? new Date(stored.updatedAt).toISOString() : null,
          note: cached.files === 0 ? 'nothing indexed yet; run action "index" or just search' : undefined,
        });
      }

      // Refresh when asked, when nothing is stored, or when the tree has moved
      // on enough to matter. The check is cheap: reading files and hashing is
      // local, and only changed files are re-vectorised.
      const files = await collectFiles(root);
      const plan = planIndex(files.map((file) => ({ file: file.file, text: file.text })), stored, INDEXER);
      const needWork = Boolean(args.rebuild) || cached.files === 0 || plan.toEmbed.length > 0 || plan.dropped.length > 0;

      if (needWork) {
        const built = buildIndex(root, files);
        stored = built.index;
        await writeIndex(root, stored);
      }

      if (action === 'index') {
        const stats = indexStats(stored);
        return success({
          root,
          files: stats.files,
          chunks: stats.chunks,
          embedded: needWork ? plan.toEmbed.length : 0,
          reused: needWork ? plan.reused : cached.files,
          dropped: plan.dropped.length,
          storage: path.join(root, '.0kay-agent', 'code-index.json'),
        });
      }

      const query = String(args.query || '').trim();
      if (!query) return failure('query is required for search');
      const stats = indexStats(stored);
      if (stats.files === 0) return success({ root, query, count: 0, hits: [], note: 'no source files were found under this root' });

      const { vocabulary, idf } = vocabularyFromIndex(stored);
      const index = new VectorIndex();
      index.load(toRecordsWith(stored, vocabulary, idf));
      if (index.width() === 0) return success({ root, query, count: 0, hits: [] });

      const limit = Math.max(1, Math.min(30, Number(args.limit) || 8));
      const perFile = Math.max(1, Math.min(10, Number(args.perFile) || 2));
      const queryVector = vocabulary.vectorize(query, idf);
      // A query of terms the corpus has never seen vectorises to zeros, and a
      // zero vector has no direction to compare. Saying so beats returning the
      // whole corpus in arbitrary order under the label "results".
      if (queryVector.every((value) => value === 0)) {
        return success({
          root, query, count: 0, hits: [],
          note: `none of the words in "${query}" appear anywhere in this repository`,
          searched: { files: stats.files, chunks: stats.chunks },
        });
      }

      const scored = index.search(queryVector, limit * perFile * 2);
      // Weight applied at ranking time, not at index time: changing how much a
      // test file counts must not require re-embedding the corpus.
      const ranked = scored
        .map((hit) => ({ ...hit, score: hit.score * pathWeight(hit.file) }))
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
      const hits = diversify(ranked, perFile, limit).map((hit) => ({
        file: hit.file,
        line: hit.line,
        score: Number(hit.score.toFixed(4)),
        text: hit.text.length > 1200 ? `${hit.text.slice(0, 1200)}\n[truncated]` : hit.text,
      }));
      return success({
        root,
        query,
        count: hits.length,
        hits,
        searched: { files: stats.files, chunks: stats.chunks, terms: vocabulary.size },
        ...(hits.length === 0 ? { note: 'the index was searched but nothing scored; try different words' } : {}),
      });
    } catch (error) {
      if (error instanceof VectorError) return failure(`the index is not usable: ${error.message}`);
      return failure(error);
    }
  }
}

/** Dense vectors, rebuilt from the stored text and the current vocabulary. */
function toRecordsWith(index: StoredIndex, vocabulary: Vocabulary, idf: Map<string, number>): VectorRecord[] {
  const records: VectorRecord[] = [];
  for (const [file, entry] of Object.entries(index.files)) {
    for (const chunk of entry.chunks) {
      const vector = vocabulary.vectorize(chunk.text, idf);
      // A chunk of nothing but stop-words has no direction; indexing it would
      // add a zero vector that matches nothing but costs a slot in every scan.
      if (vector.every((value) => value === 0)) continue;
      records.push({ id: `${file}:${chunk.line}`, file, line: chunk.line, text: chunk.text, vector });
    }
  }
  return records;
}

/** Exported for the tool's own tests: the tokenizer is what a caller's query runs through. */
export { tokenize };