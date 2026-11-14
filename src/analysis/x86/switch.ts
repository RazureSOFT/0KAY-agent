/**
 * Jump-table recovery.
 *
 * A dense switch compiles to an indexed jump: `jmp [rax*8 + table]`. The table
 * holds absolute addresses, so reading it turns one indirect branch into the
 * case list the source had. Anything that is not that exact shape — a chain of
 * comparisons, a relative-offset table — is left alone rather than guessed at.
 */
import type { Expr, LiftedBlock } from './ir.js';
import type { Instruction } from './decode.js';

export interface SwitchCase {
  value: number;
  target: number;
}

export interface SwitchInfo {
  value: Expr;
  cases: SwitchCase[];
  defaultTarget: number | null;
}

const MAX_CASES = 256;

function readU64(code: Uint8Array, offset: number): number | null {
  if (offset < 0 || offset + 8 > code.length) return null;
  let value = 0n;
  for (let i = 7; i >= 0; i--) value = (value << 8n) | BigInt(code[offset + i]);
  return Number(value);
}

/**
 * `block` must end in `jmp qword [index*8 + table]` with no base register.
 * `isCode` filters table entries that do not point at code, which is how the
 * table's real length is found when the preceding bound check is not visible.
 */
export function recoverSwitch(
  block: LiftedBlock,
  instructions: Instruction[],
  code: Uint8Array,
  baseVaddr: number,
  isCode: (address: number) => boolean,
): SwitchInfo | null {
  const last = instructions[instructions.length - 1];
  if (!last || last.mnemonic.toLowerCase() !== 'jmp') return null;
  const operand = last.operands[0];
  if (!operand || operand.kind !== 'mem') return null;
  if (operand.base || !operand.index || operand.scale !== 8) return null;
  const tableAddress = operand.disp;
  if (!tableAddress || tableAddress < 0) return null;

  const tableOffset = tableAddress - baseVaddr;
  const cases: SwitchCase[] = [];
  for (let index = 0; index < MAX_CASES; index++) {
    const target = readU64(code, tableOffset + index * 8);
    if (target == null || !isCode(target)) break;
    cases.push({ value: index, target });
  }
  if (cases.length < 3) return null; // two or fewer is a branch, not a table

  return {
    value: { t: 'reg', name: operand.index, size: 64 },
    cases,
    defaultTarget: null,
  };
}
