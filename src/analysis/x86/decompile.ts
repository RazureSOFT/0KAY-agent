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
import { lift, registerBase, sanitiseName, type Expr, type Stmt } from './ir.js';
import { structure, negate, type CtrlStmt } from './structure.js';
import { optimizeStatements } from './optimize.js';
import { recoverSwitch } from './switch.js';
import { typeForSize, typeOfExpr, refineParam, methodReceiver, receiverType, type CType } from './types.js';

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
  /**
   * Address of a routine to its name, so a call can print where it goes.
   *
   * Without this a call is `sub_40086ee0()`, and that is not C: the name is not
   * declared anywhere and a compiler rejects the call. The caller usually has the Go
   * function table in hand — the same list it got `entry` from — so the names are
   * available and were simply never passed down. `sub_40086ee0` is
   * `internal/runtime/maps.fatal`.
   */
  names?: Map<number, string>;
  /**
   * Read the eight bytes at a virtual address, for jump-table recovery.
   *
   * The table lives in `.rdata`, outside the code this function was handed, so it can
   * only be reached through the image. Without this the reader falls back to treating
   * the address as an offset into the code, which finds nothing.
   */
  readU64At?: (address: number) => number | null;
  /** Whether an address points at code, used to find where a jump table ends. */
  isCode?: (address: number) => boolean;
  /**
   * The signature the compiler recorded, when the image carries DWARF for this function.
   *
   * This replaces the inferred parameter list outright: the names, the count and the
   * types are all known, and guessing at them from which registers the body happens to
   * read is strictly worse. The types are still rendered as C the listing can compile —
   * a `*runtime.maps.Map` becomes `long` with a comment, because a pointer type cannot
   * be multiplied and Go's own code does both.
   */
  signature?: {
    params: { name: string; type: string }[];
    returns?: { name: string; type: string }[];
  };
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
  params: Array<{ name: string; type: CType | string }>;
  locals: Array<{ name: string; type: CType | string }>;
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
  const lifted = lift(fn.instructions, blocks, frame, options.names);
  // A jump table sits in `.rdata`, not in the code section the function came from, so
  // reading it means mapping an address through the image's sections. When the caller
  // has the image, it says so; otherwise the only thing that can be read is the code
  // itself, and a table outside it cannot be found.
  const readU64At = options.readU64At ?? ((address: number): number | null => {
    const offset = address - baseVaddr;
    if (offset < 0 || offset + 8 > code.length) return null;
    let value = 0n;
    for (let byte = 7; byte >= 0; byte--) value = (value << 8n) | BigInt(code[offset + byte]);
    return Number(value);
  });
  const isCodeAddress = options.isCode ?? ((address: number) => address >= baseVaddr && address - baseVaddr < code.length);
  for (let index = 0; index < lifted.length; index++) {
    const info = recoverSwitch(
      lifted[index], blocks[index]?.instructions || [], readU64At, isCodeAddress,
    );
    if (info) lifted[index].switch = info;
  }
  // A `jmp` out of the function is a tail call: the same arguments, handed on. Go
  // uses it for the promoted methods of an embedded type — `(*StructType).NumMethod`
  // is `jmp (*Type).NumMethod` — and for panic helpers. Printed as nothing it left
  // an empty body that looked like a lost implementation.
  markTailCalls(lifted, entry, options.end, fn.instructions);
  foldStackCheck(lifted, entry, options.noReturnCalls);
  const structured = structure(lifted, entry);
  const body = optimizeToFixedPoint(optimize(structured.body));
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
  // A body that is nothing but `ret` hands back the value it was given, so the
  // register it reads is an argument even though no instruction reads it before
  // the return. Without this `NoEscape` printed as `long f(void) { return rax; }`.
  if (passThroughReturn && structured.body[0]?.t === 'return') {
    const returned = structured.body[0].value;
    if (returned?.t === 'reg' && returned.name === 'rax' && !inferred.length) {
      inferred.push({ name: 'arg0', register: 'rax', index: 0 });
    }
  }
  // DWARF names, applied to the registers the disassembly put in those positions.
  //
  // The mapping is positional because that is all the two lists share: `inferred` says
  // which register holds argument N, and DWARF says what argument N is called. Renaming
  // here rather than only in the signature is what makes the body agree with the
  // declaration — `countGeneric` printed `(long b, ...)` above a body still reading
  // `arg0`, which is not a listing anyone can follow.
  const dwarfParams = options?.signature?.params ?? [];
  if (dwarfParams.length) {
    for (let index = 0; index < inferred.length && index < dwarfParams.length; index += 1) {
      const name = sanitiseName(dwarfParams[index].name);
      if (name && !/^arg\d+$/.test(name)) inferred[index].name = name;
    }
  }
  const renamed = new Map(inferred.map((param) => [param.register, param.name]));
  const paramNames = new Set(inferred.map((param) => param.name));
  let finalBody = renamed.size ? body.map((stmt) => renameStmt(stmt, renamed, paramNames)) : body;

  const info = collect(finalBody, frame, paramNames, passThroughReturn);
  // DWARF wins when it is there. The recorded signature has real names and a real count;
  // everything below this point infers them from which registers the body reads, which
  // cannot tell two arguments of the same size apart and cannot see one that is never
  // read. The types are still flattened to `long` for the reasons in `refineParam` — a
  // parameter Go multiplies cannot be declared `*Map` — but the names are the compiler's.
  const fromDwarf = options?.signature?.params ?? [];
  // The recorded count and the body's own use of `argN` can disagree: this binary has
  // DWARF for `countGeneric` naming two parameters while the body reads a third. Printing
  // the two would make `arg2` a local that happens to be read before it is written, so the
  // longer of the two wins and the extra slots keep their `argN` name.
  let paramCount = fromDwarf.length;
  for (const name of info.vars.keys()) {
    const match = /^arg(\d+)$/.exec(name);
    if (match) paramCount = Math.max(paramCount, Number(match[1]) + 1);
  }
  const params = fromDwarf.length
    ? Array.from({ length: paramCount }, (_unused, index) => ({
      name: index < fromDwarf.length ? sanitiseName(fromDwarf[index].name) : `arg${index}`,
      type: 'long' as const,
    }))
    : parameterList(frame, info);
  if (!fromDwarf.length) {
    for (const param of inferred) {
      if (params.some((existing) => existing.name === param.name)) continue;
      params.push({ name: param.name, type: 'long' });
    }
    params.sort((a, b) => Number(a.name.replace(/\D/g, '')) - Number(b.name.replace(/\D/g, '')));
  }
  // Recursive calls get the argument count the signature states. Done here, with the
  // parameters settled, so the count is the one the listing will print.
  finalBody = padSelfCalls(finalBody, sanitiseName(fn.name), params.length);
  // The receiver's type, taken from the method's symbol name. Go spells it out —
  // `runtime.(*mheap).alloc` — and the alternative for the first parameter is `long`.
  //
  // It goes in the header comment, not the signature. A parameter declared `RegArgs *`
  // cannot be multiplied: `runtime.printsp` reads `*(long *)(rsp + arg0 * 8 + 0x20)` and
  // `runtime.(*RegArgs).Dump` returns `arg0 & 1`, and `cl` rejects both with
  // `C2296: '*': not valid as left operand has type 'RegArgs *'`. Adopting the pointer
  // type was worth 9 compile errors across 60 functions and no way to know the layout
  // anyway, so the name is reported and the parameter stays arithmetic.
  const receiver = methodReceiver(fn.name);
  const receiverNote = receiver ? receiverType(receiver.receiver, receiver.pointer) : undefined;
  const locals = [...info.vars.values()]
    .filter((local) => !params.some((param) => param.name === local.name))
    // A declaration for a name that no printed statement mentions is noise, and
    // the reader cannot tell it from a value the pipeline lost. The collectors
    // run before the return-value rewrite above, so names that only appeared in a
    // dropped return are still in `vars`.
    //
    // `isUnassignedRegister` used to drop a register the body reads but never writes, on
    // the grounds that the value came from the caller and a declaration would imply a
    // store that does not exist. Dropping it makes the name undefined, and that is a
    // compile error, not a tidier listing:
    //
    //     return rbx;                 <- C2065: 'rbx': undeclared identifier
    //
    // `internal/abi.(*Type).NumMethod` is one function in 60. The read is real — it is
    // what folding the stack check left behind — so the name has to exist. The comment at
    // the top of the body still says where the value came from.
    .filter((local) => mentionsName(finalBody, local.name))
    .map((local) => ({ name: local.name, type: local.type }));
  // The layout behind each parameter, as far as the body reveals it. Reported for
  // parameters only: a local that is loaded through is usually a slice or map descriptor
  // whose fields the reader already knows, and the parameters are what the caller handed
  // in and cannot see.
  const declared = new Set([...params.map((param) => param.name), ...locals.map((local) => local.name)]);
  const layouts = fieldOffsets(finalBody, declared);
  const layoutNotes: string[] = [];
  for (const param of params) {
    const offsets = layouts.get(param.name);
    if (!offsets || !offsets.size) continue;
    const parts = [...offsets].sort((a, b) => a[0] - b[0])
      .map(([offset, width]) => `+0x${offset.toString(16)} ${typeForSize(width || 64)}`);
    // Three is enough to recognise a header; more is a wall of hex that reads worse than
    // the body it describes.
    const shown = parts.slice(0, 8).join(', ');
    layoutNotes.push(`/* ${param.name} is dereferenced at ${shown}${parts.length > 8 ? `, and ${parts.length - 8} more` : ''} */`);
  }
  const signature = `${returnType(info)} ${sanitiseName(fn.name)}(${params.length ? params.map((param) => `${param.type} ${param.name}`).join(', ') : 'void'})`;

  const lines: string[] = [];
  const unknownPct = fn.instructions.length
    ? Math.round((fn.unknown / fn.instructions.length) * 1000) / 10
    : 0;
  lines.push(`/* ${fn.name} @ 0x${entry.toString(16)} — ${fn.instructions.length} instructions, ${blocks.length} blocks, ${structured.loops} loop(s), ${structured.gotos} goto(s)${unknownPct ? `, ${unknownPct}% undecoded` : ''} */`);
  if (receiverNote) lines.push(`/* method on ${receiverNote} — arg0 in the source; the parameters stay arithmetic here */`);
  // Parameters the body loads through, so the reader knows the value is an address even
  // though nothing in the signature says so. `arg0` in `(*StructField).Embedded` reads
  // `*(long *)arg0` and the return is `rcx & 8` — the type is genuinely both.
  const pointerParams = [...info.addressNames].filter((name) => /^arg\d+$/.test(name)).sort();
  for (const note of layoutNotes) lines.push(note);
  if (pointerParams.length) {
    const subject = pointerParams.join(', ');
    const verb = pointerParams.length === 1 ? 'holds' : 'hold';
    lines.push(`/* ${subject} ${verb} an address (loaded through): not a pointer type, because ${pointerParams.length === 1 ? 'it is' : 'they are'} also used as integers */`);
  }
  // Only when it is true. A DWARF signature is recorded by the compiler, not inferred,
  // and saying otherwise sends the reader looking for the guesswork that is not there.
  if (inferred.length && !dwarfParams.length) lines.push('/* parameters inferred from register reads (register ABI); the signature is approximate */');
  if (dwarfParams.length) lines.push(`/* parameters recorded in the debug information (${dwarfParams.length} of them) */`);
  // Declare what the body calls. A call to a name nothing declares is a constraint
  // violation in C99 — the compiler has to assume the arguments and the return type,
  // and most refuse outright. The body calls other functions of the same binary, which
  // one function's listing does not define, so the declarations go here.
  //
  // The parameter list is left empty rather than guessed: `long f();` says the arguments
  // are unspecified, which is exactly what is known. Inventing a signature from the
  // registers the caller happened to load would be a different kind of wrong.
  const called = new Set<string>();
  const collectCalls = (items: CtrlStmt[]): void => {
    for (const item of items) {
      if (item.t === 'assign' || item.t === 'expr') {
        gatherCalls(item.t === 'assign' ? item.value : item.expr, called);
      } else if (item.t === 'return' && item.value) {
        gatherCalls(item.value, called);
      } else if (item.t === 'if') {
        gatherCalls(item.cond, called);
        collectCalls(item.then);
        if (item.else) collectCalls(item.else);
      } else if (item.t === 'while') {
        if (item.cond) gatherCalls(item.cond, called);
        collectCalls(item.body);
      } else if (item.t === 'do') {
        collectCalls(item.body);
        gatherCalls(item.cond, called);
      }
    }
  };
  collectCalls(finalBody);
  const ownName = sanitiseName(fn.name);
  for (const callee of [...called].sort()) {
    if (callee === ownName) continue;
    // `indirect_call` is a real callee as far as the listing is concerned: the call goes
    // through a register, so there is no address to look up and the name says exactly
    // that. Declaring it keeps the listing C without claiming to know the target.
    lines.push(`long ${callee}();`);
  }
  if (called.size) lines.push('');
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
  // The branch has to be the stack check, not just any branch that happens to lead back
  // to the entry. Go compares the stack pointer against the stack bound —
  // `cmp rsp, [r14+0x10]`, or `lea r12, [rsp-0x30]; cmp r12, [r14+0x10]` — so the
  // comparison mentions `rsp` or `r14`. Anything else is an ordinary branch that shares
  // its tail with the retry.
  //
  // `runtime.panicshift` is the case that proved it: `mov rax, [rip+X]; test rax, rax;
  // je +4` selects between a panic call and the next instruction, and the panic call's
  // block happens to fall through into morestack and back to the entry. Folding it as a
  // retry deleted the `gopanic` call and left the function ending on a load.
  if (!mentionsStackPointer(guard.cond)) return false;
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
  // A block on the retry path that something *off* the path also jumps to is not part
  // of the retry. Folding it emptied a block the structuring pass still had a jump to
  // and printed `goto L_14006417e` with no label anywhere: `runtime.selectgo` lays out
  // a jump table whose cases sit between a guard and its retry, so the fall-through
  // walk crossed two blocks that the table also targets.
  //
  // The walk stops at the first such block. Everything before it is retry-only and is
  // folded as usual; that block and whatever follows stay, because a jump needs them.
  //
  // The guard itself does not count. Its branch *is* the first edge of the retry it
  // feeds, so counting it made every guard look like a second reference to its own
  // target and nothing was ever folded: `time.appendNano` kept its whole morestack
  // sequence — save five registers, `call morestack_noctxt`, restore them, `jmp` entry —
  // and the listing ended on `rdi = (unsigned int)v_17;` with no return.
  const onPath = new Set(path);
  const all = [...byStart.values()];
  const targetsOf = (start: number): boolean => all.some((other) =>
    other.start !== guard.start
    && !onPath.has(other.start)
    && (other.target === start
      || (other.switch != null
        && (other.switch.cases.some((item) => item.target === start)
          || other.switch.defaultTarget === start))));
  guard.term = 'fallthrough';
  guard.cond = null;
  delete guard.target;
  for (const start of path) {
    if (targetsOf(start)) break;
    const block = byStart.get(start);
    if (!block) continue;
    block.folded = true;
    block.stmts = [];
  }
  return true;
}


