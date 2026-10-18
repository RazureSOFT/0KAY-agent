/**
 * Atomic file replacement for the tools that overwrite the user's files.
 *
 * `fs.writeFile` is a single buffered write — it is **not** a stream — but it is
 * also not atomic: it truncates the target and then writes, so a crash, an OOM
 * kill or a Ctrl-C in between leaves a half-written file. For `write`/`edit`/
 * `apply_patch`, whose entire job is replacing source files, that is data loss.
 * It is the same defect already fixed in Core (`internal/atomicio`) and in the
 * LIFE state store.
 *
 * Streaming was deliberately not chosen:
 *   - `content` arrives as one complete string in the tool arguments, so there is
 *     nothing to stream from;
 *   - a streaming write would additionally expose a partially written file to any
 *     reader — file watchers, the user's editor, and this agent's own `read` tool —
 *     for the duration of the write. Buffered + rename publishes the new file in
 *     one step.
 *
 * The temp file lives in the target's directory because `rename` is only atomic
 * within a filesystem. Its name is unique per call so two concurrent tasks writing
 * the same path cannot interleave into one scratch file.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

/** Write `data` to `filePath`, replacing it atomically. */
export async function writeFileAtomic(
  filePath: string,
  data: string | Buffer,
  encoding: BufferEncoding = 'utf8',
): Promise<void> {
  const directory = path.dirname(filePath);
  const temp = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}-${randomBytes(4).toString('hex')}.okay-tmp`,
  );

  // Preserve the existing mode. rename() installs a new inode, so without this a
  // rewrite would silently drop the executable bit off a shell script or a
  // previously 0600 secret.
  let mode: number | undefined;
  try {
    mode = (await fs.stat(filePath)).mode;
  } catch {
    // New file: let the platform default apply.
  }

  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(temp, 'wx', mode ?? 0o666);
    await handle.writeFile(data, encoding);
    // fsync before the rename: otherwise the rename can land before the contents
    // do, which on a power loss leaves a correctly named but empty file.
    await handle.sync().catch(() => { /* unsupported on some filesystems */ });
    await handle.close();
    handle = undefined;
    if (mode !== undefined) await fs.chmod(temp, mode).catch(() => { /* best effort */ });
    await renameWithRetry(temp, filePath);
  } catch (error) {
    if (handle) await handle.close().catch(() => { /* already failing */ });
    await fs.unlink(temp).catch(() => { /* never created, or already gone */ });
    throw error;
  }

  // Best-effort directory sync so the rename itself is durable. Windows cannot
  // open a directory for fsync, hence the swallow.
  try {
    const dirHandle = await fs.open(directory, 'r');
    await dirHandle.sync().catch(() => { /* unsupported */ });
    await dirHandle.close();
  } catch { /* unsupported on this platform */ }
}

/**
 * Rename with a bounded retry on the transient Windows sharing errors.
 *
 * POSIX rename-replace is atomic and never contends. Windows `MoveFileEx` with
 * replace-existing can return EPERM/EBUSY/EACCES while another writer is
 * replacing the same destination — observed when two tasks rewrite one file
 * concurrently. The standard remedy is to retry briefly; the winning rename
 * still publishes the whole file in one step.
 */
async function renameWithRetry(from: string, to: string, attempts = 6): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error: any) {
      const transient = error?.code === 'EPERM' || error?.code === 'EBUSY' || error?.code === 'EACCES';
      if (!transient || attempt >= attempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
    }
  }
}