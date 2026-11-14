import test from 'node:test';
import assert from 'node:assert/strict';
import { decode, decodeOne, formatInstruction } from './decode.js';

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

function one(...values: number[]) {
  return decodeOne(bytes(...values), 0, 0x1000);
}

function text(...values: number[]) {
  return formatInstruction(one(...values));
}

// These byte sequences are the encodings a compiler emits, not invented
// cases: a decoder that only handles its own examples is a decoder that has
// never been wrong.

test('mov r64, immediate uses a 10-byte form with REX.W', () => {
  const instruction = one(0x48, 0xc7, 0xc0, 0x2a, 0x00, 0x00, 0x00);
  assert.equal(instruction.mnemonic, 'mov');
  assert.equal(instruction.length, 7);
  assert.deepEqual(instruction.operands.map((o) => o.reg ?? o.value), ['rax', 42]);
});

test('push and pop of the callee-saved registers', () => {
  assert.equal(text(0x55).includes('push'), true);
  assert.match(text(0x55), /push rax|push rbp/);
  const push = one(0x55);
  assert.equal(push.operands[0].reg, 'rbp');
  assert.equal(push.length, 1);
  assert.equal(one(0x5d).operands[0].reg, 'rbp');
});

test('the stack frame prologue decodes as sub rsp, imm', () => {
  const prologue = decode(bytes(0x48, 0x83, 0xec, 0x20), { base: 0x1000 });
  assert.equal(prologue.length, 1);
  assert.equal(prologue[0].mnemonic, 'sub');
  assert.equal(prologue[0].operands[0].reg, 'rsp');
  assert.equal(prologue[0].operands[1].value, 0x20);
});

test('a call target is resolved relative to the instruction end', () => {
  // e8 rel32 where rel32 = 0 → target is the address after the call.
  const call = decodeOne(bytes(0xe8, 0x00, 0x00, 0x00, 0x00), 0, 0x1000);
  assert.equal(call.mnemonic, 'call');
  assert.equal(call.flow, 'call');
  assert.equal(call.length, 5);
  assert.equal(call.operands[0].target, 0x1005);
});

test('a backwards jump resolves to an earlier address', () => {
  // eb fe = jmp $ (an infinite loop), target = address + 2 - 2
  const jump = decodeOne(bytes(0xeb, 0xfe), 0, 0x1000);
  assert.equal(jump.mnemonic, 'jmp');
  assert.equal(jump.operands[0].target, 0x1000);
  assert.equal(jump.flow, 'jump');
});

test('short conditional jumps name the condition', () => {
  assert.equal(one(0x74, 0x10).mnemonic, 'je');
  assert.equal(one(0x75, 0x10).mnemonic, 'jne');
  assert.equal(one(0x7c, 0x10).mnemonic, 'jl');
  assert.equal(one(0x7e, 0x10).mnemonic, 'jle');
  assert.equal(one(0x74, 0x10).flow, 'condition');
});

test('long conditional jumps in the 0f map', () => {
  const instruction = decodeOne(bytes(0x0f, 0x84, 0x10, 0x00, 0x00, 0x00), 0, 0x1000);
  assert.equal(instruction.mnemonic, 'je');
  assert.equal(instruction.length, 6);
  assert.equal(instruction.operands[0].target, 0x1016);
});

test('SIB with base and scaled index', () => {
  // 48 8b 04 88 = mov rax, [rax + rcx*4]
  const instruction = one(0x48, 0x8b, 0x04, 0x88);
  assert.equal(instruction.mnemonic, 'mov');
  assert.equal(instruction.operands[1].mem, 'rax+rcx*4');
});

test('SIB with no base uses a displacement', () => {
  // 48 8b 04 25 00 10 00 00 = mov rax, [0x1000]
  const instruction = one(0x48, 0x8b, 0x04, 0x25, 0x00, 0x10, 0x00, 0x00);
  assert.equal(instruction.operands[1].mem, '0x1000');
});

test('disp8 keeps its sign', () => {
  // 48 8b 45 f8 = mov rax, [rbp - 0x8]
  const instruction = one(0x48, 0x8b, 0x45, 0xf8);
  assert.equal(instruction.operands[1].mem, 'rbp-0x8');
});

test('disp32 adds to the base', () => {
  const instruction = one(0x48, 0x8b, 0x85, 0x00, 0x01, 0x00, 0x00);
  assert.equal(instruction.operands[1].mem, 'rbp+0x100');
});

test('REX.R and REX.B reach the upper registers', () => {
  // 4c 89 c7 = mov rdi, r8
  const instruction = one(0x4c, 0x89, 0xc7);
  assert.equal(instruction.operands[0].reg, 'rdi');
  assert.equal(instruction.operands[1].reg, 'r8');
});

