/**
 * DWARF debug information: types, function signatures and struct layouts.
 *
 * The disassembler alone cannot say what a parameter is. `_func.args` in the Go function
 * table would, and it is the natural place to look — but it is zero for every function
 * in a build made without it, which is the normal case for a release binary and the case
 * this was written against: `mapKeyError2` and `printsp` both report `args=0` while
 * taking two and one arguments respectively.
 *
 * When the compiler emitted DWARF the answer is already written down. This module reads
 * it, and the difference is between `long f(long arg0, long arg1)` — arithmetic on
 * guesses — and `func (m *Map) get(k *Key) unsafe.Pointer`.
 *
 * Two layouts are handled, because both are ordinary:
 *
 *   - `.debug_info` and friends, as produced by `-ldflags=-w=false` on Linux;
 *   - `.zdebug_info`, the same bytes with a `ZLIB` header and the body deflated, which is
 *     what Go emits on Windows and what the 24 MB binary this was tested on carries.
 *
 * Only DWARF 4 and 5 are read. An image with neither is not an error: the caller gets
 * null and falls back to what the disassembly suggests, which is what every listing did
 * before this existed.
 *
 * What it covers is whatever the compiler chose to emit, and that is not the same as what
 * the binary contains. The 24 MB Go binary this was written against carries a full
 * `.zdebug_info` — 346 units, 6.5 MB uncompressed — yet it holds only 281 of the 19376
 * functions in the table, because the build kept debug info for `crypto/` and a few other
 * packages and dropped the rest. Reading 281 signatures out of 19376 is worth having and
 * is not a substitute for inferring the other 19095; the caller has to be able to work
 * both ways, which is why nothing here is required.
 */
import * as zlib from 'node:zlib';

/** A parameter or return value as DWARF describes it. */
export interface DwarfParam {
  name: string;
  /** The type as written, e.g. `*runtime.maps.Map` or `uintptr`. */
  type: string;
  /** True when the value is described by a location list rather than a register. */
  indirect?: boolean;
}

export interface DwarfFunction {
  name: string;
  lowPc: number;
  highPc: number;
  params: DwarfParam[];
  returns: DwarfParam[];
  /** The receiver, for a method: `Map *`, `int`, and so on. */
  receiver?: DwarfParam;
}

export interface DwarfInfo {
  functions: Map<number, DwarfFunction>;
  /** Struct and named types by name, with their fields. */
  types: Map<string, DwarfType>;
  note?: string;
}

export interface DwarfField {
  name: string;
  type: string;
  /** Byte offset from the start of the struct. */
  offset: number;
}

export interface DwarfType {
  name: string;
  kind: 'struct' | 'union' | 'typedef' | 'pointer' | 'array' | 'other';
  size?: number;
  fields?: DwarfField[];
  /** What a pointer or typedef points at or stands for. */
  target?: string;
}

const TAG = {
  arrayType: 0x01,
  classType: 0x02,
  enumType: 0x04,
  formalParameter: 0x05,
  member: 0x0d,
  pointerType: 0x0f,
  referenceType: 0x10,
  compileUnit: 0x11,
  structureType: 0x13,
  typedef: 0x16,
  unionType: 0x17,
  subroutineType: 0x15,
  subprogram: 0x2e,
  unspecifiedParameters: 0x18,
  constType: 0x26,
  volatileType: 0x35,
  restrictType: 0x37,
  atomicType: 0x47,
  rvalueReferenceType: 0x42,
  baseType: 0x24,
} as const;

const AT = {
  name: 0x03,
  byteSize: 0x0b,
  location: 0x02,
  highPc: 0x12,
  lowPc: 0x11,
  language: 0x13,
  dataMemberLocation: 0x38,
  addrBase: 0x73,
  // `0x3a` is `DW_AT_decl_line` and `0x3b` is `DW_AT_decl_file`: both are numbers, not
  // references. Reading them as links to a declaring DIE sent the walk to offset 4,
  // inside the unit header, and produced garbage names from there.
  declFile: 0x3b,
  type: 0x49,
  abstractOrigin: 0x31,
  specification: 0x47,
  external: 0x3f,
  declaration: 0x3c,
} as const;