/**
 * Turn a `jmp` that leaves the function into a tail call.
 *
 * The callee is entered with the registers this function was given, so the call
 * carries the inferred arguments and the return value passes straight through.
 * Only a jump whose target is outside `entry..end` qualifies: a jump inside the
 * function is ordinary control flow and is handled by the structuring pass.
 */
function markTailCalls(
  lifted: import('./ir.js').LiftedBlock[],
  entry: number,
  end: number | undefined,
  instructions: import('./decode.js').Instruction[],
): void {
  const limit = end ?? Math.max(...instructions.map((instruction) => instruction.address), entry);
  for (const block of lifted) {
    if (block.term !== 'jmp' || block.target == null) continue;
    if (block.target >= entry && block.target < limit) continue;
    // Keep the statements the block already has: the nil check that guards the
    // call is real code.
    block.stmts.push({
      t: 'return',
      value: { t: 'call', target: `sub_${(block.target >>> 0).toString(16)}`, args: [], size: 64 },
    });
    // The block no longer falls through anywhere the structuring pass can follow.
    block.term = 'ret';
    delete block.target;
  }
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
    // A block the reachability walk did not get to can still be the target of a jump
    // the structuring pass will print. `runtime.selectgo` has a jump table whose cases
    // are reached only through the table, so the walk misses them; folding one away
    // left `goto L_14006417e` pointing at a label that was never written, because the
    // block holding that label had been emptied and dropped from the order.
    //
    // Anything with an incoming edge is kept, whatever the walk concluded. The walk
    // is a good filter for a panic tail nobody branches to; it is not a licence to
    // delete a block that something jumps at.
    const hasIncoming = lifted.some((other) =>
      other.target === block.start
      || (other.switch != null
        && (other.switch.cases.some((item) => item.target === block.start)
          || other.switch.defaultTarget === block.start)));
    if (hasIncoming) continue;
    block.folded = true;
    block.stmts = [];
  }
}

