/**
 * Structural invariants of the output.
 *
 * Each of these was a real defect, found by running the same checks over every
 * function of a large binary: 534 of 4000 functions printed a `goto` to a label that
 * was nowhere in the listing, 413 printed labels nothing jumped to, 295 printed an
 * empty pair of braces where a branch body should be, and 327 printed `x = x`. No
 * single function shows that kind of thing — the counts are what made them visible.
 *
 * The cases below are the smallest programs that reproduce each shape, so a
 * regression shows up here rather than only in a 4000-function sweep. The same
 * invariants are asserted over whatever binary the sweep is pointed at.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { decompileFunction } from './decompile.js';

const BASE = 0x1000;

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

/** Every label the output defines, and every label some `goto` names. */
function labelsAndJumps(c: string): { defined: Set<string>; jumped: Set<string> } {
  const defined = new Set([...c.matchAll(/^\s*(L_[0-9a-f]+):/gm)].map((m) => m[1]));
  const jumped = new Set([...c.matchAll(/goto (L_[0-9a-f]+)/g)].map((m) => m[1]));
  return { defined, jumped };
}

test('every goto names a label that the listing defines', () => {
  // A loop with a `continue`: the branch back to the top needs a label to jump to.
  // cmp rcx,0; je done; ... dec rcx; jmp top ...
  const code = bytes(
    0x31, 0xc0,                          // xor eax, eax
    0x48, 0x85, 0xc9,                    // test rcx, rcx
    0x74, 0x0c,                          // je +12   (to 0x100e)
    0xff, 0xc0,                          // inc eax
    0x48, 0xff, 0xc9,                    // dec rcx
    0xeb, 0xf5,                          // jmp -11  (to 0x1003)
    0xc3,                                // ret
  );
  const r = decompileFunction(code, BASE, BASE, { name: 'count', end: BASE + code.length, convention: 'sysv' });
  const { defined, jumped } = labelsAndJumps(r.c);
  for (const target of jumped) {
    assert.ok(defined.has(target), `goto ${target} has no label\n${r.c}`);
  }
});

test('a label nothing jumps to is not printed', () => {
  // A straight-line function with a conditional that both paths fall out of: there
  // is nothing to jump to, so a label would be noise.
  const code = bytes(
    0x48, 0x83, 0xff, 0x00,              // cmp rdi, 0
    0x74, 0x05,                          // je +5
    0xb8, 0x01, 0x00, 0x00, 0x00,        // mov eax, 1
    0xc3,                                // ret
  );
  const r = decompileFunction(code, BASE, BASE, { name: 'flag', end: BASE + code.length, convention: 'sysv' });
  const { defined, jumped } = labelsAndJumps(r.c);
  for (const label of defined) {
    assert.ok(jumped.has(label), `label ${label} is never jumped to\n${r.c}`);
  }
});

test('a conditional never prints an empty body', () => {
  // A branch whose target is a bare `ret` — the shared epilogue Go emits — must show
  // the return, not `{ }`.
  const code = bytes(
    0x48, 0x85, 0xff,                    // test rdi, rdi
    0x75, 0x06,                          // jne +6   (to the ret below)
    0xb8, 0x00, 0x00, 0x00, 0x00,        // mov eax, 0
    0xc3,                                // ret
    0x31, 0xc0,                          // xor eax, eax
    0xc3,                                // ret
  );
  const r = decompileFunction(code, BASE, BASE, { name: 'guard', end: BASE + code.length, convention: 'sysv' });
  assert.doesNotMatch(r.c, /\{\s*\n\s*\}/, `empty braces in\n${r.c}`);
});

test('an assignment of a value to itself is dropped', () => {
  // A move from a register to itself, as the compiler emits for a redefinition it
  // then optimises away. The listing should not show `x = x`.
  const code = bytes(
    0x48, 0x89, 0xc9,                    // mov rcx, rcx
    0x48, 0x89, 0xc8,                    // mov rax, rcx
    0xc3,                                // ret
  );
  const r = decompileFunction(code, BASE, BASE, { name: 'id', end: BASE + code.length, convention: 'sysv' });
  assert.doesNotMatch(r.c, /^\s*([A-Za-z_]\w*) = \1;$/m, `self assignment in\n${r.c}`);
});

test('a jump count in the header matches the jumps printed', () => {
  const code = bytes(
    0x31, 0xc0,
    0x48, 0x85, 0xc9,
    0x74, 0x0c,
    0xff, 0xc0,
    0x48, 0xff, 0xc9,
    0xeb, 0xf5,
    0xc3,
  );
  const r = decompileFunction(code, BASE, BASE, { name: 'count2', end: BASE + code.length, convention: 'sysv' });
  const printed = [...r.c.matchAll(/\bgoto /g)].length;
  assert.equal(r.gotos, printed, `header says ${r.gotos}, listing has ${printed}\n${r.c}`);
});

test('braces balance', () => {
  const code = bytes(
    0x48, 0x83, 0xff, 0x00,
    0x74, 0x0a,
    0x48, 0x83, 0xc0, 0x01,
    0x48, 0x83, 0xc0, 0x02,
    0x48, 0x83, 0xc0, 0x03,
    0xc3,
  );
  const r = decompileFunction(code, BASE, BASE, { name: 'tally', end: BASE + code.length, convention: 'sysv' });
  let depth = 0;
  for (const ch of r.c) {
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    assert.ok(depth >= 0, `closing brace with nothing open\n${r.c}`);
  }
  assert.equal(depth, 0, `unbalanced braces\n${r.c}`);
});