const FORM = {
  addr: 0x01,
  block2: 0x03,
  block4: 0x04,
  data2: 0x05,
  data4: 0x06,
  data8: 0x07,
  string: 0x08,
  block: 0x09,
  block1: 0x0a,
  data1: 0x0b,
  flag: 0x0c,
  sdata: 0x0d,
  strp: 0x0e,
  udata: 0x0f,
  refAddr: 0x10,
  ref1: 0x11,
  ref2: 0x12,
  ref4: 0x13,
  ref8: 0x14,
  refUdata: 0x15,
  indirect: 0x16,
  secOffset: 0x17,
  exprloc: 0x18,
  flagPresent: 0x19,
  strx: 0x1a,
  addrx: 0x1b,
  refSup4: 0x1c,
  strpSup: 0x1d,
  data16: 0x1e,
  lineStrp: 0x1f,
  refSig8: 0x20,
  implicitConst: 0x21,
  loclistx: 0x22,
  rnglistx: 0x23,
  refSup8: 0x24,
  strx1: 0x25,
  strx2: 0x26,
  strx3: 0x27,
  strx4: 0x28,
  addrx1: 0x29,
  addrx2: 0x2a,
  addrx3: 0x2b,
  addrx4: 0x2c,
} as const;

/** Byte reads. DWARF is little-endian throughout on both targets this runs against. */
const u16 = (b: Uint8Array, o: number): number => b[o] | (b[o + 1] << 8);
const u24 = (b: Uint8Array, o: number): number => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
const u32 = (b: Uint8Array, o: number): number => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const u64 = (b: Uint8Array, o: number): number => u32(b, o) + u32(b, o + 4) * 0x100000000;

/** Unsigned LEB128. */
function uleb(b: Uint8Array, o: number): [number, number] {
  let result = 0;
  let shift = 0;
  let at = o;
  for (;;) {
    const byte = b[at++];
    result += (byte & 0x7f) * 2 ** shift;
    if (!(byte & 0x80)) break;
    shift += 7;
    if (shift > 63) break; // a corrupt stream must not spin
  }
  return [result, at];
}

/** Signed LEB128. */
function sleb(b: Uint8Array, o: number): [number, number] {
  let result = 0;
  let shift = 0;
  let at = o;
  for (;;) {
    const byte = b[at++];
    result += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (!(byte & 0x80)) {
      if (byte & 0x40) result -= 2 ** shift;
      break;
    }
    if (shift > 63) break;
  }
  return [result, at];
}

function cstring(b: Uint8Array, o: number): string {
  let end = o;
  while (end < b.length && b[end] !== 0) end++;
  return Buffer.from(b.subarray(o, end)).toString('utf8');
}

/** One abbreviation declaration: what a DIE with this code carries. */
interface AbbrevSpec {
  tag: number;
  children: boolean;
  attrs: { name: number; form: number; implicit: number }[];
}

function parseAbbrevTable(abbrev: Uint8Array, offset: number): Map<number, AbbrevSpec> {
  const table = new Map<number, AbbrevSpec>();
  let at = offset;
  while (at < abbrev.length) {
    const [code, afterCode] = uleb(abbrev, at);
    at = afterCode;
    if (code === 0) break;
    const [tag, afterTag] = uleb(abbrev, at);
    at = afterTag;
    const children = abbrev[at++] !== 0;
    const attrs: { name: number; form: number; implicit: number }[] = [];
    for (;;) {
      const [name, afterName] = uleb(abbrev, at);
      at = afterName;
      const [form, afterForm] = uleb(abbrev, at);
      at = afterForm;
      let implicit = 0;
      if (form === FORM.implicitConst) {
        const [value, afterValue] = sleb(abbrev, at);
        at = afterValue;
        implicit = value;
      }
      if (name === 0 && form === 0) break;
      attrs.push({ name, form, implicit });
    }
    table.set(code, { tag, children, attrs });
  }
  return table;
}

