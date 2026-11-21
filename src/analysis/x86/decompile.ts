/**
 * Function decompiler: disassembly → CFG → frame → IR → structured control
 * flow → C.
 *
 * This is not a source-level reconstruction. It prints what the instructions
 * do: registers stay registers, stack slots become named locals, flags are
 * folded into the comparison that produced them, and loops become `while` /
 * `do` when their shape is recognisable. Anything the pipeline cannot express
 * stays as an `unknown` comment instead of being dropped.
 */
import { disassembleFunction } from './function.js';
import { buildCfg } from './cfg.js';
import { analyzeFrame, inferRegisterParams, type Convention, type Frame } from './frame.js';
import { lift, type Expr, type Stmt } from './ir.js';
import { structure, negate, type CtrlStmt } from './structure.js';
import { optimizeStatements } from './optimize.js';
import { recoverSwitch } from './switch.js';
import { typeForSize, typeOfExpr, refineParam, type CType } from './types.js';

export interface DecompileOptions {
  name?: string;
  convention?: Convention;
  imageFormat?: string;
  /** Exclusive end of the function, normally the next symbol's entry. */
  end?: number;
  maxInstructions?: number;
  /**
   * Names of routines that never return, so control does not continue past a
   * call to one.
   *
   * Go's panic helpers (`runtime.gopanic`, `runtime.panicindex`, …) end the
   * goroutine. The code after them in the same function is only reached on the
   * unwind path, not by falling through, and printing it puts `return rbx` in a
   * body where rbx is the panic value.
   */
  noReturnCalls?: Set<string>;
}

export interface DecompiledFunction {
  name: string;
  entry: number;
  c: string;
  instructions: number;
  unknownPct: number;
  blocks: number;
  loops: number;
  gotos: number;
  params: Array<{ name: string; type: CType }>;
  locals: Array<{ name: string; type: CType }>;
  note?: string;
}

export function decompileFunction(
  code: Uint8Array,
  baseVaddr: number,
  entry: number,
  options: DecompileOptions = {},
): DecompiledFunction {
  const convention: Convention = options.convention
    || (options.imageFormat === 'pe' ? 'win64' : 'sysv');
  const fn = disassembleFunction(code, baseVaddr, entry, {
    name: options.name,
    end: options.end,
    maxInstructions: options.maxInstructions ?? 4000,
  });
  const blocks = buildCfg(fn.instructions);
  const frame = analyzeFrame(fn.instructions, convention);
  const lifted = lift(fn.instructions, blocks, frame);
  for (let index = 0; index < lifted.length; index++) {
    const info = recoverSwitch(
      lifted[index], blocks[index]?.instructions || [], code, baseVaddr,
      (address) => address >= baseVaddr && address - baseVaddr < code.length,
    );
    if (info) lifted[index].switch = info;
  }
  foldStackCheck(lifted, entry, options.noReturnCalls);
  const structured = structure(lifted, entry);
  const body = optimizeControl(optimize(structured.body));
  // Judged on the structured body, before dead-store elimination: a single
  // constant move followed by `ret rax` optimises down to one statement, and
  // deciding afterwards would call that a pass-through when the function did
  // compute something.
  const passThroughReturn = structured.body.length === 1 && structured.body[0]?.t === 'return';

  // Go does not spill its register arguments, so when the frame has no saved
  // arguments the inputs are recovered from the first reads instead.
  // Always infer from the reads, and let the merge below reconcile them with the
  // slots the prologue already named. A slot named `argN` records that one
  // argument was spilled; it says nothing about the ones the body still reads out
  // of registers, so treating a spill as a complete signature left the rest out.
  // Only the instructions the reader will actually see. The stack-growth retry
  // restores callee-saved registers from values it saved earlier, and reading
  // those made `rbx` look like an incoming argument when it was the runtime's
  // own bookkeeping — one phantom parameter per guard.
  const visible = liftableInstructions(fn.instructions, lifted);
  // The code that runs first, following the entry block through fall-through and
  // the main arm of each guard. A linear scan sees the panic path's `call` before
  // the body does and stops there.
  const entryPath = entryPathInstructions(fn.instructions, lifted, entry);
  const inferred = inferRegisterParams(visible, frame, entryPath);
  const renamed = new Map(inferred.map((param) => [param.register, param.name]));
  const paramNames = new Set(inferred.map((param) => param.name));
  const finalBody = renamed.size ? body.map((stmt) => renameStmt(stmt, renamed, paramNames)) : body;

  const info = collect(finalBody, frame, paramNames, passThroughReturn);
  const params = parameterList(frame, info);
  for (const param of inferred) {
    if (params.some((existing) => existing.name === param.name)) continue;
    const entry = info.vars.get(param.name);
    params.push({ name: param.name, type: entry?.type === 'void *' ? 'void *' : 'long' });
  }
  params.sort((a, b) => Number(a.name.replace(/\D/g, '')) - Number(b.name.replace(/\D/g, '')));
  const locals = [...info.vars.values()]
    .filter((local) => !params.some((param) => param.name === local.name))
    // A declaration for a name that no printed statement mentions is noise, and
    // the reader cannot tell it from a value the pipeline lost. The collectors
    // run before the return-value rewrite above, so names that only appeared in a
    // dropped return are still in `vars`.
    .filter((local) => mentionsName(finalBody, local.name))
    .map((local) => ({ name: local.name, type: local.type }));
  const signature = `${returnType(info)} ${fn.name}(${params.length ? params.map((param) => `${param.type} ${param.name}`).join(', ') : 'void'})`;

  const lines: string[] = [];
  const unknownPct = fn.instructions.length
    ? Math.round((fn.unknown / fn.instructions.length) * 1000) / 10
    : 0;
  lines.push(`/* ${fn.name} @ 0x${entry.toString(16)} — ${fn.instructions.length} instructions, ${blocks.length} blocks, ${structured.loops} loop(s), ${structured.gotos} goto(s)${unknownPct ? `, ${unknownPct}% undecoded` : ''} */`);
  if (inferred.length) lines.push('/* parameters inferred from register reads (register ABI); the signature is approximate */');
  lines.push(`${signature}`);
  lines.push('{');
  for (const local of locals) lines.push(`    ${local.type} ${local.name};`);
  const uninitialised = uninitialisedNote(info);
  if (uninitialised) lines.push(`    ${uninitialised}`);
  if (locals.length) lines.push('');
  for (const stmt of finalBody) lines.push(...printStmt(stmt, 1));
  lines.push('}');

  return {
    name: fn.name,
    entry,
    c: lines.join('\n'),
    instructions: fn.instructions.length,
    unknownPct,
    blocks: blocks.length,
    loops: structured.loops,
    gotos: structured.gotos,
    params,
    locals,
    ...(fn.truncated ? { note: 'traversal hit its instruction budget; this is a partial function' } : {}),
  };
}


