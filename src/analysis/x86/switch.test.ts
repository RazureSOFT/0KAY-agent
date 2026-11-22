/**
 * Jump-table recovery.
 *
 * Two shapes reach the table and both have to work. The address can be in the jump
 * itself, or — the form Go emits on Windows — loaded into a register one instruction
 * earlier with `lea`, so the jump reads `[reg+index*8]`.
 *
 * Neither shape was covered by a test, and the second one was rejected by the code
 * outright. With the case list missing, the case targets were unreachable, their `ret`s
 * folded away, and functions ended on whichever statement happened to precede the jump:
 * a bare table load with no return at all.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { recoverSwitch } from './switch.js'
import type { Instruction } from './decode.js'
import type { LiftedBlock } from './ir.js'

const BASE = 0x1000
const CODE_END = 0x2000
const isCode = (address: number): boolean => address >= BASE && address < CODE_END

function instruction(partial: Partial<Instruction> & { mnemonic: string; address: number; length?: number }): Instruction {
  return {
    address: partial.address,
    bytes: new Uint8Array(partial.length ?? 7),
    mnemonic: partial.mnemonic,
    operands: partial.operands ?? [],
    flow: partial.flow,
  } as Instruction
}

const block = { start: BASE, stmts: [], term: 'jmp' } as unknown as LiftedBlock

test('a table addressed by displacement is recovered', () => {
  // jmp [rcx*8 + 0x1800]; the table holds three code addresses.
  const tableAddress = 0x1800
  const targets = [0x1100, 0x1200, 0x1300]
  const jump = instruction({
    mnemonic: 'jmp', address: BASE, length: 7,
    operands: [{ kind: 'mem', mem: 'rcx*8+0x1800', size: 64, index: 'rcx', scale: 8, disp: tableAddress }],
  })
  const info = recoverSwitch(block, [jump], (address) => {
    const index = (address - tableAddress) / 8
    return Number.isInteger(index) && index >= 0 && index < targets.length ? targets[index] : null
  }, isCode)
  assert.ok(info, 'the switch is recovered')
  assert.deepEqual(info.cases.map((item) => item.target), targets)
  assert.equal(info.value.t, 'reg')
})

test('a table loaded into a register is recovered', () => {
  // Exactly what Go emits: the address is put in rdx by `lea`, then the jump reads it.
  // `lea rdx, [rip+0x60]` at BASE, seven bytes long, so the table is at BASE + 7 + 0x60.
  const tableAddress = BASE + 7 + 0x60
  const targets = [0x1100, 0x1200, 0x1300]
  const load = instruction({
    mnemonic: 'lea', address: BASE, length: 7,
    operands: [
      { kind: 'reg', reg: 'rdx', size: 64 },
      { kind: 'mem', mem: 'rip+0x60', size: 64, value: 0x60, disp: 0x60, rip: true },
    ],
  })
  const jump = instruction({
    mnemonic: 'jmp', address: BASE + 7, length: 3,
    operands: [{ kind: 'mem', mem: 'rdx+rcx*8', size: 64, base: 'rdx', index: 'rcx', scale: 8 }],
  })
  const info = recoverSwitch(block, [load, jump], (address) => {
    const index = (address - tableAddress) / 8
    return Number.isInteger(index) && index >= 0 && index < targets.length ? targets[index] : null
  }, isCode)
  assert.ok(info, 'the switch is recovered through the register')
  assert.equal(info.cases[0]?.target, 0x1100, 'the displacement is added to the end of the lea, not used raw')
})

test('a jump through a register with no load is not a switch', () => {
  // No `lea` defines rdx, so the table address is unknown. Inventing one would read
  // whatever the register happened to hold.
  const jump = instruction({
    mnemonic: 'jmp', address: BASE, length: 3,
    operands: [{ kind: 'mem', mem: 'rdx+rcx*8', size: 64, base: 'rdx', index: 'rcx', scale: 8 }],
  })
  const info = recoverSwitch(block, [jump], () => 0x1100, isCode)
  assert.equal(info, null)
})