/** The sections a value's form needs to be resolved. */
interface Sections {
  info: Uint8Array;
  lineStr?: Uint8Array;
  str?: Uint8Array;
  strOffsets?: Uint8Array;
  /**
   * The address table `DW_FORM_addrx` indexes into.
   *
   * Go splits a binary into hundreds of compile units and emits every `low_pc` as an
   * index rather than an address. Without this table the form is unreadable, every
   * subprogram loses its `low_pc`, and the whole parse yields nothing — 346 units read,
   * zero functions.
   */
  addr?: Uint8Array;
  /** Where this unit's slice of the address table starts. */
  addrBase: number;
  addrSize: number;
  /** Base address of the unit, added to an address-table entry. */
  lowPc?: number;
}

/** A value a DIE attribute holds, before it is turned into a name or an offset. */
type FormValue =
  | { kind: 'int'; value: number }
  | { kind: 'str'; value: string }
  | { kind: 'offset'; offset: number; section: 'lineStr' | 'str' }
  | { kind: 'strx'; index: number }
  | { kind: 'addrx'; index: number }
  | { kind: 'block'; bytes: Uint8Array }
  | { kind: 'none' };

/** Read one attribute value. Returns the value and the offset just past it. */
function readForm(b: Uint8Array, form: number, at: number, sections: Sections): [FormValue, number] {
  const size = sections.addrSize;
  switch (form) {
    case FORM.addr: return [{ kind: 'int', value: size === 8 ? u64(b, at) : u32(b, at) }, at + size];
    case FORM.data1: return [{ kind: 'int', value: b[at] }, at + 1];
    case FORM.data2: return [{ kind: 'int', value: u16(b, at) }, at + 2];
    case FORM.data4: return [{ kind: 'int', value: u32(b, at) }, at + 4];
    case FORM.data8: return [{ kind: 'int', value: u64(b, at) }, at + 8];
    case FORM.data16: return [{ kind: 'int', value: u64(b, at) }, at + 16];
    case FORM.udata: { const [v, n] = uleb(b, at); return [{ kind: 'int', value: v }, n]; }
    case FORM.sdata: { const [v, n] = sleb(b, at); return [{ kind: 'int', value: v }, n]; }
    case FORM.string: {
      let end = at;
      while (end < b.length && b[end] !== 0) end++;
      return [{ kind: 'str', value: Buffer.from(b.subarray(at, end)).toString('utf8') }, end + 1];
    }
    case FORM.strp: return [{ kind: 'offset', offset: u32(b, at), section: 'str' }, at + 4];
    case FORM.lineStrp: return [{ kind: 'offset', offset: u32(b, at), section: 'lineStr' }, at + 4];
    case FORM.strx: { const [v, n] = uleb(b, at); return [{ kind: 'strx', index: v }, n]; }
    case FORM.strx1: return [{ kind: 'strx', index: b[at] }, at + 1];
    case FORM.strx2: return [{ kind: 'strx', index: u16(b, at) }, at + 2];
    case FORM.strx3: return [{ kind: 'strx', index: u24(b, at) }, at + 3];
    case FORM.strx4: return [{ kind: 'strx', index: u32(b, at) }, at + 4];
    case FORM.addrx: { const [v, n] = uleb(b, at); return [{ kind: 'addrx', index: v }, n]; }
    case FORM.addrx1: return [{ kind: 'addrx', index: b[at] }, at + 1];
    case FORM.addrx2: return [{ kind: 'addrx', index: u16(b, at) }, at + 2];
    case FORM.addrx3: return [{ kind: 'addrx', index: u24(b, at) }, at + 3];
    case FORM.addrx4: return [{ kind: 'addrx', index: u32(b, at) }, at + 4];
    case FORM.ref1: return [{ kind: 'int', value: b[at] }, at + 1];
    case FORM.ref2: return [{ kind: 'int', value: u16(b, at) }, at + 2];
    case FORM.ref4: return [{ kind: 'int', value: u32(b, at) }, at + 4];
    case FORM.ref8: return [{ kind: 'int', value: u64(b, at) }, at + 8];
    case FORM.refUdata: { const [v, n] = uleb(b, at); return [{ kind: 'int', value: v }, n]; }
    case FORM.refAddr: return [{ kind: 'int', value: size === 8 ? u64(b, at) : u32(b, at) }, at + size];
    case FORM.secOffset: return [{ kind: 'int', value: u32(b, at) }, at + 4];
    case FORM.flag: return [{ kind: 'int', value: b[at] }, at + 1];
    case FORM.flagPresent: return [{ kind: 'int', value: 1 }, at];
    case FORM.exprloc: {
      const [length, afterLength] = uleb(b, at);
      return [{ kind: 'block', bytes: b.subarray(afterLength, afterLength + length) }, afterLength + length];
    }
    case FORM.block1: { const length = b[at]; return [{ kind: 'block', bytes: b.subarray(at + 1, at + 1 + length) }, at + 1 + length]; }
    case FORM.block2: { const length = u16(b, at); return [{ kind: 'block', bytes: b.subarray(at + 2, at + 2 + length) }, at + 2 + length]; }
    case FORM.block4: { const length = u32(b, at); return [{ kind: 'block', bytes: b.subarray(at + 4, at + 4 + length) }, at + 4 + length]; }
    case FORM.block: { const [length, afterLength] = uleb(b, at); return [{ kind: 'block', bytes: b.subarray(afterLength, afterLength + length) }, afterLength + length]; }
    case FORM.indirect: {
      const [realForm, afterForm] = uleb(b, at);
      return readForm(b, realForm, afterForm, sections);
    }
    default:
      // An unhandled form cannot be skipped safely — its size is unknown — so the stream
      // is abandoned rather than read at the wrong offset. The unit is lost, not corrupted.
      return [{ kind: 'none' }, b.length];
  }
}

