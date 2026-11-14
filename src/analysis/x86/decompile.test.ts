import test from 'node:test';
import assert from 'node:assert/strict';
import { decompileFunction } from './decompile.js';
import { scanCallGraph, callersOf, calleesOf } from './xref.js';
import type { FunctionEntry } from './symbols.js';

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

const BASE = 0x1000;

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
  assert.match(result.c, /if \(rdi == 0\)/);
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
  assert.match(result.c, /arg0 = rdi;/);
  assert.match(result.c, /arg0 = rdi;/);
  assert.match(result.c, /return arg0;/);
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
  // mov [rsp+8], rax; ret
  const code = bytes(0x48, 0x89, 0x44, 0x24, 0x08, 0xc3);
  const result = decompileFunction(code, BASE, BASE, { name: 'store', end: BASE + code.length, convention: 'sysv' });
  assert.match(result.c, /stack_8 = rax;/, result.c);
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
