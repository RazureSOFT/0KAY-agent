/**
 * Self-contained binary analysis. No external decompiler is involved: the
 * container is parsed here, Go's function table supplies real entry points
 * when present, and disassembly follows control flow from those entries.
 *
 * The tool always says which source of entry points it used. Reporting a
 * linear sweep from the image entry as if it were a function list would be a
 * fabricated result.
 */
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { Tool, type ToolContext, type ToolResult } from './types.js';
import { success, failure } from './helpers.js';
import { parseImage, executableSections, sectionNamed, vaddrToOffset } from '../analysis/x86/image.js';
import type { Section } from '../analysis/x86/image.js';
import { parsePclntab, findPclntab } from '../analysis/x86/pclntab.js';
import { sanitiseName } from '../analysis/x86/ir.js';
import { parseSymbols, functionAt } from '../analysis/x86/symbols.js';
import type { FunctionEntry } from '../analysis/x86/symbols.js';
import { disassembleFunction, coverageOf } from '../analysis/x86/function.js';
import { uniqueNames } from './unique_names.js';
import { parseDwarf, signatureAt } from '../analysis/x86/dwarf.js';
import { buildCfg, cfgSummary } from '../analysis/x86/cfg.js';
import { toPseudoC } from '../analysis/x86/pseudoc.js';
import { decompileFunction } from '../analysis/x86/decompile.js';
import { scanCallGraph, callersOf, calleesOf } from '../analysis/x86/xref.js';

const MAX_FILE_BYTES = 128 * 1024 * 1024;

interface Loaded {
  path: string;
  bytes: Buffer;
  image: ReturnType<typeof parseImage>;
  functions: FunctionEntry[];
  entrySource: string;
  note?: string;
  textStart: number;
}

function codeSection(image: Loaded['image'], address: number): Section | undefined {
  const candidates = executableSections(image);
  return candidates.find((s) => address >= s.vaddr && address < s.vaddr + s.size)
    || candidates[0];
}

async function load(target: string): Promise<Loaded> {
  const stat = await fs.stat(target);
  if (!stat.isFile()) throw new Error('path is not a file');
  if (stat.size > MAX_FILE_BYTES) throw new Error(`file is larger than ${MAX_FILE_BYTES} bytes`);
  const bytes = await fs.readFile(target);
  const image = parseImage(bytes);
  let functions: FunctionEntry[] = [];
  let entrySource = 'image entry point only';
  let note: string | undefined = image.note;
  let textStart = image.entryVaddr;

  const pcln = sectionNamed(image, /gopclntab/i);
  if (pcln && pcln.offset + pcln.size <= bytes.length) {
    const table = parsePclntab(bytes.subarray(pcln.offset, pcln.offset + pcln.size));
    if (table.functions.length) {
      functions = table.functions.map((fn) => ({ ...fn, source: 'go-pclntab' as const }));
      textStart = table.textStart;
      entrySource = `Go function table (${table.functions.length} functions)`;
      if (table.note) note = [note, table.note].filter(Boolean).join('; ');
    } else {
      note = [note, table.note || 'Go function table had no readable functions'].filter(Boolean).join('; ');
    }
  }
  // On PE the table is folded into .rdata, beside the type metadata, so there is no
  // section to look for by name. Scan for it before falling back to the linker's
  // symbol table: on the binary this was measured against the table has 2436 more
  // functions than the symbol table does, and the extra ones are real.
  if (!functions.length) {
    for (const section of image.sections) {
      if (section.size <= 0 || section.offset < 0 || section.offset + section.size > bytes.length) continue;
      const slice = bytes.subarray(section.offset, section.offset + section.size);
      // The table's own textStart is zero on PE: the entries are offsets from the
      // image base rather than from a field in the header. Leaving it at zero made
      // every function start at address 0, and the disassembler then produced one
      // instruction per function. The section the code lives in is the base.
      const codeSection = image.sections.find((s) => s.executable && s.size > 0);
      const found = findPclntab(slice, codeSection?.vaddr);
      if (!found) continue;
      functions = found.functions.map((fn) => ({ ...fn, source: 'go-pclntab' as const }));
      textStart = found.textStart;
      entrySource = `Go function table (${found.functions.length} functions, found in ${section.name})`;
      if (found.note) note = [note, found.note].filter(Boolean).join('; ');
      break;
    }
  }
  if (!functions.length) {
    const symbols = parseSymbols(bytes, image);
    if (symbols.length) {
      functions = symbols;
      entrySource = `${image.format} symbol table (${symbols.length} functions)`;
    }
  }
  return { path: target, bytes, image, functions, entrySource, note, textStart };
}