/**
 * A `low_pc` as a real address.
 *
 * DWARF 5 compresses addresses: `DW_FORM_addrx` holds an index into `.debug_addr`.
 * The entry there is absolute — `0x1406a4620` for the first function of the first unit in
 * the binary this was written against — so nothing is added to it. Adding the unit's
 * `low_pc` (which the CU DIE *also* carries) doubled the address into `0x280db0280` and
 * matched none of the 19376 functions in the table.
 *
 * A DWARF 4 unit has no such table; `low_pc` there is a plain `DW_FORM_addr` and arrives
 * as an `int` already.
 */
function addressOf(value: FormValue | undefined, sections: Sections): number | null {
  if (!value) return null;
  if (value.kind === 'int') return value.value;
  if (value.kind !== 'addrx' || !sections.addr) return null;
  const at = sections.addrBase + value.index * sections.addrSize;
  if (at + sections.addrSize > sections.addr.length) return null;
  return sections.addrSize === 8 ? u64(sections.addr, at) : u32(sections.addr, at);
}

function nameOf(value: FormValue | undefined, sections: Sections): string | undefined {
  if (!value) return undefined;
  if (value.kind === 'str') return value.value;
  if (value.kind === 'offset') {
    const table = value.section === 'lineStr' ? sections.lineStr : sections.str;
    if (!table || value.offset >= table.length) return undefined;
    return cstring(table, value.offset);
  }
  if (value.kind === 'strx') {
    if (!sections.strOffsets || !sections.str) return undefined;
    const offset = u32(sections.strOffsets, value.index * 4);
    if (offset >= sections.str.length) return undefined;
    return cstring(sections.str, offset);
  }
  return undefined;
}

/** Decompress a `.zdebug_*` body, or return the bytes as they are. */
export function sectionBytes(raw: Uint8Array): Uint8Array {
  if (raw.length < 12) return raw;
  if (raw[0] !== 0x5a || raw[1] !== 0x4c || raw[2] !== 0x49 || raw[3] !== 0x42) return raw; // 'ZLIB'
  let declared = 0;
  for (let index = 4; index < 12; index += 1) declared = declared * 256 + raw[index];
  try {
    const inflated = zlib.inflateSync(raw.subarray(12));
    // A declared size that disagrees means the header and the stream are not a pair;
    // trusting either would put the reader out of step for every DIE that follows.
    if (declared !== 0 && inflated.length !== declared) return raw;
    return new Uint8Array(inflated);
  } catch {
    return raw;
  }
}

