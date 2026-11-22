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
 *
 * `readU64At` maps a virtual address to the eight bytes there, so the table is read
 * wherever it lives. A switch table sits in `.rdata`, not in the code section, and an
 * earlier version computed the file offset by subtracting the code base — which for a
 * table in `.rdata` lands inside the code, reads an instruction's bytes as an address,
 * finds it is not code, and concludes the table has no cases. Every switch in the binary
 * was missed that way, and with the case list gone the targets were unreachable, their
 * `ret`s folded away, and the function ended on a bare table load.
 */
export function recoverSwitch(
  block: LiftedBlock,
  instructions: Instruction[],
  readU64At: (address: number) => number | null,
  isCode: (address: number) => boolean,
): SwitchInfo | null {
  const last = instructions[instructions.length - 1];
  if (!last || last.mnemonic.toLowerCase() !== 'jmp') return null;
  const operand = last.operands[0];
  if (!operand || operand.kind !== 'mem') return null;
  if (!operand.index || operand.scale !== 8) return null;

  // The table address arrives two ways. One is an absolute displacement in the jump
  // itself, `jmp [index*8 + table]`. The other, and the one Go emits on Windows, loads
  // the address into a register one instruction earlier and jumps through it:
  //
  //     lea rdx, [rip+0x772cc2]
  //     jmp [rdx+rcx*8]
  //
  // Requiring `operand.base` to be empty rejected the second outright, and with it every
  // switch in the binary — `(*Type).Uncommon` is one, and without its case list the
  // targets went unreachable, their `ret`s were folded away, and the function ended on
  // a bare table load with no return at all.
  let tableAddress = operand.base ? 0 : operand.disp;
  if (operand.base) {
    // Walk back for the load that defined the base. Anything else in between is skipped,
    // and if no such load is found the pattern does not hold — inventing a case list
    // from unrelated bytes is worse than missing the switch.
    for (let index = instructions.length - 2; index >= 0; index--) {
      const earlier = instructions[index];
      if (!earlier || earlier.mnemonic.toLowerCase() !== 'lea') continue;
      const [destination, source] = earlier.operands;
      if (!destination || destination.kind !== 'reg' || destination.reg !== operand.base) continue;
      if (!source || source.kind !== 'mem' || !source.rip) continue;
      // `source.value` is the displacement as written, not the address it refers to:
      // the decoder stores the raw `int32` and marks the operand RIP-relative. The
      // address is the displacement plus the end of the instruction. Using the raw
      // displacement sent the read to `0x772cc2` — inside the code, where the bytes are
      // an instruction rather than a table entry, so the table looked empty.
      const disp = source.value;
      if (disp == null) break;
      tableAddress = earlier.address + earlier.bytes.length + disp;
      break;
    }
  }
  if (!tableAddress || tableAddress < 0) return null;

  const cases: SwitchCase[] = [];
  for (let index = 0; index < MAX_CASES; index++) {
    const target = readU64At(tableAddress + index * 8);
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
