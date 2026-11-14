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
import { parseImage, executableSections, sectionNamed } from '../analysis/x86/image.js';
import type { Section } from '../analysis/x86/image.js';
import { parsePclntab } from '../analysis/x86/pclntab.js';
import { parseSymbols, functionAt } from '../analysis/x86/symbols.js';
import type { FunctionEntry } from '../analysis/x86/symbols.js';
import { disassembleFunction, coverageOf } from '../analysis/x86/function.js';
import { buildCfg, cfgSummary } from '../analysis/x86/cfg.js';
import { toPseudoC } from '../analysis/x86/pseudoc.js';

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
  // On PE the Go function table is folded into .rdata with a layout that moves
  // between releases. The linker's symbol table is the stable, documented
  // source of function entry points there.
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
      'Select a function with functionName or address (decimal or 0x hex). Every result states which entry-point source was used; without one only the image entry is walked.',
    ].join(' ');
  }
  get parameters(): Record<string, any> {
    return { type: 'object', required: ['action', 'path'], properties: {
      action: { type: 'string', enum: ['summary', 'functions', 'disasm', 'cfg', 'pseudoc'] },
      path: { type: 'string', description: 'Binary to inspect, absolute or workspace-relative.' },
      functionName: { type: 'string', description: 'Substring of a function name.' },
      address: { type: 'string', description: 'Hex (0x...) or decimal virtual address.' },
      limit: { type: 'integer', minimum: 1, maximum: 20000, description: 'Maximum instructions / functions to return.' },
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
