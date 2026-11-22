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
