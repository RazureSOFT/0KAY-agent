/**
 * Structural checks over every function of the binary.
 *
 * The point is to have a way to tell whether a change to the structuring pass made
 * the output better or worse *as a whole*, not just on the function being looked at.
 * Counting empty braces in one function said nothing about the other 1999; this runs
 * a set of invariants over all of them and reports how many break each one, with the
 * names so a fix can be checked afterwards.
 *
 * Exit code is the number of failing invariants, so it can be used as a gate.
 */
import * as fs from 'node:fs/promises'
import { parseImage, executableSections } from '../src/analysis/x86/image.js'
import { findPclntab } from '../src/analysis/x86/pclntab.js'
import { decompileFunction } from '../src/analysis/x86/decompile.js'

// Usage: npm run check:structure -- <binary> [function-limit]
// Environment overrides exist for convenience; the arguments are what the script
// documents, because the binary is a local file and has no business being defaulted
// to a path on someone else's machine.
const BINARY = process.argv[2] || process.env.STRUCTURE_BINARY
const LIMIT = Number(process.argv[3] || process.env.STRUCTURE_LIMIT || 4000)
if (!BINARY) {
  console.error('usage: npm run check:structure -- <path-to-binary> [function-limit]')
  process.exit(2)
}

const bytes = await fs.readFile(BINARY)
const image = parseImage(bytes)
let entries: { name: string; entry: number; end: number }[] = []
for (const s of image.sections) {
  if (s.size <= 0 || s.offset < 0 || s.offset + s.size > bytes.length) continue
  const codeSection = executableSections(image)[0]
  const t = findPclntab(bytes.subarray(s.offset, s.offset + s.size), codeSection?.vaddr)
  if (t) { entries = t.functions; break }
}
const named = entries.filter((e) => !/^(func_|sub_|unknown)/i.test(e.name))
const sec = executableSections(image)[0]

interface Failure { name: string; detail: string }
const fails: Record<string, Failure[]> = {
  emptyBranch: [],
  danglingGoto: [],
  unusedLabel: [],
  gotoCountMismatch: [],
  braceImbalance: [],
  selfAssign: [],
  repeatedCondition: [],
  readBeforeWritten: [],
  undeclaredName: [],
}
let functions = 0
let instructions = 0

