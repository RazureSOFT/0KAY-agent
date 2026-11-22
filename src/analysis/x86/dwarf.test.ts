/**
 * Reading debug information, and what it changes in a listing.
 *
 * The synthetic unit here is small enough to check by hand, which the 6.5 MB of real
 * `.zdebug_info` this was developed against is not. Every assertion was a real defect
 * first: the address table read at the wrong base, the unit walk stopping after its first
 * child, `implicit_const` shifting the stream.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as zlib from 'node:zlib';
import { parseDwarf, sectionBytes, signatureAt } from './dwarf.js';
import { decompileFunction } from './decompile.js';

/** A `.zdebug_*` body: `ZLIB`, the size big-endian, then the deflate stream. */
function compress(raw: Uint8Array): Uint8Array {
  const body = zlib.deflateSync(raw);
  const header = Buffer.alloc(12);
  header.write('ZLIB', 0, 'latin1');
  header.writeBigUInt64BE(BigInt(raw.length), 4);
  return new Uint8Array(Buffer.concat([header, body]));
}

test('a compressed debug section is inflated, and a plain one is left alone', () => {
  const raw = new Uint8Array([0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88]);
  const round = sectionBytes(compress(raw));
  assert.deepEqual([...round], [...raw]);

  const plain = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.deepEqual([...sectionBytes(plain)], [...plain]);
});

test('a declared size that disagrees with the stream is not trusted', () => {
  // The body decompresses to 8 bytes; the header claims 99. Reading either one as the
  // size puts every DIE that follows out of step, so the bytes are returned untouched.
  const raw = new Uint8Array([9, 9, 9, 9]);
  const compressed = compress(raw);
  compressed[11] = 99;
  const result = sectionBytes(compressed);
  assert.equal(result[0], 0x5a, 'still the ZLIB magic, not a guess at the contents');
});

test('an image with no debug sections yields null rather than throwing', () => {
  const dwarf = parseDwarf([], () => new Uint8Array(0));
  assert.equal(dwarf, null);
});

test('a signature from the debug information replaces the inferred one', () => {
  // `add rax, rdx; ret` reads two registers, so the inferred signature is two `long`
  // arguments with no names. DWARF says they are `b` and `c`, and that is what has to
  // reach the listing — in the body as well as the declaration.
  const code = new Uint8Array([0x48, 0x01, 0xd0, 0xc3]); // add rax, rdx ; ret
  const inferred = decompileFunction(code, 0x1000, 0x1000, { end: 0x1004, convention: 'sysv' });
  assert.ok(!/\(long b,/.test(inferred.c), `no names without DWARF\n${inferred.c}`);

  const withDwarf = decompileFunction(code, 0x1000, 0x1000, {
    end: 0x1004,
    convention: 'sysv',
    signature: { params: [{ name: 'b', type: 'long' }, { name: 'c', type: 'long' }] },
  });
  assert.match(withDwarf.c, /\(long b, long c\)/, `the recorded names are used\n${withDwarf.c}`);
  assert.match(withDwarf.c, /recorded in the debug information/, `and the header says so\n${withDwarf.c}`);
  // The honesty note belongs only to the inferred case.
  assert.ok(!/inferred from register reads/.test(withDwarf.c), `no false disclaimer\n${withDwarf.c}`);
});

test('signatureAt falls back to the function containing the address', () => {
  // Go sometimes records an entry that is not the table's entry; searching by range is
  // what keeps the signature attached to the body.
  const dwarf = {
    functions: new Map([[0x2000, { name: 'f', lowPc: 0x2000, highPc: 0x2100, params: [], returns: [] }]]),
    types: new Map(),
  };
  assert.equal(signatureAt(dwarf, 0x2000)?.name, 'f', 'exact hit');
  assert.equal(signatureAt(dwarf, 0x2050)?.name, 'f', 'inside the range');
  assert.equal(signatureAt(dwarf, 0x3000), undefined, 'outside it');
});
