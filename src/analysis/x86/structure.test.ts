/**
 * Exits the listing has to name.
 *
 * Every case here was a function whose body ran into its closing brace without saying
 * where control went — a `context.(*cancelCtx).Deadline` that ended on a load. The
 * structural invariants catch these over a whole binary; these fix the shape in one
 * function so a regression is caught without a 24 MB object file to hand.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { decompileFunction } from './decompile.js';

const BASE = 0x1000;

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

/** The last statement the body prints, ignoring comments and the closing brace. */
function lastStatement(c: string): string {
  const open = c.indexOf('{');
  const body = open >= 0 ? c.slice(open + 1).replace(/\s+$/, '') : '';
  return body
    .split('\n')
    .filter((line) => line.trim() && !line.trim().startsWith('/*') && line.trim() !== '}')
    .pop() ?? '';
}

test('a jump through a register says where control went, and leaves an exit', () => {
  // Go finishes an interface-method wrapper with `jmp rcx` — the itab entry, reached
  // through a value rather than an address. Nothing can be followed from it, and saying
  // nothing left the listing with no exit at all: `context.(*cancelCtx).Deadline` ended
  // on `rcx = *(long *)(rcx + 0x18);` with the tail call nowhere.
  const code = bytes(
    0x48, 0x8b, 0x49, 0x18,   // mov rcx, [rcx+0x18]
    0xff, 0xe1,               // jmp rcx
  );
  const result = decompileFunction(code, BASE, BASE, { name: 'pkg.(*Thing).call', end: BASE + code.length, convention: 'sysv' });
  assert.match(result.c, /control leaves through rcx/, `the destination is named\n${result.c}`);
  const last = lastStatement(result.c).trim();
  assert.match(last, /^(return|goto|break|continue)\b/, `the body has an exit, and it ends on it\n${result.c}`);
});

test('the layout behind a parameter is reported, in offset order', () => {
  // `mov [rax+0x8], rdx; mov rcx, [rax+0x10]` through the same base says the object has
  // something 8 bytes in and something 16 bytes in. Neither is nameable in a stripped
  // binary, but the set of offsets is a layout and a reader can use it.
  const code = bytes(
    0x48, 0x89, 0x50, 0x08,       // mov [rax+0x08], rdx
    0x48, 0x8b, 0x48, 0x10,       // mov rcx, [rax+0x10]
    0xc3,                         // ret
  );
  const result = decompileFunction(code, BASE, BASE, { name: 'pkg.f', end: BASE + code.length, convention: 'sysv' });
  const note = /(\w+) is dereferenced at ([^*]+)\*\//.exec(result.c);
  assert.ok(note, `the layout is reported\n${result.c}`);
  const offsets = note[2];
  assert.match(offsets, /\+0x8/, `the first offset\n${result.c}`);
  assert.match(offsets, /\+0x10/, `the second\n${result.c}`);
  assert.ok(offsets.indexOf('+0x8') < offsets.indexOf('+0x10'), `in order\n${result.c}`);
});

test('a name that receives a parameter once is followed, and one reused is not', () => {
  // `mov rcx, rax; mov [rcx+0x20], rdx` is the same object as rax. `mov rcx, rax` twice,
  // with other work between, is two different values in the same register and its offsets
  // belong to neither.
  const followed = bytes(
    0x48, 0x89, 0xc1,             // mov rcx, rax
    0x48, 0x89, 0x51, 0x20,       // mov [rcx+0x20], rdx
    0xc3,
  );
  const once = decompileFunction(followed, BASE, BASE, { name: 'pkg.f', end: BASE + followed.length, convention: 'sysv' });
  assert.ok(/is dereferenced at[^*]*\+0x20/.test(once.c), `one assignment is an alias\n${once.c}`);

  const reused = bytes(
    0x48, 0x89, 0xc1,             // mov rcx, rax
    0x48, 0x89, 0xd1,             // mov rcx, rdx   <- second life
    0x48, 0x89, 0x51, 0x20,       // mov [rcx+0x20], rdx
    0xc3,
  );
  const twice = decompileFunction(reused, BASE, BASE, { name: 'pkg.f', end: BASE + reused.length, convention: 'sysv' });
  assert.ok(/is dereferenced at[^*]*\+0x20/.test(twice.c), `the second value still has a layout\n${twice.c}`);
  assert.ok(!/rax is dereferenced at[^*]*\+0x20/.test(twice.c), `but it is not attributed to rax\n${twice.c}`);
});

