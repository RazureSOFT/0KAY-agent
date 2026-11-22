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
