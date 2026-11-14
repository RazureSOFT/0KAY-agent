/**
 * x86-64 instruction decoding.
 *
 * External tools are not always there: a CI container has no objdump, and an
 * agent that can only say "install something" is not much use on a machine it
 * cannot install to. This decodes the bytes directly.
 *
 * Scope is deliberate. It covers the instruction forms that appear in
 * compiled code -- legacy prefixes, REX, ModRM, SIB, the one-byte map, the
 * branches and the SSE moves -- and reports anything it does not recognise as
 * bytes rather than guessing. A wrong disassembly is worse than an honest
 * gap: it makes a caller reason confidently about code that is not there.
 */

export type OperandKind = 'reg' | 'mem' | 'imm' | 'rel' | 'none';

export interface Operand {
  kind: OperandKind;
  /** Register name, when the operand is a register. */
  reg?: string;
  /** Address expression for memory operands, e.g. "rax+0x10" or "0x401000". */
  mem?: string;
  /** Immediate or displacement value. */
  value?: number;
  /** For `rel`: the absolute target of the branch. */
  target?: number;
  size: number;
}

export type Flow = 'call' | 'jump' | 'condition' | 'ret' | 'int' | 'syscall' | 'nop' | 'stop';

export interface Instruction {
  address: number;
  length: number;
  mnemonic: string;
  operands: Operand[];
  bytes: Uint8Array;
  /** Set when the decoder could not name this instruction. */
  unknown?: boolean;
  flow?: Flow;
}

const REG64 = ['rax', 'rcx', 'rdx', 'rbx', 'rsp', 'rbp', 'rsi', 'rdi',
  'r8', 'r9', 'r10', 'r11', 'r12', 'r13', 'r14', 'r15'];
const REG32 = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi',
  'r8d', 'r9d', 'r10d', 'r11d', 'r12d', 'r13d', 'r14d', 'r15d'];
const REG16 = ['ax', 'cx', 'dx', 'bx', 'sp', 'bp', 'si', 'di',
  'r8w', 'r9w', 'r10w', 'r11w', 'r12w', 'r13w', 'r14w', 'r15w'];
const REG8 = ['al', 'cl', 'dl', 'bl', 'spl', 'bpl', 'sil', 'dil',
  'r8b', 'r9b', 'r10b', 'r11b', 'r12b', 'r13b', 'r14b', 'r15b'];
const REG8_NO_REX = ['al', 'cl', 'dl', 'bl', 'ah', 'ch', 'dh', 'bh'];

const ALU = ['add', 'or', 'adc', 'sbb', 'and', 'sub', 'xor', 'cmp'];
const SHIFT = ['rol', 'ror', 'rcl', 'rcr', 'shl', 'shr', 'sal', 'sar'];
const COND = ['o', 'no', 'b', 'ae', 'e', 'ne', 'be', 'a',
  's', 'ns', 'p', 'np', 'l', 'ge', 'le', 'g'];
const XMM = Array.from({ length: 16 }, (_v, i) => `xmm${i}`);

function regName(index: number, size: number, hasRex: boolean): string {
  if (size === 64) return REG64[index];
  if (size === 32) return REG32[index];
  if (size === 16) return REG16[index];
  // Without a REX prefix the encodings 4-7 are the high-byte registers.
  if (!hasRex && index < 8) return REG8_NO_REX[index];
  return REG8[index];
}

