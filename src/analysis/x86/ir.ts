/**
 * A small intermediate representation, lifted from x86-64 instructions.
 *
 * The decoder gives bytes and operands; this turns them into assignments,
 * loads, stores and conditions over named variables. Flags are folded into the
 * comparison that produced them, because a `cmp` followed by a `je` is one
 * condition, not two instructions.
 */
import type { Instruction, Operand } from './decode.js';
import type { BasicBlock } from './cfg.js';
import type { Frame } from './frame.js';
import { rspSlotOffset } from './frame.js';
import type { SwitchInfo } from './switch.js';

export type Expr =
  | { t: 'const'; v: number; size: number }
  | { t: 'reg'; name: string; size: number }
  | { t: 'var'; name: string; size: number }
  | { t: 'load'; addr: Expr; size: number }
  | { t: 'bin'; op: string; left: Expr; right: Expr; size: number }
  | { t: 'un'; op: string; value: Expr; size: number }
  | { t: 'cast'; value: Expr; size: number; signed: boolean }
  | { t: 'select'; cond: Expr; a: Expr; b: Expr; size: number }
  | { t: 'call'; target: string; args: Expr[]; size: number }
  | { t: 'unknown'; text: string; size: number };

export type Stmt =
  | { t: 'assign'; target: Expr; value: Expr }
  | { t: 'expr'; expr: Expr }
  | { t: 'return'; value?: Expr }
  | { t: 'unknown'; text: string };

export interface LiftedBlock {
  start: number;
  end: number;
  stmts: Stmt[];
  /** Condition for a `jcc` terminator, already in positive form. */
  cond: Expr | null;
  term: 'jmp' | 'jcc' | 'ret' | 'fallthrough';
  target?: number;
  /** Instructions decoded in this block (for coverage reporting). */
  instructions: number;
  /** Removed from the structured output (e.g. a stack-growth thunk). */
  folded?: boolean;
  /** Present when the block ends in an indexed jump table. */
  switch?: SwitchInfo;
}

const SIZE_OF_REG: Record<string, number> = {};
for (const [names, size] of [
  [['rax', 'rbx', 'rcx', 'rdx', 'rsi', 'rdi', 'rbp', 'rsp', 'r8', 'r9', 'r10', 'r11', 'r12', 'r13', 'r14', 'r15'], 64],
  [['eax', 'ebx', 'ecx', 'edx', 'esi', 'edi', 'ebp', 'esp', 'r8d', 'r9d', 'r10d', 'r11d', 'r12d', 'r13d', 'r14d', 'r15d'], 32],
  [['ax', 'bx', 'cx', 'dx', 'si', 'di', 'bp', 'sp', 'r8w', 'r9w', 'r10w', 'r11w', 'r12w', 'r13w', 'r14w', 'r15w'], 16],
  [['al', 'bl', 'cl', 'dl', 'sil', 'dil', 'bpl', 'spl', 'r8b', 'r9b', 'r10b', 'r11b', 'r12b', 'r13b', 'r14b', 'r15b', 'ah', 'bh', 'ch', 'dh'], 8],
] as Array<[string[], number]>) {
  for (const name of names) SIZE_OF_REG[name] = size;
}

/** The 64-bit register a narrower name belongs to, so `eax` and `rax` are one variable. */
export function registerBase(name: string): string {
  const lower = name.toLowerCase();
  const table: Record<string, string> = {
    eax: 'rax', ebx: 'rbx', ecx: 'rcx', edx: 'rdx', esi: 'rsi', edi: 'rdi', ebp: 'rbp', esp: 'rsp',
    ax: 'rax', bx: 'rbx', cx: 'rcx', dx: 'rdx', si: 'rsi', di: 'rdi', bp: 'rbp', sp: 'rsp',
    al: 'rax', bl: 'rbx', cl: 'rcx', dl: 'rdx', sil: 'rsi', dil: 'rdi', bpl: 'rbp', spl: 'rsp',
    ah: 'rax', bh: 'rbx', ch: 'rcx', dh: 'rdx',
  };
  if (table[lower]) return table[lower];
  if (/^r\d+d$/.test(lower)) return lower.slice(0, -1);
  if (/^r\d+w$/.test(lower)) return lower.slice(0, -1);
  if (/^r\d+b$/.test(lower)) return lower.slice(0, -1);
  return lower;
}