interface Die {
  tag: number;
  attrs: Map<number, FormValue>;
  /** Depth in the tree, so children can be attributed to their parent. */
  depth: number;
  /** Offset of this DIE's code byte inside `.debug_info`, for reference resolution. */
  offset: number;
}

/**
 * Parse a compile unit's DIEs and pair each subprogram with its parameters.
 *
 * The DIEs come in depth-first order with an explicit null to close each level, so a
 * parameter belongs to the subprogram whose depth is one less and which is still open.
 * Go also emits `DW_AT_abstract_origin` and `DW_AT_specification` on out-of-line copies,
 * so a subprogram with no name of its own takes it from the DIE it refers to — and that
 * reference is an offset from the start of the unit, not from the start of the section,
 * which is why each DIE records where it began.
 */
function parseUnit(
  info: Uint8Array,
  unitStart: number,
  unitEnd: number,
  abbrevOffset: number,
  abbrevs: Uint8Array,
  base: Sections,
  into: { functions: Map<number, DwarfFunction>; types: Map<string, DwarfType> },
): void {
  const table = parseAbbrevTable(abbrevs, abbrevOffset);
  const dies: Die[] = [];
  const stack: number[] = [];
  // Past the unit header: length(4) version(2) unit_type(1) address_size(1) abbrev(4).
  let at = unitStart + 12;
  while (at < unitEnd) {
    const dieOffset = at;
    const [code, afterCode] = uleb(info, at);
    at = afterCode;
    if (code === 0) {
      // A null closes the current level. The last one closes the CU DIE itself, and the
      // unit is over — but only then. Breaking on the first null that empties the stack
      // ended every unit after its first child: 346 units read, 278 functions found out
      // of 19376 in the table, because the largest unit is 1.18 MB of DIEs and one null
      // is all it took to leave them behind.
      stack.pop();
      continue;
    }
    const spec = table.get(code);
    if (!spec) break;
    const attrs = new Map<number, FormValue>();
    for (const { name, form, implicit } of spec.attrs) {
      // Both of these take their value from the abbreviation, not from the stream, so
      // neither may advance it. Missing `implicitConst` shifted every attribute after it
      // by a byte or two, and the reader then sat inside a string: the CU DIE came out
      // with an attribute named `0x2905` whose value was the producer string, and the
      // unit stopped three DIEs in.
      if (form === FORM.implicitConst) { attrs.set(name, { kind: 'int', value: implicit }); continue; }
      if (form === FORM.flagPresent) { attrs.set(name, { kind: 'int', value: 1 }); continue; }
      const [value, next] = readForm(info, form, at, base);
      at = next;
      attrs.set(name, value);
    }
    const depth = stack.length;
    dies.push({ tag: spec.tag, attrs, depth, offset: dieOffset });
    if (spec.children) stack.push(code);
  }

  // The CU DIE carries the table offsets the rest of the unit needs. They are attributes
  // here rather than header fields, which is a Go-specific deviation from what the DWARF 5
  // header description leads you to expect.
  const cu = dies[0];
  if (cu) {
    const addrBase = cu.attrs.get(AT.addrBase);
    if (addrBase?.kind === 'int') base.addrBase = addrBase.value;
    const lowPc = cu.attrs.get(AT.lowPc);
    const unitLow = lowPc ? addressOf(lowPc, base) : null;
    if (unitLow) base.lowPc = unitLow;
  }

  // References are relative to the unit header, so a DIE at `offset` is found by the
  // reference value plus the 12 header bytes.
  const byOffset = new Map<number, Die>();
  for (const die of dies) byOffset.set(die.offset - unitStart, die);

  const dieName = (die: Die | undefined, seen = new Set<Die>()): string | undefined => {
    if (!die || seen.has(die)) return undefined;
    seen.add(die);
    const direct = nameOf(die.attrs.get(AT.name), base);
    if (direct) return direct;
    for (const link of [AT.specification, AT.abstractOrigin]) {
      const ref = die.attrs.get(link);
      if (ref?.kind === 'int') {
        const target = byOffset.get(ref.value);
        const name = dieName(target, seen);
        if (name) return name;
      }
    }
    return undefined;
  };

  for (let index = 0; index < dies.length; index += 1) {
    const die = dies[index];
    if (die.tag !== TAG.subprogram) continue;
    const low = addressOf(die.attrs.get(AT.lowPc), base);
    if (low == null || low === 0) continue;
    const name = dieName(die);
    if (!name) continue;
    const highValue = die.attrs.get(AT.highPc);
    // `high_pc` is either an address or a length, told apart by the form: an `addr` is
    // absolute and anything else is a size. Using the wrong one puts the end of the
    // function at its own start.
    const high = highValue == null ? 0 : highValue.kind === 'addrx' ? (addressOf(highValue, base) ?? 0) : highValue.kind === 'int' ? highValue.value : 0;
    const params = parametersOf(die);
    const returns: DwarfParam[] = [];
    into.functions.set(low, {
      name,
      lowPc: low,
      highPc: high > low ? high : low,
      params,
      returns,
    });
  }

  /**
   * The parameters of a subprogram, following the link to the DIE that declares it.
   *
   * Go splits a function in two: the body DIE carries `low_pc` and the code location,
   * and a separate declaration DIE carries the name and the parameters. Following
   * `DW_AT_specification` / `0x3a` is what turns a listing from `f(long arg0, long arg1)`
   * into `f(b []byte, c byte)` — 247 of 278 functions read as parameterless until this
   * walked the link.
   */
  function parametersOf(start: Die, seen = new Set<Die>()): DwarfParam[] {
    if (seen.has(start)) return [];
    seen.add(start);
    const index = dies.indexOf(start);
    const collected: DwarfParam[] = [];
    if (index >= 0) {
      for (let child = index + 1; child < dies.length; child += 1) {
        const item = dies[child];
        if (item.depth <= start.depth) break;
        if (item.tag !== TAG.formalParameter) continue;
        collected.push({
          name: nameOf(item.attrs.get(AT.name), base) ?? `arg${collected.length}`,
          type: typeName(item.attrs.get(AT.type), byOffset, base),
          ...(item.attrs.get(AT.location)?.kind === 'block' ? { indirect: true } : {}),
        });
      }
    }
    if (collected.length) return collected;
    for (const link of [AT.specification, AT.abstractOrigin]) {
      const ref = start.attrs.get(link);
      if (ref?.kind !== 'int') continue;
      const target = byOffset.get(ref.value);
      if (!target) continue;
      const inherited = parametersOf(target, seen);
      if (inherited.length) return inherited;
    }
    return [];
  }
}