/**
 * Go emits a stack-growth check as a branch to a thunk that calls morestack and
 * jumps back to the entry. Read literally it is `while (1)` around the whole
 * function; the branch is a prologue detail, so the thunk is folded away and
 * the entry keeps its fall-through.
 */
/** Fold the stack-growth retry a guard feeds, if that is where it leads. */
function foldRetryPath(guard: import('./ir.js').LiftedBlock, entry: number, byStart: Map<number, import('./ir.js').LiftedBlock>): boolean {
  if (guard.term !== 'jcc' || guard.target == null) return false;
  const path: number[] = [];
  const seen = new Set<number>();
  let current: number | null = guard.target;
  let closes = false;
  while (current != null && !seen.has(current)) {
    seen.add(current);
    const block = byStart.get(current);
    if (!block) break;
    path.push(current);
    if (block.term === 'jmp') { closes = block.target === entry; break; }
    if (block.term === 'ret') break;
    current = block.end;
  }
  if (!closes || !path.length) return false;
  guard.term = 'fallthrough';
  guard.cond = null;
  delete guard.target;
  for (const start of path) {
    const block = byStart.get(start);
    if (!block) continue;
    block.folded = true;
    block.stmts = [];
  }
  return true;
}

function foldStackCheck(
  lifted: import('./ir.js').LiftedBlock[],
  entry: number,
  noReturnCalls: Set<string> = new Set(),
): void {
  const byStart = new Map(lifted.map((block) => [block.start, block]));
  const entryBlock = byStart.get(entry);
  if (!entryBlock) return;

  // Go emits one guard per function that needs a bigger stack, and they all lead
  // to the same grow-and-retry tail. Following only the entry's guard left the
  // others intact, and their restores read callee-saved registers that nothing in
  // that path had written — which read as incoming arguments and printed as
  // locals with no assignment.
  let foldedAny = false;
  for (const block of lifted) {
    if (block.start === entry || block.folded) continue;
    if (foldRetryPath(block, entry, byStart)) foldedAny = true;
  }
  if (foldRetryPath(entryBlock, entry, byStart)) {
    // The entry's guard is the one the reader would otherwise ask about, so it
    // keeps a one-line note in its place.
    entryBlock.stmts.unshift({ t: 'note', text: 'stack check: grows the goroutine stack, then re-runs this function' });
    foldedAny = true;
  }

  if (foldedAny) {
    // A block that jumps back to the entry is the same retry reached from a guard
    // that has just been folded; it is unreachable now.
    for (const block of lifted) {
      if (block.start === entry || block.folded) continue;
      if (block.term === 'jmp' && block.target === entry) {
        block.folded = true;
        block.stmts = [];
      }
    }
  }

  // Independent of guards: panic paths and alignment padding sit in the
  // function's address range without a branch into them.
  foldUnreachable(lifted, entry, noReturnCalls);
}