/** Does this block's last statement call a routine that never returns? */
/**
 * Does this condition compare the stack pointer?
 *
 * The stack-growth check reads `rsp` (or a register derived from it) and compares it
 * against the bound held in `r14`. A branch whose condition mentions neither is not the
 * stack check, whatever it leads to.
 */
function mentionsStackPointer(expr: Expr | null | undefined): boolean {
  if (!expr) return false;
  switch (expr.t) {
    case 'reg':
    case 'var':
      return expr.name === 'rsp' || expr.name === 'r14';
    case 'bin':
      return mentionsStackPointer(expr.left) || mentionsStackPointer(expr.right);
    case 'un':
    case 'cast':
      return mentionsStackPointer(expr.value);
    case 'load':
      return mentionsStackPointer(expr.addr);
    default:
      return false;
  }
}

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
  /**
   * Names the body loads through, so they hold an address rather than a value.
   *
   * Reported in a comment instead of as a pointer type: the same name is also multiplied
   * and masked, and no single pointer type allows both. See `refineParam`.
   */
  addressNames: Set<string>;
}


/** Names whose address the body takes anywhere, at any depth. */
function addressedNames(body: CtrlStmt[]): Set<string> {
  const names = new Set<string>();
  const walk = (value: Expr | undefined): void => {
    if (!value) return;
    switch (value.t) {
      // `&x` is the address of x; x itself is the thing addressed.
      case 'un':
        if (value.op === '&' && (value.value.t === 'var' || value.value.t === 'reg')) {
          names.add(value.value.name);
        }
        walk(value.value);
        return;
      case 'load': walk(value.addr); return;
      case 'bin': walk(value.left); walk(value.right); return;
      case 'cast': walk(value.value); return;
      case 'select': walk(value.cond); walk(value.a); walk(value.b); return;
      case 'call': for (const arg of value.args) walk(arg); return;
      default: return;
    }
  };
  const visit = (items: CtrlStmt[]): void => {
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
  visit(body);
  return names;
}

function collect(body: CtrlStmt[], frame: Frame, params: Set<string> = new Set(), passThroughReturn = false): Collected {
  const vars: Collected['vars'] = new Map();
  const addressNames = new Set<string>();
  // `rsp` and `rbp` always hold something: the stack pointer and the frame base
  // exist before the function does. Reporting either as "read before written" is
  // never right, and it was a large share of the remaining warnings on functions
  // that touch the frame through `mov [rsp+8], ...`.
  // `r14` holds the goroutine pointer for the whole life of the thread. Go keeps it
  // loaded by convention and never assigns it inside a function, so a body that
  // reads it is not reading uninitialised memory — it is reading the runtime.
  // `rsp` and `rbp` are the same kind of thing: state that exists before the code
  // runs.
  const defined = new Set<string>([...params, 'rsp', 'rbp', 'r14']);
  // A local whose address is taken is a buffer, not a scalar: `&v_208` is passed
  // to a routine that fills it, so the bytes are written through the pointer and
  // there is no assignment in this function to see. Reporting the later reads as
  // "before written" was wrong — the write happens, just not as a store this
  // walk can name. Anything addressed this way counts as defined from the start.
  for (const name of addressedNames(body)) defined.add(name);
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
          // Recorded, not spelled. A name that is dereferenced here is also multiplied
          // or masked elsewhere — `rcx` in `(*StructField).Embedded` is loaded from
          // `arg0` and then tested with `rcx & 8` — and a `char *` that is `&`-ed is a
          // constraint violation: `C2296: '&': not valid as left operand has type
          // 'char *'`. The fact that it holds an address goes in the header comment.
          addressNames.add(value.addr.name);
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
  // A buffer whose address escaped was filled through a pointer, so its contents
  // are defined even though no store here names it. Saying "read before written"
  // about something the callee wrote would be the decompiler describing its own
  // blind spot as a property of the code.
  for (const name of addressedNames(body)) undefinedReturns.delete(name);
  // Slots above the frame belong to the caller: they hold the arguments that did
  // not fit in registers, so they are defined before the function runs. Reporting
  // them as "read before written" was wrong about the calling convention itself.
  for (const slot of frame.slots.values()) {
    if (slot.kind === 'param') undefinedReturns.delete(slot.name);
  }
  // The same thing for the registers the convention passes arguments in. A stack
  // parameter gets a slot above the frame and was already covered; `rcx` and `r10`
  // arrive in a register, and a function that reads one without storing to it first
  // is reading its own argument — `indexbody` was reported as reading `r10` and `rcx`
  // with no store, and both are simply where its fourth and fifth arguments came in.
  for (const register of frame.argRegisters) undefinedReturns.delete(register);
  // Go passes integers in nine registers, not the four the platform's convention uses,
  // and `frame.argRegisters` holds the platform's list: `indexbody` was reported as
  // reading `r10` with no store, and `r10` is where its fifth argument arrives. The
  // signature inference keeps the platform list — changing it moves every signature in
  // the binary and is a separate question — but a read of a Go argument register is an
  // argument, and saying otherwise is wrong about the ABI.
  for (const register of ['rax', 'rbx', 'rcx', 'rdi', 'rsi', 'r8', 'r9', 'r10', 'r11']) {
    undefinedReturns.delete(register);
  }
  // The same registers again under a version number. The rename pass gives a register
  // a numbered name when the code writes it a second time, and a read in one block can
  // name `rbx_7` while the write named `rbx` sits in another — `runGCProg`, `sysmon`
  // and `chanrecv` each report one. The value is the same register either way, and a
  // read of a register the Go ABI passes arguments in is a read of an argument however
  // the rename labelled it. Matching on the base name is what makes the two agree.
  for (const name of [...undefinedReturns]) {
    const base = name.replace(/_\d+$/, '');
    if (base === name) continue;
    if (['rax', 'rbx', 'rcx', 'rdi', 'rsi', 'r8', 'r9', 'r10', 'r11', 'r12', 'r13', 'r14', 'r15', 'rbp'].includes(base)) {
      undefinedReturns.delete(name);
    }
  }
  // And the callee-save set. `rbx`, `rbp` and `r12`-`r15` hold their caller's values
  // on entry — a function that reads one before storing to it is reading what it was
  // handed, not garbage. `(*table).PutSlot` prints `r12 = r12` among the argument
  // spills, whose whole meaning is that r12 was left alone; calling that an undefined
  // read is the decompiler reporting the ABI as a bug in the code. The registers the
  // convention passes arguments in were handled just above.
  for (const register of ['rbx', 'rbp', 'r12', 'r13', 'r14', 'r15']) {
    undefinedReturns.delete(register);
  }
  // Go passes arguments to assembly routines on the stack, and those routines
  // write their results straight into the caller's frame. `cpuid.abi0` returns four
  // registers by filling the four slots the caller reserved. There is no store in
  // this function for such a slot and no address taken either — the callee writes
  // it by agreement. When the body calls anything at all, a frame slot it only
  // reads may have been filled that way, so silence it rather than claim the code
  // reads garbage.
  if (calledAnywhere(body)) {
    for (const name of undefinedReturns) {
      if (/^[vgs]_\d+$/.test(name)) undefinedReturns.delete(name);
    }
  }
  for (const name of undefinedReturns) {
    if (/^stack_arg_/.test(name)) undefinedReturns.delete(name);
  }
  return { vars, returnsValue, undefinedReturns, addressNames };
}

/** Does any printed statement read or write this name? */
/**
 * Add every function name an expression calls to `into`.
 *
 * Used to declare the calls before the definition, so the listing is C. Walks the whole
 * expression rather than only the top level: `x = f(g())` calls both, and a call inside
 * a comparison — `if (cmp(a, b) > 0)` — is as undeclared as one on its own line.
 */
function gatherCalls(value: Expr | undefined, into: Set<string>): void {
  if (!value) return;
  switch (value.t) {
    case 'call':
      if (value.target) into.add(value.target);
      for (const arg of value.args) gatherCalls(arg, into);
      return;
    case 'load':
      gatherCalls(value.addr, into);
      return;
    case 'bin':
      // Division by a constant zero prints as a call to `runtime_panicdivide` — see
      // `printExpr` — so the name has to be declared even though no `call` node carries
      // it. Without this the listing says "undeclared identifier" about a function it
      // printed itself. 21 of 4000 functions.
      if ((value.op === '/' || value.op === '%') && value.right.t === 'const' && value.right.v === 0) {
        into.add('runtime_panicdivide');
      }
      gatherCalls(value.left, into); gatherCalls(value.right, into); return;
    case 'un':
      gatherCalls(value.value, into); return;
    case 'cast':
      gatherCalls(value.value, into); return;
    case 'select':
      gatherCalls(value.cond, into); gatherCalls(value.a, into); gatherCalls(value.b, into); return;
    default:
      return;
  }
}

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
 * Constant offsets at which each name is dereferenced: the shape of the object behind it.
 *
 * `mov [rdx+0x50], rax` and `mov rax, [rdx+0x8]` say more together than apart. Neither
 * names the fields — nothing in a stripped binary does — but the set of offsets, in order,
 * with the width of each access, is a layout, and a reader trying to decide what `arg2` is
 * gets further with `+0x0 long, +0x8 long, +0x40 long` than with nothing.
 *
 * Only `base + constant` counts. An indexed access is through an array, and an offset that
 * is itself a variable says nothing about layout.
 *
 * The width recorded is the widest seen at that offset, because a struct field read as two
 * `char`s and a `short` is a field of the larger size at its own offset but not at the
 * other.
 */
function fieldOffsets(body: CtrlStmt[], names: Set<string>): Map<string, Map<number, number>> {
  const found = new Map<string, Map<number, number>>();
  /**
   * A name that only ever receives one parameter, so anything done through it is an
   * access through that parameter.
   *
   * `rcx = arg0` followed by `*(long *)(rcx + 0x10)` is the same object as `arg0`, and 46
   * of 400 functions read their parameters that way. Only a single assignment to the name
   * counts: a register reused for a second value is not an alias, and attributing the
   * second life's offsets to the parameter would invent a layout that is not there.
   */
  const aliases = new Map<string, string>();
  const resolveAliases = (item: CtrlStmt): void => {
    switch (item.t) {
      case 'assign': {
        const target = item.target;
        if (target.t !== 'reg' && target.t !== 'var') return;
        // Whatever the name held before is gone, so a parameter source registers as an
        // alias and anything else clears it. That is what keeps a register reused for a
        // second object from being credited with the first object's layout.
        const source = item.value;
        if ((source.t === 'reg' || source.t === 'var') && names.has(source.name)) {
          aliases.set(target.name, source.name);
        } else {
          aliases.delete(target.name);
        }
        return;
      }
      case 'if': item.then.forEach(resolveAliases); (item.else || []).forEach(resolveAliases); return;
      case 'while': item.body.forEach(resolveAliases); return;
      case 'do': item.body.forEach(resolveAliases); return;
      default: return;
    }
  };
  body.forEach(resolveAliases);
  const canonical = (name: string): string => aliases.get(name) ?? name;
  const record = (base: string, offset: number, width: number): void => {
    const resolved = canonical(base);
    if (!names.has(resolved)) return;
    let offsets = found.get(resolved);
    if (!offsets) { offsets = new Map(); found.set(resolved, offsets); }
    offsets.set(offset, Math.max(offsets.get(offset) ?? 0, width));
  };
  const visit = (value: Expr | undefined, width = 0): void => {
    if (!value) return;
    switch (value.t) {
      case 'load': {
        const addr = value.addr;
        // Only `base + constant`. `base + index * 8` is an array element and says nothing
        // about layout, and an offset that is itself a variable says less than nothing.
        if (addr.t === 'bin' && addr.op === '+' && addr.right.t === 'const' && addr.right.v >= 0) {
          const left = addr.left;
          if (left.t === 'reg' || left.t === 'var') record(left.name, addr.right.v, value.size);
        }
        visit(addr, width);
        return;
      }
      case 'bin': visit(value.left, width); visit(value.right, width); return;
      case 'un': case 'cast': visit(value.value, width); return;
      case 'select': visit(value.cond, width); visit(value.a, width); visit(value.b, width); return;
      case 'call': for (const arg of value.args) visit(arg, width); return;
      default: return;
    }
  };
  const walk = (item: CtrlStmt): void => {
    switch (item.t) {
      case 'assign': visit(item.target); visit(item.value); return;
      case 'expr': visit(item.expr); return;
      case 'return': visit(item.value); return;
      case 'if': visit(item.cond); item.then.forEach(walk); (item.else || []).forEach(walk); return;
      case 'while': visit(item.cond || undefined); item.body.forEach(walk); return;
      case 'do': item.body.forEach(walk); visit(item.cond); return;
      default: return;
    }
  };
  body.forEach(walk);
  return found;
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

function parameterList(frame: Frame, info: Collected): Array<{ name: string; type: CType | string }> {
  const byIndex = new Map<number, { name: string; type: CType | string }>();
  for (const slot of frame.slots.values()) {
    const match = /^arg(\d+)$/.exec(slot.name);
    if (!match) continue;
    const index = Number(match[1]);
    const entry = info.vars.get(slot.name);
    const usedAsAddress = entry?.type === 'char *';
    byIndex.set(index, { name: slot.name, type: refineParam(typeForSize(slot.size || 64), usedAsAddress) });
  }
  return [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, value]) => value);
}