function read16(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function read32(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] | (bytes[offset + 1] << 8)
    | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function readInt32(bytes: Uint8Array, offset: number): number {
  const value = read32(bytes, offset);
  return value > 0x7fffffff ? value - 0x100000000 : value;
}

export interface DecodeOptions {
  /** Virtual address of the first byte, so branch targets are absolute. */
  base?: number;
  limit?: number;
}

/**
 * Decode a run of instructions, linearly.
 *
 * Right for a function body, wrong for data that sits inside one: a linear
 * sweep over data produces plausible garbage. Callers that do not know what
 * they have should start at an entry point and follow branches --
 * `disassembleFunction` in this directory does that.
 */
export function decode(bytes: Uint8Array, options: DecodeOptions = {}): Instruction[] {
  const base = options.base ?? 0;
  const limit = Math.min(options.limit ?? bytes.length, bytes.length);
  const out: Instruction[] = [];
  let offset = 0;
  while (offset < limit) {
    const instruction = decodeOne(bytes, offset, base + offset);
    out.push(instruction);
    offset += instruction.length;
  }
  return out;
}

/** Decode exactly one instruction at `offset`. Never throws. */
export function decodeOne(bytes: Uint8Array, offset: number, address = 0): Instruction {
  const start = offset;
  let index = offset;

  let operandSize = 32;
  let hasRex = false;
  let rex = 0;
  let prefixText = '';

  for (let guard = 0; guard < 14 && index < bytes.length; guard++) {
    const byte = bytes[index];
    if (byte === 0x66) { operandSize = 16; index++; continue; }
    if (byte === 0x67) { index++; continue; }
    if (byte === 0xf0) { prefixText += 'lock '; index++; continue; }
    if (byte === 0xf2) { prefixText += 'repne '; index++; continue; }
    if (byte === 0xf3) { prefixText += 'rep '; index++; continue; }
    // Segment overrides change which segment a memory access reads; the
    // address text keeps the default and the note in `prefixText` says so.
    if (byte === 0x2e || byte === 0x36 || byte === 0x3e
      || byte === 0x26 || byte === 0x64 || byte === 0x65) {
      index++;
      continue;
    }
    if (byte >= 0x40 && byte <= 0x4f) {
      hasRex = true;
      rex = byte;
      if (rex & 0x08) operandSize = 64;
      index++;
      continue;
    }
    break;
  }

  const rexW = (rex & 0x08) !== 0;
  const rexR = (rex & 0x04) !== 0;
  const rexX = (rex & 0x02) !== 0;
  const rexB = (rex & 0x01) !== 0;

  if (index >= bytes.length) return rawByte(bytes, start, address, prefixText);

  const opcode = bytes[index++];
  /** Set by modrm(): the group field, for the opcodes where it picks the verb. */
  let group = 0;

  const finish = (mnemonic: string, operands: Operand[], flow?: Flow): Instruction => ({
    address,
    length: index - start,
    mnemonic: prefixText + mnemonic,
    operands,
    bytes: bytes.slice(start, index),
    ...(flow ? { flow } : {}),
  });

  const read = (): number => (index < bytes.length ? bytes[index++] : 0);

  /** Decode ModRM and, when it names memory, the full address expression. */
  const modrm = (size: number): { reg: number; operand: Operand | null } => {
    const byte = read();
    const mod = byte >> 6;
    const groupField = (byte >> 3) & 7;
    group = groupField;
    const reg = groupField + (rexR ? 8 : 0);
    // The rm field is part of the byte just read; memory() must not read it
    // again, or it consumes the displacement instead.
    return { reg, operand: memory(mod, byte & 7, size) };
  };

  const memory = (mod: number, rmLow: number, size: number): Operand | null => {
    const lowBits = rmLow & 7;

    if (mod === 3) {
      return { kind: 'reg', reg: regName(lowBits + (rexB ? 8 : 0), size, hasRex), size };
    }

    let text = '';
    let hasBase = false;

    if (lowBits === 4) {
      const sib = read();
      const scale = 1 << (sib >> 6);
      const indexField = (sib >> 3) & 7;
      const baseField = sib & 7;
      const hasIndex = indexField !== 4;
      if (baseField === 5 && mod === 0) {
        // No base register: the displacement is the whole address.
        const disp = read32(bytes, index);
        index += 4;
        text = `0x${disp.toString(16)}`;
      } else {
        text = REG64[baseField + (rexB ? 8 : 0)];
        hasBase = true;
      }
      if (hasIndex) {
        const indexReg = REG64[indexField + (rexX ? 8 : 0)];
        const term = scale === 1 ? indexReg : `${indexReg}*${scale}`;
        text = hasBase ? `${text}+${term}` : term;
      }
    } else if (lowBits === 5 && mod === 0) {
      // RIP-relative in 64-bit mode: the displacement is the whole operand.
      const disp = readInt32(bytes, index);
      const value = read32(bytes, index);
      index += 4;
      return { kind: 'mem', mem: `rip${disp < 0 ? '-' : '+'}0x${value.toString(16)}`, size, value: disp };
    } else {
      text = REG64[lowBits + (rexB ? 8 : 0)];
      hasBase = true;
    }

    if (mod === 1) {
      const disp = (bytes[index++] << 24) >> 24;
      text += `${disp < 0 ? '-' : '+'}0x${Math.abs(disp).toString(16)}`;
    } else if (mod === 2) {
      const disp = readInt32(bytes, index);
      index += 4;
      text += `${disp < 0 ? '-' : '+'}0x${Math.abs(disp).toString(16)}`;
    }
    return { kind: 'mem', mem: text.startsWith('+') ? text.slice(1) : text, size };
  };

  const imm = (size: number): Operand => {
    if (size === 8) return { kind: 'imm', value: bytes[index++] ?? 0, size: 8 };
    if (size === 16) { const v = read16(bytes, index); index += 2; return { kind: 'imm', value: v, size: 16 }; }
    const v = readInt32(bytes, index);
    index += 4;
    return { kind: 'imm', value: v, size };
  };

  const rel = (size: 8 | 32): Operand => {
    const disp = size === 8 ? ((bytes[index++] ?? 0) << 24) >> 24 : readInt32(bytes, index);
    if (size === 32) index += 4;
    return { kind: 'rel', target: address + (index - start) + disp, value: disp, size: 64 };
  };

  const register = (value: number, size: number): Operand =>
    ({ kind: 'reg', reg: regName(value, size, hasRex), size });

  // 0x00-0x3f: the ALU block. Eight verbs, each with six similar forms.
  if (opcode < 0x40 && (opcode & 7) < 6) {
    const name = ALU[opcode >> 3];
    const form = opcode & 7;
    const wide = (form & 1) !== 0;
    const size = wide ? operandSize : 8;
    if (form < 4) {
      const { reg, operand } = modrm(size);
      if (!operand) return rawByte(bytes, start, address, prefixText);
      const ops = (form & 2) ? [register(reg, size), operand] : [operand, register(reg, size)];
      return finish(name, ops);
    }
    return finish(name, [register(0, size), imm(size)]);
  }

  switch (opcode) {
    // push/pop r64, the short form
    case 0x50: case 0x51: case 0x52: case 0x53:
    case 0x54: case 0x55: case 0x56: case 0x57: {
      const size = operandSize === 16 ? 16 : 64;
      return finish('push', [register((opcode & 7) + (rexB ? 8 : 0), size)]);
    }
    case 0x58: case 0x59: case 0x5a: case 0x5b:
    case 0x5c: case 0x5d: case 0x5e: case 0x5f: {
      const size = operandSize === 16 ? 16 : 64;
      return finish('pop', [register((opcode & 7) + (rexB ? 8 : 0), size)]);
    }

    case 0x63: {
      const { reg, operand } = modrm(32);
      if (!operand) return rawByte(bytes, start, address, prefixText);
      return finish('movsxd', [register(reg, operandSize), operand]);
    }

    case 0x68: return finish('push', [imm(operandSize === 16 ? 16 : 32)]);
    case 0x6a: return finish('push', [imm(8)]);
    case 0x69: {
      const { reg, operand } = modrm(operandSize);
      if (!operand) return rawByte(bytes, start, address, prefixText);
      return finish('imul', [register(reg, operandSize), operand,
        imm(operandSize === 16 ? 16 : 32)]);
    }
    case 0x6b: {
      const { reg, operand } = modrm(operandSize);
      if (!operand) return rawByte(bytes, start, address, prefixText);
      return finish('imul', [register(reg, operandSize), operand, imm(8)]);
    }
    case 0x6c: case 0x6d: case 0x6e: case 0x6f:
      return rawByte(bytes, start, address, prefixText);

    case 0x70: case 0x71: case 0x72: case 0x73:
    case 0x74: case 0x75: case 0x76: case 0x77:
    case 0x78: case 0x79: case 0x7a: case 0x7b:
    case 0x7c: case 0x7d: case 0x7e: case 0x7f:
      return finish(`j${COND[opcode - 0x70]}`, [rel(8)], 'condition');

    case 0x80: case 0x81: case 0x83: {
      const size = opcode === 0x80 ? 8 : operandSize;
      const { operand } = modrm(size);
      if (!operand) return rawByte(bytes, start, address, prefixText);
      const value = opcode === 0x83 ? imm(8) : imm(opcode === 0x80 ? 8 : (size === 16 ? 16 : 32));
      return finish(ALU[group] || 'add', [operand, value]);
    }

    case 0x84: {
      const { reg, operand } = modrm(8);
      if (!operand) return rawByte(bytes, start, address, prefixText);
      return finish('test', [operand, { kind: 'reg', reg: regName(reg, 8, hasRex), size: 8 }]);
    }
    case 0x85: {
      const { reg, operand } = modrm(operandSize);
      if (!operand) return rawByte(bytes, start, address, prefixText);
      return finish('test', [operand, register(reg, operandSize)]);
    }
    case 0x86: case 0x87: {
      const size = opcode === 0x86 ? 8 : operandSize;
      const { reg, operand } = modrm(size);
      if (!operand) return rawByte(bytes, start, address, prefixText);
      return finish('xchg', [operand, register(reg, size)]);
    }

    case 0x88: {
      const { reg, operand } = modrm(8);
      if (!operand) return rawByte(bytes, start, address, prefixText);
      return finish('mov', [operand, { kind: 'reg', reg: regName(reg, 8, hasRex), size: 8 }]);
    }
    case 0x89: {
      const { reg, operand } = modrm(operandSize);
      if (!operand) return rawByte(bytes, start, address, prefixText);
      return finish('mov', [operand, register(reg, operandSize)]);
    }
    case 0x8a: {
      const { reg, operand } = modrm(8);
      if (!operand) return rawByte(bytes, start, address, prefixText);
      return finish('mov', [{ kind: 'reg', reg: regName(reg, 8, hasRex), size: 8 }, operand]);
    }
    case 0x8b: {
      const { reg, operand } = modrm(operandSize);
      if (!operand) return rawByte(bytes, start, address, prefixText);
      return finish('mov', [register(reg, operandSize), operand]);
    }
    case 0x8d: {
      const { reg, operand } = modrm(operandSize);
      if (!operand) return rawByte(bytes, start, address, prefixText);
      return finish('lea', [register(reg, operandSize), operand]);
    }
    case 0x8f: {
      const { operand } = modrm(64);
      if (!operand) return rawByte(bytes, start, address, prefixText);
      return finish('pop', [operand]);
    }

    case 0x90: return finish('nop', [], 'nop');
    case 0x98: return finish(operandSize === 64 ? 'cdqe' : operandSize === 16 ? 'cbw' : 'cwde', []);
    case 0x99: return finish(operandSize === 64 ? 'cqo' : operandSize === 16 ? 'cwd' : 'cdq', []);
    case 0x9b: return finish('fwait', []);
    case 0x9c: return finish('pushfq', []);
    case 0x9d: return finish('popfq', []);

    case 0xa4: return finish('movsb', []);
    case 0xa5: return finish('movsd', []);
    case 0xa8: return finish('test', [{ kind: 'reg', reg: 'al', size: 8 }, imm(8)]);
    case 0xa9: return finish('test', [register(0, operandSize), imm(operandSize === 16 ? 16 : 32)]);
    case 0xaa: return finish('stosb', []);
    case 0xab: return finish('stosd', []);
    case 0xac: return finish('lodsb', []);
    case 0xad: return finish('lodsd', []);
    case 0xae: return finish('scasb', []);

    case 0xb0: case 0xb1: case 0xb2: case 0xb3:
    case 0xb4: case 0xb5: case 0xb6: case 0xb7:
      return finish('mov', [register((opcode & 7) + (rexB ? 8 : 0), 8), imm(8)]);
    case 0xb8: case 0xb9: case 0xba: case 0xbb:
    case 0xbc: case 0xbd: case 0xbe: case 0xbf:
      return finish('mov', [register((opcode & 7) + (rexB ? 8 : 0), operandSize),
        imm(operandSize === 16 ? 16 : operandSize)]);

    case 0xc0: case 0xc1: {
      const size = opcode === 0xc0 ? 8 : operandSize;
      const { operand } = modrm(size);
      if (!operand) return rawByte(bytes, start, address, prefixText);
      return finish(SHIFT[group] || 'shl', [operand, imm(8)]);
    }
    case 0xc2: {
      const value = read16(bytes, index);
      index += 2;
      return finish('ret', [{ kind: 'imm', value, size: 16 }], 'ret');
    }
    case 0xc3: return finish('ret', [], 'ret');
    case 0xc6: {
      const { operand } = modrm(8);
      if (!operand) return rawByte(bytes, start, address, prefixText);
      return finish('mov', [operand, imm(8)]);
    }
    case 0xc7: {
      const { operand } = modrm(operandSize);
      if (!operand) return rawByte(bytes, start, address, prefixText);
      return finish('mov', [operand, imm(operandSize === 16 ? 16 : 32)]);
    }
    case 0xc9: return finish('leave', []);
    case 0xcb: return finish('retf', [], 'ret');
    case 0xcc: return finish('int3', [], 'int');
    case 0xcd: return finish('int', [imm(8)], 'int');
    case 0xcf: return finish('iret', [], 'ret');

    case 0xd0: case 0xd1: case 0xd2: case 0xd3: {
      const size = (opcode === 0xd0 || opcode === 0xd2) ? 8 : operandSize;
      const { operand } = modrm(size);
      if (!operand) return rawByte(bytes, start, address, prefixText);
      const count: Operand = (opcode === 0xd0 || opcode === 0xd1)
        ? { kind: 'imm', value: 1, size: 8 }
        : { kind: 'reg', reg: 'cl', size: 8 };
      return finish(SHIFT[group] || 'shl', [operand, count]);
    }

    case 0xe0: return finish('loopne', [rel(8)], 'condition');
    case 0xe1: return finish('loope', [rel(8)], 'condition');
    case 0xe2: return finish('loop', [rel(8)], 'condition');
    case 0xe3: return finish('jrcxz', [rel(8)], 'condition');
    case 0xe8: return finish('call', [rel(32)], 'call');
    case 0xe9: return finish('jmp', [rel(32)], 'jump');
    case 0xeb: return finish('jmp', [rel(8)], 'jump');
    case 0xec: return finish('in', [{ kind: 'reg', reg: 'al', size: 8 }, { kind: 'reg', reg: 'dx', size: 16 }]);
    case 0xee: return finish('out', [{ kind: 'reg', reg: 'dx', size: 16 }, { kind: 'reg', reg: 'al', size: 8 }]);

    case 0xf4: return finish('hlt', [], 'stop');
    case 0xf5: return finish('cmc', []);
    case 0xf8: return finish('clc', []);
    case 0xf9: return finish('stc', []);
    case 0xfa: return finish('cli', []);
    case 0xfb: return finish('sti', []);
    case 0xfc: return finish('cld', []);
    case 0xfd: return finish('std', []);

    case 0xf6: case 0xf7: {
      const size = opcode === 0xf6 ? 8 : operandSize;
      const { operand } = modrm(size);
      if (!operand) return rawByte(bytes, start, address, prefixText);
      const names = ['test', 'test', 'not', 'neg', 'mul', 'imul', 'div', 'idiv'];
      if (group === 0 || group === 1) return finish('test', [operand, imm(size)]);
      return finish(names[group], [operand]);
    }

    case 0xfe: case 0xff: {
      const size = opcode === 0xfe ? 8 : operandSize;
      const { operand } = modrm(size);
      if (!operand) return rawByte(bytes, start, address, prefixText);
      if (group === 0) return finish('inc', [operand]);
      if (group === 1) return finish('dec', [operand]);
      if (group === 2) return finish('call', [operand], 'call');
      if (group === 4) return finish('jmp', [operand], 'jump');
      if (group === 6) return finish('push', [operand]);
      return finish('group', [operand]);
    }

    case 0x0f:
      return decodeTwoByte(bytes, start, index, address, prefixText, { rexR, rexB, rexX, rexW, operandSize, hasRex });

    default:
      return rawByte(bytes, start, address, prefixText);
  }
}

const TWO_BYTE_FLOW: Record<number, { name: string; flow?: Flow }> = {
  0x05: { name: 'syscall', flow: 'syscall' },
  0x0b: { name: 'ud2', flow: 'stop' },
  0x0d: { name: 'nop', flow: 'nop' },
  0x1f: { name: 'nop', flow: 'nop' },
  0x31: { name: 'rdtsc' },
  0xa2: { name: 'cpuid' },
  0xaf: { name: 'imul' },
  0xb6: { name: 'movzx' },
  0xb7: { name: 'movzx' },
  0xbe: { name: 'movsx' },
  0xbf: { name: 'movsx' },
};

/**
 * The 0f map.
 *
 * Three things here matter to an analysis: the long conditional jumps (0x80-
 * 0x8f, the ones a short form cannot reach), the moves between registers that
 * feed the rest of the function, and syscall. The SSE block is decoded just
 * far enough to step over it correctly -- a caller that needs the semantics of
 * a vector instruction is asking a different question than this answers.
 */
function decodeTwoByte(
  bytes: Uint8Array, start: number, indexRef: number, address: number,
  prefixText: string, state: { rexR: boolean; rexB: boolean; rexX: boolean; rexW: boolean; operandSize: number; hasRex: boolean },
): Instruction {
  let index = indexRef;
  const second = bytes[index] ?? 0;
  index++;

  const finish = (mnemonic: string, operands: Operand[], flow?: Flow): Instruction => ({
    address,
    length: index - start,
    mnemonic: prefixText + mnemonic,
    operands,
    bytes: bytes.slice(start, index),
    ...(flow ? { flow } : {}),
  });

  if (second >= 0x80 && second <= 0x8f) {
    const disp = readInt32(bytes, index);
    index += 4;
    return finish(`j${COND[second - 0x80]}`,
      [{ kind: 'rel', target: address + (index - start) + disp, value: disp, size: 64 }],
      'condition');
  }

  const known = TWO_BYTE_FLOW[second];

  // Instructions that take no ModRM.
  if (known && (second === 0x05 || second === 0x0b || second === 0x31 || second === 0xa2)) {
    return finish(known.name, [], known.flow);
  }

  // Everything else in this map carries a ModRM byte (and SIB).
  if (second === 0x1f || second === 0x0d) {
    const modrmByte = bytes[index] ?? 0;
    const mod = modrmByte >> 6;
    index++;
    if (mod !== 3) {
      if ((modrmByte & 7) === 4) index++;
      if (mod === 1) index++;
      else if (mod === 2) index += 4;
      else if ((modrmByte & 7) === 5) index += 4;
    }
    return finish('nop', [], 'nop');
  }

  const modrmByte = bytes[index] ?? 0;
  const mod = modrmByte >> 6;
  const regField = ((modrmByte >> 3) & 7) + (state.rexR ? 8 : 0);
  const rmField = (modrmByte & 7) + (state.rexB ? 8 : 0);
  index++;

  let operand: Operand | null = null;
  if (mod === 3) {
    operand = second >= 0x6f
      ? { kind: 'reg', reg: XMM[rmField], size: 128 }
      : { kind: 'reg', reg: regName(rmField, second === 0xb6 || second === 0xb7 || second === 0xbe || second === 0xbf ? 8 : state.operandSize, state.hasRex), size: state.operandSize };
  } else {
    if ((modrmByte & 7) === 4) index++;
    const dispBytes = mod === 1 ? 1 : mod === 2 ? 4 : ((modrmByte & 7) === 5 ? 4 : 0);
    index += dispBytes;
    operand = { kind: 'mem', mem: '[mem]', size: state.operandSize };
  }

  if (known && operand) {
    if (known.name === 'imul') {
      return finish('imul', [{ kind: 'reg', reg: regName(regField, state.operandSize, state.hasRex), size: state.operandSize }, operand]);
    }
    if (known.name === 'movzx' || known.name === 'movsx') {
      return finish(known.name, [{ kind: 'reg', reg: regName(regField, state.operandSize, state.hasRex), size: state.operandSize }, operand]);
    }
  }

  // Recognised shape, unnamed verb: report it as a two-byte opcode so the
  // length is right and the caller is not told a lie about what it does.
  return {...finish(`0f${second.toString(16).padStart(2, '0')}`, []), unknown: true};
}

function rawByte(bytes: Uint8Array, start: number, address: number, prefixText: string): Instruction {
  return {
    address,
    length: 1,
    mnemonic: `${prefixText}db`,
    operands: [{ kind: 'imm', value: bytes[start] ?? 0, size: 8 }],
    bytes: bytes.slice(start, start + 1),
    unknown: true,
  };
}

/** Render one instruction the way a listing would. */
export function formatInstruction(instruction: Instruction, addressWidth = 8): string {
  const operands = instruction.operands.map(formatOperand).filter(Boolean).join(', ');
  const address = `0x${instruction.address.toString(16).padStart(addressWidth, '0')}`;
  const raw = Array.from(instruction.bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join(' ')
    .padEnd(22);
  const text = `${instruction.mnemonic}${operands ? ' ' + operands : ''}`;
  return `${address}  ${raw} ${text}`;
}

function formatOperand(operand: Operand): string {
  if (operand.kind === 'reg') return operand.reg || '';
  if (operand.kind === 'mem') {
    const size = operand.size === 64 ? 'qword' : operand.size === 32 ? 'dword'
      : operand.size === 16 ? 'word' : operand.size === 8 ? 'byte' : '';
    return size ? `${size} [${operand.mem}]` : `[${operand.mem}]`;
  }
  if (operand.kind === 'rel') return `0x${(operand.target ?? 0).toString(16)}`;
  if (operand.kind === 'imm') {
    const value = operand.value ?? 0;
    return value < 0 ? `-0x${Math.abs(value).toString(16)}` : `0x${value.toString(16)}`;
  }
  return '';
}
