import * as fs from 'node:fs/promises'
import { parseImage, executableSections, sectionNamed } from '../src/analysis/x86/image.js'
import { parsePclntab } from '../src/analysis/x86/pclntab.js'
import { parseSymbols } from '../src/analysis/x86/symbols.js'
import { decompileFunction } from '../src/analysis/x86/decompile.js'
const bytes = await fs.readFile('D:/0KAY/.run/core.exe')
const image = parseImage(bytes)
let entries = []
const pcln = sectionNamed(image, /gopclntab/i)
if (pcln) { const t = parsePclntab(bytes.subarray(pcln.offset, pcln.offset + pcln.size)); if (t.functions.length) entries = t.functions }
if (!entries.length) entries = parseSymbols(bytes, image)
const named = entries.filter((e) => !/^(func_|sub_|unknown)/i.test(e.name))
const sec = executableSections(image)[0]
const N = Number(process.argv[2] || 600)
const sample = named.slice(0, N)
const tally = { f: 0, ur: 0, dns: 0, uk: 0, eb: 0, fl: 0, vn: 0, so: 0, rp: 0 }
const rows = []
for (const fn of sample) {
  let r; try { r = decompileFunction(bytes, sec.vaddr - sec.offset, fn.entry, { name: fn.name, end: fn.end > fn.entry ? fn.end : undefined, imageFormat: image.format, maxInstructions: 3000 }) } catch { continue }
  tally.f += 1
  if (/read before written/.test(r.c)) { tally.ur += 1; rows.push(fn.name + ' :: ' + (r.c.match(/read before written: ([^\n—]+)/) || [])[1]) }
  if (/\{\s*\n\s*\}/.test(r.c)) tally.eb += 1
  if (/\/\* flags \*\//.test(r.c)) tally.fl += 1
  if (/\b(?:r[a-z0-9]+|arg\d+)_\d+\b/.test(r.c)) tally.vn += 1
  if (/\b([A-Za-z_]\w*) [&|^-] \1\b/.test(r.c)) tally.so += 1
  if (/\*\(long \*\)\(rsp \+/.test(r.c)) tally.rp += 1
  const dec = [...r.c.matchAll(/^\s{4}long (\w+);$/gm)].map((m) => m[1])
  const bt = r.c.split('\n').filter((l) => !/^\s{4}long \w+;$/.test(l) && !/^\s*\/\*/.test(l)).join('\n')
  const sg = r.c.split('\n').find((l) => l.includes('(')) || ''
  if (dec.some((n) => !bt.includes(n + ' =') && !bt.includes('&' + n) && !sg.includes(n))) tally.dns += 1
  if (/\/\* unknown:/.test(r.c)) tally.uk += 1
}
const p = (n) => `${Math.round((n / Math.max(tally.f, 1)) * 1000) / 10}%`
console.log('f', tally.f)
console.log('undefined read  ', tally.ur, p(tally.ur))
console.log('declared never  ', tally.dns, p(tally.dns))
console.log('unknown stmt    ', tally.uk, p(tally.uk))
console.log('empty body      ', tally.eb, p(tally.eb))
console.log('versioned name  ', tally.vn, p(tally.vn))
console.log('self op         ', tally.so, p(tally.so))
console.log('---')
for (const x of rows.slice(0, 20)) console.log(' ', x)