function returnType(info: Collected): CType | 'void' {
  return info.returnsValue ? 'long' : 'void';
}

/** A flat rendering of a statement tree, used only to look for `name =`. */
function printStmtForCheck(item: CtrlStmt): string {
  switch (item.t) {
    case 'assign': return `${printExpr(item.target)} = ${printExpr(item.value)};`;
    case 'expr': return `${printExpr(item.expr)};`;
    case 'return': return item.value ? `return ${printExpr(item.value)};` : 'return;';
    case 'if': return `${printExpr(item.cond)} ${[item.then, item.else || []].flat().map(printStmtForCheck).join('')}`;
    case 'while': return `${item.cond ? printExpr(item.cond) : '1'} ${item.body.map(printStmtForCheck).join('')}`;
    case 'do': return `${item.body.map(printStmtForCheck).join('')} ${printExpr(item.cond)}`;
    default: return '';
  }
}


/** Does the body call anything? */
function calledAnywhere(body: CtrlStmt[]): boolean {
  let found = false;
  const walk = (value: Expr | undefined): void => {
    if (!value || found) return;
    switch (value.t) {
      case 'call': found = true; return;
      case 'load': walk(value.addr); return;
      case 'bin': walk(value.left); walk(value.right); return;
      case 'un': case 'cast': walk(value.value); return;
      case 'select': walk(value.cond); walk(value.a); walk(value.b); return;
      default: return;
    }
  };
  const visit = (items: CtrlStmt[]): void => {
    for (const item of items) {
      if (found) return;
      switch (item.t) {
        case 'assign': walk(item.value); break;
        case 'expr': walk(item.expr); break;
        case 'return': walk(item.value); break;
        case 'if': walk(item.cond); visit(item.then); if (item.else) visit(item.else); break;
        case 'while': if (item.cond) walk(item.cond); visit(item.body); break;
        case 'do': visit(item.body); walk(item.cond); break;
        default: break;
      }
    }
  };
  visit(body);
  return found;
}