/**
 * Fold blocks that control flow cannot reach.
 *
 * Go emits panic paths and stack-guard tails that sit after a `ret` with no
 * branch into them: they run only from a call that never returns, and the
 * disassembler still lifts them because they sit in the function's address
 * range. Printing them puts `return rbx` in a body where rbx is the panic
 * value, which reads as an unassigned local the reader is supposed to explain.
 *
 * Reachability is computed over the successors that survive folding, so this
 * runs after the stack-guard pass and cannot resurrect what it removed.
 */
function foldUnreachable(
  lifted: import('./ir.js').LiftedBlock[],
  entry: number,
  noReturnCalls: Set<string> = new Set(),
): void {
  const byStart = new Map(lifted.map((block) => [block.start, block]));
  const order = lifted.filter((block) => !block.folded).map((block) => block.start).sort((a, b) => a - b);
  const nextOf = (block: import('./ir.js').LiftedBlock): number | null => {
    const index = order.indexOf(block.start);
    return index >= 0 && index + 1 < order.length ? order[index + 1] : null;
  };

  const reachable = new Set<number>();
  const queue: number[] = [entry];
  while (queue.length) {
    const start = queue.pop() as number;
    if (reachable.has(start)) continue;
    const block = byStart.get(start);
    if (!block || block.folded) continue;
    reachable.add(start);
    if (block.switch) {
      for (const item of block.switch.cases) queue.push(item.target);
      if (block.switch.defaultTarget != null) queue.push(block.switch.defaultTarget);
      continue;
    }
    if (block.term === 'ret') continue;
    if (block.target != null) queue.push(block.target);
    // Falling through a call that never returns does not happen: the code that
    // follows it in the same function is only entered from the unwind path.
    if (block.term !== 'jmp' && !endsInNoReturnCall(block, noReturnCalls)) {
      const next = nextOf(block);
      if (next != null) queue.push(next);
    }
  }

  for (const block of lifted) {
    if (block.folded || reachable.has(block.start)) continue;
    block.folded = true;
    block.stmts = [];
  }
}

/** Does this block's last statement call a routine that never returns? */
function endsInNoReturnCall(block: import('./ir.js').LiftedBlock, noReturnCalls: Set<string>): boolean {
  if (!noReturnCalls.size) return false;
  for (let index = block.stmts.length - 1; index >= 0; index -= 1) {
    const stmt = block.stmts[index];
    if (stmt.t !== 'assign') continue;
    if (stmt.value.t !== 'call') continue;
    return noReturnCalls.has(stmt.value.target);
  }
  return false;
}

/**
 * The instructions that survive folding, in address order.
 *
 * Parameter inference wants the code a reader will see. Feeding it the whole
 * listing let the stack-growth retry contribute: it restores callee-saved
 * registers from slots it filled before, and the restore reads a register
 * nothing in that path had written, which looked exactly like an incoming
 * argument.
 */
function liftableInstructions(
  all: import('./decode.js').Instruction[],
  lifted: import('./ir.js').LiftedBlock[],
): import('./decode.js').Instruction[] {
  const kept = new Set<string>();
  for (const block of lifted) {
    if (block.folded) continue;
    for (let address = block.start; address < block.end; address += 1) kept.add(String(address));
  }
  // Block boundaries are byte addresses, but instructions sit at arbitrary
  // offsets; keep an instruction when its own address is inside a live block.
  return all.filter((instruction) => {
    for (const block of lifted) {
      if (block.folded) continue;
      if (instruction.address >= block.start && instruction.address < block.end) return true;
    }
    return false;
  });
}


/**
 * The instructions on the entry path, in execution order.
 *
 * Walks from the entry block along its fall-through edge and, at a guard, into
 * the arm that continues rather than the one that leaves the function. Go lays
 * panic paths out inside the same address range, often before the main body, and
 * a linear read of the listing hit their `call` and stopped — so the arguments
 * the body reads afterwards were never seen.
 */
