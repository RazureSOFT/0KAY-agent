import { promises as fs } from 'node:fs';

export interface StreamWriteOptions {
  targetMs?: number;
  steps?: number;
  maxStreamedChars?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface StreamWriteResult {
  bytes: number;
  pacedChars: number;
  paced: boolean;
}

const DEFAULT_TARGET_MS = 2_500;
const DEFAULT_STEPS = 48;
const DEFAULT_MAX_PACED_CHARS = 512 * 1024;
const MIN_CHUNK_CHARS = 24;
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

  let previous: Buffer | null = null;
  try {
    const stat = await fs.stat(filePath);
    if (stat.isFile() && stat.size <= 32 * 1024 * 1024) previous = await fs.readFile(filePath);
  } catch { }

  const pacedChars = Math.min(content.length, maxPaced);
  const paced = pacedChars > 0 && targetMs > 0;
  const chunkChars = paced
    ? Math.max(MIN_CHUNK_CHARS, Math.ceil(pacedChars / steps))
    : content.length;
  const chunks = paced ? Math.max(1, Math.ceil(pacedChars / chunkChars)) : 1;
  const perChunkDelay = paced
    ? Math.min(MAX_CHUNK_DELAY_MS, Math.floor(targetMs / chunks))
    : 0;

  let handle: fs.FileHandle | undefined;
  let bytes = 0;
  try {
    handle = await fs.open(filePath, 'w');

    let offset = 0;
    while (offset < content.length) {
      signal?.throwIfAborted();
      const limit = paced && offset < pacedChars ? Math.min(content.length, pacedChars) : content.length;
      const piece = content.slice(offset, Math.min(limit, offset + chunkChars));
      await handle.write(piece, null, 'utf8');
      offset += piece.length;
      bytes += Buffer.byteLength(piece, 'utf8');
      if (paced && offset < limit && perChunkDelay > 0) await sleep(perChunkDelay, signal);
    }

    await handle.sync().catch(() => { });
    await handle.close();
    handle = undefined;
    return { bytes, pacedChars: paced ? pacedChars : 0, paced };
  } catch (error) {
    if (handle) await handle.close().catch(() => { });
    try {
      if (previous) {
        const { writeFileAtomic } = await import('./atomic_write.js');
        await writeFileAtomic(filePath, previous);
      } else {
        await fs.unlink(filePath);
      }
    } catch { }
    throw error;
  }
}