function uninitialisedNote(info: Collected): string | null {
  if (!info.undefinedReturns.size) return null;
  return `/* read before written: ${[...info.undefinedReturns].sort().join(', ')} — the disassembly shows no store to it */`;
}


/** Turn an inferred parameter register into a named variable throughout the body. */
function renameExpr(expr: Expr, mapping: Map<string, string>): Expr {
  switch (expr.t) {
    case 'reg': {
      // The mapping is keyed by base register (`r8`), and an operand can name a
      // sub-register (`r8b`). Matching the spelled name alone left the byte-sized
      // form unrenamed, so the body still mentioned a register the signature had
      // already given a parameter name.
      const direct = mapping.get(expr.name);
      if (direct) return { t: 'var', name: direct, size: expr.size };
      const base = registerBase(expr.name);
      const viaBase = mapping.get(base);
      return viaBase ? { t: 'var', name: viaBase, size: expr.size } : expr;
    }
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
 * Give every call to this function the argument count the signature states.
 *
 * A recursive call carries the same arguments as the function itself, so a call with
 * fewer names than the signature has is an inference miss, not a different call. The
 * value on the other side is not always recoverable: `mapKeyError2` recurses from inside
 * a loop, where the registers the arguments arrived in have long been overwritten, and
 * three of its four call sites came out as `mapKeyError2()`. `cl` rejects that —
 * `C2198: 'mapKeyError2(long,long)': too few arguments for call` — and the listing is the
 * only place the argument count is known at all, because nothing else in the image
 * records it.
 *
 * Only the count is fixed. The arguments keep whatever was recovered, and a call that
 * recovered none reads as passing the function's own parameters, which is what the
 * register state at that point usually is.
 */
function padSelfCalls(body: CtrlStmt[], own: string, arity: number): CtrlStmt[] {
  if (arity === 0) return body;
  const pad = (value: Expr): Expr => {
    switch (value.t) {
      case 'call': {
        const args = value.args.map(pad);
        if (value.target !== own || args.length >= arity) return { ...value, args };
        const filled = [...args];
        for (let index = filled.length; index < arity; index += 1) {
          filled.push({ t: 'var', name: `arg${index}`, size: 64 });
        }
        return { ...value, args: filled };
      }
      case 'bin': return { ...value, left: pad(value.left), right: pad(value.right) };
      case 'un': case 'cast': return { ...value, value: pad(value.value) };
      case 'load': return { ...value, addr: pad(value.addr) };
      case 'select': return { ...value, cond: pad(value.cond), a: pad(value.a), b: pad(value.b) };
      default: return value;
    }
  };
  const walk = (stmt: CtrlStmt): CtrlStmt => {
    switch (stmt.t) {
      case 'assign': return { ...stmt, target: pad(stmt.target), value: pad(stmt.value) };
      case 'expr': return { ...stmt, expr: pad(stmt.expr) };
      case 'return': return stmt.value ? { ...stmt, value: pad(stmt.value) } : stmt;
      case 'if': return { ...stmt, cond: pad(stmt.cond), then: stmt.then.map(walk), ...(stmt.else ? { else: stmt.else.map(walk) } : {}) };
      case 'while': return { ...stmt, cond: stmt.cond ? pad(stmt.cond) : null, body: stmt.body.map(walk) };
      case 'do': return { ...stmt, body: stmt.body.map(walk), cond: pad(stmt.cond) };
      default: return stmt;
    }
  };
  return body.map(walk);
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

/**
 * Optimize until no read names a value the output never assigns.
 *
 * The versioning pass runs inside each straight-line run and creates names the
 * caller's liveness set cannot contain: that set comes from the statements as they
 * were before versioning. So a run that defines `rbx_3` and a later run that reads
 * it looked unrelated, the definition was deleted as dead, and the reader named a
 * value with no assignment.
 *
 * Rather than predicting those names, this runs the optimizer, looks at what the
 * output actually reads without defining, adds that to the live set, and runs
 * again. Each round can only add names to the live set, the set is bounded by the
 * names in the body, and the work stops as soon as a round adds nothing — so it
 * terminates, and it measures the real product of the pass rather than guessing.
 */
function optimizeToFixedPoint(stmts: CtrlStmt[]): CtrlStmt[] {
  const live = namesReadIn(stmts);
  let body = optimizeControl(stmts, live);
  for (let round = 0; round < 4; round += 1) {
    const missing = namesReadWithoutDefinition(body);
    let added = 0;
    for (const name of missing) {
      if (live.has(name)) continue;
      live.add(name);
      added += 1;
    }
    if (!added) break;
    body = optimizeControl(stmts, live);
  }
  return body;
}

/**
 * Names the body reads that nothing in it assigns.
 *
 * A parameter is not in this set: the signature is printed from the frame and the
 * inferred registers, not from an assignment. Stack-passed arguments and buffers
 * whose address escaped are excluded for the same reason they are never reported
 * as read-before-written.
 */
function namesReadWithoutDefinition(body: CtrlStmt[]): Set<string> {
  const read = new Set<string>();
  const written = new Set<string>();
  const collect = (value: Expr | undefined, into: Set<string>): void => {
    if (!value) return;
    switch (value.t) {
      case 'reg': case 'var': into.add(value.name); return;
      case 'load': collect(value.addr, into); return;
      case 'bin': collect(value.left, into); collect(value.right, into); return;
      case 'un': case 'cast': collect(value.value, into); return;
      case 'select': collect(value.cond, into); collect(value.a, into); collect(value.b, into); return;
      case 'call': for (const arg of value.args) collect(arg, into); return;
      default: return;
    }
  };
  const visit = (items: CtrlStmt[]): void => {
    for (const item of items) {
      switch (item.t) {
        case 'assign':
          collect(item.value, read);
          if (item.target.t === 'reg' || item.target.t === 'var') written.add(item.target.name);
          else if (item.target.t === 'load') collect(item.target.addr, read);
          break;
        case 'expr': collect(item.expr, read); break;
        case 'return': collect(item.value, read); break;
        case 'if': collect(item.cond, read); visit(item.then); if (item.else) visit(item.else); break;
        case 'while': if (item.cond) collect(item.cond, read); visit(item.body); break;
        case 'do': visit(item.body); collect(item.cond, read); break;
        default: break;
      }
    }
  };
  visit(body);
  const missing = new Set<string>();
  for (const name of read) {
    if (written.has(name)) continue;
    // `rsp`/`rbp` are not values, arguments come from the caller, and an addressed
    // buffer is filled through its pointer.
    if (name === 'rsp' || name === 'rbp') continue;
    if (/^(arg\d+|stack_arg_|v_)/.test(name)) continue;
    if (addressedNames(body).has(name)) continue;
    missing.add(name);
  }
  return missing;
}

function optimizeControl(stmts: CtrlStmt[], readsAnywhere?: Set<string>): CtrlStmt[] {
  // Names the whole function reads, not just the statements after this run.
  //
  // The run-level view was not enough: an assignment sits in one block and its
  // only reader in the next, so neither block's local view contained a read and
  // the assignment was deleted as dead. Liveness over the whole body is the cheap
  // approximation of what a versioned form would give.
  const reads = readsAnywhere || namesReadIn(stmts);
  const recurse = (items: CtrlStmt[]) => optimizeControl(items, reads);
  const out: CtrlStmt[] = [];
  let buffer: Stmt[] = [];
  for (const stmt of stmts) {
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

function printExpr(expr: Expr, parentPrecedence = 0, asCondition = false): string {
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
      // Division by a constant zero. Go emits the check as a call to `panicdivide` and
      // then the `div` itself, and the recovery sees the divisor as the zero the panic
      // arm left in the register. Printing `-0x1 / 0` is not C — `cl` reports
      // `C2124: divide or mod by zero` — and the code cannot do anything else, since a
      // zero divisor panics. The call is what the source has.
      if ((expr.op === '/' || expr.op === '%') && expr.right.t === 'const' && expr.right.v === 0) {
        return 'runtime_panicdivide()';
      }
      const precedence = PRECEDENCE[expr.op] ?? 10;
      const text = `${printExpr(expr.left, precedence)} ${expr.op} ${printExpr(expr.right, precedence + 1)}`;
      return precedence < parentPrecedence ? `(${text})` : text;
    }
    case 'un':
      return `${expr.op}${wrap(expr.value, 90, asCondition)}`;
    case 'cast':
      return `(${typeForSize(expr.size, !expr.signed)})${wrap(expr.value, 90)}`;
    case 'select':
      return `${printExpr(expr.cond, 20)} ? ${printExpr(expr.a, 20)} : ${printExpr(expr.b, 20)}`;
    case 'call':
      return `${expr.target}(${expr.args.map((arg) => printExpr(arg)).join(', ')})`;
    case 'unknown':
      // In a condition the safe placeholder is `1`: a condition printed as zero
      // means the branch body is never shown, and hiding code is worse than showing
      // a branch whose test is admittedly not modelled. In a value position `0` is
      // the neutral choice. Neither is an answer, and the comment says so.
      return `/* ${expr.text} */ ${asCondition ? 1 : 0}`;
    default:
      return '0';
  }
}

function wrap(expr: Expr, precedence: number, asCondition = false): string {
  const text = printExpr(expr, precedence, asCondition);
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
      const lines = [`${pad}if (${printExpr(stmt.cond, 0, true)}) {`];
      for (const inner of stmt.then) lines.push(...printStmt(inner, level + 1));
      if (stmt.else?.length) {
        lines.push(`${pad}} else {`);
        for (const inner of stmt.else) lines.push(...printStmt(inner, level + 1));
      }
      lines.push(`${pad}}`);
      return lines;
    }
    case 'while': {
      const lines = [`${pad}while (${stmt.cond ? printExpr(stmt.cond, 0, true) : '1'}) {`];
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
    case 'continue':
      return [`${pad}continue;`];
    case 'goto':
      return [`${pad}goto ${stmt.label};`];
    case 'label':
      return [`${pad}${stmt.name}:;`];
    default:
      return [];
  }
}
