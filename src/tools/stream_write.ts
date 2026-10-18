/**
 * Streaming file write: the file at the target path grows in place, chunk by
 * chunk, so an observer (the Agent UI, a file watcher, the user's editor) can
 * watch it being written.
 *
 * This intentionally does the opposite of `writeFileAtomic`: the target is
 * truncated immediately and appended to over time, because the whole point is
 * that external readers see partial content. That means a crash mid-write would
 * destroy the previous file, so the original is read first and restored on
 * failure or abort.
 *
 * The write is paced to look like a person typing, but bounded: a multi-megabyte
 * write must not hold the tool open for minutes, so past `maxStreamedChars` the
 * remaining content is written in a few immediate chunks. Once the animation
 * budget is spent the file is closed and the tool returns — "写完关闭".
 */

import { promises as fs } from 'node:fs';

export interface StreamWriteOptions {
  /** Total wall-clock budget for the visible typing effect. */
  targetMs?: number;
  /** How many chunks the visible portion is split into. */
  steps?: number;
  /** Content beyond this many characters is written without pacing. */
  maxStreamedChars?: number;
  /** Injectable for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface StreamWriteResult {
  /** Total bytes written. */
  bytes: number;
  /** Characters that were written under the pacing budget. */
  pacedChars: number;
  /** Whether pacing was applied at all. */
  paced: boolean;
}

const DEFAULT_TARGET_MS = 2_500;
const DEFAULT_STEPS = 48;
const DEFAULT_MAX_PACED_CHARS = 512 * 1024;
// A chunk smaller than this is not worth a visible step, and forcing one made a
// 20-character file take 1.6s. With 24, anything that fits in one chunk is written
// immediately.
const MIN_CHUNK_CHARS = 24;
// Never sleep longer than this between chunks, whatever the budget maths says.
const MAX_CHUNK_DELAY_MS = 80;

function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(signal!.reason ?? new Error('aborted'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Write `content` to `filePath`, publishing it incrementally.
 *
 * Restores the previous file if the write fails or is aborted.
 */
export async function streamWriteFile(
  filePath: string,
  content: string,
  signal?: AbortSignal,
  options: StreamWriteOptions = {},
): Promise<StreamWriteResult> {
  const targetMs = Math.max(0, options.targetMs ?? DEFAULT_TARGET_MS);
  const steps = Math.max(1, options.steps ?? DEFAULT_STEPS);
  const maxPaced = Math.max(0, options.maxStreamedChars ?? DEFAULT_MAX_PACED_CHARS);
  const sleep = options.sleep ?? sleepAbortable;

  // Keep the previous contents so a failed or cancelled write can be undone.
  // Bounded: past this size the safety net is not worth the memory.
  let previous: Buffer | null = null;
  try {
    const stat = await fs.stat(filePath);
    if (stat.isFile() && stat.size <= 32 * 1024 * 1024) previous = await fs.readFile(filePath);
  } catch { /* new file */ }

  const pacedChars = Math.min(content.length, maxPaced);
  const paced = pacedChars > 0 && targetMs > 0;
  const chunkChars = paced
    ? Math.max(MIN_CHUNK_CHARS, Math.ceil(pacedChars / steps))
    : content.length;
  const chunks = paced ? Math.max(1, Math.ceil(pacedChars / chunkChars)) : 1;
  // Capped so a short file is not stretched to the full budget by a huge delay.
  const perChunkDelay = paced
    ? Math.min(MAX_CHUNK_DELAY_MS, Math.floor(targetMs / chunks))
    : 0;

  let handle: fs.FileHandle | undefined;
  let bytes = 0;
  try {
    // 'w' truncates immediately: the file exists and starts growing right away,
    // which is what makes it observable.
    handle = await fs.open(filePath, 'w');

    let offset = 0;
    while (offset < content.length) {
      signal?.throwIfAborted();
      // Pacing only applies to the first `pacedChars`; the tail goes out fast.
      const limit = paced && offset < pacedChars ? Math.min(content.length, pacedChars) : content.length;
      const piece = content.slice(offset, Math.min(limit, offset + chunkChars));
      await handle.write(piece, null, 'utf8');
      offset += piece.length;
      bytes += Buffer.byteLength(piece, 'utf8');
      if (paced && offset < limit && perChunkDelay > 0) await sleep(perChunkDelay, signal);
    }

    // Durability on completion. No periodic fsync: peer processes see the bytes
    // through the page cache immediately, which is all the live preview needs.
    await handle.sync().catch(() => { /* unsupported on some filesystems */ });
    await handle.close();
    handle = undefined;
    return { bytes, pacedChars: paced ? pacedChars : 0, paced };
  } catch (error) {
    if (handle) await handle.close().catch(() => { /* already failing */ });
    // Put the previous file back, or remove the partial one.
    try {
      if (previous) {
        const { writeFileAtomic } = await import('./atomic_write.js');
        await writeFileAtomic(filePath, previous);
      } else {
        await fs.unlink(filePath);
      }
    } catch { /* nothing better to do than surface the original error */ }
    throw error;
  }
}