function parseAddress(value: unknown): number {
  if (typeof value === 'number') return value;
  const text = String(value || '').trim();
  const parsed = /^0x[0-9a-f]+$/i.test(text) ? Number.parseInt(text.slice(2), 16) : Number(text);
  if (!Number.isFinite(parsed)) throw new Error(`invalid address: ${text}`);
  return parsed;
}

function pickFunction(loaded: Loaded, args: Record<string, any>): FunctionEntry {
  if (loaded.functions.length) {
    if (args.functionName) {
      const needle = String(args.functionName).toLowerCase();
      const found = loaded.functions.find((fn) => fn.name.toLowerCase().includes(needle));
      if (found) return found;
      throw new Error(`no function matches ${args.functionName}`);
    }
    if (args.address != null) {
      const address = parseAddress(args.address);
      const found = functionAt(loaded.functions, address);
      if (found) return found as FunctionEntry;
    }
    return loaded.functions[0];
  }
  const entry = args.address != null ? parseAddress(args.address) : loaded.image.entryVaddr;
  return { name: `entry_${entry.toString(16)}`, entry, end: 0, size: 0, source: 'go-pclntab' };
}

function walk(loaded: Loaded, fn: FunctionEntry, limit: number) {
  const section = codeSection(loaded.image, fn.entry || loaded.textStart);
  if (!section) throw new Error('no executable section was found in this image');
  // With base = section.vaddr - section.offset, `address - base` is a file
  // offset, so the decoder can read straight from the mapped file.
  const base = section.vaddr - section.offset;
  const address = fn.entry || section.vaddr;
  const end = fn.end > fn.entry ? fn.end : section.vaddr + section.size;
  const result = disassembleFunction(loaded.bytes, base, address, {
    name: fn.name,
    end: Math.min(end, section.vaddr + section.size),
    maxInstructions: limit,
  });
  return { result, section };
}

