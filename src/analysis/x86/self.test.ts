import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseImage, vaddrToOffset, executableSections } from './image.js';
import { parsePclntab } from './pclntab.js';
import { parseSymbols, functionAt } from './symbols.js';
import { disassembleFunction, coverageOf } from './function.js';
import { buildCfg, cfgSummary } from './cfg.js';
import { toPseudoC } from './pseudoc.js';
import { BinaryAnalysisTool } from '../../tools/binary_analysis.js';
import { createDefaultRegistry } from '../../tools/tools.js';
import type { ToolContext } from '../../tools/types.js';

const ctx = (cwd: string): ToolContext => ({ cwd, taskId: 't', agentType: 'general' }) as ToolContext;

/** mov rax,42; cmp rax,42; je +3; inc rax; ret */
const FUNCTION_BYTES = new Uint8Array([
  0x48, 0xc7, 0xc0, 0x2a, 0x00, 0x00, 0x00,
  0x48, 0x83, 0xf8, 0x2a,
  0x74, 0x03,
  0x48, 0xff, 0xc0,
  0xc3,
]);

/** A minimal ELF64 with .text, .symtab, .strtab and .shstrtab. */
export function makeElf(): Buffer {
  const b = Buffer.alloc(0x500);
  b[0] = 0x7f; b[1] = 0x45; b[2] = 0x4c; b[3] = 0x46;
  b[4] = 2; b[5] = 1; b[6] = 1;
  b.writeUInt16LE(2, 16);       // ET_EXEC
  b.writeUInt16LE(62, 18);      // EM_X86_64
  b.writeUInt32LE(1, 20);
  b.writeBigUInt64LE(0x401000n, 24); // e_entry
  b.writeBigUInt64LE(64n, 40);       // e_shoff
  b.writeUInt16LE(64, 52);           // e_ehsize
  b.writeUInt16LE(64, 58);           // e_shentsize
  b.writeUInt16LE(5, 60);            // e_shnum
  b.writeUInt16LE(2, 62);            // e_shstrndx
  const names = '\0.text\0.shstrtab\0.symtab\0.strtab\0';
  const nameOff = (value: string) => names.indexOf(value);
  const sh = (index: number, values: Record<number, number | bigint>) => {
    const o = 64 + index * 64;
    for (const [off, value] of Object.entries(values)) {
      const at = o + Number(off);
      if (typeof value === 'bigint') b.writeBigUInt64LE(value, at);
      else if (off === '8' || off === '16' || off === '24' || off === '32' || off === '56') b.writeBigUInt64LE(BigInt(value), at);
      else if (off === '0' || off === '4' || off === '40' || off === '44' || off === '48') b.writeUInt32LE(value, at);
      else b.writeUInt16LE(value, at);
    }
  };
  // null section
  sh(0, {});
  // Section headers occupy 64..384, so the earliest safe file offset is 0x200.
  // 1: .text — PROGBITS, ALLOC|EXECINSTR, addr 0x401000, file offset 0x400
  sh(1, { 0: nameOff('.text'), 4: 1, 8: 6n, 16: 0x401000n, 24: 0x400n, 32: FUNCTION_BYTES.length, 48: 16 });
  // 2: .shstrtab — STRTAB
  sh(2, { 0: nameOff('.shstrtab'), 4: 3, 24: 0x200n, 32: names.length });
  // 3: .symtab — SYMTAB, link 4 (.strtab), entsize 24
  sh(3, { 0: nameOff('.symtab'), 4: 2, 24: 0x300n, 32: 48, 40: 4, 48: 8, 56: 24n });
  // 4: .strtab — STRTAB
  sh(4, { 0: nameOff('.strtab'), 4: 3, 24: 0x480n, 32: 8 });
  b.write(names, 0x200, 'latin1');
  Buffer.from(FUNCTION_BYTES).copy(b, 0x400);
  // symbol 1: name "main", GLOBAL|FUNC, shndx 1, value 0x401000, size 0x20
  const sym = 0x300 + 24;
  b.writeUInt32LE(1, sym);
  b[sym + 4] = 0x12;
  b.writeUInt16LE(1, sym + 6);
  b.writeBigUInt64LE(0x401000n, sym + 8);
  b.writeBigUInt64LE(0x20n, sym + 16);
  b.write('\0main\0', 0x480, 'latin1');
  return b;
}

/** One go116-style pcHeader, its functab, one _func and the name table. */
function makePclntab(): Uint8Array {
  const b = new Uint8Array(120);
  const u32 = (o: number, v: number) => { b[o] = v & 255; b[o + 1] = (v >>> 8) & 255; b[o + 2] = (v >>> 16) & 255; b[o + 3] = (v >>> 24) & 255; };
  const u64 = (o: number, v: number) => { u32(o, v); u32(o + 4, 0); };
  u32(0, 0xfffffff1);
  b[6] = 1; b[7] = 8;
  u64(8, 1);              // nfunc
  u64(24, 0x401000);      // textStart
  u64(32, 72);            // funcnameOffset
  u64(64, 80);            // pclnOffset
  // funcnametab at 72: \0main\0
  Buffer.from('\0main\0').copy(b, 72);
  // functab at 80: two entries of (entryoff, funcoff)
  u32(80, 0); u32(84, 16);
  u32(88, 0x20); u32(92, 0);
  // _func at 96: entryOff, nameOff
  u32(96, 0); u32(100, 1);
  return b;
}

