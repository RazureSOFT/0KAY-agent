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
const counts = new Map()
for (const fn of named.slice(0, 600)) {
  let r; try { r = decompileFunction(bytes, sec.vaddr - sec.offset, fn.entry, { name: fn.name, end: fn.end > fn.entry ? fn.end : undefined, imageFormat: image.format, maxInstructions: 3000 }) } catch { continue }
  for (const m of r.c.matchAll(/\/\* unknown: (.+?) \*\//g)) {
    const key = m[1].trim().split(/\s+/).slice(0, 2).join(' ')
    counts.set(key, (counts.get(key) || 0) + 1)
  }
}
for (const [k, v] of [...counts.entries()].sort((a, b) => b[1] - a[1])) console.log(String(v).padStart(4), k)
