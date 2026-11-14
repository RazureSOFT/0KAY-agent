/**
 * A reading aid, not a decompiler and not compilable C. It names registers,
 * turns the common arithmetic into assignments, and renders branches as
 * gotos. Anything it cannot express stays as an inline assembly comment, so
 * the output never quietly drops instructions.
 */
import { formatInstruction } from './decode.js';
import type { Instruction, Operand } from './decode.js';
import type { DisassembledFunction } from './function.js';
import type { BasicBlock } from './cfg.js';

const CONDITION: Record<string, string> = {
  je: '==', jz: '==', jne: '!=', jnz: '!=',
  ja: '> (unsigned)', jnbe: '> (unsigned)', jae: '>= (unsigned)', jnb: '>= (unsigned)',
  jb: '< (unsigned)', jnae: '< (unsigned)', jbe: '<= (unsigned)', jna: '<= (unsigned)',
  jg: '>', jnle: '>', jge: '>=', jnl: '>=',
  jl: '<', jnge: '<', jle: '<=', jng: '<=',
  js: '< 0 (sign)', jns: '>= 0 (sign)', jo: 'overflow', jno: '!overflow',
  jp: 'parity', jnp: '!parity', jc: 'carry', jnc: '!carry',
};

const BINARY: Record<string, string> = {
  add: '+=', sub: '-=', and: '&=', or: '|=', xor: '^=', shl: '<<=', shr: '>>=', sar: '>>=',
};

function operandText(operand: Operand): string {
  switch (operand.kind) {
    case 'reg': return operand.reg || '?';
    case 'imm': return `0x${(operand.value ?? 0).toString(16)}`;
    case 'rel': return `0x${(operand.target ?? 0).toString(16)}`;
    case 'mem': return `*(/* ${operand.mem} */)`;
    default: return '';
  }
}

function translate(ins: Instruction, lastCompare: Instruction | null): string {
  const m = ins.mnemonic.toLowerCase();
  const [a, b] = ins.operands;
  const left = a ? operandText(a) : '';
  const right = b ? operandText(b) : '';

  if (m === 'mov' || m === 'movzx' || m === 'movsx' || m === 'lea') {
    return `  ${left} = ${right};`;
  }
  if (BINARY[m] && a && b) return `  ${left} ${BINARY[m]} ${right};`;
  if (m === 'inc') return `  ${left} += 1;`;
  if (m === 'dec') return `  ${left} -= 1;`;
  if ((m === 'test' || m === 'cmp') && a && b) return `  /* ${m} ${left}, ${right} */`;
  if (m === 'call') return `  call(${right || left || 'unknown'});`;
  if (m === 'ret' || m === 'retn') return '  return;';
  if (m === 'jmp') return `  goto L_${(a?.target ?? 0).toString(16)};`;
  if (CONDITION[m]) {
    const condition = lastCompare
      ? `${operandText(lastCompare.operands[0])} ${CONDITION[m]} ${operandText(lastCompare.operands[1])}`
      : `flags say ${CONDITION[m]}`;
    return `  if (${condition}) goto L_${(a?.target ?? 0).toString(16)};`;
  }
  if (m === 'nop') return '  /* nop */';
  if (m === 'push') return `  /* push ${left} */`;
  if (m === 'pop') return `  /* pop ${left} */`;
  return `  /* ${formatInstruction(ins).trim().replace(/\s+/g, ' ')} */`;
}

export function toPseudoC(fn: DisassembledFunction, blocks: BasicBlock[] = []): string {
  const ordered = blocks.length
    ? blocks.flatMap((block) => block.instructions)
    : fn.instructions;
  const labels = new Set(blocks.map((block) => block.start));
  const lines: string[] = [
    '/* Reading aid only: registers are literal, memory is annotated, and',
    '   instructions without a C equivalent are kept as comments. */',
    `void ${fn.name.replace(/[^A-Za-z0-9_$.]/g, '_')}(void) {`,
  ];
  let lastCompare: Instruction | null = null;
  for (const ins of ordered) {
    if (labels.has(ins.address)) lines.push(`L_${ins.address.toString(16)}:`);
    lines.push(translate(ins, lastCompare));
    lastCompare = ins.mnemonic === 'cmp' || ins.mnemonic === 'test' ? ins : null;
  }
  lines.push('}');
  if (fn.unknown) lines.unshift(`/* ${fn.unknown} undecoded byte(s) in this function. */`);
  if (fn.truncated) lines.unshift('/* Traversal hit its instruction budget; this is a partial function. */');
  return lines.join('\n');
}