export function registerSize(name: string): number {
  return SIZE_OF_REG[name.toLowerCase()] || 64;
}

function constExpr(value: number, size: number): Expr {
  return { t: 'const', v: value, size };
}

function addressExpr(operand: Operand, instruction: Instruction): Expr {
  if (operand.rip) {
    const absolute = instruction.address + instruction.length + (operand.disp || 0);
    return constExpr(absolute, 64);
  }
  let expr: Expr | null = null;
  if (operand.base) {
    expr = { t: 'reg', name: registerBase(operand.base), size: 64 };
  }
  if (operand.index) {
    const index: Expr = { t: 'reg', name: registerBase(operand.index), size: 64 };
    const scaled: Expr = (operand.scale || 1) === 1
      ? index
      : { t: 'bin', op: '*', left: index, right: constExpr(operand.scale || 1, 64), size: 64 };
    expr = expr ? { t: 'bin', op: '+', left: expr, right: scaled, size: 64 } : scaled;
  }
  const disp = operand.disp || 0;
  if (disp) {
    const displacement = constExpr(disp, 64);
    expr = expr ? { t: 'bin', op: '+', left: expr, right: displacement, size: 64 } : displacement;
  }
  return expr || constExpr(0, 64);
}

function slotFor(offset: number, size: number, frame: Frame): Expr {
  const slot = frame.slots.get(offset);
  return { t: 'var', name: slot ? slot.name : (offset < 0 ? `v_${Math.abs(offset)}` : `stack_${offset}`), size: size || 64 };
}

/** A memory operand as an address (for `lea`) or as a value (for everything else). */
export function operandExpr(operand: Operand | undefined, instruction: Instruction, frame: Frame, asAddress = false): Expr {
  if (!operand) return constExpr(0, 64);
  const size = operand.size || 64;
  switch (operand.kind) {
    case 'reg':
      return { t: 'reg', name: registerBase(operand.reg || ''), size: operand.size || registerSize(operand.reg || '') };
    case 'imm':
      return constExpr(operand.value || 0, size);
    case 'rel':
      return constExpr(operand.target || 0, 64);
    case 'mem': {
      // A stack slot is a variable, not memory behind a pointer: reading it is
      // the variable, writing it is an assignment, and only `lea` takes its
      // address.
      if (operand.base === 'rbp' && typeof operand.disp === 'number') {
        const slot = slotFor(operand.disp, size, frame);
        return asAddress ? { t: 'un', op: '&', value: slot, size: 64 } : slot;
      }
      // rsp-relative is a frame slot too, frame pointer or not. Go allocates with
      // `sub rsp, N` and then addresses everything off rsp, so gating this on
      // `!hasFramePointer` printed its entire frame as pointer arithmetic on a
      // register that no instruction ever writes.
      if (operand.base === 'rsp' && typeof operand.disp === 'number') {
        const slot = slotFor(rspSlotOffset(operand.disp, frame), size, frame);
        return asAddress ? { t: 'un', op: '&', value: slot, size: 64 } : slot;
      }
      const address = addressExpr(operand, instruction);
      return asAddress ? address : { t: 'load', addr: address, size };
    }
    default:
      return constExpr(0, size);
  }
}


function isNamedReg(operand: Operand | undefined, name: string): boolean {
  return operand?.kind === 'reg' && registerBase(operand.reg || '') === name;
}

interface PendingCondition {
  op: 'cmp' | 'test';
  left: Expr;
  right: Expr;
}

const JCC: Record<string, { op: string; swap?: boolean; zero?: boolean }> = {
  je: { op: '==' }, jz: { op: '==' },
  jne: { op: '!=' }, jnz: { op: '!=' },
  jb: { op: '<' }, jnae: { op: '<' }, jc: { op: '<' },
  jae: { op: '>=' }, jnb: { op: '>=' }, jnc: { op: '>=' },
  jbe: { op: '<=' }, jna: { op: '<=' },
  ja: { op: '>' }, jnbe: { op: '>' },
  jl: { op: '<' }, jnge: { op: '<' },
  jge: { op: '>=' }, jnl: { op: '>=' },
  jle: { op: '<=' }, jng: { op: '<=' },
  jg: { op: '>' }, jnle: { op: '>' },
  js: { op: '<', zero: true },
  jns: { op: '>=', zero: true },
};

