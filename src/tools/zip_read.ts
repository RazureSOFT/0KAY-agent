export interface ZipReadEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  offset: number;
  data: Buffer;
}

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;

function findEocd(buffer: Buffer): number {
  const min = Math.max(0, buffer.length - 66_000);
  for (let i = buffer.length - 22; i >= min; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

export function buildZipRead(buffer: Buffer): ZipReadEntry[] {
  const entries: ZipReadEntry[] = [];
  const eocd = findEocd(buffer);
  let count = 0;
  let centralOffset = 0;
  if (eocd >= 0) {
    count = buffer.readUInt16LE(eocd + 10);
    centralOffset = buffer.readUInt32LE(eocd + 16);
  }
  if (count === 0xffff || centralOffset === 0xffffffff || eocd < 0) {
    return scanLocalHeaders(buffer);
  }
  let offset = centralOffset;
  for (let i = 0; i < count && offset + 46 <= buffer.length; i++) {
    if (buffer.readUInt32LE(offset) !== CEN_SIG) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.slice(offset + 46, offset + 46 + nameLength).toString('utf8');
    const data = readLocalData(buffer, localOffset, compressedSize);
    entries.push({ name, method, compressedSize, size, offset: localOffset, data });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function readLocalData(buffer: Buffer, localOffset: number, compressedSize: number): Buffer {
  if (buffer.readUInt32LE(localOffset) !== 0x04034b50) return Buffer.alloc(0);
  const nameLength = buffer.readUInt16LE(localOffset + 26);
  const extraLength = buffer.readUInt16LE(localOffset + 28);
  const start = localOffset + 30 + nameLength + extraLength;
  return buffer.slice(start, start + compressedSize);
}

function scanLocalHeaders(buffer: Buffer): ZipReadEntry[] {
  const entries: ZipReadEntry[] = [];
  let offset = 0;
  while (offset + 30 <= buffer.length && entries.length < 5000) {
    if (buffer.readUInt32LE(offset) !== 0x04034b50) { offset++; continue; }
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const size = buffer.readUInt32LE(offset + 22);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.slice(offset + 30, offset + 30 + nameLength).toString('utf8');
    const dataStart = offset + 30 + nameLength + extraLength;
    const data = buffer.slice(dataStart, dataStart + compressedSize);
    entries.push({ name, method, compressedSize, size, offset, data });
    offset = dataStart + compressedSize;
  }
  return entries;
}
