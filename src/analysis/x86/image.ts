/**
 * Executable image parsing: enough of ELF, PE and Mach-O to find code and map
 * a virtual address back to a file offset.
 *
 * A linear sweep over a whole `.text` section decodes the embedded Go build id
 * and other data as instructions and produces confident-looking garbage. The
 * only reliable starting points are an entry point, a symbol, or a function
 * table — so this file exists to find those, not to replace a disassembler.
 */
export interface Section {
  name: string;
  /** Virtual address (relative to the image base). */
  vaddr: number;
  /** Offset of the section's bytes in the file. */
  offset: number;
  size: number;
  executable: boolean;
  /** ELF section type / link / entry size, when the container has them. */
  type?: number;
  link?: number;
  entsize?: number;
}

/** A symbol table we can read for real function entry points. */
export interface SymbolTable {
  kind: 'elf' | 'coff';
  offset: number;
  count: number;
  stringOffset: number;
  entrySize: number;
  bits: 32 | 64;
}

export interface Image {
  format: 'elf' | 'pe' | 'macho' | 'raw';
  bits: 32 | 64;
  /** File offset of the entry point, or -1 when not known. */
  entryOffset: number;
  entryVaddr: number;
  imageBase: number;
  sections: Section[];
  symbols?: SymbolTable;
  /** Why parsing stopped, when the format could not be fully read. */
  note?: string;
}

function u16(b: Buffer | Uint8Array, o: number, le = true): number {
  const v = b as Uint8Array;
  return le ? (v[o] | (v[o + 1] << 8)) : ((v[o] << 8) | v[o + 1]);
}
function u32(b: Buffer | Uint8Array, o: number, le = true): number {
  const v = b as Uint8Array;
  return le
    ? ((v[o] | (v[o + 1] << 8) | (v[o + 2] << 16) | (v[o + 3] << 24)) >>> 0)
    : (((v[o] << 24) | (v[o + 1] << 16) | (v[o + 2] << 8) | v[o + 3]) >>> 0);
}
function u64(b: Buffer | Uint8Array, o: number, le = true): number {
  const v = b as Uint8Array;
  const lo = u32(v, o, le);
  const hi = u32(v, o + 4, le);
  return le ? lo + hi * 0x100000000 : lo * 0x100000000 + hi;
}
function cstring(b: Buffer | Uint8Array, o: number, max = 64): string {
  const v = b as Uint8Array;
  let end = o;
  while (end < v.length && end - o < max && v[end] !== 0) end++;
  return Buffer.from(v.subarray(o, end)).toString('utf8');
}