export class BinaryAnalysisTool extends Tool {
  get name(): string { return 'binary_analyze'; }
  get description(): string {
    return [
      'Analyze an executable with the built-in disassembler. Read-only: the target is never executed.',
      'action=summary reports the container, executable sections and how function entry points were found.',
      'action=functions lists real function entries from the Go function table or the linker symbol table; action=disasm disassembles one function by following control flow from its entry; action=cfg returns basic blocks and edges; action=pseudoc renders a reading aid.',
      'action=decompile prints the function as C: named stack slots and arguments, folded conditions, structured if/while/do, and an unknown comment for anything it cannot express. action=xref reports callers, callees and data references.',
      'Select a function with functionName or address (decimal or 0x hex). Every result states which entry-point source was used; without one only the image entry is walked.',
    ].join(' ');
  }
  get parameters(): Record<string, any> {
    return { type: 'object', required: ['action', 'path'], properties: {
      action: { type: 'string', enum: ['summary', 'functions', 'disasm', 'cfg', 'pseudoc', 'decompile', 'xref'] },
      path: { type: 'string', description: 'Binary to inspect, absolute or workspace-relative.' },
      functionName: { type: 'string', description: 'Substring of a function name.' },
      address: { type: 'string', description: 'Hex (0x...) or decimal virtual address.' },
      limit: { type: 'integer', minimum: 1, maximum: 20000, description: 'Maximum instructions / functions to return.' },
      scanLimit: { type: 'integer', minimum: 1, maximum: 20000, description: 'xref: how many functions to scan for callers (default 500).' },
      out: { type: 'string', description: 'Optional workspace path to write the listing or pseudo-C.' },
    }};
  }
  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    try {
      const target = path.resolve(context.cwd, String(args.path || ''));
      const loaded = await load(target);
      const limit = Math.max(1, Math.min(Number(args.limit) || 400, 20000));
      const base = {
        path: target,
        format: loaded.image.format,
        bits: loaded.image.bits,
        entrySource: loaded.entrySource,
        ...(loaded.note ? { note: loaded.note } : {}),
      };

      let payload: Record<string, any>;
      let text: string | undefined;
      switch (args.action) {
        case 'summary':
          payload = {
            ...base,
            size: loaded.bytes.length,
            imageBase: loaded.image.imageBase,
            entryVaddr: loaded.image.entryVaddr,
            functionCount: loaded.functions.length,
            sections: loaded.image.sections.map((s) => ({ name: s.name, vaddr: `0x${s.vaddr.toString(16)}`, size: s.size, executable: s.executable })),
          };
          break;
        case 'functions': {
          const rows = loaded.functions.length
            ? loaded.functions.slice(0, limit).map((fn) => ({ name: fn.name, entry: `0x${fn.entry.toString(16)}`, size: fn.size }))
            : [{ name: 'entry', entry: `0x${loaded.image.entryVaddr.toString(16)}`, size: 0 }];
          payload = { ...base, total: loaded.functions.length, returned: rows.length, functions: rows };
          break;
        }
        case 'disasm': {
          const fn = pickFunction(loaded, args);
          const { result, section } = walk(loaded, fn, limit);
          payload = {
            ...base,
            function: fn.name,
            entry: `0x${result.entry.toString(16)}`,
            section: section.name,
            ...coverageOf(result),
            unresolved: result.unresolved.map((a) => `0x${a.toString(16)}`),
            truncated: result.truncated,
            listing: result.listing,
          };
          text = result.listing;
          break;
        }
        case 'cfg': {
          const fn = pickFunction(loaded, args);
          const { result, section } = walk(loaded, fn, limit);
          const blocks = buildCfg(result.instructions);
          payload = {
            ...base,
            function: fn.name,
            section: section.name,
            ...coverageOf(result),
            summary: cfgSummary(blocks),
            blocks: blocks.map((block) => ({
              id: block.id, kind: block.kind,
              instructions: block.instructions.length,
              first: `0x${block.start.toString(16)}`,
              last: `0x${block.instructions[block.instructions.length - 1].address.toString(16)}`,
              successors: block.successors.map((i) => blocks[i].id),
            })),
          };
          break;
        }
        case 'pseudoc': {
          const fn = pickFunction(loaded, args);
          const { result } = walk(loaded, fn, limit);
          const rendered = toPseudoC(result, buildCfg(result.instructions));
          payload = { ...base, function: fn.name, ...coverageOf(result), pseudoc: rendered };
          text = rendered;
          break;
        }
        case 'decompile': {
          const fn = pickFunction(loaded, args);
          const section = codeSection(loaded.image, fn.entry || loaded.textStart);
          if (!section) return failure('no executable section was found in this image');
          const imageBase = section.vaddr - section.offset;
          const end = fn.end > fn.entry
            ? Math.min(fn.end, section.vaddr + section.size)
            : section.vaddr + section.size;
          const codes = executableSections(loaded.image).map((s) => [s.vaddr, s.vaddr + s.size] as const);
          const decompiled = decompileFunction(loaded.bytes, imageBase, fn.entry || section.vaddr, {
            name: fn.name,
            end,
            imageFormat: loaded.image.format,
            maxInstructions: limit,
            names: new Map(loaded.functions.map((entry) => [entry.entry, entry.name])),
            readU64At: (address: number) => {
              const offset = vaddrToOffset(address, loaded.image.sections);
              if (offset < 0 || offset + 8 > loaded.bytes.length) return null;
              let value = 0n;
              for (let byte = 7; byte >= 0; byte--) value = (value << 8n) | BigInt(loaded.bytes[offset + byte]);
              return Number(value);
            },
            isCode: (address: number) => codes.some(([from, to]) => address >= from && address < to),
          });
          payload = { ...base, ...decompiled };
          text = decompiled.c;
          break;
        }
        case 'xref': {
          const fn = pickFunction(loaded, args);
          const section = codeSection(loaded.image, fn.entry || loaded.textStart);
          if (!section) return failure('no executable section was found in this image');
          const imageBase = section.vaddr - section.offset;
          const graph = scanCallGraph(loaded.bytes, imageBase, loaded.functions, {
            limit: Math.max(1, Math.min(Number(args.scanLimit) || 500, 20000)),
            isMapped: (address) => loaded.image.sections.some((s) => address >= s.vaddr && address < s.vaddr + s.size),
          });
          const names = uniqueNames(loaded.functions);
          const label = (address: number) => ({ address: `0x${address.toString(16)}`, name: names.get(address) || null });
          const fnEnd = fn.end > fn.entry ? fn.end : Number.POSITIVE_INFINITY;
          const dataRefs = [...graph.dataRefs.entries()]
            .filter(([, instructions]) => instructions.some((address) => address >= fn.entry && address < fnEnd))
            .slice(0, 200)
            .map(([address, instructions]) => ({
              address: `0x${address.toString(16)}`,
              from: instructions.filter((a) => a >= fn.entry && a < fnEnd).map((a) => `0x${a.toString(16)}`),
            }));
          payload = {
            ...base,
            function: fn.name,
            callers: callersOf(graph, fn.entry).map(label),
            callees: calleesOf(graph, fn.entry).map(label),
            dataRefs,
            scanned: graph.scanned,
            total: graph.total,
            truncated: graph.truncated,
          };
          break;
        }
        default:
          return failure(`unknown action: ${args.action}`);
      }

      if (args.out && text) {
        const outPath = path.resolve(context.cwd, String(args.out));
        await fs.mkdir(path.dirname(outPath), { recursive: true });
        await fs.writeFile(outPath, text, 'utf8');
        payload.out = outPath;
      }
      return success(payload);
    } catch (error) { return failure(error); }
  }
}

