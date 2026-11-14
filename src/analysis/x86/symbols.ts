/**
 * Function entry points from the symbol table. Go's own function table is not
 * always visible as a named section (on PE it lives inside .rdata with a
 * layout that changes between releases), but the linker also emits a symbol
 * table, and function symbols are stable, documented and easy to validate.
 *
 * A symbol gives a start; the next symbol's start gives the end. That range is
 * what keeps recursive traversal inside one function.
 */
import type { Image } from './image.js';

export interface FunctionEntry {
  name: string;
  entry: number;
  end: number;
  size: number;
  source: 'elf-symtab' | 'coff-symtab' | 'go-pclntab';
}

function cstring(bytes: Uint8Array, offset: number, max = 256): string {
  if (offset < 0 || offset >= bytes.length) return '';
  let end = offset;
  while (end < bytes.length && end - offset < max && bytes[end] !== 0) end++;
  return Buffer.from(bytes.subarray(offset, end)).toString('utf8');
}

function u16(b: Uint8Array, o: number): number { return b[o] | (b[o + 1] << 8); }
function u32(b: Uint8Array, o: number): number {
  return ((b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0);
}
function u64(b: Uint8Array, o: number): number { return u32(b, o) + u32(b, o + 4) * 0x100000000; }

function parseElfSymbols(bytes: Uint8Array, image: Image): FunctionEntry[] {
  const table = image.symbols;
  if (!table || table.kind !== 'elf') return [];
  const out: Array<{ name: string; entry: number; size: number }> = [];
  const stride = Math.max(16, table.entrySize);
  const count = Math.min(table.count, Math.floor((bytes.length - table.offset) / stride));
  for (let i = 0; i < count; i++) {
    const o = table.offset + i * stride;
    if (o + stride > bytes.length) break;
    const is64 = table.bits === 64;
    const nameOff = u32(bytes, o);
    const type = bytes[o + (is64 ? 4 : 12)] & 0xf;
    if (type !== 2) continue; // STT_FUNC
    const shndx = u16(bytes, o + (is64 ? 6 : 14));
    if (shndx === 0 || shndx >= 0xff00) continue;
    const entry = is64 ? u64(bytes, o + 8) : u32(bytes, o + 4);
    const size = is64 ? u64(bytes, o + 16) : u32(bytes, o + 8);
    if (!entry) continue;
    const name = cstring(bytes, table.stringOffset + nameOff);
    if (!name) continue;
    out.push({ name, entry, size });
  }
  return withRanges(out, 'elf-symtab');
}

function parseCoffSymbols(bytes: Uint8Array, image: Image): FunctionEntry[] {
  const table = image.symbols;
  if (!table || table.kind !== 'coff') return [];
  const out: Array<{ name: string; entry: number; size: number }> = [];
  const count = Math.min(table.count, Math.floor((bytes.length - table.offset) / 18));
  for (let i = 0; i < count; i++) {
    const o = table.offset + i * 18;
    if (o + 18 > bytes.length) break;
    const name = u32(bytes, o) === 0
      ? cstring(bytes, table.stringOffset + u32(bytes, o + 4))
      : cstring(bytes, o, 8).replace(/\0.*$/, '');
    const value = u32(bytes, o + 8);
    const sectionNumber = (bytes[o + 12] | (bytes[o + 13] << 8)) as number;
    const type = u16(bytes, o + 14);
    const storageClass = bytes[o + 16];
    const aux = bytes[o + 17];
    if (storageClass !== 2 || sectionNumber <= 0 || (type & 0x20) === 0) continue;
    const section = image.sections[sectionNumber - 1];
    if (!section || !section.executable || value >= section.size) continue;
    if (!name) continue;
    // Build metadata and section markers are emitted with a function type but
    // are not code; walking them would decode the build id as instructions.
    if (/^(go:|runtime\.(text|etext|rodata|noptrdata|data|bss|epclntab|symtab|pclntab)$)/.test(name)) continue;
    // COFF values are section-relative offsets, not virtual addresses.
    out.push({ name, entry: section.vaddr + value, size: 0 });
    i += aux; // auxiliary records follow the symbol they describe
  }
  return withRanges(out, 'coff-symtab');
}

/** Sort by address, drop duplicates and derive each function's end. */
function withRanges(
  rows: Array<{ name: string; entry: number; size: number }>,
  source: FunctionEntry['source'],
): FunctionEntry[] {
  const sorted = rows.sort((a, b) => a.entry - b.entry);
  const unique: typeof sorted = [];
  for (const row of sorted) {
    if (unique.length && unique[unique.length - 1].entry === row.entry) continue;
    unique.push(row);
  }
  return unique.map((row, index) => {
    const next = unique[index + 1];
    const declaredEnd = row.entry + row.size;
    const end = row.size > 0 && (!next || declaredEnd <= next.entry)
      ? declaredEnd
      : (next ? next.entry : declaredEnd);
    return { name: row.name, entry: row.entry, end, size: Math.max(0, end - row.entry), source };
  });
}

export function parseSymbols(bytes: Uint8Array, image: Image): FunctionEntry[] {
  return image.format === 'elf' ? parseElfSymbols(bytes, image)
    : image.format === 'pe' ? parseCoffSymbols(bytes, image)
      : [];
}

/** Find the function whose range contains an address (works without explicit ends). */
export function functionAt(functions: Array<{ name: string; entry: number; end?: number }>, address: number) {
  let lo = 0;
  let hi = functions.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const fn = functions[mid];
    const next = functions[mid + 1];
    if (address < fn.entry) { hi = mid - 1; continue; }
    const end = fn.end && fn.end > fn.entry ? fn.end : (next ? next.entry : Infinity);
    if (address >= end) { lo = mid + 1; continue; }
    return fn;
  }
  return undefined;
}
