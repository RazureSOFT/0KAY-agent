/**
 * Recursive traversal disassembly: start at a known function entry and follow
 * control flow, rather than sweeping the section from byte zero.
 *
 * A linear sweep over `.text` decodes embedded data as instructions. Starting
 * at an entry and following branches is what turns "21% unknown" into a real
 * function listing. Calls are NOT followed (they belong to other functions);
 * conditional branches fork; unconditional jumps follow their target.
 */
import { decodeOne, formatInstruction } from './decode.js';
import type { Instruction } from './decode.js';

export interface DisassembledFunction {
  entry: number;
  name: string;
  instructions: Instruction[];
  /** Addresses that could not be reached as code but were referenced. */
  unresolved: number[];
  unknown: number;
  truncated: boolean;
  listing: string;
}

export interface WalkOptions {
  name?: string;
  /** Exclusive upper bound, normally the next function's entry. */
  end?: number;
  maxInstructions?: number;
  /** Never walk further than this many bytes from the entry without an end. */
  maxSpan?: number;
}

function branchTarget(instruction: Instruction): number | null {
  for (const operand of instruction.operands) {
    if (operand.kind === 'rel' && Number.isFinite(operand.target)) return operand.target as number;
  }
  return null;
}

export function disassembleFunction(
  code: Uint8Array,
  baseVaddr: number,
  entry: number,
  options: WalkOptions = {},
): DisassembledFunction {
  const maxInstructions = Math.max(1, Math.min(options.maxInstructions ?? 4000, 50_000));
  const end = options.end && options.end > entry
    ? Math.min(options.end, baseVaddr + code.length)
    : baseVaddr + code.length;
  const hardEnd = Math.min(end, entry + (options.maxSpan ?? 1 << 20));
  const worklist: number[] = [entry];
  const visited = new Set<number>();
  const found: Instruction[] = [];
  const unresolved = new Set<number>();
  let unknown = 0;
  let truncated = false;

  const inRange = (address: number) => address >= baseVaddr && address < hardEnd && address - baseVaddr < code.length;
  const accept = (address: number | null) => {
    if (address == null) return;
    if (inRange(address)) worklist.push(address);
    else unresolved.add(address);
  };

  while (worklist.length) {
    if (found.length >= maxInstructions) { truncated = true; break; }
    const address = worklist.pop() as number;
    if (visited.has(address)) continue;
    if (!inRange(address)) { unresolved.add(address); continue; }
    visited.add(address);
    const offset = address - baseVaddr;
    const instruction = decodeOne(code, offset, address);
    if (!instruction || instruction.length <= 0) { truncated = true; break; }
    found.push(instruction);
    if (instruction.unknown) {
      unknown++;
      // An undecodable byte is data or an opcode we do not know. Continuing
      // linearly from here is exactly the mistake this traversal avoids.
      continue;
    }

    const flow = instruction.flow;
    const fallthrough = address + instruction.length;
    if (flow === 'ret' || flow === 'stop') continue;
    if (flow === 'jump') {
      accept(branchTarget(instruction));
      continue;
    }
    if (flow === 'condition') {
      accept(branchTarget(instruction));
    }
    // calls, syscalls, ints and ordinary instructions all fall through; a
    // call target is another function and must not be walked from here.
    accept(fallthrough);
  }

  found.sort((a, b) => a.address - b.address);
  const name = options.name || `sub_${entry.toString(16)}`;
  return {
    entry,
    name,
    instructions: found,
    unresolved: [...unresolved].sort((a, b) => a - b),
    unknown,
    truncated,
    listing: `${name} @ 0x${entry.toString(16)}:\n` + found.map((i) => formatInstruction(i)).join('\n'),
  };
}

/** Unknown ratio is the honest measure of whether a starting point was real code. */
export function coverageOf(fn: DisassembledFunction): { instructions: number; unknown: number; unknownPct: number } {
  const total = fn.instructions.length;
  return {
    instructions: total,
    unknown: fn.unknown,
    unknownPct: total ? Math.round((fn.unknown / total) * 1000) / 10 : 0,
  };
}
