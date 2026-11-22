import test from 'node:test';
import assert from 'node:assert/strict';
import { decompileFunction } from './decompile.js';
import { scanCallGraph, callersOf, calleesOf } from './xref.js';
import type { FunctionEntry } from './symbols.js';

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

const BASE = 0x1000;

/**
 * Every name in the body is declared, and every declared name is assigned.
 *
 * Both directions matter and they fail differently. An undeclared name is a compile
 * error — the reader cannot look the name up either. A declared name that nothing
 * assigns is a value the pipeline lost on the way to the printer.
 *
 * This used to check only the second direction, in a way that could not fail: the
 * pattern meant to find `name =` dropped its backslashes inside a template literal, so
 * it matched nothing and every assertion passed. Meanwhile the body printed names the
 * header never declared, in 203 functions out of 300.
 */
function assertEveryNameIsDeclaredAndAssigned(c: string): void {
  const header = c.split('{')[0] || '';
  const body = c.slice(c.indexOf('{') + 1);
  const declared = new Set<string>()
  for (const m of header.matchAll(/\b(?:long|int|char|short|float|double|unsigned|void|__int64)\b\s*\*?\s*([A-Za-z_]\w*)/g)) {
    declared.add(m[1])
  }
  for (const m of body.matchAll(/^\s*(?:long|int|char|short|float|double|unsigned|void|__int64)\s+\*?\s*([A-Za-z_]\w*)\s*;/gm)) {
    declared.add(m[1])
  }
  // A register with a `_N` suffix is a versioned name the same way `rbx` is.
  const isRegister = (name: string): boolean => /^(?:r[a-z]{2}|r\d{1,2}|e[a-z]{2}|v_\d+|stack_\d+|xmm\d+|ymm\d+)(?:_\d+)?$/.test(name)
  const assigned = new Set<string>()
  for (const m of body.matchAll(/\b([a-zA-Z_]\w*)\s*=(?!=)/g)) assigned.add(m[1])
  for (const name of assigned) {
    if (!isRegister(name)) continue
    if (name === 'rsp' || name === 'rbp') continue
    assert.ok(declared.has(name), `${name} is used in the body but never declared\n${c}`)
  }
  for (const name of declared) {
    if (!isRegister(name)) continue
    assert.ok(assigned.has(name), `${name} is declared but nothing assigns it\n${c}`)
  }
}

test('an if/else becomes structured C, not a goto', () => {
  // cmp rdi, 0; je +6; mov eax,1; ret; xor eax,eax; ret
  const code = bytes(
    0x48, 0x83, 0xff, 0x00,
    0x74, 0x06,
    0xb8, 0x01, 0x00, 0x00, 0x00,
    0xc3,
    0x31, 0xc0,
    0xc3,
  );
  const result = decompileFunction(code, BASE, BASE, { name: 'pick', end: BASE + code.length, convention: 'sysv' });
  assert.equal(result.name, 'pick');
  assert.match(result.c, /if \(arg1 == 0\)/);
  assert.match(result.c, /return/);
  assert.doesNotMatch(result.c, /goto /);
  assert.equal(result.gotos, 0);
});

