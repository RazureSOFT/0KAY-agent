/**
 * Go's pclntab: the function table that tells us where functions actually
 * start. Parsing it is the difference between disassembling code and
 * disassembling the build-id string, jump tables and string constants that
 * sit in the same section.
 *
 * Layout is the go116/go120 pcHeader (Go 1.18+). Older images get an explicit
 * note instead of a guess: a wrong function table is worse than none.
 */
export interface GoFunction {
  name: string;
  entry: number;
  end: number;
  size: number;
}

export interface PclnTable {
  functions: GoFunction[];
  textStart: number;
  magic: number;
  ptrSize: number;
  note?: string;
}

const GO116MAGIC = 0xfffffff0;
const GO120MAGIC = 0xfffffff1;
const MAX_FUNCS = 1_000_000;

function u32(b: Uint8Array, o: number): number {
  return ((b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0);
}
function uptr(b: Uint8Array, o: number, ptrSize: number): number {
  if (ptrSize === 4) return u32(b, o);
  return u32(b, o) + u32(b, o + 4) * 0x100000000;
}
function cstring(b: Uint8Array, o: number, max = 256): string | null {
  if (o < 0 || o >= b.length) return null;
  let end = o;
  while (end < b.length && end - o < max && b[end] !== 0) {
    const c = b[end];
    if (c < 0x20 || c > 0x7e) return null; // names are ASCII; garbage is not a name
    end++;
  }
  if (end === o || end - o >= max) return null;
  return Buffer.from(b.subarray(o, end)).toString('ascii');
}

export function parsePclntab(data: Uint8Array, textStartOverride?: number): PclnTable {
  const empty: PclnTable = { functions: [], textStart: 0, magic: 0, ptrSize: 0 };
  if (data.length < 72) return { ...empty, note: 'pclntab is too short to hold a header' };
  const magic = u32(data, 0);
  if (magic !== GO116MAGIC && magic !== GO120MAGIC) {
    return { ...empty, magic, note: `unsupported pclntab magic 0x${magic.toString(16)} (Go 1.18+ expected)` };
  }
  const ptrSize = data[7];
  if (ptrSize !== 4 && ptrSize !== 8) {
    return { ...empty, magic, ptrSize, note: `unsupported pointer size ${ptrSize}` };
  }
  const nfunc = uptr(data, 8, ptrSize);
  const textStart = textStartOverride ?? uptr(data, 24, ptrSize);
  const funcnameOffset = uptr(data, 32, ptrSize);
  const pclnOffset = uptr(data, 64, ptrSize);
  if (!Number.isFinite(nfunc) || nfunc <= 0 || nfunc > MAX_FUNCS) {
    return { ...empty, magic, ptrSize, textStart, note: `implausible function count ${nfunc}` };
  }
  if (pclnOffset + (nfunc + 1) * 8 > data.length) {
    return { ...empty, magic, ptrSize, textStart, note: 'the function table runs past the section' };
  }

  const functions: GoFunction[] = [];
  let unnamed = 0;
  for (let i = 0; i < nfunc; i++) {
    const at = pclnOffset + i * 8;
    const entryOff = u32(data, at);
    const funcOff = u32(data, at + 4);
    const nextEntryOff = u32(data, pclnOffset + (i + 1) * 8);
    const funcAt = pclnOffset + funcOff;
    if (funcAt + 8 > data.length) { unnamed++; continue; }
    const nameOff = u32(data, funcAt + 4);
    const name = cstring(data, funcnameOffset + nameOff);
    if (!name) unnamed++;
    // The first entry is not a function: Go puts the build id there under the name
    // `go:buildid` and points it at the start of .text, which is not code. Listing it
    // gave a function whose body decompiled to nothing, and it is the only name in
    // the table with a colon that is not a package path.
    if (name === 'go:buildid') continue;
    const entry = textStart + entryOff;
    const end = textStart + nextEntryOff;
    functions.push({
      name: name || `func_${entry.toString(16)}`,
      entry,
      end: end > entry ? end : entry,
      size: Math.max(0, end - entry),
    });
  }
  return {
    functions,
    textStart,
    magic,
    ptrSize,
    note: unnamed ? `${unnamed} name(s) could not be read; those functions got address labels` : undefined,
  };
}

/**
 * Find the Go function table inside a section that holds other data too.
 *
 * On PE the linker folds the table into `.rdata`, next to the string constants and
 * the type metadata, so there is no section named `gopclntab` to look for. Scanning
 * for the header is safe because the header is self-describing: the magic is a
 * specific value, the pointer size is 4 or 8, and the function count has to be
 * plausible and fit in the data. A false positive that satisfies all three and
 * parses into tens of thousands of named functions does not occur by accident.
 */
export function findPclntab(data: Uint8Array, textStart?: number): PclnTable | undefined {
  for (let at = 0; at + 72 < data.length; at += 4) {
    const magic = u32(data, at);
    if (magic !== GO116MAGIC && magic !== GO120MAGIC) continue;
    const ptrSize = data[at + 7];
    if (ptrSize !== 4 && ptrSize !== 8) continue;
    const nfunc = uptr(data, at + 8, ptrSize);
    if (!Number.isFinite(nfunc) || nfunc < 16 || nfunc > MAX_FUNCS) continue;
    const table = parsePclntab(data.subarray(at), textStart);
    if (table.functions.length >= 16) return table;
  }
  return undefined;
}

/** Find a function whose address range contains `address`. */
export function functionAt(functions: GoFunction[], address: number): GoFunction | undefined {
  let lo = 0;
  let hi = functions.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const fn = functions[mid];
    if (address < fn.entry) hi = mid - 1;
    else if (address >= fn.end && fn.end > fn.entry) lo = mid + 1;
    else return fn;
  }
  return undefined;
}
