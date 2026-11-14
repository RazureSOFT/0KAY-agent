/**
 * Basic blocks and a control-flow graph over a recursively walked function.
 *
 * Blocks are cut at leaders (entry, branch targets, and the instruction after
 * any control transfer). Edges come from the last instruction of each block,
 * so a block that ends in a call keeps its fall-through edge rather than
 * pretending the callee is part of this function.
 */
import type { Instruction } from './decode.js';

export interface BasicBlock {
  id: string;
  start: number;
  end: number;
  instructions: Instruction[];
  successors: number[];
  predecessors: number[];
  kind: 'entry' | 'normal' | 'exit';
}

function targetOf(instruction: Instruction): number | null {
  for (const operand of instruction.operands) {
    if (operand.kind === 'rel' && Number.isFinite(operand.target)) return operand.target as number;
  }
  return null;
}

export function buildCfg(instructions: Instruction[]): BasicBlock[] {
  if (!instructions.length) return [];
  const byAddress = new Map<number, number>();
  instructions.forEach((ins, index) => byAddress.set(ins.address, index));

  const leaders = new Set<number>([instructions[0].address]);
  instructions.forEach((ins, index) => {
    const flow = ins.flow;
    const isTransfer = flow === 'jump' || flow === 'condition' || flow === 'ret' || flow === 'stop' || flow === 'call' || flow === 'syscall';
    if (isTransfer && index + 1 < instructions.length) leaders.add(instructions[index + 1].address);
    const target = targetOf(ins);
    if (target != null && byAddress.has(target)) leaders.add(target);
  });

  const ordered = [...leaders].sort((a, b) => a - b);
  const blocks: BasicBlock[] = [];
  let cursor = 0;
  for (let i = 0; i < ordered.length; i++) {
    const start = ordered[i];
    const stop = i + 1 < ordered.length ? ordered[i + 1] : Infinity;
    const body: Instruction[] = [];
    while (cursor < instructions.length && instructions[cursor].address < start) cursor++;
    while (cursor < instructions.length && instructions[cursor].address < stop) {
      body.push(instructions[cursor]);
      cursor++;
    }
    if (!body.length) continue;
    const last = body[body.length - 1];
    blocks.push({
      id: `L_${start.toString(16)}`,
      start,
      end: last.address + last.length,
      instructions: body,
      successors: [],
      predecessors: [],
      kind: i === 0 ? 'entry' : last.flow === 'ret' || last.flow === 'stop' ? 'exit' : 'normal',
    });
  }

  const starts = new Map<number, number>();
  blocks.forEach((block, index) => starts.set(block.start, index));
  const edge = (from: number, to: number) => {
    if (from < 0 || to < 0 || from >= blocks.length || to >= blocks.length) return;
    if (!blocks[from].successors.includes(to)) blocks[from].successors.push(to);
    if (!blocks[to].predecessors.includes(from)) blocks[to].predecessors.push(from);
  };

  blocks.forEach((block, index) => {
    const last = block.instructions[block.instructions.length - 1];
    const flow = last.flow;
    if (flow === 'ret' || flow === 'stop') return;
    const targetIndex = (() => {
      const target = targetOf(last);
      return target == null ? -1 : (starts.get(target) ?? -1);
    })();
    if (flow === 'jump') {
      if (targetIndex >= 0) edge(index, targetIndex);
      else if (index + 1 < blocks.length) edge(index, index + 1);
      return;
    }
    if (flow === 'condition' && targetIndex >= 0) edge(index, targetIndex);
    // Calls, syscalls, ints and ordinary instructions continue at the next block.
    if (index + 1 < blocks.length) edge(index, index + 1);
  });

  return blocks;
}

export function cfgSummary(blocks: BasicBlock[]): {
  blocks: number; edges: number; unreachable: number; exits: number;
} {
  const edges = blocks.reduce((sum, block) => sum + block.successors.length, 0);
  return {
    blocks: blocks.length,
    edges,
    unreachable: blocks.filter((block, index) => index > 0 && block.predecessors.length === 0).length,
    exits: blocks.filter((block) => block.kind === 'exit').length,
  };
}