test('a backward branch becomes a loop', () => {
  // mov eax,0; inc rax; cmp rax,10; jl -9; ret
  const code = bytes(
    0xb8, 0x00, 0x00, 0x00, 0x00,
    0x48, 0xff, 0xc0,
    0x48, 0x83, 0xf8, 0x0a,
    0x7c, 0xf7,
    0xc3,
  );
  const result = decompileFunction(code, BASE, BASE, { name: 'count', end: BASE + code.length, convention: 'sysv' });
  assert.equal(result.loops, 1, result.c);
  assert.match(result.c, /(while|do) \(/);
  assert.match(result.c, /rax/);
});

test('the frame turns [rbp-8] into a local and the saved argument into a parameter', () => {
  // push rbp; mov rbp,rsp; sub rsp,0x10; mov [rbp-8],rdi; mov rax,[rbp-8]; leave; ret
  const code = bytes(
    0x55,
    0x48, 0x89, 0xe5,
    0x48, 0x83, 0xec, 0x10,
    0x48, 0x89, 0x7d, 0xf8,
    0x48, 0x8b, 0x45, 0xf8,
    0xc9,
    0xc3,
  );
  const result = decompileFunction(code, BASE, BASE, { name: 'keep', end: BASE + code.length, convention: 'sysv' });
  // [rbp-8] holds the saved first argument, so it is a parameter named arg0.
  assert.ok(result.params.some((param) => param.name === 'arg0'), JSON.stringify(result.params));
  // The prologue spill is recognised, so the body is just the return.
  assert.match(result.c, /return arg0;/);
  assert.doesNotMatch(result.c, /arg0 = rdi;/);
});

test('a call prints its argument register as an argument', () => {
  // mov rcx,5; call +0 (next instruction); ret
  const code = bytes(
    0x48, 0xc7, 0xc1, 0x05, 0x00, 0x00, 0x00,
    0xe8, 0x00, 0x00, 0x00, 0x00,
    0xc3,
  );
  const result = decompileFunction(code, BASE, BASE, { name: 'caller', end: BASE + code.length, convention: 'win64' });
  assert.match(result.c, /sub_[0-9a-f]+\(5\)/, result.c);
});

test('a store through a computed address keeps its parentheses', () => {
  // mov [rsp+8], rax ; mov rax, [rsp+8] ; ret — the slot is written then read
  // back, so it cannot be dropped as a dead store. What matters is that it is a
  // named slot, not `*(long *)(rsp + 8)` on a register nothing wrote.
  const code = bytes(
    0x48, 0x89, 0x44, 0x24, 0x08,      // mov [rsp+8], rax
    0x48, 0x8b, 0x44, 0x24, 0x08,      // mov rax, [rsp+8]
    0xc3,                              // ret
  );
  const result = decompileFunction(code, BASE, BASE, { name: 'store', end: BASE + code.length, convention: 'sysv' });
  assert.doesNotMatch(result.c, /\*\(long \*\)\(rsp \+ 8\)/, result.c);
});

test('undecodable bytes stay visible instead of being dropped', () => {
  // A VEX prefix and an opcode this decoder does not model.
  const code = bytes(0xc5, 0xf8, 0x10, 0xc0, 0xc3);
  const result = decompileFunction(code, BASE, BASE, { name: 'unknown', end: BASE + code.length, convention: 'sysv' });
  assert.ok(result.unknownPct >= 0);
  assert.match(result.c, /(unknown|\/\*)/);
});

test('xref finds callers, callees and data references', () => {
  // f1 at 0x1000 calls f2 at 0x1020; f2 returns.
  const code = new Uint8Array(0x40);
  // call rel32: 0x1000 -> 0x1020 (next instruction at 0x1005, disp = 0x1b)
  code.set([0xe8, 0x1b, 0x00, 0x00, 0x00], 0);
  code[5] = 0xc3;
  code[0x20] = 0xc3;
  const functions: FunctionEntry[] = [
    { name: 'f1', entry: 0x1000, end: 0x1020, size: 0x20, source: 'elf-symtab' },
    { name: 'f2', entry: 0x1020, end: 0x1040, size: 0x20, source: 'elf-symtab' },
  ];
  const graph = scanCallGraph(code, 0x1000, functions, { limit: 10 });
  assert.deepEqual(calleesOf(graph, 0x1000), [0x1020]);
  assert.deepEqual(callersOf(graph, 0x1020), [0x1000]);
  assert.equal(graph.scanned, 2);
  assert.equal(graph.truncated, false);
});

test('an indexed jump table becomes a switch', () => {
  const buffer = new Uint8Array(0x3000);
  // cmp edi,3; ja +0x20; jmp qword [rdi*8 + 0x2000]
  buffer.set([0x83, 0xff, 0x03], 0);
  buffer.set([0x77, 0x20], 3);
  buffer.set([0xff, 0x24, 0xfd, 0x00, 0x20, 0x00, 0x00], 5);
  // case 0 / 1 / 2 return 1 / 2 / 3; default returns 0
  buffer.set([0xb8, 0x01, 0x00, 0x00, 0x00, 0xc3], 0x10);
  buffer.set([0xb8, 0x02, 0x00, 0x00, 0x00, 0xc3], 0x15);
  buffer.set([0xb8, 0x03, 0x00, 0x00, 0x00, 0xc3], 0x1a);
  buffer.set([0x31, 0xc0, 0xc3], 0x25);
  // table at file offset 0x1000 (virtual 0x2000): three absolute addresses
  [0x1010, 0x1015, 0x101a].forEach((value, index) => {
    // Shifting by 32 wraps to 0 in JS; divide instead.
    for (let byte = 0; byte < 8; byte++) buffer[0x1000 + index * 8 + byte] = Math.floor(value / 2 ** (8 * byte)) & 0xff;
  });
  const result = decompileFunction(buffer, 0x1000, 0x1000, { name: 'pick', end: 0x1030, convention: 'sysv' });
  assert.match(result.c, /switch \(rdi\)/, result.c);
  assert.match(result.c, /case 0:/);
  assert.match(result.c, /case 2:/);
  assert.match(result.c, /return 1;|return 3;/);
});

// ---- parameters and calls -------------------------------------------------
//
// Two bugs made the printed C wrong in a way that looks right at a glance:
// a call result was assigned back onto a parameter name, and a value read
// through a register appeared under two different names in one expression.
// Both come from the same place — a parameter is a name for an incoming value,
// not a variable the body may overwrite — so both are pinned here.

test('a call result is never assigned onto a parameter', () => {
  // mov rdi, rsi        ; rdi := rsi  (arg0 shadowed by a copy — fine to print once)
  // call 0x2000 (rel)   ; rax := call(arg0)
  // mov rdi, rax        ; rdi := rax  (reusing the register, not the argument)
  // ret
  // The point: after the call, `rdi` is a scratch register again. Printing
  // `arg0 = call(...)` would claim the incoming argument was overwritten by the
  // callee's result, which no compiler emits.
  const code = bytes(
    0x48, 0x89, 0xf7,                                     // mov rdi, rsi
    0xe8, 0x00, 0x00, 0x00, 0x00,                          // call +0 (resolves inside the function)
    0x48, 0x89, 0xc7,                                     // mov rdi, rax
    0xc3,                                                 // ret
  )
  const result = decompileFunction(code, BASE, BASE, { name: 'caller', end: BASE + code.length, convention: 'sysv' })
  const assigns = result.c.split('\n').filter((line) => /arg\d+\s*=.*call\(/.test(line))
  assert.deepEqual(assigns, [], 'a call result must not be printed as an assignment to a parameter')
})

test('one register never prints as two different names in one expression', () => {
  // test rax, rax ; je +1 ; ret  — both operands are the same register.
  // Decoding them through two different lookups produced `rax * rax`, which
  // reads as squaring and is simply false.
  const code = bytes(
    0x48, 0x85, 0xc0,      // test rax, rax
    0x74, 0x01,            // je +1
    0xc3,                  // ret
  )
  const result = decompileFunction(code, BASE, BASE, { name: 'selfcmp', end: BASE + code.length, convention: 'sysv' })
  assert.doesNotMatch(result.c, /arg\d+ & arg\d+/, 'a self-test must not become a binary op between two params')
  assert.doesNotMatch(result.c, /(\w+) [&|^] \1\b/, 'a value must not be combined with itself')
})

test('a parameter that is only copied into a local is still a parameter', () => {
  // mov rax, rdi     ; rax := arg0   — rdi is read before it is ever written
  // add rax, 1
  // ret
  // The signature must carry that argument. It did not: the copy assigned `rax`
  // first, `defined` gained rax before rdi was ever considered an input, and the
  // function came out as `scratch(void)` with no parameters at all.
  const code = bytes(
    0x48, 0x89, 0xf8,                          // mov rax, rdi
    0x48, 0x83, 0xc0, 0x01,                    // add rax, 1
    0xc3,                                      // ret
  )
  const result = decompileFunction(code, BASE, BASE, { name: 'copied', end: BASE + code.length, convention: 'sysv' })
  assert.match(result.c, /copied\(long arg0\)/, 'the incoming argument must appear in the signature')
})

test('a routine that never sets rax does not print a return of rax', () => {
  // mov qword [rsp+8], 1 ; ret — a hand-written routine that stores its result
  // into the caller's frame. `long f(void) { return rax; }` would be an
  // invention and would not compile as C; `void f(void)` with a bare return is
  // what the instructions actually do.
  const code = bytes(
    0x48, 0xc7, 0x44, 0x24, 0x08, 0x01, 0x00, 0x00, 0x00,   // mov qword [rsp+8], 1
    0xc3,                                                    // ret
  )
  const result = decompileFunction(code, BASE, BASE, { name: 'noret', end: BASE + code.length, convention: 'win64' })
  assert.match(result.c, /void noret\(void\)/, 'no invented return type')
  assert.doesNotMatch(result.c, /return rax/, 'no invented return value')
})

test('a register only ever read at entry becomes a parameter, not a warning', () => {
  // mov rdi, [rsi] ; add rax, 1 ; ret — every register read before its own write
  // is something the caller supplied, so all of them are parameters. This used to
  // print an undefined-read warning for rax while also listing it as arg0.
  const code = bytes(
    0x48, 0x8b, 0x3e,                              // mov rdi, [rsi]
    0x48, 0x83, 0xc0, 0x01,                        // add rax, 1
    0xc3,                                          // ret
  )
  const result = decompileFunction(code, BASE, BASE, { name: 'uses', end: BASE + code.length, convention: 'sysv' })
  assert.doesNotMatch(result.c, /read before written/, 'an incoming value is not an undefined read')
  assert.match(result.c, /uses\(long arg0/, 'the destination of the add is an input')
})

test('a bare ret handing back the caller\'s register is not an undefined read', () => {
  // `ret` alone: Go uses this to forward the result it already has in rax, so
  // there is nothing undefined about it. Labelling it put the warning on a third
  // of every binary and trained the reader to ignore it.
  const code = bytes(0xc3)
  const result = decompileFunction(code, BASE, BASE, { name: 'passthrough', end: BASE + code.length, convention: 'sysv' })
  assert.doesNotMatch(result.c, /read before written/, 'a pass-through return is not an undefined read')
})

test('a value that is written first carries no such label', () => {
  const code = bytes(
    0x48, 0x89, 0xf8,                          // mov rax, rdi
    0x48, 0x83, 0xc0, 0x01,                    // add rax, 1
    0xc3,                                      // ret
  )
  const result = decompileFunction(code, BASE, BASE, { name: 'copied', end: BASE + code.length, convention: 'sysv' })
  assert.doesNotMatch(result.c, /read before written/, 'a defined value is not an undefined read')
  assert.match(result.c, /return arg0 \+ 1/)
})

// ---- stack frame ----------------------------------------------------------
//
// Go emits `push rbp; mov rbp, rsp; sub rsp, N` and then addresses its frame off
// rsp anyway, because rsp is the register the stack guard already compared. The
// frame reader skipped every rsp-relative access while a frame pointer existed,
// so a Go function's whole frame printed as `*(long *)(rsp + 0x100)` on a
// register nothing ever wrote — complete-looking code with no relation to the
// instructions.

test('an rsp-relative slot is named, not printed as pointer arithmetic', () => {
  // push rbp ; mov rbp, rsp ; sub rsp, 0x20 ; mov [rsp+0x10], rcx ; ret
  const code = bytes(
    0x55,                                     // push rbp
    0x48, 0x89, 0xe5,                         // mov rbp, rsp
    0x48, 0x83, 0xec, 0x20,                   // sub rsp, 0x20
    0x48, 0x89, 0x4c, 0x24, 0x10,             // mov [rsp+0x10], rcx
    0xc3,                                     // ret
  )
  const result = decompileFunction(code, BASE, BASE, { name: 'frame', end: BASE + code.length, convention: 'win64' })
  assert.doesNotMatch(result.c, /rsp \+ 0x/, 'the slot must have a name')
  assert.doesNotMatch(result.c, /read before written: rsp/, 'rsp is not a value the body reads')
})

test('a result spilled above the return address is not called an argument', () => {
  // push rbp ; mov rbp,rsp ; sub rsp,0x20 ; mov [rsp+0x30], rax ; ret
  // The slot is beyond the frame, in the argument shadow space, but it is only
  // ever written — it holds the outgoing result. Naming it `argN` claims the
  // caller passed a sixth argument that the signature cannot support.
  const code = bytes(
    0x55,                                     // push rbp
    0x48, 0x89, 0xe5,                         // mov rbp, rsp
    0x48, 0x83, 0xec, 0x20,                   // sub rsp, 0x20
    0x48, 0x89, 0x44, 0x24, 0x30,             // mov [rsp+0x30], rax
    0xc3,                                     // ret
  )
  const result = decompileFunction(code, BASE, BASE, { name: 'spill', end: BASE + code.length, convention: 'win64' })
  assert.doesNotMatch(result.c, /arg4/, 'a write-only spill must not become the fifth argument')
  assert.doesNotMatch(result.c, /stack_arg_\d+ arg/, 'the spill is a slot, not a parameter')
})

test('a slot above the return address that is read first is a parameter', () => {
  // push rbp ; mov rbp,rsp ; sub rsp,0x20 ; mov rax,[rsp+0x30] ; ret
  const code = bytes(
    0x55,                                     // push rbp
    0x48, 0x89, 0xe5,                         // mov rbp, rsp
    0x48, 0x83, 0xec, 0x20,                   // sub rsp, 0x20
    0x48, 0x8b, 0x44, 0x24, 0x30,             // mov rax, [rsp+0x30]
    0xc3,                                     // ret
  )
  const result = decompileFunction(code, BASE, BASE, { name: 'reads', end: BASE + code.length, convention: 'win64' })
  assert.match(result.c, /reads\([^)]*arg\d/, 'an incoming stack argument is a parameter')
})

test('folding a stack-check thunk does not delete the code after it', () => {
  // The thunk walk follows single successors, and when the thunk jumps back to
  // the entry the chain continues into the entry's own following blocks — real
  // code. Marking those folded removed a `lea` that computed a loop bound, and
  // the decompiler then printed the register it defined as "never assigned".
  // A block is a thunk only while it holds no statement of its own.
  const code = bytes(
    // entry: compare against the stack guard and branch to the slow path
    0x49, 0x3b, 0x66, 0x10,               // cmp rsp, [r14+0x10]
    0x76, 0x10,                           // jbe +0x10 (a block of its own)
    // real work the function must keep
    0x48, 0x8d, 0x51, 0xff,               // lea rdx, [rcx-1]
    0x48, 0x85, 0xc9,                     // test rcx, rcx
    0x75, 0x06,                           // jne +6
    0x48, 0x89, 0xc8,                     // mov rax, rcx
    0xc3,                                 // ret
    // the "thunk": jump straight back to the entry
    0xeb, 0xee,                           // jmp entry
  )
  const result = decompileFunction(code, BASE, BASE, { name: 'thunk', end: BASE + code.length, convention: 'win64' })
  assert.doesNotMatch(result.c, /read before written: rdx/, 'the lea after the thunk must survive')
})

// ---- parameters from memory operands --------------------------------------
//
// The two defects below were the largest single source of wrong output measured
// over a real Go binary: together they accounted for most of the C that read a
// local nothing had assigned.

test('a receiver read through a memory operand is a parameter', () => {
  // movzx eax, byte ptr [rax+0x17] ; ret
  // `rax` is read as the base of the load — that is the receiver, and it belongs
  // in the signature. Only `reg` operands used to be inspected, so the base of a
  // memory operand never became an argument and the body read an unassigned local.
  const code = bytes(
    0x0f, 0xb6, 0x40, 0x17,      // movzx eax, byte ptr [rax+0x17]
    0xc3,                        // ret
  )
  const result = decompileFunction(code, BASE, BASE, { name: 'kind', end: BASE + code.length, convention: 'sysv' })
  assert.match(result.c, /kind\(long arg0\)/, 'the receiver is a parameter')
  assert.match(result.c, /\*\(char \*\)\(arg0 \+ 0x17\)/, 'the body uses that parameter')
  assert.doesNotMatch(result.c, /read before written/, 'no unassigned local is left behind')
})

test('an assignment read only inside a later branch is not a dead store', () => {
  // mov rdx, rcx ; sub rdx, 1 ; test rcx, rdx ; je skip ; mov rax, 1 ; ret ; skip: xor eax,eax ; ret
  // The straight-line run is optimized on its own, so `rdx = rcx - 1` looked
  // dead: its only reader is one statement further, inside the branch.
  const code = bytes(
    0x48, 0x89, 0xca,                     // mov rdx, rcx
    0x48, 0x83, 0xea, 0x01,               // sub rdx, 1
    0x48, 0x85, 0xd1,                     // test rcx, rdx
    0x74, 0x06,                           // je +6
    0xb8, 0x01, 0x00, 0x00, 0x00,         // mov eax, 1
    0xc3,                                 // ret
    0x31, 0xc0,                           // xor eax, eax
    0xc3,                                 // ret
  )
  const result = decompileFunction(code, BASE, BASE, { name: 'bound', end: BASE + code.length, convention: 'sysv' })
  assert.match(result.c, /rdx = arg1 - (0x)?1/, 'the assignment must survive')
  assert.doesNotMatch(result.c, /read before written: rdx/, 'rdx is assigned before it is read')
  assert.match(result.c, /if \(/, 'the branch is structured')
})

test('a register a call wrote is not an undefined read afterwards', () => {
  // call f ; mov rax, rbx ; ret
  // Go returns its second value in rbx, so reading rbx after the call reads that
  // result. The body used to report it as a local nothing had assigned because the
  // call only marked rax as defined.
  const code = bytes(
    0xe8, 0x00, 0x00, 0x00, 0x00,      // call +0 (target is inside the block)
    0x48, 0x89, 0xd8,                  // mov rax, rbx
    0xc3,                              // ret
    0xc3,                              // ret (call target)
  )
  const result = decompileFunction(code, BASE, BASE, { name: 'twovalue', end: BASE + code.length, convention: 'sysv' })
  assert.doesNotMatch(result.c, /read before written: rbx/, 'a call result is a defined value')
})

test('code after a call that never returns is not presented as reachable', () => {
  // call a known no-return routine, then a block that reads a register nothing
  // wrote. The second block only runs on the unwind path, so printing it puts an
  // unassigned local in the body.
  const code = bytes(
    0x55,                              // push rbp
    0x48, 0x89, 0xe5,                  // mov rbp, rsp
    0xe8, 0x00, 0x00, 0x00, 0x00,      // call +0 (the panic helper below)
    0x48, 0x89, 0xd8,                  // mov rax, rbx   <- unreachable
    0xc3,                              // ret
    0xc3,                              // panic helper: ret (never really returns)
  )
  const panicHelper = `sub_${(BASE + 0x9).toString(16)}`
  const result = decompileFunction(code, BASE, BASE, {
    name: 'panics', end: BASE + code.length, convention: 'sysv',
    noReturnCalls: new Set([panicHelper]),
  })
  assert.doesNotMatch(result.c, /return rbx/, 'the unwind path is not part of the body')
})

test('an assignment is kept when its only reader is in another block', () => {
  // lea rcx, [rsi+1] ; then a loop body does `rdi = rdi << rcx`.
  // Each straight-line run is optimized on its own, so the run holding the `lea`
  // saw no reader and deleted it; the loop then shifted by a variable nothing had
  // assigned. Liveness is taken over the whole body, not the run.
  const code = bytes(
    0x48, 0x8d, 0x4e, 0x01,                // lea rcx, [rsi+1]
    0x48, 0xd3, 0xe7,                     // shl rdi, cl
    0x48, 0x83, 0xff, 0x00,               // cmp rdi, 0
    0x7f, 0xf8,                           // jg -8 (back over the shl)
    0xc3,                                 // ret
  )
  const result = decompileFunction(code, BASE, BASE, { name: 'shift', end: BASE + code.length, convention: 'sysv' })
  assert.match(result.c, /rcx = arg1 \+ (0x)?1/, 'the lea survives its reader being in another block')
  assert.doesNotMatch(result.c, /read before written: rcx/, 'and the loop body can read it')
})

test('a loop whose latch has no branch of its own still owns its body', () => {
  // lea rcx, [rsi+1] ; shl rdi, cl ; cmp rdi, 0 ; jg back over the shl ; ret
  // The backward edge lands on a `fallthrough` block, not on a `jcc`. Requiring
  // the latch to be a conditional branch made the loop fall through to the
  // empty-body case, and the body then read a register whose assignment had been
  // placed in another subtree.
  const code = bytes(
    0x48, 0x8d, 0x4e, 0x01,                // lea rcx, [rsi+1]
    0x48, 0xd3, 0xe7,                     // shl rdi, cl
    0x48, 0x83, 0xff, 0x00,               // cmp rdi, 0
    0x7f, 0xf8,                           // jg -8
    0xc3,                                 // ret
  )
  const result = decompileFunction(code, BASE, BASE, { name: 'latched', end: BASE + code.length, convention: 'sysv' })
  // The body must contain both the producing assignment and the shifting read.
  assert.match(result.c, /rcx = arg1 \+ (0x)?1/, 'the producing assignment is in the body')
  assert.match(result.c, /<< rcx/, 'and so is its reader')
})

test('one spilled argument does not stand in for the whole signature', () => {
  // mov [rsp+0x18], rax ; cmp rbx, 0 ; je +2 ; ret ; ret
  // The prologue names rax by spilling it. rbx is read straight out of a register
  // and is an argument too; treating the spill as a complete signature reported it
  // as an unassigned local.
  const code = bytes(
    0x48, 0x89, 0x44, 0x24, 0x18,         // mov [rsp+0x18], rax
    0x48, 0x83, 0xfb, 0x00,               // cmp rbx, 0
    0x74, 0x01,                           // je +1
    0xc3,                                 // ret
    0xc3,                                 // ret
  )
  const result = decompileFunction(code, BASE, BASE, { name: 'twoargs', end: BASE + code.length, convention: 'sysv' })
  assert.match(result.c, /twoargs\(long arg0, long arg1\)/, 'both arguments are in the signature')
  assert.doesNotMatch(result.c, /read before written: rbx/, 'rbx is an argument, not a lost local')
})

test('a versioned value read once is folded into its reader', () => {
  // The versioning pass numbers a redefined register. When only one statement
  // reads the numbered name, keeping it prints `rbx_2 = ...; rdx = rbx_2 + rbx_2`
  // for a value that exists to be used once. The name goes away and the reader
  // carries the expression.
  const code = bytes(
    0x48, 0x89, 0xf8,                  // mov rax, rdi
    0x48, 0xd1, 0xf8,                  // sar rax, 1
    0x48, 0xc1, 0xf8, 0x02,            // sar rax, 2
    0x48, 0x01, 0xf8,                  // add rax, rdi
    0xc3,                              // ret
  )
  const result = decompileFunction(code, BASE, BASE, { name: 'fold', end: BASE + code.length, convention: 'sysv' })
  // Both directions. "Declared implies assigned" is the one that catches a value the
  // pipeline dropped; "assigned implies declared" is the one that catches a name the
  // body uses and the header never introduced, which is a compile error and was the
  // actual defect — 203 functions in 300 used an undeclared name, and this test passed
  // on all of them because it only asked the first question.
  assertEveryNameIsDeclaredAndAssigned(result.c)
})

test('a chain of versioned values folds transitively', () => {
  // inc [rdx+0x20]; dec [rdx+0x21] — the shape Go emits for `x++; y--`.
  // Folding `rbx_4 = rbx_3 - 1` into its reader left the `rbx_3` it mentions
  // undefined, because the substitution was one level deep. Every name in the
  // printed body must have an assignment.
  const code = bytes(
    0x0f, 0xb6, 0x43, 0x20,               // movzx eax, byte [rbx+0x20]
    0x83, 0xc0, 0x01,                     // add eax, 1
    0x88, 0x43, 0x20,                     // mov [rbx+0x20], al
    0x0f, 0xb6, 0x43, 0x21,               // movzx eax, byte [rbx+0x21]
    0x83, 0xe8, 0x01,                     // sub eax, 1
    0x88, 0x43, 0x21,                     // mov [rbx+0x21], al
    0xc3,                                 // ret
  )
  const result = decompileFunction(code, BASE, BASE, { name: 'bump', end: BASE + code.length, convention: 'sysv' })
  assertEveryNameIsDeclaredAndAssigned(result.c)
})


test('spilling an argument through rsp does not overwrite the parameter', () => {
  // push rbp; mov rbp,rsp; sub rsp,0x28; mov [rsp+0x40], rcx; call f
  // Go addresses its frame off rsp as often as off rbp. Only the rbp form was
  // recognised as "this slot is arg0", so the rsp form printed `arg0 = rcx` —
  // the parameter assigned to itself, from a value that is not the parameter.
  const code = bytes(
    0x55,
    0x48, 0x89, 0xe5,
    0x48, 0x83, 0xec, 0x28,               // sub rsp, 0x28
    0x48, 0x89, 0x4c, 0x24, 0x40,         // mov [rsp+0x40], rcx
    0xe8, 0x00, 0x00, 0x00, 0x00,         // call rel32
    0x48, 0x83, 0xc4, 0x28,               // add rsp, 0x28
    0x5d,                                 // pop rbp
    0xc3,                                 // ret
  )
  const result = decompileFunction(code, BASE, BASE, { name: 'spill', end: BASE + code.length, convention: 'sysv' })
  assert.doesNotMatch(result.c, /arg0 = /, 'the parameter is not assigned to itself')
  assert.doesNotMatch(result.c, /read before written/, 'and nothing is left unassigned')
})

test('a spilled argument register stays a parameter', () => {
  // push rbp; mov rbp,rsp; sub rsp,0x18; mov [rsp+0x38], rcx; ...
  // The prologue spills rcx and the body forwards it to a callee. `savedArgs` is the
  // only place that pairs the register with `argN`, and the inference loop works in
  // register names, so it could not see the pairing: the signature came out short
  // and the body read a register nothing had assigned.
  const code = bytes(
    0x55,
    0x48, 0x89, 0xe5,
    0x48, 0x83, 0xec, 0x18,               // sub rsp, 0x18
    0x48, 0x89, 0x4c, 0x24, 0x38,         // mov [rsp+0x38], rcx
    0x48, 0x89, 0xc3,                     // mov rbx, rax
    0xe8, 0x00, 0x00, 0x00, 0x00,         // call rel32
    0x48, 0x83, 0xc4, 0x18,               // add rsp, 0x18
    0x5d,
    0xc3,
  )
  const result = decompileFunction(code, BASE, BASE, { name: 'fwd', end: BASE + code.length, convention: 'sysv' })
  assert.doesNotMatch(result.c, /read before written: rcx/, 'the spilled argument is not an orphan')
})

test('a register rotation survives dead-store elimination', () => {
  // mov rcx, rax; mov rax, rbx; mov rbx, rcx; call f
  // This is how Go sets up a call whose arguments are not already in place. The
  // third move reads the *first* move's destination, so forwarding `rcx -> rax`
  // past the write to rax turned it into `rbx = rax` — the value rax holds after
  // the rotation started, which is the wrong register entirely.
  const code = bytes(
    0x48, 0x89, 0xc1,                     // mov rcx, rax
    0x48, 0x89, 0xd8,                     // mov rax, rbx
    0x48, 0x89, 0xcb,                     // mov rbx, rcx
    0xe8, 0x00, 0x00, 0x00, 0x00,         // call rel32
    0xc3,                                 // ret
  )
  const result = decompileFunction(code, BASE, BASE, { name: 'rotate', end: BASE + code.length, convention: 'sysv' })
  // The rotation must appear: each of the three moves writes a distinct register
  // from another one, and none of them reads the value it just wrote.
  const moves = [...result.c.matchAll(/^\s{4}(\w+) = (\w+);$/gm)]
  assert.ok(moves.length >= 2, `the rotation is printed, not collapsed: ${result.c}`)
  for (const [, to, from] of moves) assert.notEqual(to, from, 'no move reads its own destination')
})

test('a Go symbol name becomes a C identifier', () => {
  // `internal/runtime/maps.(*Map).Clear` has four characters C rejects in an
  // identifier. 98.9% of the Go function table needs rewriting, so the definition would
  // be rejected before the body was read.
  const code = bytes(0xc3)
  const result = decompileFunction(code, BASE, BASE, {
    name: 'internal/runtime/maps.(*Map).Clear',
    end: BASE + code.length,
    convention: 'sysv',
  })
  const definition = /^\s*[\w]*\s*\*?\s*([A-Za-z_]\w*)\s*\(/m.exec(result.c.split('\n').slice(2).join('\n'))
  assert.ok(definition, `a definition line is printed\n${result.c}`)
  assert.match(definition[1], /^[A-Za-z_]\w*$/, 'the name is a C identifier')
  assert.match(definition[1], /internal_runtime_maps/, 'the package path is still readable in it')
})

test('a call prints a name and the listing declares it', () => {
  // call rel32; ret — the target is a real function of the binary, named by the table.
  const code = bytes(
    0xe8, 0x10, 0x00, 0x00, 0x00,         // call BASE+0x15
    0xc3,                                 // ret
    0x90, 0x90, 0x90, 0x90, 0x90,
    0x90, 0x90, 0x90, 0x90, 0x90,
    0xc3,                                 // the callee
  )
  const names = new Map([[BASE + 0x15, 'pkg.name']])
  const result = decompileFunction(code, BASE, BASE, {
    name: 'caller', end: BASE + code.length, convention: 'sysv', names,
  })
  // The name is printed, mangled the same way the definition would be.
  assert.match(result.c, /pkg_name\(\)/, `the callee is named\n${result.c}`)
  // And declared: a call to an undeclared name is a C99 constraint violation.
  const header = result.c.split('{')[0] || ''
  assert.match(header, /long pkg_name\(\);/, `the callee is declared above\n${result.c}`)
})

test('an indirect call is declared, not left undeclared', () => {
  // call rbx — the target is in a register, so there is no name to look up. The listing
  // says `indirect_call` and declares it, which is honest about what is known and still
  // compiles.
  const code = bytes(
    0xff, 0xd3,                           // call rbx
    0xc3,                                 // ret
  )
  const result = decompileFunction(code, BASE, BASE, { name: 'viaptr', end: BASE + code.length, convention: 'sysv' })
  assert.match(result.c, /indirect_call\(\)/, `the call is marked indirect\n${result.c}`)
  assert.match(result.c.split('{')[0] || '', /long indirect_call\(\);/, 'and declared')
})

test('a method receiver is spelled with its type, and the type is declared', () => {
  // `ret` alone: the body carries nothing, so the parameter list is built from the
  // symbol name. The receiver type is the one thing the name states outright, and
  // without it the first parameter reads `long` — which is what 273 of 364 methods in a
  // 24 MB binary printed before this.
  const code = bytes(0xc3)
  const result = decompileFunction(code, BASE, BASE, {
    name: 'internal/runtime/maps.(*Map).Clear',
    end: BASE + code.length,
    convention: 'sysv',
  })
  // The declaration comes first, so the signature is not naming a type from nowhere.
  assert.match(result.c, /typedef struct Map Map;/, `the type is declared\n${result.c}`)
  assert.match(result.c, /\(\s*Map \* arg0\s*\)/, `the receiver takes its type from the name\n${result.c}`)
})

test('a receiver the body dereferences keeps the pointer type it already had', () => {
  // `mov [rax], rbx` uses rax as an address. rax is Go's first argument register, so
  // the receiver here is the dereferenced one and the parameter is already `void *` —
  // a real pointer type. Replacing it with a named one would be a step backwards, so
  // the name only fills in where nothing better was found.
  const code = bytes(
    0x48, 0x89, 0x18,                    // mov [rax], rbx
    0xc3,                                // ret
  )
  const result = decompileFunction(code, BASE, BASE, {
    name: 'pkg.(*Thing).set',
    end: BASE + code.length,
    convention: 'sysv',
  })
  assert.match(result.c, /void \* arg0/, `the dereferenced receiver stays a pointer\n${result.c}`)
  assert.ok(!/typedef struct Thing/.test(result.c), `and no type is declared for it\n${result.c}`)
})

test('an anonymous struct receiver is left alone', () => {
  // `(struct { io.Reader }).Read` is real in the Go runtime. There is no identifier to
  // print for it, and inventing one would be worse than the parameter as it was.
  const code = bytes(0xc3)
  const result = decompileFunction(code, BASE, BASE, {
    name: 'pkg.(struct { io.Reader }).Read',
    end: BASE + code.length, convention: 'sysv',
  })
  assert.ok(!/typedef struct \{/.test(result.c), `no fabricated type\n${result.c}`)
})