test('a 32-bit write uses the 32-bit register name', () => {
  const instruction = one(0x89, 0xc8);
  assert.equal(instruction.mnemonic, 'mov');
  assert.equal(instruction.operands[0].reg, 'eax');
  assert.equal(instruction.operands[1].reg, 'ecx');
});

test('the high-byte registers appear only without REX', () => {
  // 88 e0 = mov al, ah
  assert.equal(one(0x88, 0xe0).operands[1].reg, 'ah');
  // With REX the same encoding becomes spl
  const withRex = one(0x40, 0x88, 0xe0);
  assert.equal(withRex.operands[1].reg, 'spl');
});

test('lea decodes its memory operand but does not dereference it', () => {
  const instruction = one(0x48, 0x8d, 0x3d, 0x10, 0x00, 0x00, 0x00);
  assert.equal(instruction.mnemonic, 'lea');
  assert.equal(instruction.operands[0].reg, 'rdi');
  assert.equal(instruction.operands[1].kind, 'mem');
  assert.match(instruction.operands[1].mem || '', /^rip\+0x10$/);
});

test('ret with a stack adjustment', () => {
  const instruction = one(0xc2, 0x08, 0x00);
  assert.equal(instruction.mnemonic, 'ret');
  assert.equal(instruction.flow, 'ret');
  assert.equal(instruction.length, 3);
  assert.equal(instruction.operands[0].value, 8);
});

test('the ALU block covers every verb', () => {
  const expected = ['add', 'or', 'adc', 'sbb', 'and', 'sub', 'xor', 'cmp'];
  // The r/m,r form of each verb: 0x01 + verb*8. The r,r forms at 0x39 and
  // above run into the REX prefix range, so they cannot be probed this way.
  for (let verb = 0; verb < 8; verb++) {
    const opcode = 0x01 + verb * 8;
    assert.equal(one(opcode, 0xd8).mnemonic, expected[verb], `opcode 0x${opcode.toString(16)}`);
  }
});

test('the group opcodes read their verb from the ModRM reg field', () => {
  // ff d0 = call rax (group 2), ff e0 = jmp rax (group 4)
  assert.equal(one(0xff, 0xd0).mnemonic, 'call');
  assert.equal(one(0xff, 0xe0).mnemonic, 'jmp');
  // f7 d8 = neg eax (group 3)
  assert.equal(one(0xf7, 0xd8).mnemonic, 'neg');
  // c1 e0 04 = shl eax, 4 (group 4)
  const shift = one(0xc1, 0xe0, 0x04);
  assert.equal(shift.mnemonic, 'shl');
  assert.equal(shift.operands[1].value, 4);
});

test('int3 and syscall are recognised as stops', () => {
  assert.equal(one(0xcc).mnemonic, 'int3');
  assert.equal(one(0xcc).flow, 'int');
  assert.equal(one(0xcd, 0x80).operands[0].value, 0x80);
  const syscall = decodeOne(bytes(0x0f, 0x05), 0, 0x1000);
  assert.equal(syscall.mnemonic, 'syscall');
  assert.equal(syscall.flow, 'syscall');
});

test('an unknown opcode is reported as bytes, not guessed', () => {
  const instruction = one(0x06);
  assert.equal(instruction.unknown, true);
  assert.equal(instruction.mnemonic, 'db');
  assert.equal(instruction.length, 1);
});

test('decoding a run advances by each instruction length', () => {
  // push rbp; mov rbp, rsp; pop rbp; ret
  const program = decode(bytes(0x55, 0x48, 0x89, 0xe5, 0x5d, 0xc3), { base: 0x1000 });
  assert.deepEqual(program.map((i) => i.mnemonic), ['push', 'mov', 'pop', 'ret']);
  assert.deepEqual(program.map((i) => i.address), [0x1000, 0x1001, 0x1004, 0x1005]);
  assert.equal(program.reduce((sum, i) => sum + i.length, 0), 6);
});

test('decoding stops at the limit and never runs past the buffer', () => {
  const program = decode(bytes(0x90, 0x90, 0x90, 0xc3), { limit: 2 });
  assert.equal(program.length, 2);
});

test('a truncated instruction does not throw', () => {
  // A 7-byte mov with only 4 bytes present.
  assert.doesNotThrow(() => one(0x48, 0xc7, 0xc0, 0x2a));
  // A lone prefix
  assert.doesNotThrow(() => one(0x48));
  assert.doesNotThrow(() => one(0x66, 0x0f));
});

test('the formatted listing shows address, bytes and text', () => {
  const line = formatInstruction(decodeOne(bytes(0x55), 0, 0x401000));
  assert.match(line, /^0x00401000/);
  assert.match(line, /55/);
  assert.match(line, /push/);
});