for (const fn of named.slice(0, LIMIT)) {
  let r
  try {
    r = decompileFunction(bytes, sec.vaddr - sec.offset, fn.entry, {
      name: fn.name,
      end: fn.end > fn.entry ? fn.end : undefined,
      imageFormat: image.format,
      maxInstructions: 4000,
    })
  } catch (error) {
    fails.braceImbalance.push({ name: fn.name, detail: `threw: ${(error as Error).message}` })
    continue
  }
  functions += 1
  instructions += r.instructions
  const c = r.c

  // 1. An empty pair of braces is an empty block. A body of comments is not empty:
  //    `ud2` and `int 3` are written up and say what the function does.
  for (const m of c.matchAll(/\{\s*\n\s*\}/g)) {
    const at = m.index ?? 0
    const line = c.slice(0, at).split('\n').length
    fails.emptyBranch.push({ name: fn.name, detail: `line ${line}` })
    break
  }

  // 2. Every goto needs a label that exists.
  const defs = new Set([...c.matchAll(/^\s*(L_[0-9a-f]+):/gm)].map((m) => m[1]))
  const refs = [...c.matchAll(/goto (L_[0-9a-f]+)/g)].map((m) => m[1])
  for (const ref of new Set(refs)) {
    if (!defs.has(ref)) fails.danglingGoto.push({ name: fn.name, detail: ref })
  }

  // 3. Every label needs a goto. A label nobody jumps to is noise that buries the
  //    listing.
  const refSet = new Set(refs)
  for (const d of defs) {
    if (!refSet.has(d)) fails.unusedLabel.push({ name: fn.name, detail: d })
  }

  // 4. The header's goto count must match the gotos actually printed.
  const header = /—[^—]*?(\d+) goto\(s\)/.exec(c.split('\n')[0] || '')
  if (header && Number(header[1]) !== refs.length) {
    fails.gotoCountMismatch.push({ name: fn.name, detail: `header ${header[1]} vs printed ${refs.length}` })
  }

  // 5. Braces balance. Catches a printer that lost a line.
  let depth = 0
  let minDepth = 0
  for (const ch of c) {
    if (ch === '{') depth += 1
    else if (ch === '}') { depth -= 1; if (depth < minDepth) minDepth = depth }
  }
  if (depth !== 0 || minDepth < 0) {
    fails.braceImbalance.push({ name: fn.name, detail: `depth ${depth}, min ${minDepth}` })
  }

  // 6. `x = x;` — an assignment whose two sides are the same bare name. The left side
  //    must be a name on its own: `*(long *)arg0 = arg0;` stores arg0 through the
  //    pointer arg0, which is a real write, and an unanchored pattern reports it.
  if (/^\s*([A-Za-z_]\w*) = \1;$/m.test(c)) {
    fails.selfAssign.push({ name: fn.name, detail: 'value assigned to itself' })
  }

  // 7. The same guard printed twice in a row: `if (a) { } if (a) { ... }` came from
  //    a shared block being emitted twice with an empty first copy.
  if (/\bif \(([^)\n]{1,80})\) \{\s*\n\s*\}\s*\n\s*if \(\1\)/.test(c)) {
    fails.repeatedCondition.push({ name: fn.name, detail: 'same guard twice' })
  }

  if (/read before written/.test(c)) fails.readBeforeWritten.push({ name: fn.name, detail: '' })

  // 8. Every name the body uses must be declared. This is the one that decides whether
  //    the listing is C at all: an undeclared identifier is a compile error, and a
  //    reader cannot look up a name the function never introduced. The other checks are
  //    about readability; this one is about the output being source code.
  const declared = new Set<string>()
  for (const m of (c.split('{')[0] || '').matchAll(/\b(?:long|int|char|short|float|double|unsigned|void|__int64)\b\s*\*?\s*([A-Za-z_]\w*)/g)) {
    declared.add(m[1])
  }
  const openBrace = c.indexOf('{')
  const body = openBrace >= 0 ? c.slice(openBrace + 1) : ''
  for (const m of body.matchAll(/^\s*(?:long|int|char|short|float|double|unsigned|void|__int64)\s+\*?\s*([A-Za-z_]\w*)\s*;/gm)) {
    declared.add(m[1])
  }
  const missing = new Set<string>()
  for (const m of body.matchAll(/\b([a-zA-Z_]\w*)\s*=(?!=)/g)) {
    const name = m[1]
    if (declared.has(name)) continue
    if (!/^(?:r[a-z]{2}|r\d{1,2}|e[a-z]{2}|v_\d+|stack_\d+|xmm\d+|ymm\d+)$/.test(name)) continue
    // `rsp` and `rbp` are the stack pointer and frame base. They are not variables the
    // function owns, so a declaration for either would ask the reader to find a store
    // that does not exist — the decompiler leaves them out on purpose.
    if (name === 'rsp' || name === 'rbp') continue
    missing.add(name)
  }
  if (missing.size) {
    fails.undeclaredName.push({ name: fn.name, detail: [...missing].slice(0, 4).join(', ') })
  }
}

const order = [
  'undeclaredName', 'braceImbalance', 'emptyBranch', 'danglingGoto', 'unusedLabel',
  'gotoCountMismatch', 'selfAssign', 'repeatedCondition', 'readBeforeWritten',
]
console.log(`functions ${functions} | instructions ${instructions}`)
let bad = 0
for (const key of order) {
  const list = fails[key]
  const pct = ((list.length / Math.max(functions, 1)) * 100).toFixed(2)
  const flag = list.length ? '  <-- FAIL' : ''
  console.log(`${key.padEnd(20)} ${String(list.length).padStart(5)}  ${pct.padStart(6)}%${flag}`)
  if (list.length) {
    bad += 1
    for (const f of list.slice(0, 5)) console.log(`      ${f.name}  ${f.detail}`)
  }
}
if (process.env.OKAY_JSON) {
  await fs.writeFile(process.env.OKAY_JSON, JSON.stringify({ functions, instructions, fails }, null, 1))
  console.log(`wrote ${process.env.OKAY_JSON}`)
}
process.exit(bad)