function parseElf(b: Buffer | Uint8Array): Image | null {
  const v = b as Uint8Array;
  if (v.length < 52 || v[0] !== 0x7f || v[1] !== 0x45 || v[2] !== 0x4c || v[3] !== 0x46) return null;
  const bits: 32 | 64 = v[4] === 2 ? 64 : 32;
  const le = v[5] !== 2;
  const entry = bits === 64 ? u64(v, 24, le) : u32(v, 24, le);
  const shoff = bits === 64 ? u64(v, 40, le) : u32(v, 32, le);
  const shentsize = u16(v, bits === 64 ? 58 : 46, le);
  const shnum = u16(v, bits === 64 ? 60 : 48, le);
  const shstrndx = u16(v, bits === 64 ? 62 : 50, le);
  const sections: Section[] = [];
  if (!shoff || !shnum || !shentsize || shoff + shnum * shentsize > v.length) {
    return { format: 'elf', bits, entryOffset: -1, entryVaddr: entry, imageBase: 0, sections, note: 'section table is missing or truncated' };
  }
  const strBase = shoff + shstrndx * shentsize;
  const strOff = bits === 64 ? u64(v, strBase + 24, le) : u32(v, strBase + 16, le);
  for (let i = 0; i < shnum; i++) {
    const o = shoff + i * shentsize;
    if (o + shentsize > v.length) break;
    const nameOff = u32(v, o, le);
    const flags = bits === 64 ? u64(v, o + 8, le) : u32(v, o + 8, le);
    const addr = bits === 64 ? u64(v, o + 16, le) : u32(v, o + 12, le);
    const off = bits === 64 ? u64(v, o + 24, le) : u32(v, o + 16, le);
    const size = bits === 64 ? u64(v, o + 32, le) : u32(v, o + 20, le);
    const type = u32(v, o + 4, le);
    const link = u32(v, o + (bits === 64 ? 40 : 24), le);
    const entsize = bits === 64 ? u64(v, o + 56, le) : u32(v, o + 36, le);
    sections.push({
      name: cstring(v, strOff + nameOff) || `section_${i}`,
      vaddr: addr, offset: off, size,
      executable: (flags & 0x4) !== 0, // SHF_EXECINSTR
      type, link, entsize,
    });
  }
  const sym = sections.find((s) => s.type === 2 && s.entsize) || sections.find((s) => s.type === 11 && s.entsize);
  const str = sym && sym.link != null ? sections[sym.link] : undefined;
  const symbols: SymbolTable | undefined = sym && str && sym.entsize
    ? { kind: 'elf', offset: sym.offset, count: Math.floor(sym.size / sym.entsize), stringOffset: str.offset, entrySize: sym.entsize, bits }
    : undefined;
  return { format: 'elf', bits, entryOffset: vaddrToOffset(entry, sections), entryVaddr: entry, imageBase: 0, sections, symbols };
}

function parsePe(b: Buffer | Uint8Array): Image | null {
  const v = b as Uint8Array;
  if (v.length < 0x40 || v[0] !== 0x4d || v[1] !== 0x5a) return null;
  const pe = u32(v, 0x3c);
  if (pe + 24 > v.length || u32(v, pe) !== 0x00004550) return null;
  const nsec = u16(v, pe + 6);
  const optSize = u16(v, pe + 20);
  const opt = pe + 24;
  // COFF header lives at pe+4. Long section names and the symbol table both
  // point into the string table that follows the 18-byte symbol records.
  const ptrSym = u32(v, pe + 12);
  const nSym = u32(v, pe + 16);
  const strtab = ptrSym && nSym ? ptrSym + nSym * 18 : 0;
  if (opt + 2 > v.length) return null;
  const magic = u16(v, opt);
  const bits: 32 | 64 = magic === 0x20b ? 64 : 32;
  const imageBase = bits === 64 ? u64(v, opt + 24) : u32(v, opt + 28);
  const entryRva = u32(v, opt + 16);
  const sectionTable = opt + optSize;
  const sections: Section[] = [];
  for (let i = 0; i < nsec; i++) {
    const o = sectionTable + i * 40;
    if (o + 40 > v.length) break;
    const vsize = u32(v, o + 8);
    const vaddr = u32(v, o + 12);
    const rawSize = u32(v, o + 16);
    const rawOff = u32(v, o + 20);
    const chars = u32(v, o + 36);
    const shortName = cstring(v, o, 8).trim();
    let name = shortName;
    if (/^\/\d+$/.test(shortName) && strtab) {
      name = cstring(v, strtab + Number(shortName.slice(1)), 128) || shortName;
    }
    sections.push({
      name: name || `section_${i}`,
      vaddr: imageBase + vaddr,
      offset: rawOff,
      size: Math.min(vsize || rawSize, rawSize),
      executable: (chars & 0x20000000) !== 0 || (chars & 0x20) !== 0,
    });
  }
  const symbols: SymbolTable | undefined = ptrSym && nSym && strtab < v.length
    ? { kind: 'coff', offset: ptrSym, count: nSym, stringOffset: strtab, entrySize: 18, bits }
    : undefined;
  return {
    format: 'pe', bits, imageBase,
    entryVaddr: imageBase + entryRva,
    entryOffset: vaddrToOffset(imageBase + entryRva, sections),
    sections,
    symbols,
  };
}