/**
 * The self-contained decompilation of one binary, for callers that need it as
 * data rather than as a tool result.
 *
 * `reverse_engineer` used to shell out to an installed Ghidra for this. That made
 * a "deeper analysis" flag depend on a 400MB Java suite being on the machine,
 * and when it was not the caller got a note saying so instead of an answer. The
 * pipeline below is ours, always available, and reports the same way whether or
 * not anything else is installed.
 */
/**
 * The call targets a block cannot fall through.
 *
 * Go's runtime panic helpers end the goroutine instead of returning, so the code
 * after them in the same function is entered only on the unwind path. Treating
 * the fall-through as live put `return rbx` into bodies where rbx is the panic
 * value — an unassigned local the reader has no way to explain.
 *
 * The names are the ones the Go runtime uses across releases; the check is by
 * suffix so a package path prefix does not matter.
 */
const NO_RETURN_SUFFIXES = [
  'runtime.gopanic', 'runtime.panicindex', 'panicslice', 'panicdivide',
  'panicoverflow', 'panicshift', 'panicmem', 'panicunsupported',
  // `panicbounds` was missing from the list, so a body ending on
  // `rax = runtime_panicBounds();` read as a function that runs off its end.
  'panicbounds',
  'runtime.throw', 'runtime.fatal', 'runtime.goexit', 'runtime.exit',
  'runtime.morestack', 'morestack_noctxt', 'runtime.sigpanic',
  'runtime.panicdottype', 'runtime.panicnil', 'runtime.unsafe', 'abort',
];

export function collectNoReturnTargets(functions: Array<{ name: string; entry: number }>): Set<string> {
  const targets = new Set<string>();
  for (const fn of functions) {
    const name = fn.name.toLowerCase();
    if (!NO_RETURN_SUFFIXES.some((suffix) => name.includes(suffix.toLowerCase()))) continue;
    // The IR carries the callee's printed name, which is the symbol name run through
    // `sanitiseName` — `runtime.gopanic` prints as `runtime_gopanic`. Adding only the
    // `sub_<address>` spelling meant this set matched nothing once calls started
    // printing names instead of addresses, and every panic path stopped being folded:
    // 14 of 800 functions ended on `rax = runtime_panicBounds();` with no return.
    //
    // The address spelling stays as well, for any path that still names a call by
    // address rather than by symbol.
    targets.add(sanitiseName(fn.name));
    targets.add(`sub_${(fn.entry >>> 0).toString(16)}`);
  }
  return targets;
}

