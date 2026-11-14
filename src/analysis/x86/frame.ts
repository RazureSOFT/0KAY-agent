/**
 * Stack frame and calling convention.
 *
 * A decompiler needs names before it can print expressions: `[rbp-8]` is a
 * local, `[rbp+0x10]` is a stack argument, and `mov [rbp-8], rcx` in the
 * prologue means the first register argument lives there. This module reads
 * the prologue and the memory operands once and gives the rest of the pipeline
 * stable names.
 */
import type { Instruction } from './decode.js';

export type Convention = 'win64' | 'sysv';

export interface FrameSlot {
  name: string;
  /** rbp-relative offset; negative for locals, positive for incoming stack args. */
  offset: number;
  size: number;
  kind: 'local' | 'param' | 'saved';
}

export interface Frame {
  convention: Convention;
  hasFramePointer: boolean;
  frameSize: number;
  slots: Map<number, FrameSlot>;
  /** Registers that carry arguments, in order. */
  argRegisters: string[];
  /** Register saved into a stack slot by the prologue: register -> slot name. */
  savedArgs: Map<string, string>;
  /** Registers pushed to preserve them (rbx, r12-r15). */
  savedRegisters: string[];
  note?: string;
}

const WIN64_ARGS = ['rcx', 'rdx', 'r8', 'r9'];
const SYSV_ARGS = ['rdi', 'rsi', 'rdx', 'rcx', 'r8', 'r9'];
const CALLEE_SAVED = new Set(['rbx', 'rbp', 'r12', 'r13', 'r14', 'r15']);
const VOLATILE = new Set(['rax', 'rcx', 'rdx', 'rsi', 'rdi', 'r8', 'r9', 'r10', 'r11']);

export function detectConvention(imageFormat: string): Convention {
  return imageFormat === 'pe' ? 'win64' : 'sysv';
}

function isRegister(instruction: Instruction, index: number, name: string): boolean {
  const operand = instruction.operands[index];
  return operand?.kind === 'reg' && operand.reg === name;
}

function immediate(instruction: Instruction, index: number): number | null {
  const operand = instruction.operands[index];
  return operand?.kind === 'imm' && typeof operand.value === 'number' ? operand.value : null;
}

/**
 * Read the prologue and every memory operand. The result is deliberately
 * conservative: a slot seen with two widths keeps the widest one, and a name
 * is never reused for two offsets.
 */
export function analyzeFrame(instructions: Instruction[], convention: Convention): Frame {
  const frame: Frame = {
    convention,
    hasFramePointer: false,
    frameSize: 0,
    slots: new Map(),
    argRegisters: convention === 'win64' ? [...WIN64_ARGS] : [...SYSV_ARGS],
    savedArgs: new Map(),
    savedRegisters: [],
  };
  if (!instructions.length) return frame;

  // Prologue: push rbp; mov rbp, rsp; sub rsp, N — and the pushes of callee-saved
  // registers that some compilers emit instead of a frame pointer.
  for (let i = 0; i < Math.min(instructions.length, 16); i++) {
    const ins = instructions[i];
    if (ins.mnemonic === 'push' && ins.operands[0]?.kind === 'reg') {
      const reg = ins.operands[0].reg || '';
      if (reg === 'rbp' && i + 1 < instructions.length
        && instructions[i + 1].mnemonic === 'mov'
        && isRegister(instructions[i + 1], 0, 'rbp')
        && isRegister(instructions[i + 1], 1, 'rsp')) {
        frame.hasFramePointer = true;
      } else if (CALLEE_SAVED.has(reg) && reg !== 'rbp') {
        if (!frame.savedRegisters.includes(reg)) frame.savedRegisters.push(reg);
      }
    }
    if (ins.mnemonic === 'sub' && isRegister(ins, 0, 'rsp')) {
      const size = immediate(ins, 1);
      if (size && size > 0 && size < 0x100000) frame.frameSize = size;
    }
  }

  const slotFor = (offset: number, size: number, base: 'rbp' | 'rsp' = 'rbp'): FrameSlot => {
    const existing = frame.slots.get(offset);
    if (existing) {
      if (size > existing.size) existing.size = size;
      return existing;
    }
    const slot: FrameSlot = {
      name: frameName(offset, frame, base),
      offset,
      size,
      kind: offset < 0 ? 'local' : 'param',
    };
    frame.slots.set(offset, slot);
    return slot;
  };

  for (const ins of instructions) {
    for (const operand of ins.operands) {
      if (operand.kind !== 'mem') continue;
      const size = operand.size || 8;
      if (operand.base === 'rbp' && typeof operand.disp === 'number') {
        slotFor(operand.disp, size, 'rbp');
      } else if (operand.base === 'rsp' && typeof operand.disp === 'number' && !frame.hasFramePointer) {
        // Without a frame pointer the offset moves with every push; name it
        // anyway and let the printed code carry the caveat.
        slotFor(operand.disp, size, 'rsp');
      }
    }
  }

  // mov [rbp-8], rcx in the prologue: the argument register's home slot.
  for (let i = 0; i < Math.min(instructions.length, 24); i++) {
    const ins = instructions[i];
    if (ins.mnemonic !== 'mov') continue;
    const dst = ins.operands[0];
    const src = ins.operands[1];
    if (dst?.kind !== 'mem' || dst.base !== 'rbp' || typeof dst.disp !== 'number') continue;
    if (src?.kind !== 'reg' || !src.reg) continue;
    const index = frame.argRegisters.indexOf(src.reg);
    if (index < 0) continue;
    const slot = slotFor(dst.disp, dst.size || 8);
    slot.name = `arg${index}`;
    slot.kind = 'param';
    frame.savedArgs.set(src.reg, slot.name);
  }

  return frame;
}

function frameName(offset: number, frame: Frame, base: 'rbp' | 'rsp' = 'rbp'): string {
  // rsp-relative offsets are not frame slots: without a frame pointer they
  // move with every push, so they get a neutral name and no argument meaning.
  if (base === 'rsp') return `stack_${offset}`;
  if (offset < 0) return `v_${Math.abs(offset)}`;
  if (offset >= 0x10) {
    const index = (offset - 0x10) / 8 + frame.argRegisters.length;
    return Number.isInteger(index) ? `arg${index}` : `stack_${offset}`;
  }
  if (offset === 0) return 'saved_rbp';
  if (offset === 8) return 'return_address';
  return `stack_${offset}`;
}

/** Volatile registers are not preserved across a call; the printer uses this. */
export function isVolatile(register: string): boolean {
  return VOLATILE.has(register);
}