function parseMacho(b: Buffer | Uint8Array): Image | null {
  const v = b as Uint8Array;
  if (v.length < 32) return null;
  const magic = u32(v, 0, false);
  const is64 = magic === 0xfeedfacf || magic === 0xcffaedfe;
  const le = magic === 0xcefaedfe || magic === 0xcffaedfe;
  if (![0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(magic)) return null;
  const ncmds = u32(v, 16, le);
  const sizeofcmds = u32(v, 20, le);
  const headerSize = is64 ? 32 : 28;
  const sections: Section[] = [];
  let cursor = headerSize;
  let entryVaddr = 0;
  const limit = Math.min(v.length, headerSize + sizeofcmds);
  for (let c = 0; c < ncmds && cursor + 8 <= limit; c++) {
    const cmd = u32(v, cursor, le);
    const size = u32(v, cursor + 4, le);
    if (size < 8 || cursor + size > v.length) break;
    // LC_SEGMENT (0x1) / LC_SEGMENT_64 (0x19): sections follow the segment command.
    if (cmd === 0x19 || cmd === 0x1) {
      const seg = is64 ? 72 : 56;
      const nsects = u32(v, cursor + (is64 ? 64 : 48), le);
      const vmaddr = is64 ? u64(v, cursor + 24, le) : u32(v, cursor + 24, le);
      let s = cursor + seg;
      for (let i = 0; i < nsects && s + 80 <= v.length; i++) {
        const name = cstring(v, s, 16).trim();
        const addr = is64 ? u64(v, s + 32, le) : u32(v, s + 32, le);
        const ssize = is64 ? u64(v, s + 40, le) : u32(v, s + 36, le);
        const off = u32(v, s + (is64 ? 48 : 40), le);
        sections.push({ name: name || `section_${i}`, vaddr: addr, offset: off, size: ssize, executable: name === '__text' });
        s += is64 ? 80 : 68;
      }
      void vmaddr;
    }
    // LC_MAIN (0x80000028): entryoff is the file offset of the entry point.
    if (cmd === 0x80000028 && cursor + 16 <= v.length) {
      entryVaddr = u64(v, cursor + 8, le);
    }
    cursor += size;
  }
  return { format: 'macho', bits: is64 ? 64 : 32, imageBase: 0, entryOffset: -1, entryVaddr, sections, note: 'entry is a file offset on this format' };
}

export function parseImage(buffer: Buffer | Uint8Array): Image {
  const v = buffer as Uint8Array;
  const image = parseElf(v) || parsePe(v) || parseMacho(v);
  if (image) return image;
  return {
    format: 'raw', bits: 64, imageBase: 0, entryOffset: 0, entryVaddr: 0,
    sections: [{ name: 'raw', vaddr: 0, offset: 0, size: v.length, executable: true }],
    note: 'unrecognised container; treating the whole file as one code region',
  };
}

/** Map a virtual address into a file offset; -1 means "not backed by bytes". */
export function vaddrToOffset(vaddr: number, sections: Section[]): number {
  for (const section of sections) {
    if (section.size <= 0) continue;
    if (vaddr >= section.vaddr && vaddr < section.vaddr + section.size) {
      const delta = vaddr - section.vaddr;
      if (delta < section.size) return section.offset + delta;
    }
  }
  return -1;
}

export function executableSections(image: Image): Section[] {
  const found = image.sections.filter((s) => s.executable && s.size > 0 && s.offset >= 0);
  return found.length ? found : image.sections.filter((s) => /text|code/i.test(s.name) && s.size > 0);
}

/** Find a named section, for the Go function table and similar metadata. */
export function sectionNamed(image: Image, pattern: RegExp): Section | undefined {
  return image.sections.find((s) => pattern.test(s.name) && s.size > 0 && s.offset >= 0);
}