function entryPathInstructions(
  all: import('./decode.js').Instruction[],
  lifted: import('./ir.js').LiftedBlock[],
  entry: number,
): import('./decode.js').Instruction[] {
  const byStart = new Map(lifted.map((block) => [block.start, block]));
  const order = lifted.filter((block) => !block.folded).map((block) => block.start).sort((a, b) => a - b);
  const nextOf = (block: import('./ir.js').LiftedBlock): number | null => {
    const index = order.indexOf(block.start);
    return index >= 0 && index + 1 < order.length ? order[index + 1] : null;
  };
  const path: import('./decode.js').Instruction[] = [];
  const seen = new Set<number>();
  let current: number | null = entry;
  while (current != null && !seen.has(current) && path.length < 64) {
    seen.add(current);
    const block = byStart.get(current);
    if (!block || block.folded) break;
    for (let address = block.start; address < block.end; address += 1) {
      const instruction = all.find((candidate) => candidate.address === address);
      if (instruction) path.push(instruction);
    }
    if (block.term === 'ret') break;
    // At a guard, follow the arm that continues the body: the fall-through when
    // that is a live block, and the branch target when the fall-through is the
    // path that leaves. Go puts the panic or error path in the fall-through slot
    // as often as in the target slot, so neither position can be assumed.
    const fallthrough = nextOf(block);
    if (block.term === 'jcc' && block.target != null) {
      const target = byStart.get(block.target);
      const fallthroughBlock = fallthrough != null ? byStart.get(fallthrough) : undefined;
      // Both arms of a guard can end in `ret`: one returns a value, the other
      // calls a panic helper and returns. Picking by `term` therefore cannot tell
      // the body from the exit path. The body is the arm that carries the work, so
      // the comparison is on how much code follows.
      // Compare the two arms by how many instructions they carry in total,
      // following only forward edges. A panic arm is a call and a return; the body
      // carries the work.
      const weight = (start: number | null | undefined): number => {
        if (start == null) return -1;
        const seen = new Set<number>();
        const queue = [start];
        let total = 0;
        while (queue.length && seen.size < 40) {
          const nextStart = queue.shift() as number;
          if (seen.has(nextStart)) continue;
          seen.add(nextStart);
          const candidate = byStart.get(nextStart);
          if (!candidate || candidate.folded) continue;
          total += candidate.instructions || 1;
          if (candidate.term === 'ret' || candidate.term === 'jmp') continue;
          if (candidate.term === 'jcc' && candidate.target != null) queue.push(candidate.target);
          const following = nextOf(candidate);
          if (following != null) queue.push(following);
        }
        return total;
      };
      const targetWeight = weight(block.target);
      const fallthroughWeight = weight(fallthrough);
      current = fallthroughWeight > targetWeight ? fallthrough : block.target;
      continue;
    }
    current = block.term === 'jmp' ? block.target ?? null : fallthrough;
  }
  return path;
}

interface Collected {
  vars: Map<string, { name: string; size: number; type: CType }>;
  returnsValue: boolean;
  /** Names returned without ever being written — an undefined read, not a value. */
  undefinedReturns: Set<string>;
}

function collect(body: CtrlStmt[], frame: Frame, params: Set<string> = new Set(), passThroughReturn = false): Collected {
  const vars: Collected['vars'] = new Map();
  // `rsp` and `rbp` always hold something: the stack pointer and the frame base
  // exist before the function does. Reporting either as "read before written" is
  // never right, and it was a large share of the remaining warnings on functions
  // that touch the frame through `mov [rsp+8], ...`.
  const defined = new Set<string>([...params, 'rsp', 'rbp']);
  const undefinedReturns = new Set<string>();
  /** Names the body writes. Empty means the function computes nothing of its own. */
  const writes = new Set<string>();
  let returnsValue = false;

  const note = (name: string, size: number) => {
    const existing = vars.get(name);
    if (existing) {
      if (size > existing.size) { existing.size = size; existing.type = typeForSize(size); }
      return;
    }
    const slot = [...frame.slots.values()].find((candidate) => candidate.name === name);
    const resolved = slot ? slot.size : size;
    vars.set(name, { name, size: resolved, type: typeForSize(resolved) });
  };

  const expr = (value: Expr | undefined) => {
    if (!value) return;
    switch (value.t) {
      case 'reg':
      case 'var':
        note(value.name, value.size);
        return;
      case 'load': {
        if (value.addr.t === 'var' || value.addr.t === 'reg') {
          note(value.addr.name, value.addr.size);
          const entry = vars.get(value.addr.name);
          if (entry) entry.type = 'void *';
        }
        expr(value.addr);
        return;
      }
      case 'bin':
        expr(value.left); expr(value.right); return;
      case 'un':
        expr(value.value); return;
      case 'cast':
        expr(value.value); return;
      case 'select':
        expr(value.cond); expr(value.a); expr(value.b); return;
      case 'call':
        for (const arg of value.args) expr(arg);
        return;
      default:
        return;
    }
  };

  const stmt = (item: CtrlStmt) => {
    switch (item.t) {
      case 'assign':
        // The value is read before the target is written: `rax = rax + 1`
        // reads an undefined rax, and that is the bug this catches.
        undefinedReads(item.value, defined, undefinedReturns);
        expr(item.value);
        expr(item.target);
        // A versioned name (`rbx_2`) is a fresh variable, but the base name has
        // been written too: without this every version of a pinned register read
        // as undefined.
        defined.add(nameOf(item.target));
        if (nameOf(item.target)) {
          writes.add(nameOf(item.target));
          const base = nameOf(item.target).replace(/_\d+$/, '');
          if (base !== nameOf(item.target)) defined.add(base);
        }
        // A call hands back its results in registers the previous call also
        // wrote. Go returns a second value in rbx, so `mov rax, rbx` after
        // `call ExportedMethods` reads that call's result — a defined value, not
        // an unassigned local.
        if (item.value.t === 'call') {
          for (const register of ['rax', 'rbx', 'rcx', 'rdx', 'rsi', 'rdi', 'r8', 'r9', 'r10', 'r11']) {
            defined.add(register);
          }
        }
        if (item.target.t === 'reg' && item.target.name === 'rax') returnsValue = true;
        return;
      case 'expr':
        undefinedReads(item.expr, defined, undefinedReturns);
        expr(item.expr);
        return;
      case 'return':
        if (item.value) {
          // A pass-through is the whole body: a bare `ret` handing back the
          // register it was given. Go emits that idiom widely, and labelling it
          // put the warning on a third of every binary until readers learned to
          // ignore it. Anything longer that reads an unwritten name really is
          // an undefined read.
          if (!passThroughReturn) undefinedReads(item.value, defined, undefinedReturns);
          else {
            // The pass-through idiom reads the value it was handed, so that value
            // is defined — the function's whole body is "give back what you got".
            // Without this the declaration pass declared the register and nothing
            // ever assigned it, which reads like a lost statement.
            for (const name of ['rax', 'rbx']) defined.add(name);
          }
          expr(item.value);
          // `rax` is only a return value if the function ever put something in
          // it. A hand-written assembly routine stores its result into the
          // caller's frame (`mov [rsp+8], 1`) and returns without touching rax —
          // printing `long f(void) { return rax; }` there is an invention.
          const returnsRax = item.value.t === 'reg' && item.value.name === 'rax';
          if (returnsRax && !defined.has('rax') && !passThroughReturn) {
            // Nothing wrote rax and this is not the pass-through idiom: the
            // routine returns through the caller's frame or a different register.
            // `void f(void) { return rax; }` is not C, so the value is dropped —
            // and so is the undefined-read record for it, because the read is no
            // longer in the output and a warning about an absent line is noise.
            item.value = undefined;
            undefinedReturns.delete('rax');
            returnsValue = false;
            return;
          }
          expr(item.value);
          returnsValue = true;
        }
        return;
      case 'if':
        expr(item.cond); item.then.forEach(stmt); item.else?.forEach(stmt); return;
      case 'while':
        if (item.cond) expr(item.cond);
        item.body.forEach(stmt);
        return;
      case 'do':
        item.body.forEach(stmt); expr(item.cond); return;
      default:
        return;
    }
  };

  body.forEach(stmt);
  // A name that the function writes anywhere is not an undefined read, even when
  // the read comes first in the printed order: the write is on another branch.
  // Going by printed order alone labelled every register the decompiler happened
  // to place after its assignment — `mov rcx, rbx` printed before the `lea rbx`
  // that defines rbx is a branch, not a bug.
  for (const name of writes) undefinedReturns.delete(name);
  return { vars, returnsValue, undefinedReturns };
}

