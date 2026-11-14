// The index on disk, and the reason re-indexing is cheap.
//
// Embedding a repository is a model call per chunk, so the expensive part is the
// embedding and the cheap part is everything else. Storing the vectors next to a
// content hash per file means a second index run only pays for files whose
// contents actually changed — which is usually a handful, and is the difference
// between "run it after every edit" and "run it once and hope".
//
// The file lives under the same `.0kay-agent/` directory the workspace already
// owns. A corrupt or version-mismatched store reads as empty rather than
// throwing: the index is a cache, and losing it costs one rebuild.

import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';
import { AGENT_DIR } from '../../agent/agent_workspace.js';
import { chunkText, type VectorRecord } from './vectors.js';

export const INDEX_FILE = 'code-index.json';

/** Bumped when the record shape changes, so an old file is ignored not misread. */
export const INDEX_VERSION = 1;

export interface StoredChunk {
  line: number;
  text: string;
  vector: number[];
}

export interface StoredFile {
  /** Hash of the file's contents, so an unchanged file costs nothing. */
  hash: string;
  /** The model that produced the vectors, so a model change forces a reindex. */
  model: string;
  chunks: StoredChunk[];
}

export interface StoredIndex {
  version: number;
  /** Root the index describes, so a moved index is detectable. */
  root: string;
  model: string;
  files: Record<string, StoredFile>;
  updatedAt: number;
}

export function hashContent(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32);
}

export function emptyIndex(root: string, model: string): StoredIndex {
  return { version: INDEX_VERSION, root, model, files: {}, updatedAt: Date.now() };
}

function indexPath(cwd: string): string {
  return path.join(cwd, AGENT_DIR, INDEX_FILE);
}

/**
 * Read the stored index.
 *
 * Returns an empty index when there is none, when the version moved, when the
 * model changed, or when the file is not readable as an index. In every one of
 * those cases the right answer is the same — re-index — and the caller does not
 * need to tell them apart.
 */
export async function readIndex(cwd: string, root: string, model: string): Promise<StoredIndex> {
  try {
    const raw = await fs.readFile(indexPath(cwd), 'utf8');
    const parsed = JSON.parse(raw) as StoredIndex;
    if (!parsed || parsed.version !== INDEX_VERSION) return emptyIndex(root, model);
    if (parsed.model !== model) return emptyIndex(root, model);
    if (!parsed.files || typeof parsed.files !== 'object') return emptyIndex(root, model);
    return parsed;
  } catch {
    return emptyIndex(root, model);
  }
}

export async function writeIndex(cwd: string, index: StoredIndex): Promise<string> {
  const dir = path.join(cwd, AGENT_DIR);
  await fs.mkdir(dir, { recursive: true });
  const file = indexPath(cwd);
  await fs.writeFile(file, `${JSON.stringify({ ...index, updatedAt: Date.now() })}\n`, 'utf8');
  return file;
}

export interface IndexPlan {
  /** Files whose contents changed or that are new; these need embedding. */
  toEmbed: Array<{ file: string; text: string }>;
  /** File contents already covered by the stored index. */
  reused: number;
  /** Files in the store that no longer exist. */
  dropped: string[];
}

/**
 * Decide what actually needs embedding.
 *
 * Separated from the indexing itself because it is the part that must be right:
 * a plan that re-embeds everything makes the cache pointless, and one that skips
 * a changed file serves stale vectors that look like fresh ones.
 */
export function planIndex(
  files: Array<{ file: string; text: string }>,
  stored: StoredIndex,
  model: string,
): IndexPlan {
  const seen = new Set<string>();
  const toEmbed: Array<{ file: string; text: string }> = [];
  let reused = 0;

  for (const entry of files) {
    seen.add(entry.file);
    const previous = stored.files[entry.file];
    if (previous && previous.hash === hashContent(entry.text) && previous.model === model) {
      reused += 1;
      continue;
    }
    toEmbed.push(entry);
  }

  const dropped = Object.keys(stored.files).filter((file) => !seen.has(file));
  return { toEmbed, reused, dropped };
}

/**
 * Fold freshly embedded files into the index.
 *
 * Deletion and reuse are handled here rather than by the caller so that the
 * three outcomes cannot drift apart: an index that forgot to drop a deleted file
 * keeps answering with code that is not there.
 */
export function applyPlan(
  stored: StoredIndex,
  plan: IndexPlan,
  embedded: Array<{ file: string; text: string; model: string; vectors: number[][] }>,
  model: string,
  root: string,
  options: { maxChunkChars?: number } = {},
): StoredIndex {
  const files: Record<string, StoredFile> = {};

  // Unchanged files carry over verbatim.
  for (const [file, entry] of Object.entries(stored.files)) {
    if (plan.toEmbed.some((pending) => pending.file === file)) continue;
    if (plan.dropped.includes(file)) continue;
    files[file] = entry;
  }

  for (const entry of embedded) {
    const chunks = chunkText(entry.text, { maxChars: options.maxChunkChars });
    // If the embedding count disagrees with the chunk count, the vectors cannot
    // be attributed to lines; keeping them would put a hit on the wrong line.
    if (chunks.length !== entry.vectors.length) continue;
    files[entry.file] = {
      hash: hashContent(entry.text),
      model: entry.model,
      chunks: chunks.map((chunk, index) => ({ line: chunk.line, text: chunk.text, vector: entry.vectors[index] })),
    };
  }

  return { version: INDEX_VERSION, root, model, files, updatedAt: Date.now() };
}

/** Flatten the store into the records the search index wants. */
export function toRecords(index: StoredIndex): VectorRecord[] {
  const records: VectorRecord[] = [];
  for (const [file, entry] of Object.entries(index.files)) {
    for (const chunk of entry.chunks) {
      records.push({
        id: `${file}:${chunk.line}`,
        file,
        line: chunk.line,
        text: chunk.text,
        vector: chunk.vector,
      });
    }
  }
  return records;
}

export function indexStats(index: StoredIndex): { files: number; chunks: number } {
  let chunks = 0;
  for (const entry of Object.values(index.files)) chunks += entry.chunks.length;
  return { files: Object.keys(index.files).length, chunks };
}