/**
 * The external decompiler adapter.
 *
 * These tests never require an install: the point of the module is that it works whether
 * or not one is present, and a test that needed a 900 MB download would not run. What is
 * checked is the part that goes wrong on a machine without one — the search, and the
 * decision to return null instead of throwing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { findGhidra, decompileWithGhidra } from './ghidra.js';

test('a directory with no install under it yields null, not an exception', async () => {
  const found = await findGhidra('D:/this/path/does/not/exist');
  // The search also covers the default roots, so an install on this machine is a valid
  // answer; what must never happen is a throw.
  assert.ok(found === null || typeof found.root === 'string', String(found));
});

test('decompiling without an install returns null', async () => {
  // `location` is deliberately a directory with no `support/` in it. The adapter must
  // report nothing rather than fail the caller, which falls back to the built-in reader.
  const result = await decompileWithGhidra({
    location: { root: 'D:/this/path/does/not/exist', launcher: 'D:/this/path/does/not/exist/analyzeHeadless' },
    binary: 'D:/this/path/does/not/exist/a.exe',
    address: 0x1000,
    projectRoot: 'D:/this/path/does/not/exist/proj',
    timeoutMs: 2000,
  });
  assert.equal(result, null);
});
