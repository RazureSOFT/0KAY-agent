import * as fs from 'node:fs/promises'
import { parseImage, executableSections, sectionNamed } from '../src/analysis/x86/image.js'
import { parsePclntab } from '../src/analysis/x86/pclntab.js'
import { parseSymbols } from '../src/analysis/x86/symbols.js'
import { decompileFunction } from '../src/analysis/x86/decompile.js'
const name = process.argv[2]
const bytes = await fs.readFile('D:/0KAY/.run/core.exe')
const image = parseImage(bytes)
let entries = []
const pcln = sectionNamed(image, /gopclntab/i)
if (pcln) { const t = parsePclntab(bytes.subarray(pcln.offset, pcln.offset + pcln.size)); if (t.functions.length) entries = t.functions }
if (!entries.length) entries = parseSymbols(bytes, image)
const fn = entries.find((s) => s.name.includes(name))
if (!fn) { console.error('not found'); process.exit(1) }
const sec = executableSections(image)[0]
console.log(decompileFunction(bytes, sec.vaddr - sec.offset, fn.entry, { name: fn.name, end: fn.end, imageFormat: image.format, maxInstructions: 600 }).c)
