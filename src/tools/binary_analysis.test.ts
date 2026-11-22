/**
 * The parts of `binary_analyze` that can be checked without a binary.
 *
 * `compare` runs two decompilations and puts the strings side by side, which no unit test
 * can assert much about. What it does beyond that is count the parameters each listing
 * declares, and that is a judgement about text — the difference between `1` and `7` is the
 * whole point of the comparison, so the counting has to be right.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parameterCountOf } from './binary_analysis.js';

test('a signature with parameters is counted', () => {
  const listing = 'void internal_abi_BoundsDecode(int v, int code, bool signed)\n\n{\n  return;\n}';
  assert.equal(parameterCountOf(listing), 3);
});

test('a single parameter is one, not zero', () => {
  // The comparison that motivated this: the built-in listing says `long arg0` and the
  // external one says seven parameters. Reporting 0 for a one-parameter function would
  // make the difference look larger than it is.
  assert.equal(parameterCountOf('long internal_abi_BoundsDecode(long arg0)\n{'), 1);
});

test('a prototype is not mistaken for the signature of a function with no parameters', () => {
  // `long runtime_gopanic();` is a declaration the listing emits for a callee. It is
  // `void`-like in that it has no parameters, and counting it as the signature would
  // report 0 for a function that takes seven.
  const listing = [
    'long runtime_gopanic();',
    '',
    'void internal_abi_BoundsDecode(int v, int code)',
    '{',
    '}',
  ].join('\n');
  assert.equal(parameterCountOf(listing), 2);
});

test('a listing with no signature at all reports null', () => {
  assert.equal(parameterCountOf('/* decompile failed */'), null);
});

test('void and empty parentheses both mean no parameters', () => {
  assert.equal(parameterCountOf('long f(void)\n{'), 0);
  assert.equal(parameterCountOf('long f()\n{'), 0);
});

test('a multi-line signature is still counted', () => {
  // The external listing wraps its parameter list; the count must survive the newline.
  const listing = 'void internal_abi_BoundsDecode\n               (int v,int code,bool signed)\n\n{';
  assert.equal(parameterCountOf(listing), 3);
});