/** Does any printed statement read or write this name? */
function mentionsName(body: CtrlStmt[], name: string): boolean {
  const inExpr = (value: Expr | undefined): boolean => {
    if (!value) return false;
    switch (value.t) {
      case 'reg': case 'var': return value.name === name;
      case 'load': return inExpr(value.addr);
      case 'bin': return inExpr(value.left) || inExpr(value.right);
      case 'un': return inExpr(value.value);
      case 'cast': return inExpr(value.value);
      case 'select': return inExpr(value.cond) || inExpr(value.a) || inExpr(value.b);
      case 'call': return value.args.some((arg) => inExpr(arg));
      default: return false;
    }
  };
  const inStmt = (item: CtrlStmt): boolean => {
    switch (item.t) {
      case 'assign': return inExpr(item.target) || inExpr(item.value);
      case 'expr': return inExpr(item.expr);
      case 'return': return inExpr(item.value);
      case 'if': return inExpr(item.cond) || item.then.some(inStmt) || (item.else || []).some(inStmt);
      case 'while': return inExpr(item.cond || undefined) || item.body.some(inStmt);
      case 'do': return item.body.some(inStmt) || inExpr(item.cond);
      default: return false;
    }
  };
  return body.some(inStmt);
}

/**
 * Names this expression reads that nothing has written yet.
 *
 * Walked rather than checked at the top level: `return rax + 1` reads rax one
 * level down, and a top-level-only check called that fine.
 */
function undefinedReads(value: Expr | undefined, defined: Set<string>, out: Set<string>): void {
  if (!value) return;
  switch (value.t) {
    case 'reg':
    case 'var':
      if (value.name && !defined.has(value.name)) out.add(value.name);
      return;
    case 'load': undefinedReads(value.addr, defined, out); return;
    case 'bin': undefinedReads(value.left, defined, out); undefinedReads(value.right, defined, out); return;
    // `lea rax, [rsp+32]` takes the address of a slot; that is not a read of the
    // slot's contents, and a stack slot has an address from the moment the frame
    // exists. Counting it put the warning on every function that passes a local
    // by pointer.
    case 'un': if (value.op !== '&') undefinedReads(value.value, defined, out); return;
    case 'cast': undefinedReads(value.value, defined, out); return;
    case 'select': undefinedReads(value.cond, defined, out); undefinedReads(value.a, defined, out); undefinedReads(value.b, defined, out); return;
    case 'call': for (const arg of value.args) undefinedReads(arg, defined, out); return;
    default: return;
  }
}

