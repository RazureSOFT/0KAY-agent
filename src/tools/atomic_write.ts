import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

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

  let mode: number | undefined;
  try {
    mode = (await fs.stat(filePath)).mode;
  } catch {
  }

  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(temp, 'wx', mode ?? 0o666);
    await handle.writeFile(data, encoding);
    await handle.sync().catch(() => { });
    await handle.close();
    handle = undefined;
    if (mode !== undefined) await fs.chmod(temp, mode).catch(() => { });
    await renameWithRetry(temp, filePath);
  } catch (error) {
    if (handle) await handle.close().catch(() => { });
    await fs.unlink(temp).catch(() => { });
    throw error;
  }

  try {
    const dirHandle = await fs.open(directory, 'r');
    await dirHandle.sync().catch(() => { });
    await dirHandle.close();
  } catch { }
}

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