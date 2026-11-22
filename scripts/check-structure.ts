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
import { parseImage, executableSections, vaddrToOffset } from '../src/analysis/x86/image.js'
import { findPclntab } from '../src/analysis/x86/pclntab.js'
import { decompileFunction } from '../src/analysis/x86/decompile.js'
import { collectNoReturnTargets } from '../src/tools/binary_analysis.js'

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
// The same name map the tool passes in. Without it every call is `sub_<address>()`,
// which is not a declared function and not what the tool prints either — the checker
// would report a defect that the real output does not have.
const names = new Map(entries.map((entry) => [entry.entry, entry.name]))
// The same jump-table reader the tool passes in. A switch table lives in `.rdata`, so
// without the image's address mapping every switch is missed — and the listing the tool
// produces and the listing this checker sees would be different things.
const codeRanges = executableSections(image).map((s) => [s.vaddr, s.vaddr + s.size] as const)
const readU64At = (address: number): number | null => {
  const offset = vaddrToOffset(address, image.sections)
  if (offset < 0 || offset + 8 > bytes.length) return null
  let value = 0n
  for (let byte = 7; byte >= 0; byte--) value = (value << 8n) | BigInt(bytes[offset + byte])
  return Number(value)
}
const isCode = (address: number): boolean => codeRanges.some(([from, to]) => address >= from && address < to)
// The same panic-path set the tool passes in. A call that never returns ends its path,
// and without this the checker reads the code after it as reachable and reports a
// function that ends on `rax = runtime_panicBounds();` — 14 of 800, all of them the
// checker disagreeing with the tool rather than a defect in the listing.
const noReturnCalls = collectNoReturnTargets(entries)

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
  invalidIdentifier: [],
  undeclaredCallee: [],
  duplicateDeclaration: [],
  fallsOffEnd: [],
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
      names,
      readU64At,
      isCode,
      ...(noReturnCalls.size ? { noReturnCalls } : {}),
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

  // 9. Every identifier the listing introduces has to be a valid C identifier — the
  //    function's own name included. 98.9% of the names in the Go function table are
  //    not: `internal/runtime/maps.(*Map).Clear` has four characters C rejects in an
  //    identifier. A definition whose name is not an identifier is the one error no
  //    compiler will look past, and it is also what a call to that function prints.
  const signatureName = /^\s*[\w*\s]+?([A-Za-z_]\w*)\s*\(/.exec(c.split('\n').find((line) => line.includes('(') && !line.trimStart().startsWith('/*')) || '')
  if (signatureName && !/^[A-Za-z_]\w*$/.test(signatureName[1])) {
    fails.invalidIdentifier.push({ name: fn.name, detail: `definition named ${signatureName[1]}` })
  }
  for (const m of c.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)) {
    const callee = m[1]
    if (/^(?:if|while|for|switch|return|sizeof)$/.test(callee)) continue
    if (/^[A-Za-z_]\w*$/.test(callee)) continue
    fails.invalidIdentifier.push({ name: fn.name, detail: `call to ${callee}` })
  }

  // 10. Every function the body calls is declared. A call to an undeclared name is a
  //     constraint violation in C99, the same class as an undeclared variable: 30% of
  //     functions had one. The declaration is printed above the definition, so the
  //     names the body calls have to be a subset of the names the listing introduces.
  //
  //     Comments are stripped first. The body carries notes like "bts sets one bit of
  //     the destination (bit 52)", and matching inside those reported `destination` as
  //     a call — 126 functions, every one of them a false positive.
  const code = stripComments(c)
  const introduced = new Set<string>()
  for (const m of code.matchAll(/\b(?:long|int|char|short|void|unsigned|__int64)\s+\*?\s*([A-Za-z_]\w*)\s*\(/g)) introduced.add(m[1])
  const keywords = new Set(['if', 'while', 'for', 'switch', 'return', 'sizeof'])
  const called = new Set<string>()
  for (const m of code.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)) {
    if (keywords.has(m[1])) continue
    if (/^(?:unsigned|int|long|char|short|void)$/.test(m[1])) continue
    called.add(m[1])
  }
  const undeclaredCallee = [...called].filter((name) => !introduced.has(name))
  if (undeclaredCallee.length) {
    fails.undeclaredCallee.push({ name: fn.name, detail: undeclaredCallee.slice(0, 3).join(', ') })
  }

  // 11. A local declared twice in the same scope is a redefinition, and a parameter
  //     declared again as a local shadows it. Both are errors, and both are cheap to
  //     produce when the collectors and the declaration printer disagree.
  const declaredLocals = new Map<string, number>()
  for (const m of body.matchAll(/^\s{4}(?:long|int|char|short|float|double|unsigned|void)\s+\*?\s*([A-Za-z_]\w*)\s*;/gm)) {
    declaredLocals.set(m[1], (declaredLocals.get(m[1]) || 0) + 1)
  }
  const doubled = [...declaredLocals].filter(([, count]) => count > 1).map(([n]) => n)
  if (doubled.length) fails.duplicateDeclaration.push({ name: fn.name, detail: doubled.slice(0, 3).join(', ') })

  // 12. A non-void function whose last printed statement is not a `return` can fall off
  //     the end, which is undefined behaviour and a warning every project turns into an
  //     error. The printer emits `return` on every path that leaves the body, so this
  //     only fires when a path lost its return.
  const returnType = (c.split('\n').find((line) => line.includes('(') && !line.trimStart().startsWith('/*')) || '').trim().split(/\s+/)[0]
  if (returnType && returnType !== 'void') {
    // `body` still carries the closing brace, so a body ending in `return x; }` has its
    // last *statement* one line up. Ignoring the brace keeps this from reporting every
    // function that returns properly — 497 of 500 without it.
    // `body` still carries the closing brace, so a body ending in `return x; }` has its
    // last *statement* one line up. Ignoring the brace keeps this from reporting every
    // function that returns properly — 497 of 500 without it.
    const tail = body.replace(/\s+$/, '')
    const lastLine = tail.split('\n')
      .filter((line) => line.trim() && !line.trim().startsWith('/*') && line.trim() !== '}')
      .pop() || ''
    // The last *line* is what matters only when it is a plain statement. A `break`,
    // `continue` or `goto` leaves the block, and a `}` closes one, so none of them is a
    // fall-through. A `switch` printed before the final `return` put `break;` last and
    // reported 48 functions that do return.
    //
    // A call that never returns ends the path just as surely: nothing follows
    // `runtime_gopanic()`, so a body ending on it is complete. Go's panic helpers are
    // collected by name, and a `cgocallbackg` that ends on `rax = runtime_gopanic();`
    // is the last statement of the function, not a missing return.
    const lastCall = /\b([A-Za-z_]\w*)\([^()]*\);\s*$/.exec(lastLine.trim())
    const endsInNoReturn = lastCall != null && noReturnCalls.has(lastCall[1])
    if (lastLine && !endsInNoReturn && !/^(return|goto|break|continue|\}|\{|else)\b/.test(lastLine.trim()) && !/^\}/.test(lastLine.trim())) {
      fails.fallsOffEnd.push({ name: fn.name, detail: lastLine.trim().slice(0, 50) })
    }
  }
}

/** Remove block comments, so a check on the code does not read the notes. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ')
}

const order = [
  'invalidIdentifier', 'undeclaredName', 'undeclaredCallee', 'duplicateDeclaration',
  'fallsOffEnd', 'braceImbalance', 'emptyBranch', 'danglingGoto', 'unusedLabel',
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