/** Which name an expression reads or writes, when it is one name. */
function nameOf(expr: Expr): string {
  return expr.t === 'var' || expr.t === 'reg' ? expr.name : '';
}

function parameterList(frame: Frame, info: Collected): Array<{ name: string; type: CType }> {
  const byIndex = new Map<number, { name: string; type: CType }>();
  for (const slot of frame.slots.values()) {
    const match = /^arg(\d+)$/.exec(slot.name);
    if (!match) continue;
    const index = Number(match[1]);
    const entry = info.vars.get(slot.name);
    const usedAsAddress = entry?.type === 'void *';
    byIndex.set(index, { name: slot.name, type: refineParam(typeForSize(slot.size || 64), usedAsAddress) });
  }
  return [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, value]) => value);
}

function returnType(info: Collected): CType | 'void' {
  return info.returnsValue ? 'long' : 'void';
}

/**
 * A value that is printed before anything writes it.
 *
 * The disassembly is complete — the register really is read with no prior
 * write in this function — so the honest output says so once at the declaration
 * instead of leaving a bare `long rax;` that reads like a normal local.
 */
function uninitialisedNote(info: Collected): string | null {
  if (!info.undefinedReturns.size) return null;
  return `/* read before written: ${[...info.undefinedReturns].sort().join(', ')} — the disassembly shows no store to it */`;
}


/** Turn an inferred parameter register into a named variable throughout the body. */
function renameExpr(expr: Expr, mapping: Map<string, string>): Expr {
  switch (expr.t) {
    case 'reg':
      return mapping.has(expr.name) ? { t: 'var', name: mapping.get(expr.name) as string, size: expr.size } : expr;
    case 'load':
      return { ...expr, addr: renameExpr(expr.addr, mapping) };
    case 'bin':
      return { ...expr, left: renameExpr(expr.left, mapping), right: renameExpr(expr.right, mapping) };
    case 'un':
      return { ...expr, value: renameExpr(expr.value, mapping) };
    case 'cast':
      return { ...expr, value: renameExpr(expr.value, mapping) };
    case 'select':
      return { ...expr, cond: renameExpr(expr.cond, mapping), a: renameExpr(expr.a, mapping), b: renameExpr(expr.b, mapping) };
    case 'call':
      return { ...expr, args: expr.args.map((arg) => renameExpr(arg, mapping)) };
    default:
      return expr;
  }
}

/**
 * Rename registers to parameter names, and stop the body from assigning them.
 *
 * A parameter is a name for a value that arrived in a register, not a variable
 * the body owns. After the rename, `rdi` becomes `arg0` everywhere — including
 * in places where the register is being used as scratch space after a call,
 * which would print `arg0 = call(...)` and claim the caller's argument had been
 * overwritten by the callee's result. No compiler emits that, and a reader who
 * believes it draws the wrong conclusion about the data flow.
 *
 * So an assignment whose target is a parameter keeps the register name instead:
 * the value is real, the variable it lands in is not the argument.
 */
function renameStmt(stmt: CtrlStmt, mapping: Map<string, string>, params: Set<string>): CtrlStmt {
  switch (stmt.t) {
    case 'assign': {
      const value = renameExpr(stmt.value, mapping);
      const renamed = renameExpr(stmt.target, mapping);
      // A parameter target falls back to the raw register it came from.
      const target = renamed.t === 'var' && params.has(renamed.name)
        ? unrenameExpr(renamed, mapping)
        : renamed;
      return { t: 'assign', target, value };
    }
    case 'expr':
      return { t: 'expr', expr: renameExpr(stmt.expr, mapping) };
    case 'return':
      return stmt.value ? { t: 'return', value: renameExpr(stmt.value, mapping) } : stmt;
    case 'if':
      return { t: 'if', cond: renameExpr(stmt.cond, mapping), then: stmt.then.map((inner) => renameStmt(inner, mapping, params)), ...(stmt.else ? { else: stmt.else.map((inner) => renameStmt(inner, mapping, params)) } : {}) };
    case 'while':
      return { t: 'while', cond: stmt.cond ? renameExpr(stmt.cond, mapping) : null, body: stmt.body.map((inner) => renameStmt(inner, mapping, params)) };
    case 'do':
      return { t: 'do', body: stmt.body.map((inner) => renameStmt(inner, mapping, params)), cond: renameExpr(stmt.cond, mapping) };
    default:
      return stmt;
  }
}

