/**
 * Cross references: who calls this function, what this function calls, and
 * which data addresses the code mentions.
 *
 * Scanning every function in a large image is expensive, so callers pass a
 * limit and get an honest `scanned` count back. A partial index that says how
 * partial it is beats a "complete" one that quietly stopped early.
 */
import { disassembleFunction } from './function.js';
import type { FunctionEntry } from './symbols.js';

export interface CallGraph {
  /** callee entry -> caller entries */
  callers: Map<number, number[]>;
  /** caller entry -> callee entries */
  callees: Map<number, number[]>;
  /** data address -> instruction addresses that mention it */
  dataRefs: Map<number, number[]>;
  scanned: number;
  total: number;
  truncated: boolean;
}

export interface ScanOptions {
  limit?: number;
  maxInstructionsPerFunction?: number;
  /** True when an immediate looks like an address inside a mapped section. */
  isMapped?: (address: number) => boolean;
}

export function scanCallGraph(
  code: Uint8Array,
  baseVaddr: number,
  functions: FunctionEntry[],
  options: ScanOptions = {},
): CallGraph {
  const limit = Math.max(1, Math.min(options.limit ?? 500, functions.length || 1));
  const maxInstructions = options.maxInstructionsPerFunction ?? 800;
  const graph: CallGraph = {
    callers: new Map(), callees: new Map(), dataRefs: new Map(),
    scanned: 0, total: functions.length, truncated: functions.length > limit,
  };
  const known = new Set(functions.map((fn) => fn.entry));

  for (const fn of functions.slice(0, limit)) {
    const disassembled = disassembleFunction(code, baseVaddr, fn.entry, {
      name: fn.name, end: fn.end, maxInstructions,
    });
    graph.scanned += 1;
    for (const instruction of disassembled.instructions) {
      if (instruction.mnemonic === 'call' || instruction.mnemonic === 'jmp') {
        const target = instruction.operands.find((operand) => operand.kind === 'rel')?.target;
        if (target != null && known.has(target)) {
          if (instruction.mnemonic === 'call') {
            push(graph.callers, target, fn.entry);
            push(graph.callees, fn.entry, target);
          }
        }
      }
      for (const operand of instruction.operands) {
        // Absolute addresses appear as immediates, or as a bare displacement.
        const candidate = operand.kind === 'imm'
          ? operand.value
          : operand.kind === 'mem' && !operand.base && !operand.index && !operand.rip
            ? operand.disp
            : undefined;
        if (candidate == null) continue;
        if (Math.abs(candidate) < 0x1000) continue;
        if (options.isMapped && !options.isMapped(candidate)) continue;
        push(graph.dataRefs, candidate, instruction.address);
      }
    }
  }
  return graph;
}

function push(map: Map<number, number[]>, key: number, value: number): void {
  const list = map.get(key);
  if (!list) { map.set(key, [value]); return; }
  if (!list.includes(value)) list.push(value);
}

export function callersOf(graph: CallGraph, entry: number): number[] {
  return graph.callers.get(entry) || [];
}

export function calleesOf(graph: CallGraph, entry: number): number[] {
  return graph.callees.get(entry) || [];
}