function conditionFrom(mnemonic: string, pending: PendingCondition | null): Expr | null {
  const spec = JCC[mnemonic];
  if (!spec) return null;
  if (!pending) return { t: 'unknown', text: mnemonic, size: 1 };
  const { left, right } = pending;
  if (pending.op === 'test') {
    // `test a, a` is the compiler's own zero check — it exists precisely because
    // it means "is this value zero", not "AND the value with itself". Printing
    // the AND makes the reader think two different values were combined, and it
    // prints the same name twice in one expression.
    const selfTest = sameExpr(left, right);
    const subject: Expr = selfTest ? left : { t: 'bin', op: '&', left, right, size: left.size };
    if (spec.op === '==') return { t: 'bin', op: '==', left: subject, right: constExpr(0, left.size), size: 1 };
    if (spec.op === '!=') return { t: 'bin', op: '!=', left: subject, right: constExpr(0, left.size), size: 1 };
    return { t: 'bin', op: spec.op, left: subject, right: constExpr(0, left.size), size: 1 };
  }
  if (spec.zero) {
    return { t: 'bin', op: spec.op, left, right: constExpr(0, left.size), size: 1 };
  }
  const result: Expr = { t: 'bin', op: spec.op, left, right, size: 1 };
  return result;
}

/** Are these two operands literally the same value? `test reg, reg` and the like. */
function sameExpr(a: Expr, b: Expr): boolean {
  if (a.t !== b.t) return false;
  switch (a.t) {
    case 'reg': return a.name === (b as typeof a).name;
    case 'var': return a.name === (b as typeof a).name;
    case 'const': return a.v === (b as typeof a).v;
    case 'load': return sameExpr(a.addr, (b as typeof a).addr);
    default: return false;
  }
}

const BINARY_VERBS: Record<string, string> = {
  add: '+', sub: '-', and: '&', or: '|', xor: '^',
  shl: '<<', sal: '<<', shr: '>>', sar: '>>',
  imul: '*', mul: '*',
};