export async function decompileSummary(
  target: string,
  options: {
    maxFunctions?: number;
    functionName?: string;
    maxInstructions?: number;
    /**
     * Skip the DWARF pass. It is on by default: a signature the compiler recorded is
     * better than one inferred from register reads, and the cost is one decompression of
     * the debug sections.
     */
    dwarf?: boolean;
  } = {},
): Promise<{
  format: string;
  bits: number;
  functions: number;
  entrySource: string;
  note?: string;
  sample: Array<{ name: string; entry: string; size: number }>;
  decompiled?: Array<{ name: string; entry: string; c: string; instructions: number; unknownPct: number; blocks: number; loops: number }>;
}> {
  const loaded = await load(target);
  const maxFunctions = Math.max(1, Math.min(options.maxFunctions ?? 200, 20000));
  const section = executableSections(loaded.image)[0];
  const imageBase = section ? section.vaddr - section.offset : 0;

  const picked = options.functionName
    ? loaded.functions.filter((fn) => fn.name.includes(String(options.functionName)))
    : loaded.functions;
  const sample = picked.slice(0, 40).map((fn) => ({
    name: fn.name,
    entry: `0x${fn.entry.toString(16)}`,
    size: fn.end > fn.entry ? fn.end - fn.entry : 0,
  }));

  // Decompiling every function of a large image would take minutes; a sample is
  // enough to show what the pipeline recovers, and naming a function gets that
  // one exactly.
  const budget = options.functionName ? Math.min(picked.length, 8) : 3;
  const decompiled: NonNullable<Awaited<ReturnType<typeof decompileSummary>>['decompiled']> = [];
  const noReturnCalls = collectNoReturnTargets(loaded.functions);
  // Debug information, when the build kept any. It is the only source of parameter names
  // and counts — `_func.args` is zero on a release build — and it may cover only part of
  // the binary, so every use below is conditional.
  const dwarf = options.dwarf === false
    ? null
    : parseDwarf(
      loaded.image.sections.map((s) => ({ name: s.name ?? '', offset: s.offset, size: s.size })),
      (offset, size) => loaded.bytes.subarray(offset, offset + size),
    );
  // Address to name, so a call prints where it goes instead of `sub_40086ee0()`. The
  // list is already in hand — it is where `fn` came from — and names are made unique,
  // because a Go symbol is not: `internal/bytealg.countGeneric` exists once per element
  // size, and a call to the second copy printed as a recursive call to the first.
  const names = uniqueNames(loaded.functions);
  // Jump tables live in `.rdata`, which the function's own `code` window does not cover,
  // so the reader is handed the image's address mapping. Without it every switch in the
  // binary was missed.
  const codeRanges = executableSections(loaded.image).map((s) => [s.vaddr, s.vaddr + s.size] as const);
  const readU64At = (address: number): number | null => {
    const offset = vaddrToOffset(address, loaded.image.sections);
    if (offset < 0 || offset + 8 > loaded.bytes.length) return null;
    let value = 0n;
    for (let byte = 7; byte >= 0; byte--) value = (value << 8n) | BigInt(loaded.bytes[offset + byte]);
    return Number(value);
  };
  const isCode = (address: number): boolean => codeRanges.some(([from, to]) => address >= from && address < to);
  /**
   * The text at a constant address, when there is text there.
   *
   * Go's format tables, error messages and digit strings all live in `.rdata` and are
   * reached through a constant. `0x140756613` is `"0123456789"` in the binary this was
   * written against, and printing the literal alone tells the reader nothing.
   *
   * A Go string is a pointer and a length with no terminator, so the extent has to be
   * inferred: take printable bytes up to a limit, and only accept the result when it ends
   * at something that is not printable. A run that stops at the limit is the middle of
   * something larger and is left alone — reporting half a string as if it were the whole
   * one is worse than reporting none.
   */
  const MAX_TEXT = 120;
  const textAt = (address: number): string | null => {
    const offset = vaddrToOffset(address, loaded.image.sections);
    if (offset < 0 || offset >= loaded.bytes.length) return null;
    const printable = (byte: number): boolean => byte >= 0x20 && byte < 0x7f;
    if (!printable(loaded.bytes[offset])) return null;
    let end = offset;
    while (end < loaded.bytes.length && end - offset < MAX_TEXT && printable(loaded.bytes[end])) end += 1;
    const length = end - offset;
    if (length < 4) return null;
    if (end - offset === MAX_TEXT && end < loaded.bytes.length && printable(loaded.bytes[end])) return null;
    const text = Buffer.from(loaded.bytes.subarray(offset, end)).toString('latin1');
    // A fragment of code or a pointer table reads as printable often enough to matter;
    // requiring it to look like words keeps the output from being noise.
    if (!/[a-zA-Z]{2}/.test(text)) return null;
    return JSON.stringify(text);
  };
  if (section) {
    for (const fn of picked.slice(0, budget)) {
      try {
        const signature = dwarf ? signatureAt(dwarf, fn.entry) : undefined;
        const result = decompileFunction(loaded.bytes, imageBase, fn.entry, {
          // The disambiguated name, so a call to this function lands on it rather than on
          // the same-named copy the table lists first.
          name: names.get(fn.entry) ?? fn.name,
          ...(signature?.params.length ? { signature: { params: signature.params } } : {}),
          textAt,
          end: fn.end > fn.entry ? Math.min(fn.end, section.vaddr + section.size) : section.vaddr + section.size,
          imageFormat: loaded.image.format,
          maxInstructions: options.maxInstructions ?? 2000,
          ...(noReturnCalls.size ? { noReturnCalls } : {}),
          names,
          readU64At,
          isCode,
        });
        decompiled.push({
          name: result.name, entry: `0x${result.entry.toString(16)}`, c: result.c,
          instructions: result.instructions, unknownPct: result.unknownPct, blocks: result.blocks, loops: result.loops,
        });
      } catch { /* one function that cannot be lifted does not fail the summary */ }
    }
  }

  return {
    format: loaded.image.format,
    bits: loaded.image.bits,
    functions: loaded.functions.length,
    entrySource: loaded.entrySource,
    ...(loaded.note ? { note: loaded.note } : {}),
    sample,
    ...(decompiled.length ? { decompiled } : {}),
  };
}
