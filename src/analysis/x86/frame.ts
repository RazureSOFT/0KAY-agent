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
      } else if (operand.base === 'rsp' && typeof operand.disp === 'number') {
        // rsp-relative addressing happens with a frame pointer too — Go emits
        // `push rbp; mov rbp, rsp` and then addresses the frame off rsp anyway,
        // because rsp is the register the stack guard already compared. Skipping
        // these slots when a frame pointer exists left every such access printed
        // as raw pointer arithmetic on an undefined rsp.
        //
        // The offset is a positive displacement into the frame (the frame was
        // allocated by `sub rsp, N`), so it names the same kind of slot: within
        // the allocation it is a local, beyond it is an incoming stack argument.
        slotFor(rspSlotOffset(operand.disp, frame), size, 'rsp');
      }
    }
  }

  // mov [rbp-8], rcx in the prologue: the argument register's home slot.
  for (let i = 0; i < Math.min(instructions.length, 24); i++) {
    const ins = instructions[i];
    if (ins.mnemonic !== 'mov') continue;
    const dst = ins.operands[0];
    const src = ins.operands[1];
    if (dst?.kind !== 'mem' || typeof dst.disp !== 'number') continue;
    if (dst.base !== 'rbp' && dst.base !== 'rsp') continue;
    if (src?.kind !== 'reg' || !src.reg) continue;
    const index = frame.argRegisters.indexOf(src.reg);
    if (index < 0) continue;
    const slot = slotFor(dst.base === 'rsp' ? rspSlotOffset(dst.disp, frame) : dst.disp, dst.size || 8);
    slot.name = `arg${index}`;
    slot.kind = 'param';
    frame.savedArgs.set(src.reg, slot.name);
  }

  // A slot above the return address that is only ever written is a spill of the
  // result, not an argument: Go stores rax there on the way out. Only a slot
  // that is read before anything writes it can be an incoming parameter, and
  // that distinction is what the old `argN` naming threw away.
  promoteSpilledArgs(instructions, frame);

  return frame;
}

/** Rename result-spill slots to `argN` only when the body reads them first. */
function promoteSpilledArgs(instructions: Instruction[], frame: Frame): void {
  const pending = [...frame.slots.values()].filter((slot) => /^stack_arg_\d+$/.test(slot.name));
  if (!pending.length) return;
  for (const slot of pending) {
    let written = false;
    let read = false;
    for (const ins of instructions) {
      const operands = ins.operands;
      for (let index = 0; index < operands.length; index += 1) {
        const operand = operands[index];
        if (!operand || operand.kind !== 'mem' || typeof operand.disp !== 'number') continue;
        if (operand.base !== 'rbp' && operand.base !== 'rsp') continue;
        const at = operand.base === 'rsp' ? rspSlotOffset(operand.disp, frame) : operand.disp;
        if (at !== slot.offset) continue;
        // Operand 0 of a write instruction is the destination.
        if (index === 0 && !written) written = true;
        else read = true;
      }
    }
    if (read && !written) {
      const index = (slot.offset - 0x10) / 8 + frame.argRegisters.length;
      slot.name = `arg${index}`;
      slot.kind = 'param';
    }
  }
}

function frameName(offset: number, frame: Frame, base: 'rbp' | 'rsp' = 'rbp'): string {
  // rsp-relative accesses arrive here already converted to frame-base offsets,
  // so they name a slot like any other: negative is a local, positive beyond the
  // return address is an incoming stack argument.
  if (offset < 0) return `v_${Math.abs(offset)}`;
  if (offset >= 0x10) {
    const index = (offset - 0x10) / 8 + frame.argRegisters.length;
    // An unnamed slot in the argument area is only a parameter when it is read
    // before anything stores to it. Go spills a register result into that same
    // area, so blindly calling every slot `arg4` invents an argument the caller
    // never passed — the write is what tells the two apart, and that is decided
    // later, once the instructions have been walked.
    return Number.isInteger(index) ? `stack_arg_${offset}` : `stack_${offset}`;
  }
  if (offset === 0) return 'saved_rbp';
  if (offset === 8) return 'return_address';
  return `stack_${offset}`;
}

/**
 * Where an rsp-relative access lands, expressed the way the rest of the frame
 * is addressed.
 *
 * With `push rbp; mov rbp, rsp; sub rsp, N`, a displacement of `d` off rsp is
 * `-N + d` relative to the frame base: inside the allocation for `d < N`
 * (a local), at or beyond `N` for an incoming stack argument. Returning the
 * displacement unchanged would call every one of them `stack_256` and lose
 * which ones are parameters.
 *
 * Exported because the IR builder has to apply exactly the same rule; two
 * copies of this arithmetic is how the slot table and the printed code drift
 * apart.
 */
export function rspSlotOffset(displacement: number, frame: Frame): number {
  if (!frame.hasFramePointer || !frame.frameSize) return displacement;
  return displacement - frame.frameSize;
}

/** Volatile registers are not preserved across a call; the printer uses this. */
export function isVolatile(register: string): boolean {
  return VOLATILE.has(register);
}

/**
 * Go passes arguments in registers (AX, BX, CX, DI, SI, R8-R11) and does not
 * spill them to the stack, so the prologue gives no argument list. What it does
 * give is a first read: a register read before anything writes it is an input.
 * Scanning stops at the first call, because after that every register is a
 * scratch value rather than an argument.
 */