/** Lift one function's blocks into IR. */
export function lift(instructions: Instruction[], blocks: BasicBlock[], frame: Frame): LiftedBlock[] {
  const byStart = new Map<number, BasicBlock>();
  for (const block of blocks) byStart.set(block.start, block);
  const lifted: LiftedBlock[] = [];

  for (const block of blocks) {
    const stmts: Stmt[] = [];
    // Argument registers are written just before a call; remember the value and
    // where it was written so the call can carry it as an argument and the
    // assignment can be dropped instead of printed twice.
    const regValues = new Map<string, Expr>();
    const argStmtIndex = new Map<string, number>();
    const deleted = new Set<number>();
    let pending: PendingCondition | null = null;
    let cond: Expr | null = null;
    let term: LiftedBlock['term'] = 'fallthrough';
    let target: number | undefined;
    let unknown = 0;

    for (const ins of block.instructions) {
      const m = ins.mnemonic.toLowerCase();
      const [a, b] = ins.operands;
      if (m === 'cmp' || m === 'test') {
        pending = { op: m === 'cmp' ? 'cmp' : 'test', left: operandExpr(a, ins, frame), right: operandExpr(b, ins, frame) };
        continue;
      }
      if (m === 'nop' || m === 'endbr64' || m === 'leave' || m === 'push' || m === 'pop'
        || m === 'stc' || m === 'clc' || m === 'cmc' || m === 'cld' || m === 'std'
        || m === 'sahf' || m === 'lahf' || m === 'pause') continue;
      // Prologue and epilogue when a frame pointer is in use: the slots are
      // addressed through rbp, so adjusting rsp says nothing the reader needs.
      if (frame.hasFramePointer) {
        if (m === 'mov' && isNamedReg(a, 'rbp') && isNamedReg(b, 'rsp')) continue;
        if (m === 'mov' && isNamedReg(a, 'rsp') && isNamedReg(b, 'rbp')) continue;
        if ((m === 'sub' || m === 'add') && isNamedReg(a, 'rsp') && b?.kind === 'imm') continue;
      }
      if (m === 'jrcxz' || m === 'jecxz' || m === 'jcxz') {
        term = 'jcc';
        cond = { t: 'bin', op: '==', left: { t: 'reg', name: 'rcx', size: 64 }, right: constExpr(0, 64), size: 1 };
        target = a?.target;
        continue;
      }
      if (m === 'jmp') {
        term = 'jmp';
        target = a?.target;
        continue;
      }
      if (m.startsWith('j') && JCC[m]) {
        term = 'jcc';
        cond = conditionFrom(m, pending);
        target = a?.target;
        pending = null;
        continue;
      }
      if (m === 'ret' || m === 'retn') {
        term = 'ret';
        stmts.push({ t: 'return', value: { t: 'reg', name: 'rax', size: 64 } });
        continue;
      }
      if (m === 'call') {
        const targetExpr = a ? operandExpr(a, ins, frame, true) : constExpr(0, 64);
        const name = targetExpr.t === 'const' ? `sub_${(targetExpr.v >>> 0).toString(16)}` : 'indirect_call';
        const args: Expr[] = [];
        for (const register of frame.argRegisters) {
          const value = regValues.get(register);
          if (!value) break;
          args.push(value);
          const index = argStmtIndex.get(register);
          if (index != null) deleted.add(index);
        }
        stmts.push({
          t: 'assign',
          target: { t: 'reg', name: 'rax', size: 64 },
          value: { t: 'call', target: name, args, size: 64 },
        });
        regValues.clear();
        argStmtIndex.clear();
        continue;
      }
      if (m === 'mov' || m === 'movabs') {
        // Segment-register moves do not affect the value flow this IR models.
        if (a?.kind === 'reg' && a.reg === 'seg' || b?.kind === 'reg' && b.reg === 'seg') continue;
        // `mov [rbp-8], rdi` is the prologue spilling an argument. The slot is
        // already named arg0, so printing `arg0 = rdi` would overwrite the
        // parameter with itself.
        if (a?.kind === 'mem' && a.base === 'rbp' && typeof a.disp === 'number' && b?.kind === 'reg') {
          const slot = frame.slots.get(a.disp);
          if (slot && /^arg\d+$/.test(slot.name) && frame.argRegisters.includes(registerBase(b.reg || ''))) continue;
        }
        if (a && b) {
          const targetExpr = operandExpr(a, ins, frame);
          const valueExpr = operandExpr(b, ins, frame);
          stmts.push({ t: 'assign', target: targetExpr, value: valueExpr });
          if (targetExpr.t === 'reg' && frame.argRegisters.includes(targetExpr.name)) {
            regValues.set(targetExpr.name, valueExpr);
            argStmtIndex.set(targetExpr.name, stmts.length - 1);
          }
        }
        continue;
      }
      if (m === 'lea') {
        if (a && b) stmts.push({ t: 'assign', target: operandExpr(a, ins, frame), value: operandExpr(b, ins, frame, true) });
        continue;
      }
      if (m === 'movzx' || m === 'movsx' || m === 'movsxd') {
        if (a && b) {
          stmts.push({
            t: 'assign',
            target: operandExpr(a, ins, frame),
            value: { t: 'cast', value: operandExpr(b, ins, frame), size: a.size || 64, signed: m !== 'movzx' },
          });
        }
        continue;
      }
      if (m === 'xor' && a?.kind === 'reg' && b?.kind === 'reg' && registerBase(a.reg || '') === registerBase(b.reg || '')) {
        stmts.push({ t: 'assign', target: operandExpr(a, ins, frame), value: constExpr(0, a.size || 64) });
        continue;
      }
      if (m === 'imul' && a && !b) {
        const value = operandExpr(a, ins, frame);
        stmts.push({
          t: 'assign',
          target: { t: 'reg', name: 'rax', size: 64 },
          value: { t: 'bin', op: '*', left: { t: 'reg', name: 'rax', size: 64 }, right: value, size: 64 },
        });
        continue;
      }
      if (m === 'bt' && a && b) {
        // bt sets CF to the tested bit; the branch that follows reads CF.
        const value = operandExpr(a, ins, frame);
        const bit = operandExpr(b, ins, frame);
        const shifted: Expr = { t: 'bin', op: '>>', left: value, right: bit, size: value.size };
        const masked: Expr = { t: 'bin', op: '&', left: shifted, right: constExpr(1, value.size), size: value.size };
        pending = { op: 'cmp', left: masked, right: constExpr(1, value.size) };
        continue;
      }
      if (BINARY_VERBS[m] && a && b) {
        const left = operandExpr(a, ins, frame);
        stmts.push({
          t: 'assign',
          target: left,
          value: { t: 'bin', op: BINARY_VERBS[m], left, right: operandExpr(b, ins, frame), size: left.size },
        });
        continue;
      }
      if ((m === 'inc' || m === 'dec') && a) {
        const left = operandExpr(a, ins, frame);
        stmts.push({
          t: 'assign', target: left,
          value: { t: 'bin', op: m === 'inc' ? '+' : '-', left, right: constExpr(1, left.size), size: left.size },
        });
        continue;
      }
      if ((m === 'neg' || m === 'not') && a) {
        const value = operandExpr(a, ins, frame);
        stmts.push({ t: 'assign', target: value, value: { t: 'un', op: m === 'neg' ? '-' : '~', value, size: value.size } });
        continue;
      }
      if (m === 'cdqe' || m === 'cwde' || m === 'cbw') {
        stmts.push({ t: 'assign', target: { t: 'reg', name: 'rax', size: 64 }, value: { t: 'cast', value: { t: 'reg', name: 'rax', size: 32 }, size: 64, signed: true } });
        continue;
      }
      if (m === 'cqo' || m === 'cdq' || m === 'cwd') {
        stmts.push({ t: 'assign', target: { t: 'reg', name: 'rdx', size: 64 }, value: { t: 'unknown', text: `${m}(rax)`, size: 64 } });
        continue;
      }
      if (m === 'idiv' || m === 'div') {
        const divisor = b ? operandExpr(b, ins, frame) : constExpr(0, 64);
        stmts.push({ t: 'assign', target: { t: 'reg', name: 'rax', size: 64 }, value: { t: 'bin', op: '/', left: { t: 'reg', name: 'rax', size: 64 }, right: divisor, size: 64 } });
        stmts.push({ t: 'assign', target: { t: 'reg', name: 'rdx', size: 64 }, value: { t: 'bin', op: '%', left: { t: 'reg', name: 'rax', size: 64 }, right: divisor, size: 64 } });
        continue;
      }
      if (/^set[a-z]{1,2}$/.test(m)) {
        const value = conditionFrom(`j${m.slice(3)}`, pending) || { t: 'unknown', text: m, size: 1 };
        if (a) stmts.push({ t: 'assign', target: operandExpr(a, ins, frame), value });
        continue;
      }
      if (m.startsWith('cmov') && a && b) {
        const condition = conditionFrom(`j${m.slice(4)}`, pending) || { t: 'unknown', text: m, size: 1 };
        const target = operandExpr(a, ins, frame);
        stmts.push({
          t: 'assign',
          target,
          value: { t: 'select', cond: condition, a: operandExpr(b, ins, frame), b: target, size: target.size },
        });
        continue;
      }
      if (m === 'xchg' && a && b) {
        const left = operandExpr(a, ins, frame);
        const right = operandExpr(b, ins, frame);
        stmts.push({ t: 'assign', target: left, value: right });
        stmts.push({ t: 'assign', target: right, value: left });
        continue;
      }
      // Anything else stays visible instead of being dropped.
      unknown += 1;
      stmts.push({ t: 'unknown', text: `${m} ${ins.operands.map((operand) => operand.reg || operand.mem || (operand.value != null ? `0x${(operand.value >>> 0).toString(16)}` : '')).filter(Boolean).join(', ')}`.trim() });
    }

    // A block that ends in a conditional jump but has no condition is still a
    // branch; say so rather than printing `if (?)`.
    if (term === 'jcc' && !cond) cond = { t: 'unknown', text: 'flags', size: 1 };
    lifted.push({
      start: block.start,
      end: block.end,
      stmts: stmts.filter((_stmt, index) => !deleted.has(index)),
      cond,
      term,
      ...(target != null ? { target } : {}),
      instructions: block.instructions.length,
    });
    void unknown;
    void byStart;
  }
  return lifted;
}