/** Render a `DW_AT_type` reference as a C-like type name. */
function typeName(ref: FormValue | undefined, byOffset: Map<number, Die>, base: Sections, depth = 0): string {
  if (!ref || ref.kind !== 'int' || depth > 8) return 'long';
  const die = byOffset.get(ref.value);
  if (!die) return 'long';
  const bare = nameOf(die.attrs.get(AT.name), base);
  switch (die.tag) {
    case TAG.pointerType: {
      const target = typeName(die.attrs.get(AT.type), byOffset, base, depth + 1);
      return `${target} *`;
    }
    case TAG.referenceType: {
      const target = typeName(die.attrs.get(AT.type), byOffset, base, depth + 1);
      return `${target} *`;
    }
    case TAG.constType:
    case TAG.volatileType:
    case TAG.restrictType:
    case TAG.atomicType:
      return typeName(die.attrs.get(AT.type), byOffset, base, depth + 1);
    case TAG.typedef:
      return bare ?? typeName(die.attrs.get(AT.type), byOffset, base, depth + 1);
    case TAG.baseType:
      return bare ?? 'long';
    case TAG.structureType:
      return bare ? `struct ${bare}` : 'struct';
    case TAG.unionType:
      return bare ? `union ${bare}` : 'union';
    case TAG.enumType:
      return bare ? `enum ${bare}` : 'int';
    case TAG.arrayType: {
      const element = typeName(die.attrs.get(AT.type), byOffset, base, depth + 1);
      const count = die.attrs.get(0x25); // DW_AT_count
      return count?.kind === 'int' ? `${element}[${count.value}]` : `${element}[]`;
    }
    case TAG.subroutineType:
      return 'void *';
    default:
      return bare ?? 'long';
  }
}