/** The inverse of `mapping`, for the one case where a name must not be used. */
function unrenameExpr(expr: Expr, mapping: Map<string, string>): Expr {
  if (expr.t !== 'var') return expr;
  for (const [register, name] of mapping) {
    if (name === expr.name) return { t: 'reg', name: register, size: expr.size };
  }
  return expr;
}


/** Apply value propagation to each run of straight-line statements. */

/** Every name the given statements read, at any depth. */
function namesReadIn(stmts: CtrlStmt[]): Set<string> {
  const names = new Set<string>();
  const walk = (value: Expr | undefined) => {
    if (!value) return;
    switch (value.t) {
      case 'reg': case 'var': if (value.name) names.add(value.name); return;
      case 'load': walk(value.addr); return;
      case 'bin': walk(value.left); walk(value.right); return;
      case 'un': walk(value.value); return;
      case 'cast': walk(value.value); return;
      case 'select': walk(value.cond); walk(value.a); walk(value.b); return;
      case 'call': for (const arg of value.args) walk(arg); return;
      default: return;
    }
  };
  const visit = (items: CtrlStmt[]) => {
    for (const item of items) {
      switch (item.t) {
        case 'assign': walk(item.value); walk(item.target); break;
        case 'expr': walk(item.expr); break;
        case 'return': walk(item.value); break;
        case 'if': walk(item.cond); visit(item.then); if (item.else) visit(item.else); break;
        case 'while': if (item.cond) walk(item.cond); visit(item.body); break;
        case 'do': visit(item.body); walk(item.cond); break;
        default: break;
      }
    }
  };
  visit(stmts);
  return names;
}

function optimizeControl(stmts: CtrlStmt[], readsAnywhere?: Set<string>): CtrlStmt[] {
  // Names the whole function reads, not just the statements after this run.
  //
  // The run-level view was not enough: `rcx = rsi + rdi * 2` sits in one block
  // and its only reader — `rdi = rdi << rcx` — is in the next one, so neither
  // block's local view contained a read and the assignment was deleted as dead.
  // The C then shifted by a variable nothing had assigned. Liveness over the
  // whole body is the cheap approximation of what a versioned form would give.
  const reads = readsAnywhere || namesReadIn(stmts);
  const recurse = (items: CtrlStmt[]) => optimizeControl(items, reads);
  const out: CtrlStmt[] = [];
  let buffer: Stmt[] = [];
  for (let index = 0; index < stmts.length; index++) {
    const stmt = stmts[index];
    if (stmt.t === 'assign' || stmt.t === 'expr' || stmt.t === 'return' || stmt.t === 'unknown' || stmt.t === 'note') {
      buffer.push(stmt);
      continue;
    }
    if (buffer.length) {
      out.push(...optimizeStatements(buffer, reads));
      buffer = [];
    }
    if (stmt.t === 'if') out.push({ ...stmt, then: recurse(stmt.then), ...(stmt.else ? { else: recurse(stmt.else) } : {}) });
    else if (stmt.t === 'while') out.push({ ...stmt, body: recurse(stmt.body) });
    else if (stmt.t === 'do') out.push({ ...stmt, body: recurse(stmt.body) });
    else out.push(stmt);
  }
  if (buffer.length) out.push(...optimizeStatements(buffer, reads));
  return out;
}

function optimize(stmts: CtrlStmt[]): CtrlStmt[] {
  const out: CtrlStmt[] = [];
  for (const stmt of stmts) {
    if (stmt.t === 'assign' && stmt.target.t === stmt.value.t && 'name' in stmt.target && 'name' in stmt.value
      && stmt.target.name === stmt.value.name) {
      continue; // x = x
    }
    if (stmt.t === 'return' && stmt.value?.t === 'reg' && stmt.value.name === 'rax') {
      const previous = out[out.length - 1];
      if (previous && previous.t === 'assign' && previous.target.t === 'reg' && previous.target.name === 'rax') {
        out[out.length - 1] = { t: 'return', value: previous.value };
        continue;
      }
      // rax was not written in this block; keep the value rather than turning a
      // real return into `return;` (the callee may have set it in another path).
      out.push(stmt);
      continue;
    }
    if (stmt.t === 'if') {
      out.push({ t: 'if', cond: stmt.cond, then: optimize(stmt.then), ...(stmt.else ? { else: optimize(stmt.else) } : {}) });
      continue;
    }
    if (stmt.t === 'while') { out.push({ t: 'while', cond: stmt.cond, body: optimize(stmt.body) }); continue; }
    if (stmt.t === 'do') { out.push({ t: 'do', body: optimize(stmt.body), cond: stmt.cond }); continue; }
    out.push(stmt);
  }
  return out;
}

const PRECEDENCE: Record<string, number> = {
  '*': 80, '/': 80, '%': 80,
  '+': 70, '-': 70,
  '<<': 60, '>>': 60,
  '<': 50, '>': 50, '<=': 50, '>=': 50,
  '==': 40, '!=': 40,
  '&': 35, '^': 30, '|': 25,
};