test('image parsing finds executable sections and maps addresses to file offsets', () => {
  const image = parseImage(makeElf());
  assert.equal(image.format, 'elf');
  assert.equal(image.bits, 64);
  assert.equal(image.entryVaddr, 0x401000);
  assert.equal(image.sections.length, 5);
  const text = image.sections.find((s) => s.name === '.text');
  assert.ok(text);
  assert.equal(text.executable, true);
  assert.equal(executableSections(image)[0].name, '.text');
  assert.equal(vaddrToOffset(0x401000, image.sections), 0x400);
  assert.equal(vaddrToOffset(0x999999, image.sections), -1);
  assert.equal(image.symbols?.kind, 'elf');
});

test('symbol tables produce real function ranges and address lookup', () => {
  const bytes = makeElf();
  const image = parseImage(bytes);
  const functions = parseSymbols(bytes, image);
  assert.equal(functions.length, 1);
  assert.equal(functions[0].name, 'main');
  assert.equal(functions[0].entry, 0x401000);
  assert.equal(functions[0].end, 0x401020);
  assert.equal(functions[0].size, 0x20);
  assert.equal(functionAt(functions, 0x401010)?.name, 'main');
  assert.equal(functionAt(functions, 0x401020), undefined);
});

test('the Go function table yields names and entry points', () => {
  const table = parsePclntab(makePclntab());
  assert.equal(table.functions.length, 1);
  assert.equal(table.functions[0].name, 'main');
  assert.equal(table.functions[0].entry, 0x401000);
  assert.equal(table.functions[0].size, 0x20);
  assert.equal(parsePclntab(new Uint8Array(8)).note, 'pclntab is too short to hold a header');
  assert.match(parsePclntab(new Uint8Array(80)).note || '', /unsupported pclntab magic/);
});

test('recursive traversal decodes from an entry without sweeping data', () => {
  const fn = disassembleFunction(FUNCTION_BYTES, 0x1000, 0x1000, { name: 'main' });
  assert.equal(fn.name, 'main');
  assert.equal(fn.instructions.length, 5, 'both sides of the branch are reached');
  assert.equal(coverageOf(fn).unknownPct, 0);
  assert.equal(fn.truncated, false);
  assert.deepEqual(fn.instructions.map((i) => i.address - 0x1000), [0, 7, 11, 13, 16]);
  assert.match(fn.listing, /ret/);
  // A declared function end must stop the walk, so a function table range
  // cannot bleed into the next function's bytes.
  const bounded = disassembleFunction(FUNCTION_BYTES, 0x1000, 0x1000, { name: 'bounded', end: 0x100d });
  assert.ok(bounded.instructions.length < fn.instructions.length);
  assert.equal(bounded.unresolved.length > 0, true, 'the skipped branch target is reported, not hidden');
});

test('basic blocks carry both branch edges and pseudo-C keeps unknown opcodes', () => {
  const fn = disassembleFunction(FUNCTION_BYTES, 0x1000, 0x1000, { name: 'main' });
  const blocks = buildCfg(fn.instructions);
  assert.equal(blocks.length, 3);
  assert.equal(cfgSummary(blocks).edges, 3);
  assert.equal(cfgSummary(blocks).exits, 1);
  assert.equal(blocks[0].successors.length, 2, 'the conditional forks');
  const rendered = toPseudoC(fn, blocks);
  assert.match(rendered, /goto L_1010/);
  assert.match(rendered, /return;/);
  assert.match(rendered, /Reading aid only/);
  assert.ok(buildCfg([]).length === 0);
});

test('binary_analyze is registered and reads a real ELF without inventing results', async () => {
  const registry = createDefaultRegistry();
  const tool = registry.get('binary_analyze');
  assert.ok(tool, 'binary_analyze is missing from the default registry');
  assert.ok(tool instanceof BinaryAnalysisTool);

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), '0kay-binary-'));
  const file = path.join(dir, 'sample.elf');
  await fs.writeFile(file, makeElf());
  try {
    const summary = await tool!.execute({ action: 'summary', path: file }, ctx(dir));
    assert.equal(summary.success, true, summary.error);
    assert.equal(summary.data.format, 'elf');
    assert.equal(summary.data.functionCount, 1);
    assert.match(summary.data.entrySource, /symbol table/);

    const functions = await tool!.execute({ action: 'functions', path: file }, ctx(dir));
    assert.equal(functions.data.total, 1);
    assert.equal(functions.data.functions[0].name, 'main');

    const disasm = await tool!.execute({ action: 'disasm', path: file, functionName: 'main' }, ctx(dir));
    assert.equal(disasm.success, true, disasm.error);
    assert.equal(disasm.data.instructions, 5);
    assert.equal(disasm.data.unknownPct, 0);

    const cfg = await tool!.execute({ action: 'cfg', path: file, functionName: 'main' }, ctx(dir));
    assert.equal(cfg.success, true, cfg.error);
    assert.equal(cfg.data.summary.blocks, 3);
    assert.equal(Array.isArray(cfg.data.blocks), true);

    const pseudoc = await tool!.execute({ action: 'pseudoc', path: file, functionName: 'main' }, ctx(dir));
    assert.match(pseudoc.data.pseudoc, /return;/);

    const missing = await tool!.execute({ action: 'disasm', path: file, functionName: 'does-not-exist' }, ctx(dir));
    assert.equal(missing.success, false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