const GO_INT_ARGS = ['rax', 'rbx', 'rcx', 'rdi', 'rsi', 'r8', 'r9', 'r10', 'r11'];

function baseName(name: string): string {
  const lower = name.toLowerCase();
  const table: Record<string, string> = {
    eax: 'rax', ebx: 'rbx', ecx: 'rcx', edx: 'rdx', esi: 'rsi', edi: 'rdi', ebp: 'rbp', esp: 'rsp',
    ax: 'rax', bx: 'rbx', cx: 'rcx', dx: 'rdx', si: 'rsi', di: 'rdi', bp: 'rbp', sp: 'rsp',
    al: 'rax', bl: 'rbx', cl: 'rcx', dl: 'rdx', sil: 'rsi', dil: 'rdi', bpl: 'rbp', spl: 'rsp',
    ah: 'rax', bh: 'rbx', ch: 'rcx', dh: 'rdx',
  };
  if (table[lower]) return table[lower];
  if (/^r\d+d$/.test(lower) || /^r\d+w$/.test(lower) || /^r\d+b$/.test(lower)) return lower.slice(0, -1);
  return lower;
}

const WRITES_FIRST: Record<string, true> = {
  mov: true, movabs: true, lea: true, movzx: true, movsx: true, movsxd: true,
  add: true, sub: true, and: true, or: true, xor: true, adc: true, sbb: true,
  shl: true, sal: true, shr: true, sar: true, imul: true, mul: true,
  inc: true, dec: true, neg: true, not: true, bswap: true, pop: true,
};

/**
 * Instructions that read their destination as well as write it.
 *
 * `add rax, rbx` computes `rax + rbx`, so rax is an input. Treating the first
 * operand as a pure destination meant `nop; add rax, rbx; ret` — Go's
 * two-value return, where rax and rbx both arrive in registers — produced a
 * signature naming only `rbx` and a body that read an unassigned rax.
 */
const READS_DESTINATION: Record<string, true> = {
  add: true, sub: true, and: true, or: true, xor: true, adc: true, sbb: true,
  shl: true, sal: true, shr: true, sar: true, imul: true, mul: true,
  inc: true, dec: true, neg: true, not: true, bswap: true,
};

function writtenRegister(instruction: Instruction): string | null {
  const mnemonic = instruction.mnemonic.toLowerCase();
  if (/^set[a-z]{1,2}$/.test(mnemonic) || mnemonic.startsWith('cmov')) return null;
  if (!WRITES_FIRST[mnemonic]) return null;
  const first = instruction.operands[0];
  return first?.kind === 'reg' && first.reg ? baseName(first.reg) : null;
}

/** Does this instruction read the register it writes? */
function readsDestination(instruction: Instruction): boolean {
  return READS_DESTINATION[instruction.mnemonic.toLowerCase()] === true;
}

export interface InferredParam {
  name: string;
  register: string;
  index: number;
}

export function inferRegisterParams(instructions: Instruction[], frame: Frame): InferredParam[] {
  if (frame.savedArgs.size > 0) return []; // the prologue already named them
  const defined = new Set(['rsp', 'rbp']);
  const inputs: string[] = [];
  for (const instruction of instructions.slice(0, 48)) {
    const mnemonic = instruction.mnemonic.toLowerCase();
    if (instruction.flow === 'call' || mnemonic === 'call') break;
    // `ret` and `jmp` end the visible fall-through but not the register story.
    // Go returns a second value in rbx and prints one branch at a time, so a
    // `jmp` after the first case never contains the read that uses it. Stopping
    // at control flow lost the second parameter of every multi-value and
    // multi-case function.
    //
    // A call is different: it clobbers every argument register, so anything read
    // after it is a scratch value rather than an incoming argument.
    // Reads before the instruction's own write: a register read here was live
    // on entry. The destination is skipped, or `mov eax, 0` would look like a
    // use of eax and every function would grow a phantom first argument — unless
    // the instruction reads that destination to compute its result.
    const written = writtenRegister(instruction);
    const readsItsOwnDestination = readsDestination(instruction);
    for (let index = 0; index < instruction.operands.length; index++) {
      if (index === 0 && written && !readsItsOwnDestination) continue;
      const operand = instruction.operands[index];
      if (!operand) continue;
      // A memory operand reads its base and index registers, and those are the
      // registers a function receives its arguments in. Only looking at `reg`
      // operands missed `movzx eax, [rax+0x17]` — a getter reading through its
      // receiver — so the receiver never became a parameter and the body read a
      // local that nothing had assigned.
      const used: string[] = [];
      if (operand.kind === 'reg' && operand.reg) used.push(operand.reg);
      else if (operand.kind === 'mem') {
        if (operand.base) used.push(operand.base);
        if (operand.index) used.push(operand.index);
      }
      for (const raw of used) {
        const name = baseName(raw);
        if (name === 'seg' || name === 'rip') continue;
        if (!defined.has(name) && !inputs.includes(name)) inputs.push(name);
      }
    }
    if (written) defined.add(written);
  }
  // Order by the Go argument register order, then by first appearance for
  // anything outside it.
  const ordered = inputs
    .map((register) => ({ register, rank: GO_INT_ARGS.indexOf(register) }))
    .sort((a, b) => (a.rank < 0 ? 99 : a.rank) - (b.rank < 0 ? 99 : b.rank))
    .map((entry) => entry.register);
  return ordered.map((register, index) => ({ name: `arg${index}`, register, index }));
}
