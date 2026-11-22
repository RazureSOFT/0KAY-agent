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
  /**
   * An explanation the decompiler adds because the C cannot say it.
   *
   * Distinct from `unknown`, which means "there is an instruction here the
   * pipeline could not lift". Both print as a comment, but only one of them is a
   * gap in the analysis: `sbb x, x` is understood and stated, a `punpcklbw` with
   * no semantics is not. Conflating them made the unknown rate look dominated by
   * the decompiler's own notes.
   */
  | { t: 'note'; text: string }
  | { t: 'unknown'; text: string };

export interface LiftedBlock {
  start: number;
  end: number;
  stmts: Stmt[];
  /** Condition for a `jcc` terminator, already in positive form. */
  cond: Expr | null;
  term: 'jmp' | 'jcc' | 'ret' | 'fallthrough';
  target?: number;
  /**
   * The register an indirect `jmp` goes through.
   *
   * Set when `target` is absent because the destination is in a register — Go reaches a
   * method through the itab this way, as the last instruction of a wrapper. Nothing can
   * be followed from it, but dropping it silently left the listing with no exit at all:
   * `(*cancelCtx).Deadline` ended on `rcx = *(long *)(rcx + 0x18);`.
   */
  indirect?: string;
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

export function slotFor(offset: number, size: number, frame: Frame): Expr {  const slot = frame.slots.get(offset);
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
      // An indexed operand is an array element, not a slot. `[rsp+rax*8+0xa8]` is
      // the base of a frame array plus a scaled index; treating it as the scalar at
      // displacement 0xa8 made the read name a variable nothing had written, and
      // silently dropped the index so the printed code fetched the wrong element.
      if (operand.base === 'rsp' && typeof operand.disp === 'number' && !operand.index) {
        // The displacement names a slot only together with how far rsp has moved
        // on the way here. `frame.frameSize` accounts for the prologue; the
        // instruction carries the rest.
        const adjusted = operand.disp + (instruction.rspOffset || 0);
        const slot = slotFor(rspSlotOffset(adjusted, frame), size, frame);
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
  op: 'cmp' | 'test' | 'float' | 'overflow';
  left: Expr;
  right: Expr;
}

/**
 * Jumps whose condition comes from the previous instruction's flags rather than
 * from a compare's operands.
 *
 * `jo` reads the overflow flag and `jp` the parity flag, and Go produces both as
 * paired reads of an `imul` or a `ucomiss`. They have no place in JCC — there is no
 * comparison to invert — so the dispatch has to know about them separately.
 */
const FLAG_JUMPS = new Set(['jo', 'jno', 'jp', 'jnp']);

const JCC: Record<string, { op: string; swap?: boolean; zero?: boolean }> = {
  je: { op: '==' }, jz: { op: '==' },  jne: { op: '!=' }, jnz: { op: '!=' },
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
  if (pending.op === 'overflow') {
    // Go checks a multiplication for overflow with `imul` followed by `jo`: the
    // jump asks whether the product fit. The printed test states that as the sign
    // of the product, which is the part of it the source can show, and the note
    // beside the multiplication says the rest. Without this the branch came out as
    // `/* unknown: jo 0x66 */` with no way to tell what was being checked.
    if (mnemonic === 'jo' || mnemonic === 'jno') {
      return { t: 'bin', op: '<=', left: pending.left, right: constExpr(0, pending.left.size), size: 1 };
    }
    return null;
  }
  if (pending.op === 'float') {
    // A pair of flags read from one float compare: Go tests ZF first (`jne`/`je`) and
    // PF second (`jnp`/`jp`), and the second read only rules out the unordered case,
    // so the condition is the first comparison.
    if (mnemonic === 'jnp' || mnemonic === 'jp') return { t: 'const', v: 1, size: 1 };
    // The operands are vector registers, which this IR does not track. Naming them
    // directly (`xmm1 == xmm0`) invented variables that nothing assigns — the one
    // output shape that reads as a bug in the *listing* rather than a limit of the
    // analysis. A float comparison is stated as such instead, with the operand order
    // preserved so the reader can line it up with the disassembly.
    const describe = (e: Expr): string => (e.t === 'reg' ? e.name : 'value');
    return { t: 'unknown', text: `float compare ${describe(left)} ${spec.op} ${describe(right)}`, size: 1 };
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
  add: '+', sub: '-', and: '&', or: '|', xor: '^', sbb: '-',
  shl: '<<', sal: '<<', shr: '>>', sar: '>>',
  // The rotations. `rcr`/`rcl` pull the carry in, and the carry is not modelled, so
  // the printed form is the plain rotate: it is what the instruction does to the
  // value, minus one bit of state the reader can see is missing. Reporting the
  // whole instruction as unexplained would be worse — the destination is written.
  rol: '<<', ror: '>>', rcl: '<<', rcr: '>>',
  imul: '*', mul: '*',
};

/**
 * Instructions the decoder understands but this IR has no operator for.
 *
 * Each is recorded as an assignment of a named, obviously-approximate value rather
 * than as "unexplained": the destination is written, the reader can see that the
 * computation is being summarised, and the function stops looking like it contains
 * bytes nobody can read. `popcnt` is named because Go's bit tricks use it and the
 * name is the whole explanation.
 */
const NAMED_VALUES: Record<string, string> = {
  popcnt: 'popcount',
  bswap: 'byteswap',
  bsfl: 'lowest_bit',
  bsfq: 'lowest_bit',
  bsrl: 'highest_bit',
  bsrq: 'highest_bit',
  cpuid: 'cpuid',
  rdtsc: 'rdtsc',
  rdtscp: 'rdtscp',
};

/**
 * Instructions whose result depends on the carry flag.
 *
 * `sbb a, b` is `a - b - carry`. The carry is not modelled here, so the printed
 * expression says `a - b` and the comment says what was left out — Go uses sbb
 * to materialise a borrow (`sbb x, x` is a branchless 0/-1), and calling that a
 * plain subtraction would be a different program.
 */
const CARRIED: Record<string, true> = { sbb: true };


/** The implicit-operand string instructions Go emits for small copies and fills. */
const STRING_OPS: Record<string, { kind: 'move' | 'store'; width: string }> = {
  movsb: { kind: 'move', width: 'b' }, movsw: { kind: 'move', width: 'w' },
  movsd: { kind: 'move', width: 'd' }, movsq: { kind: 'move', width: 'q' },
  stosb: { kind: 'store', width: 'b' }, stosw: { kind: 'store', width: 'w' },
  stosd: { kind: 'store', width: 'd' }, stosq: { kind: 'store', width: 'q' },
};

/** Lift one function's blocks into IR. */

/**
 * The stack-pointer displacement at the start of each block.
 *
 * Walks the CFG in address order, taking the smallest magnitude when a join has
 * predecessors that disagree — the paths that reach a join with different stack
 * depths are almost always a `push` on one arm and a value in a register on the
 * other, and the arm that reaches the join with the shallowest stack is the one
 * the following code is written for.
 *
 * Only the prologue's own subtraction is excluded: `frame.frameSize` already
 * accounts for it, and counting it twice moved every slot by a whole frame.
 */
function stackOffsetPerBlock(
  blocks: BasicBlock[],
  byStart: Map<number, BasicBlock>,
): Map<number, number> {
  const result = new Map<number, number>();
  if (!blocks.length) return result;
  // Delta a block applies to rsp, ignoring the prologue's own `sub rsp, frameSize`
  // because `frame.frameSize` already accounts for it.
  const deltaOf = (block: BasicBlock, isEntry: boolean): number => {
    let delta = 0;
    let skippedPrologue = !isEntry;
    for (const instruction of block.instructions) {
      const mnemonic = instruction.mnemonic.toLowerCase();
      const first = instruction.operands[0];
      const second = instruction.operands[1];
      if (!skippedPrologue && mnemonic === 'sub' && first?.kind === 'reg'
        && registerBase(first.reg || '') === 'rsp' && second?.kind === 'imm') {
        skippedPrologue = true;
        continue;
      }
      if (!skippedPrologue) continue;
      if (mnemonic === 'push') delta -= 8;
      if (mnemonic === 'pop') delta += 8;
      if ((mnemonic === 'sub' || mnemonic === 'add') && first?.kind === 'reg'
        && registerBase(first.reg || '') === 'rsp' && second?.kind === 'imm') {
        const amount = typeof second.value === 'number' ? second.value : 0;
        delta += mnemonic === 'sub' ? -amount : amount;
      }
    }
    return delta;
  };

  const entry = blocks[0].start;
  const worklist = [entry];
  result.set(entry, 0);
  let guard = 0;
  while (worklist.length && guard++ < 2000) {
    const start = worklist.shift() as number;
    const block = byStart.get(start);
    if (!block) continue;
    const outgoing = (result.get(start) || 0) + deltaOf(block, start === entry);
    for (const successor of block.successors) {
      // Keep the shallower stack: the arm that carries a pushed value is deeper,
      // and the code at the join is written against the shallower one.
      const existing = result.get(successor);
      if (existing == null || Math.abs(outgoing) < Math.abs(existing)) {
        result.set(successor, outgoing);
        worklist.push(successor);
      }
    }
  }
  return result;
}


/** Mnemonics that only touch the vector unit. */
const VECTOR_ONLY = new Set([
  'aesenc', 'aesenclast', 'aesdec', 'aesdeclast', 'aesimc', 'aeskeygenassist',
  'pinsrd', 'pinsrw', 'pclmulqdq', 'pcmpestrm',
  'movups', 'movaps', 'movdqa', 'movdqu', 'movq', 'movd',
  'punpcklbw', 'punpcklwd', 'punpckldq', 'punpckhbw', 'punpckhwd', 'punpckhdq',
  'punpcklqdq', 'punpckhqdq', 'packsswb', 'packssdw', 'packuswb',
  'pcmpgtb', 'pcmpgtw', 'pcmpgtd', 'pcmpeqb', 'pcmpeqw', 'pcmpeqd',
  'pshufd', 'psrlw', 'psrld', 'psrlq', 'pmovmskb', 'pand', 'pandn', 'por', 'pxor',
  'psadbw', 'paddd', 'psubd', 'andps', 'andnps', 'orps', 'xorps',
  'addps', 'mulps', 'subps', 'divps', 'sqrtps', 'rsqrtps', 'rcpps', 'minps', 'maxps',
  'cvtps2pd', 'cvtdq2ps', 'cvttpd2dq', 'vzeroupper', 'vzeroall',
  // The VEX-encoded forms. Every one of them is a vector operation, and listing them
  // by hand meant the list drifted out of step with the decoder's own name table:
  // `vmovdqa` was in one and not the other, so 30 statements printed as unexplained
  // through 2000 functions. Matching the `v` prefix keeps the two in step — it is
  // the AVX family, and nothing else in this decoder starts with `v` except the
  // opcode-form fallbacks, which are handled separately.
]);

/** Is this mnemonic a vector operation this IR does not model? */
function isVectorOnly(mnemonic: string): boolean {
  if (VECTOR_ONLY.has(mnemonic)) return true;
  // `vex_6f` and friends: the decoder could not name the instruction behind a VEX
  // prefix. It still moves 128 bits through registers this IR does not track.
  if (mnemonic.startsWith('vex_')) return true;
  if (mnemonic.startsWith('evex_')) return true;
  // Every named AVX instruction begins with `v`; no general-purpose x86 mnemonic
  // does.
  return mnemonic.length > 1 && mnemonic[0] === 'v';
}

/**
 * Remove writes that nothing reads before they are overwritten.
 *
 * `eax` is written to clear the upper half of `rax` as often as it is written for its
 * value, so the lift produces
 *
 *     rdx = arg0;
 *     rax = arg0 >> 0x3f;
 *     rax = 0xe38e38e38e38e000;      <- never read
 *     rbx = rdx;
 *     rax = 0xe38e38e38e38e000 * rdx;
 *
 * where the third line exists only because the instruction that loaded the multiplier also
 * zeroed the register it was about to overwrite. In 400 functions that is 4836 assignments
 * against 5100 before this pass, with 1014 pairs of the same name still in the output —
 * those are the ones that carry a call, or sit in different blocks.
 *
 * Two properties make this safe to run per block without a whole-function view:
 *
 *   - only a write that a *later write in the same block* shadows is removed. A name
 *     written once and never again in the block is that block's result and something
 *     outside may read it, so it is never touched.
 *   - a statement that reads the name it writes — `rax = rax + 3` — depends on the value
 *     before it, so the earlier write is live. Missing this deleted `mov eax, 5` under
 *     `add eax, 3` and left the sum reading an uninitialised register.
 *
 * A write also has to have no side effect. `rax = runtime_printlock(); rax =
 * runtime_printstring();` prints two things; 496 of the 1014 same-name pairs in that
 * sample are calls and are left alone.
 */
function dropDeadWrites(stmts: Stmt[]): Stmt[] {
  const remove = new Set<number>();
  /** Names read by a statement, and whether it writes a name at all. */
  const info = stmts.map((stmt) => {
    const reads = new Set<string>();
    let writes: string | null = null;
    const visit = (value: Expr | undefined): void => {
      if (!value) return;
      switch (value.t) {
        case 'reg': case 'var': reads.add(value.name); return;
        case 'load': visit(value.addr); return;
        case 'bin': visit(value.left); visit(value.right); return;
        case 'un': case 'cast': visit(value.value); return;
        case 'select': visit(value.cond); visit(value.a); visit(value.b); return;
        case 'call': for (const arg of value.args) visit(arg); return;
        default: return;
      }
    };
    if (stmt.t === 'assign') {
      // A store writes memory, not a name; its address and value are both reads.
      if (stmt.target.t === 'reg' || stmt.target.t === 'var') writes = stmt.target.name;
      else visit(stmt.target);
      visit(stmt.value);
    } else if (stmt.t === 'expr') visit(stmt.expr);
    else if (stmt.t === 'return') visit(stmt.value);
    return { reads, writes };
  });

  // Backwards. `live` holds names whose current value is still needed later; `written`
  // holds names this block has already written further down, which is what separates "dead"
  // from "the block's result". A write at the end of a block is that block's result —
  // something outside may read it — so it is never removed, and only a write that a later
  // write in the same block shadows is.
  const live = new Set<string>();
  const written = new Set<string>();
  for (let index = stmts.length - 1; index >= 0; index -= 1) {
    const stmt = stmts[index];
    const { reads, writes } = info[index];
    if (stmt.t === 'assign' && writes && written.has(writes) && !live.has(writes) && !hasSideEffect(stmt.value)) {
      remove.add(index);
      continue;
    }
    for (const name of reads) live.add(name);
    if (writes) {
      // A statement that reads the name it writes — `rax = rax + 3` — depends on the
      // value written *before* it, so that earlier write is live. Taking `writes` out of
      // `live` unconditionally deleted `mov eax, 5` under `add eax, 3` and left the sum
      // reading an uninitialised register.
      if (!reads.has(writes)) live.delete(writes);
      written.add(writes);
    }
  }
  return remove.size ? stmts.filter((_stmt, index) => !remove.has(index)) : stmts;
}

/** Whether an expression can be removed without changing behaviour. */
function hasSideEffect(value: Expr): boolean {
  switch (value.t) {
    case 'call': return true;
    case 'load': return hasSideEffect(value.addr);
    case 'bin': return hasSideEffect(value.left) || hasSideEffect(value.right);
    case 'un': case 'cast': return hasSideEffect(value.value);
    case 'select': return hasSideEffect(value.cond) || hasSideEffect(value.a) || hasSideEffect(value.b);
    default: return false;
  }
}

export function lift(instructions: Instruction[], blocks: BasicBlock[], frame: Frame, names?: Map<number, string>): LiftedBlock[] {
  const byStart = new Map<number, BasicBlock>();
  for (const block of blocks) byStart.set(block.start, block);
  const lifted: LiftedBlock[] = [];
  /**
   * How far `rsp` sits below its value at the start of the prologue, per block.
   *
   * Slots are addressed relative to the live `rsp`, so `[rsp+168]` names a
   * different variable depending on how much stack the path leading there has
   * taken. Measured off the block alone, a slot written on one path and read on
   * another came out as two different variables: the write landed on a name
   * nothing read and the read on a name nothing wrote. That is the
   * `read before written: v_72` class — the write exists in the binary, at a
   * displacement that only makes sense with the right stack adjustment.
   *
   * The prologue's own `sub rsp, N` is already folded into `frame.frameSize`, so
   * the walk starts at zero there and only tracks movement after it.
   */
  const rspAtBlockEntry = stackOffsetPerBlock(blocks, byStart);

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
    let indirect: string | undefined;
    let unknown = 0;

    // The offset is measured from where `rsp` sits *after* the prologue, because
    // that is the frame `frame.slots` describes. Before the prologue `rsp` is still
    // at its entry value, a whole frame higher, so an entry-block instruction that
    // comes before it needs that much added back. Without this the stack-growth
    // guard at the top of every Go function — `cmp [rsp+8], r14` — read the argument
    // slot as a local eighty bytes down in the frame, and that local was a name
    // nothing had assigned.
    let prologueSeen = block.start !== blocks[0]?.start;
    let rspShift = rspAtBlockEntry.get(block.start) || 0;
    if (!prologueSeen) rspShift = frame.frameSize + (frame.hasFramePointer ? 8 : 0);
    for (const ins of block.instructions) {
      const mnemonic = ins.mnemonic.toLowerCase();
      const first = ins.operands[0];
      const second = ins.operands[1];
      // The prologue is `push rbp; mov rbp, rsp; sub rsp, N`. `frameSize` is that
      // N, and the push is not part of it, so counting the push as an adjustment
      // moved every slot in the function by eight bytes.
      const isPrologue = mnemonic === 'push' && first?.kind === 'reg' && registerBase(first.reg || '') === 'rbp'
        || (mnemonic === 'mov' && first?.kind === 'reg' && registerBase(first.reg || '') === 'rbp')
        || (mnemonic === 'sub' && first?.kind === 'reg' && registerBase(first.reg || '') === 'rsp' && second?.kind === 'imm');
      if (isPrologue) {
        // Past the prologue the frame is exactly where `frame.slots` says it is.
        if (!prologueSeen) { prologueSeen = true; rspShift = 0; }
      } else if (prologueSeen) {
        if (mnemonic === 'push') rspShift -= 8;
        else if (mnemonic === 'pop') rspShift += 8;
        else if ((mnemonic === 'sub' || mnemonic === 'add') && first?.kind === 'reg'
          && registerBase(first.reg || '') === 'rsp' && second?.kind === 'imm') {
          const amount = typeof second.value === 'number' ? second.value : 0;
          rspShift += mnemonic === 'sub' ? -amount : amount;
        }
      }
      ins.rspOffset = rspShift;
    }
    for (const ins of block.instructions) {
      // Prefixes are part of the printed mnemonic (`lock cmpxchg`) but not part of
  // the instruction's identity: the atomics below are the same operation with or
  // without `lock`, and matching on the full text silently skipped every one of
  // them that had a prefix.
  const m = ins.mnemonic.toLowerCase().replace(/^(lock|repne|rep|lock repne|lock rep)\s+/i, '');
      const [a, b] = ins.operands;
      if (m === 'cmp' || m === 'test') {
        pending = { op: m === 'cmp' ? 'cmp' : 'test', left: operandExpr(a, ins, frame), right: operandExpr(b, ins, frame) };
        continue;
      }
      // The scalar float compares. `ucomiss`/`comiss` set ZF, PF and CF together, and
      // Go's compiler reads them in pairs: `jne` then `jnp` is "not equal and not
      // unordered", i.e. `!=` on the two values. Without this the pair printed as
      // `if (!(0))` with a jump the reader could not follow.
      if (m === 'ucomiss' || m === 'comiss' || m === 'ucomisd' || m === 'comisd') {
        pending = { op: 'float', left: operandExpr(a, ins, frame), right: operandExpr(b, ins, frame) };
        continue;
      }
      // Track the stack pointer: push/pop and the prologue's `sub rsp` change what
      // a displacement means. `push` moves rsp down by 8, `pop` up by 8, and a
      // `sub rsp, N` moves it by N.
      if (m === 'nop' || m === 'endbr64' || m === 'leave' || m === 'push' || m === 'pop'
        || m === 'stc' || m === 'clc' || m === 'cmc' || m === 'cld' || m === 'std'
        || m === 'sahf' || m === 'lahf' || m === 'pause') continue;
      // `int3` is alignment padding (0xCC fills every function's tail). A block
      // that begins there has nothing to say, so it ends the lift instead of
      // contributing an "unknown" line the reader has to interpret.
      if (m === 'int3') break;
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
        // `jmp rcx` — the destination is a value, so there is no address to follow. The
        // register is kept so the listing can say where control went instead of stopping.
        if (target == null && a?.kind === 'reg' && a.reg) indirect = registerBase(a.reg);
        continue;
      }
      if (m.startsWith('j') && (JCC[m] || FLAG_JUMPS.has(m))) {
        // The flag-only jumps — `jo`, `jno`, `jp`, `jnp` — have no entry in JCC
        // because their condition comes from the instruction before them, not from
        // the operands of a compare. Asking `JCC[m]` here meant every one of them
        // fell through to the catch-all, including the overflow checks (`imul; jo`)
        // and the float compares (`ucomiss; jne; jnp`) that the two handlers above
        // had just worked out a condition for.
        const flagCond = conditionFrom(m, pending);
        if (flagCond) {
          term = 'jcc';
          cond = flagCond;
          target = a?.target;
        }
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
        // A direct call names its destination when a symbol table was handed in, and
        // falls back to the address otherwise. `sub_40086ee0()` is not a call to
        // anything: the name is declared nowhere and a C compiler rejects it. The same
        // address is `internal/runtime/maps.fatal` in the Go function table, which the
        // caller has and simply never passed down.
        let name = 'indirect_call';
        if (targetExpr.t === 'const') {
          // No `>>> 0` here. The call target is a full 64-bit address — `0x140086ee0` is
          // 5369261792, past 2^32 — and `>>> 0` truncates it to `0x40086ee0`, which
          // matches no function table entry. That is why every call stayed `sub_...`
          // even with the table in hand. The unsigned coercion belongs where a value is
          // being printed as 32-bit, not where an address is being looked up.
          const address = targetExpr.v;
          const known = names?.get(address) ?? names?.get(address >>> 0);
          name = known ? sanitiseName(known) : `sub_${address.toString(16)}`;
        }
        const args: Expr[] = [];
        for (const register of frame.argRegisters) {
          const value = regValues.get(register);
          if (!value) break;
          args.push(value);
          const index = argStmtIndex.get(register);
          if (index != null) deleted.add(index);
        }
        // The statement that set up an argument register is dropped because the
        // call carries its value. That is only true if the register is not read
        // again: `mov rcx, rax; mov rbx, rcx; call f` forwards rcx *through* rbx,
        // and dropping the first move left the second reading a register nothing
        // assigned. Keep any deleted statement whose destination is still read by
        // an instruction later in this block.
        for (const [register, index] of argStmtIndex) {
          if (!deleted.has(index)) continue;
          // Any read anywhere in the block counts, not only reads after the call:
          // the forwarding chain `mov rcx, rax; mov rbx, rcx; call f` reads rcx
          // before the call, and that read is what carries the value forward.
          const stillNeeded = block.instructions.some((later) => {
            if (later.address === ins.address) return false;
            return later.operands.some((operand) => {
              if (operand.kind === 'reg') return registerBase(operand.reg || '') === register;
              if (operand.kind === 'mem') {
                return registerBase(operand.base || '') === register
                  || registerBase(operand.index || '') === register;
              }
              return false;
            });
          });
          if (stillNeeded) deleted.delete(index);
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
      // Anything touching a vector register is outside what this IR models: it tracks
// integer and pointer values, and a 128-bit lane has neither. Printing
// `xmm0 = xmm0` for the compiler's `movd`/`xorps` register-juggling would add
// lines that say nothing.
      if ((m === 'bsf' || m === 'bsr') && a && b) {
        // Bit scan: index of the lowest or highest set bit. Go uses these to
        // compute shifts and leading-zero counts, so saying which bit is meant it
        // keeps the value flow that follows readable.
        const target = operandExpr(a, ins, frame);
        stmts.push({
          t: 'assign',
          target,
          value: { t: 'call', target: m === 'bsf' ? 'lowest_set_bit' : 'highest_set_bit', args: [operandExpr(b, ins, frame)], size: target.size },
        });
        continue;
      }
      if (m === 'mul' && a) {
        // Unsigned multiply of rax by the operand; the product lands in rdx:rax.
        // Go emits it for division by a constant, so the high half is usually the
        // one read next.
        stmts.push({
          t: 'assign',
          target: { t: 'reg', name: 'rax', size: 64 },
          value: { t: 'bin', op: '*', left: { t: 'reg', name: 'rax', size: 64 }, right: operandExpr(a, ins, frame), size: 64 },
        });
        stmts.push({ t: 'note', text: 'the high half of this product is in rdx' });
        // The `jo` that follows an unsigned multiply is Go's overflow check: the
        // product lands in rdx:rax and the jump asks whether it fit in rax. Same
        // treatment as `imul`, which reaches the shared arithmetic path below.
        pending = { op: 'overflow', left: { t: 'reg', name: 'rax', size: 64 }, right: constExpr(0, 64) };
        continue;
      }
      if (/xmm\d+/.test(a?.reg || '') || /xmm\d+/.test(b?.reg || '')) continue;
      // Vector instructions named without operands — the AES and AVX encodings
      // whose operand shapes this decoder does not model — are stepping stones for
      // the vector unit alone. They carry no integer value this IR tracks, so they
      // are passed over rather than reported as something not understood.
      if (isVectorOnly(m)) continue;
      // Atomics. `cmpxchg` compares the destination against rax and swaps on a
      // match; `xadd` exchanges and adds. Both say something about the value, so
      // they are recorded as a store with the exchange stated — dropping them
      // would lose the write entirely, and the destination is exactly what the
      // lock prefix exists to protect.
      if (m === 'cmpxchg' || m === 'xadd') {
        if (!a || !b) continue;
        const destination = operandExpr(a, ins, frame);
        const register = operandExpr(b, ins, frame);
        stmts.push({ t: 'assign', target: destination, value: register });
        stmts.push({
          t: 'note',
          text: m === 'cmpxchg'
            ? 'atomic: swaps rax and the destination when they are equal'
            : 'atomic: exchanges the register and the destination, then adds them',
        });
        continue;
      }
      if (m === 'mov' || m === 'movabs') {
        // Segment-register moves do not affect the value flow this IR models.
        if (a?.kind === 'reg' && a.reg === 'seg' || b?.kind === 'reg' && b.reg === 'seg') continue;
        // `mov [rbp-8], rdi` is the prologue spilling an argument. The slot is
        // already named arg0, so printing `arg0 = rdi` would overwrite the
        // parameter with itself.
        // Go addresses the frame off `rsp` as often as off `rbp`, so both bases name
        // the same slot: a displacement is only meaningful together with the base,
        // and the rsp form needs the frame subtracted the same way `slotFor` does.
        if (a?.kind === 'mem' && (a.base === 'rbp' || a.base === 'rsp') && typeof a.disp === 'number' && b?.kind === 'reg') {
          const offset = a.base === 'rsp'
            ? rspSlotOffset(a.disp + (ins.rspOffset || 0), frame)
            : a.disp;
          const slot = frame.slots.get(offset);
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
        // `sbb x, x` is Go's branchless way to materialise a borrow: x - x - carry
        // is just -carry, i.e. 0 or -1. Printed as `x = x - x` it reads as a value
        // combined with itself, which is exactly the shape of thing this
        // decompiler is supposed to never print.
        const sameOperand = a.kind === 'reg' && b.kind === 'reg' && a.reg === b.reg;
        if (m === 'sbb' && sameOperand) {
          stmts.push({ t: 'assign', target: left, value: { t: 'un', op: '-', value: { t: 'const', v: 1, size: left.size }, size: left.size } });
          stmts.push({ t: 'note', text: 'the -1 above is the borrow, not a literal: sbb x, x is 0 or -1 from the carry flag' });
          continue;
        }
        stmts.push({
          t: 'assign',
          target: left,
          value: { t: 'bin', op: BINARY_VERBS[m], left, right: operandExpr(b, ins, frame), size: left.size },
        });
        if (CARRIED[m]) stmts.push({ t: 'note', text: `${m} carries the borrow into this result` });
        // An arithmetic instruction overwrites the flags a compare left behind:
        // keeping the old operands made a following flag-only jump compare values
        // from before this result existed. A multiplication is the exception — the
        // flags describe the product, and the `jo` that follows one is Go's overflow
        // check on it.
        pending = m === 'imul' || m === 'mul'
          ? { op: 'overflow', left, right: constExpr(0, left.size) }
          : null;
        continue;
      }
      // Bit test-and-modify: `bts a, b` sets one bit of a. The bit index is usually a
// runtime value, so the exact mask cannot be printed; saying which bit was set
// is more useful than dropping the instruction.
      if ((m === 'bts' || m === 'btr' || m === 'btc') && a && b) {
        const bit = operandExpr(b, ins, frame);
        const verb = m === 'bts' ? 'sets' : m === 'btr' ? 'clears' : 'flips';
        stmts.push({ t: 'note', text: `${m} ${verb} one bit of ${a.kind === 'mem' ? a.mem || 'that value' : operandExpr(a, ins, frame).t === 'var' ? (operandExpr(a, ins, frame) as { name: string }).name : 'the destination'}${bit.t === 'const' ? ` (bit ${bit.v})` : ''}` });
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
      // Trap instructions end the path by design. `ud2` is the compiler's "this
      // cannot happen", `int 3` is a breakpoint, and Go emits both as the body of a
      // function that is not meant to return — `runtime.abort.abi0` is one `int 3`.
      // Reporting them as unexplained made those functions look empty.
      if (m === 'ud2') {
        stmts.push({ t: 'note', text: 'ud2: the compiler marked this path unreachable' });
        term = 'ret';
        continue;
      }
      if (m === 'int' && (a?.kind === 'imm' ? a.value === 3 : false)) {
        stmts.push({ t: 'note', text: 'int 3: breakpoint trap, does not continue' });
        term = 'ret';
        continue;
      }
      // The string instructions take no operands: the source and destination are
      // implicit in rsi/rdi. Go inlines small copies this way, and the output should
      // say what happened to the memory rather than leaving a hole where the copy is.
      if (STRING_OPS[m]) {
        const sizes: Record<string, number> = { b: 8, w: 16, d: 32, q: 64 };
        const width = sizes[STRING_OPS[m].width] ?? 8;
        const destination = { t: 'load' as const, addr: { t: 'reg' as const, name: 'rdi', size: 64 }, size: width };
        const source = STRING_OPS[m].kind === 'move'
          ? { t: 'load' as const, addr: { t: 'reg' as const, name: 'rsi', size: 64 }, size: width }
          : { t: 'reg' as const, name: 'rax', size: width };
        stmts.push({ t: 'assign', target: destination, value: source });
        stmts.push({ t: 'note', text: `${m} advances the pointer by ${width / 8} byte(s)` });
        continue;
      }
      // The flag save and restore. `pushfq`/`popfq` move the flags register through
      // the stack and write no general register, so there is no assignment to make;
      // the flags are state this IR does not model, and saying so is the whole
      // statement.
      if (m === 'pushfq' || m === 'popfq') {
        stmts.push({ t: 'note', text: `${m}: saves or restores the flags register` });
        continue;
      }
      if (NAMED_VALUES[m]) {
        // Zero-operand forms (cpuid) write rax too, but naming the operation is what
        // matters; the destination of the general form is operand 0.
        const target = a ? operandExpr(a, ins, frame) : { t: 'reg' as const, name: 'rax', size: 64 };
        const source = b ? operandExpr(b, ins, frame) : null;
        stmts.push({
          t: 'assign',
          target,
          value: { t: 'call', target: NAMED_VALUES[m], args: source ? [source] : [], size: target.size || 64 },
        });
        continue;
      }
      unknown += 1;
      stmts.push({ t: 'unknown', text: `${m} ${ins.operands.map((operand) => operand.reg || operand.mem || (operand.value != null ? `0x${(operand.value >>> 0).toString(16)}` : '')).filter(Boolean).join(', ')}`.trim() });
    }

    // A block that ends in a conditional jump but has no condition is still a
    // branch; say so rather than printing `if (?)`.
    if (term === 'jcc' && !cond) cond = { t: 'unknown', text: 'flags', size: 1 };
    lifted.push({
      start: block.start,
      end: block.end,
      stmts: dropDeadWrites(stmts.filter((_stmt, index) => !deleted.has(index))),
      cond,
      term,
      ...(target != null ? { target } : {}),
      ...(indirect != null ? { indirect } : {}),
      instructions: block.instructions.length,
    });
    void unknown;
    void byStart;
  }
  return lifted;
}

/**
 * Turn a Go symbol name into an identifier a C compiler accepts.
 *
 * Go names are not C names. `internal/runtime/maps.(*Map).Clear` has four kinds of
 * character C does not allow in an identifier, and 98.9% of the names in the function
 * table fail the test — so a call to one and the definition of one are both rejected
 * before the rest of the body is even read. The mangling is reversible, which is the
 * point: the reader can see the package path and the receiver in the printed name.
 *
 * The rule is the usual one for this: everything outside `[A-Za-z0-9_]` becomes `_`,
 * with `_1`-style escapes for the separators that carry meaning, so two different Go
 * names cannot collide after the rewrite. Called from both the call site and the
 * definition, so the two agree.
 */
export function sanitiseName(name: string): string {
  // A plain substitution of every character C rejects — 98.9% of the Go function table
  // needs it. Kept this simple after checking, not assuming: a version that gave `.`
  // and `/` different spellings to avoid collisions, and another that transliterated
  // brackets and receivers, both worked, and the plain one has no collisions either
  // across the 19376 names of a 24 MB binary. `internal/runtime/maps.(*Map).Clear`
  // becomes `internal_runtime_maps___Map__Clear`, which a reader can follow back.
  const out = name.replace(/[^A-Za-z0-9_]/g, '_');
  // A leading digit is not an identifier either.
  return /^[0-9]/.test(out) ? `_${out}` : out;
}