test('a constant that points at text is labelled with it', () => {
  // Go reaches its error messages and format tables through a constant. `0x140756613` is
  // `"0123456789"` in the binary this was written against, and the literal alone tells a
  // reader nothing.
  const code = bytes(
    0x48, 0xb8, 0x00, 0x20, 0x00, 0x40, 0x01, 0x00, 0x00, 0x00, // mov rax, 0x140002000
    0xc3,
  );
  const result = decompileFunction(code, BASE, BASE, {
    end: BASE + code.length,
    convention: 'sysv',
    textAt: (address) => (address === 0x140002000 ? JSON.stringify('panic: ') : null),
  });
  assert.match(result.c, /0x140002000 \/\* "panic: " \*\//, `the text is named\n${result.c}`);
});

test('a constant with no text behind it is left as a number', () => {
  const code = bytes(
    0x48, 0xb8, 0x00, 0x20, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // mov rax, 0x2000
    0xc3,
  );
  const result = decompileFunction(code, BASE, BASE, { end: BASE + code.length, convention: 'sysv' });
  assert.match(result.c, /0x2000/, `still the literal\n${result.c}`);
  assert.ok(!/\/\* "/.test(result.c), `and no invented text\n${result.c}`);
});

test('a write that nothing reads before it is overwritten is dropped', () => {
  // `mov eax, 5; mov eax, 7` — the first value is never read. `eax` is written to clear the
  // upper half of `rax` as often as for its value, and the lift kept both.
  const code = bytes(
    0xb8, 0x05, 0x00, 0x00, 0x00, // mov eax, 5
    0xb8, 0x07, 0x00, 0x00, 0x00, // mov eax, 7
    0xc3,
  );
  const result = decompileFunction(code, BASE, BASE, { end: BASE + code.length, convention: 'sysv' });
  assert.match(result.c, /return 7;/, `the surviving value\n${result.c}`);
  assert.ok(!/return 5;/.test(result.c), `the discarded one is gone\n${result.c}`);
});

test('the last write in a block is kept, because something outside may read it', () => {
  // The liveness pass runs backwards; when it reaches the top of the block the names it
  // has not seen written are that block's result. Removing them would change what the
  // function returns, and this is the case that a naive "overwritten later" check misses.
  const code = bytes(
    0xb8, 0x05, 0x00, 0x00, 0x00, // mov eax, 5
    0xc3,
  );
  const result = decompileFunction(code, BASE, BASE, { end: BASE + code.length, convention: 'sysv' });
  assert.match(result.c, /return 5;/, `the block result survives\n${result.c}`);
});

test('a call is never dropped, even when its result is overwritten', () => {
  // The result of `a()` is discarded, but `a()` ran. `runtime_printlock()` followed by
  // `runtime_printstring()` prints twice; deleting the first changes the program. 520 of
  // the 1067 overwrites measured on this binary are calls for exactly this reason.
  const code = bytes(
    0xe8, 0x00, 0x00, 0x00, 0x00, // call a
    0xe8, 0x00, 0x00, 0x00, 0x00, // call b
    0xe8, 0x00, 0x00, 0x00, 0x00, // call c
    0xc3,
  );
  const names = new Map([[0x1005, 'a'], [0x100a, 'b'], [0x100f, 'c']]);
  const result = decompileFunction(code, BASE, BASE, { end: BASE + code.length, convention: 'sysv', names });
  assert.match(result.c, /a\(\);/, `the first call is still there\n${result.c}`);
  assert.match(result.c, /b\(\);/, `and the second\n${result.c}`);
});

test('a value that is read before being overwritten is kept', () => {
  // `mov eax, 5; add eax, 3` reads what it writes. Dropping the first would leave the sum
  // starting from whatever was in the register, which is not the same program.
  const code = bytes(
    0xb8, 0x05, 0x00, 0x00, 0x00, // mov eax, 5
    0x83, 0xc0, 0x03,             // add eax, 3
    0xc3,
  );
  const result = decompileFunction(code, BASE, BASE, { end: BASE + code.length, convention: 'sysv' });
  assert.match(result.c, /5/, `the first value contributes\n${result.c}`);
  assert.match(result.c, /8|3/, `and the arithmetic survives\n${result.c}`);
});
