/**
 * Check that every Go symbol name becomes a usable C identifier, and that no two
 * distinct names become the same one.
 *
 * Two properties, and the second is the one that is easy to get wrong. Making each name
 * legal is a substitution; making the substitution *injective* is a design decision, and
 * an earlier version dropped brackets, which made `sync.OnceValue[go.shape.[]string].func1`
 * and `sync.OnceValue[go.shape.string].func1` the same identifier. Two functions sharing
 * a name is a redefinition, so this is checked against the real table rather than
 * reasoned about.
 *
 * Usage: npm run check:names -- <path-to-binary>
 */
import * as fs from 'node:fs/promises'
import { parseImage, executableSections } from '../src/analysis/x86/image.js'
import { findPclntab } from '../src/analysis/x86/pclntab.js'
import { sanitiseName } from '../src/analysis/x86/ir.js'

const BINARY = process.argv[2] || process.env.STRUCTURE_BINARY
if (!BINARY) {
  console.error('usage: npm run check:names -- <path-to-binary>')
  process.exit(2)
}

const bytes = await fs.readFile(BINARY)
const image = parseImage(bytes)
const sec = executableSections(image)[0]
let functions: { name: string; entry: number }[] = []
for (const s of image.sections) {
  if (s.size <= 0 || s.offset < 0 || s.offset + s.size > bytes.length) continue
  const t = findPclntab(bytes.subarray(s.offset, s.offset + s.size), sec?.vaddr)
  if (t) { functions = t.functions; break }
}

const seen = new Map<string, string>()
let invalid = 0
let collisions = 0
for (const fn of functions) {
  const safe = sanitiseName(fn.name)
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(safe)) {
    invalid += 1
    if (invalid <= 3) console.log('INVALID', JSON.stringify(fn.name), '->', JSON.stringify(safe))
  }
  const previous = seen.get(safe)
  if (previous !== undefined && previous !== fn.name) {
    collisions += 1
    if (collisions <= 3) console.log('COLLIDE', safe, '<-', JSON.stringify(fn.name), 'and', JSON.stringify(previous))
  }
  seen.set(safe, fn.name)
}
console.log(`total ${functions.length} | invalid ${invalid} | collisions ${collisions}`)
for (const example of [
  'internal/runtime/maps.(*Map).Clear',
  'runtime.memmove',
  'crypto/internal/fips140/sha256.blockAVX2',
  'main.(*T).f',
  'go:buildid',
]) {
  console.log(' ', example, '->', sanitiseName(example))
}
process.exit(invalid || collisions ? 1 : 0)