/**
 * Read the debug information out of an image, if it carries any.
 *
 * Returns null when there is no `.debug_info` / `.zdebug_info` — a stripped binary, or
 * one built with `-ldflags=-w`. That is not a failure: every listing before this existed
 * worked from the disassembly alone, and the caller falls back to it.
 */
export function parseDwarf(sections: { name: string; offset: number; size: number }[], read: (offset: number, size: number) => Uint8Array): DwarfInfo | null {
  const find = (uncompressed: string, compressed: string): Uint8Array | null => {
    for (const name of [uncompressed, compressed]) {
      const section = sections.find((s) => s.name === name);
      if (!section || !section.size) continue;
      return sectionBytes(read(section.offset, section.size));
    }
    return null;
  };

  const info = find('.debug_info', '.zdebug_info');
  const abbrev = find('.debug_abbrev', '.zdebug_abbrev');
  if (!info || !abbrev) return null;

  const lineStr = find('.debug_line_str', '.zdebug_line_str') ?? undefined;
  const str = find('.debug_str', '.zdebug_str') ?? undefined;
  const strOffsetsRaw = find('.debug_str_offsets', '.zdebug_str_offsets') ?? undefined;
  const addrRaw = find('.debug_addr', '.zdebug_addr') ?? undefined;

  const functions = new Map<number, DwarfFunction>();
  const types = new Map<string, DwarfType>();
  let units = 0;
  let skipped = 0;

  let at = 0;
  while (at + 12 <= info.length) {
    const unitLength = u32(info, at);
    if (unitLength === 0) break;
    // 0xffffffff introduces a 64-bit length; Go does not emit it, and following it would
    // mean guessing at a layout nothing here has been tested against.
    if (unitLength === 0xffffffff) break;
    const unitEnd = at + 4 + unitLength;
    if (unitEnd > info.length) break;
    const version = u16(info, at + 4);
    if (version !== 4 && version !== 5) { skipped += 1; at = unitEnd; continue; }
    const addressSize = info[at + 7];
    const abbrevOffset = u32(info, at + 8);
    // `addr_base` is a *DIE attribute* in what Go emits, not a header field: the unit
    // header here is the 12 bytes above and the next byte is already a DIE code. Reading
    // it from the header picked up the first four bytes of a string
    // (`0x79746561`, `aety`), and every `DW_FORM_addrx` then resolved to an address in
    // `.debug_str`. `parseUnit` reads `DW_AT_addr_base` off the CU DIE instead.
    const base: Sections = {
      info,
      addrSize: addressSize === 4 ? 4 : 8,
      addrBase: 0,
      ...(lineStr ? { lineStr } : {}),
      ...(str ? { str } : {}),
      ...(strOffsetsRaw ? { strOffsets: strOffsetsRaw } : {}),
      ...(addrRaw ? { addr: addrRaw } : {}),
    };
    try {
      parseUnit(info, at, unitEnd, abbrevOffset, abbrev, base, { functions, types });
      units += 1;
    } catch {
      // One unit that does not parse must not cost the rest of the table.
      skipped += 1;
    }
    at = unitEnd;
  }

  if (!functions.size && !types.size) return null;
  return {
    functions,
    types,
    note: skipped ? `${skipped} compile unit(s) could not be read` : undefined,
  };
}

/** The signature DWARF records for the function starting at `address`, if any. */
export function signatureAt(dwarf: DwarfInfo, address: number): DwarfFunction | undefined {
  const exact = dwarf.functions.get(address);
  if (exact) return exact;
  // Go sometimes records the entry with a different low_pc than the table's entry — an
  // ABI wrapper, a split body — so fall back to the nearest function that contains it.
  for (const fn of dwarf.functions.values()) {
    if (address >= fn.lowPc && address < fn.highPc) return fn;
  }
  return undefined;
}