function printExpr(expr: Expr, parentPrecedence = 0): string {
  switch (expr.t) {
    case 'const': {
      const value = expr.v;
      if (value < 0) return `-0x${Math.abs(value).toString(16)}`;
      return value <= 9 ? String(value) : `0x${value.toString(16)}`;
    }
    case 'reg':
    case 'var':
      return expr.name;
    case 'load':
      return `*(${typeForSize(expr.size)} *)${wrap(expr.addr, 90)}`;
    case 'bin': {
      if ((expr.op === '>>' || expr.op === '<<') && expr.right.t === 'const' && expr.right.v === 0) return printExpr(expr.left, parentPrecedence);
      const precedence = PRECEDENCE[expr.op] ?? 10;
      const text = `${printExpr(expr.left, precedence)} ${expr.op} ${printExpr(expr.right, precedence + 1)}`;
      return precedence < parentPrecedence ? `(${text})` : text;
    }
    case 'un':
      return `${expr.op}${wrap(expr.value, 90)}`;
    case 'cast':
      return `(${typeForSize(expr.size, !expr.signed)})${wrap(expr.value, 90)}`;
    case 'select':
      return `${printExpr(expr.cond, 20)} ? ${printExpr(expr.a, 20)} : ${printExpr(expr.b, 20)}`;
    case 'call':
      return `${expr.target}(${expr.args.map((arg) => printExpr(arg)).join(', ')})`;
    case 'unknown':
      return `/* ${expr.text} */ 0`;
    default:
      return '0';
  }
}

function wrap(expr: Expr, precedence: number): string {
  const text = printExpr(expr, precedence);
  return text.startsWith('(') || /^[A-Za-z_][A-Za-z0-9_]*$/.test(text) || /^(0x[0-9a-f]+|\d+)$/.test(text)
    ? text
    : `(${text})`;
}

function indent(level: number): string {
  return '    '.repeat(level);
}

function printStmt(stmt: CtrlStmt, level: number): string[] {
  const pad = indent(level);
  switch (stmt.t) {
    case 'assign': {
      if (stmt.target.t === 'load') {
        return [`${pad}*(${typeForSize(stmt.target.size)} *)${wrap(stmt.target.addr, 90)} = ${printExpr(stmt.value)};`];
      }
      return [`${pad}${printExpr(stmt.target)} = ${printExpr(stmt.value)};`];
    }
    case 'expr':
      return [`${pad}${printExpr(stmt.expr)};`];
    case 'return':
      return [stmt.value ? `${pad}return ${printExpr(stmt.value)};` : `${pad}return;`];
    case 'unknown':
      return [`${pad}/* unknown: ${stmt.text} */`];
    case 'note':
      // An explanation, not a gap. Same comment shape so the listing stays one
      // stream, but the wording does not claim ignorance.
      return [`${pad}/* ${stmt.text} */`];
    case 'if': {
      // A branch printed with an empty then-body and a full else is the same test
      // written backwards, and it reads like lost code. The reconstruction can
      // produce it when the join point lands on the branch target; the meaning is
      // preserved by inverting the test here.
      if (!stmt.then.length && stmt.else?.length) {
        return printStmt({ t: 'if', cond: negate(stmt.cond), then: stmt.else }, level);
      }
      const lines = [`${pad}if (${printExpr(stmt.cond)}) {`];
      for (const inner of stmt.then) lines.push(...printStmt(inner, level + 1));
      if (stmt.else?.length) {
        lines.push(`${pad}} else {`);
        for (const inner of stmt.else) lines.push(...printStmt(inner, level + 1));
      }
      lines.push(`${pad}}`);
      return lines;
    }
    case 'while': {
      const lines = [`${pad}while (${stmt.cond ? printExpr(stmt.cond) : '1'}) {`];
      for (const inner of stmt.body) lines.push(...printStmt(inner, level + 1));
      lines.push(`${pad}}`);
      return lines;
    }
    case 'do': {
      const lines = [`${pad}do {`];
      for (const inner of stmt.body) lines.push(...printStmt(inner, level + 1));
      lines.push(`${pad}} while (${printExpr(stmt.cond)});`);
      return lines;
    }
    case 'switch': {
      const lines = [`${pad}switch (${printExpr(stmt.value)}) {`];
      for (const entry of stmt.cases) {
        lines.push(`${pad}case ${entry.value}:`);
        for (const inner of entry.body) lines.push(...printStmt(inner, level + 1));
        lines.push(`${pad}    break;`);
      }
      if (stmt.defaultBody) {
        lines.push(`${pad}default:`);
        for (const inner of stmt.defaultBody) lines.push(...printStmt(inner, level + 1));
        lines.push(`${pad}    break;`);
      }
      lines.push(`${pad}}`);
      return lines;
    }
    case 'goto':
      return [`${pad}goto ${stmt.label};`];
    case 'label':
      return [`${pad}${stmt.name}:;`];
    default:
      return [];
  }
}
