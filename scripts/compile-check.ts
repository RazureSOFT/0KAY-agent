/**
 * Compile the listings with a real C compiler.
 *
 * The structural invariants in `check-structure.ts` say the output is well formed; they
 * do not say it compiles. Two rounds of fixes went in before anyone ran a compiler over
 * the result, and the first run reported 102 errors in 60 functions — a parameter typed
 * `RegArgs *` that the body also multiplies, a label written twice, a name read but never
 * declared. None of those is visible in the shape of the output, and all of them are
 * visible to `cl` in a second.
 *
 * One function per file, which is what the tool prints, so a listing that only works when
 * concatenated does not pass.
 *
 *   node --import tsx scripts/compile-check.ts [count] [outDir]
 *
 * Needs `cl.exe` from a Visual Studio install; the path is found below. On a machine
 * without one the script reports that and stops, rather than silently passing.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseImage, executableSections, vaddrToOffset } from '../src/analysis/x86/image.js';
import { findPclntab } from '../src/analysis/x86/pclntab.js';
import { decompileFunction } from '../src/analysis/x86/decompile.js';
import { collectNoReturnTargets } from '../src/tools/binary_analysis.js';
import { uniqueNames } from '../src/tools/unique_names.js';

const count = Number(process.argv[2] || 60);
const binary = process.env.OKAY_BINARY || 'D:/0KAY/.run/core.exe';
const outDir = process.argv[3] || path.join(os.tmpdir(), 'okay-compile-check');

/**
 * The newest `cl.exe` under a Visual Studio install, or null.
 *
 * The tree is `<root>/<year>/<product>/VC/Tools/MSVC/<version>/bin/Hostx64/x64/cl.exe`.
 * The year and the product are read from the disk rather than assumed — `2022` and
 * `Community` on this machine, but `2019` and `BuildTools` are just as ordinary.
 */
async function findCompiler(): Promise<string | null> {
  const roots = ['C:/Program Files/Microsoft Visual Studio', 'C:/Program Files (x86)/Microsoft Visual Studio'];
  const found: string[] = [];
  for (const root of roots) {
    let years: string[];
    try { years = await fs.readdir(root); } catch { continue; }
    for (const year of years) {
      let products: string[];
      try { products = await fs.readdir(`${root}/${year}`); } catch { continue; }
      for (const product of products) {
        const tools = `${root}/${year}/${product}/VC/Tools/MSVC`;
        let versions: string[];
        try { versions = await fs.readdir(tools); } catch { continue; }
        for (const version of versions) {
          const candidate = `${tools}/${version}/bin/Hostx64/x64/cl.exe`;
          if (existsSync(candidate)) found.push(candidate);
        }
      }
    }
  }
  return found.sort().reverse()[0] ?? null;
}

const compiler = await findCompiler();
if (!compiler) {
  console.log('no cl.exe found — install the C++ workload, or skip this check');
  process.exit(0);
}

const bytes = await fs.readFile(binary);
const image = parseImage(bytes);
const sec = executableSections(image)[0];
const table = findPclntab(bytes.subarray(image.sections.find((s) => /rdata/i.test(s.name))!.offset, 0xfffffff), sec.vaddr);
const names = uniqueNames(table.functions);
const codes = executableSections(image).map((s) => [s.vaddr, s.vaddr + s.size] as const);
const readU64At = (address: number): number | null => {
  const offset = vaddrToOffset(address, image.sections);
  if (offset < 0 || offset + 8 > bytes.length) return null;
  let value = 0n;
  for (let byte = 7; byte >= 0; byte--) value = (value << 8n) | BigInt(bytes[offset + byte]);
  return Number(value);
};
const isCode = (address: number) => codes.some(([from, to]) => address >= from && address < to);
const noReturnCalls = collectNoReturnTargets(table.functions);
const named = table.functions.filter((e) => !/^(func_|sub_|unknown)/i.test(e.name));

await fs.rm(outDir, { recursive: true, force: true });
await fs.mkdir(outDir, { recursive: true });

const failures: { file: string; name: string; errors: string[] }[] = [];
let written = 0;
for (const entry of named.slice(0, count)) {
  let result;
  try {
    result = decompileFunction(bytes, sec.vaddr - sec.offset, entry.entry, {
      name: names.get(entry.entry) ?? entry.name, end: entry.end > entry.entry ? entry.end : undefined, imageFormat: image.format,
      maxInstructions: 4000, names, readU64At, isCode, noReturnCalls,
    });
  } catch { continue; }
  written += 1;
  const file = `${outDir}/f${String(written).padStart(4, '0')}.c`;
  await fs.writeFile(file, result.c, 'utf8');
  const run = spawnSync(compiler, ['/nologo', '/c', `/Fo${outDir}/out.obj`, file], { encoding: 'utf8' });
  const errors = `${run.stdout ?? ''}${run.stderr ?? ''}`
    .split('\n')
    .filter((line) => /: error /.test(line))
    .map((line) => line.replace(/^.*?: error /, '').trim());
  if (errors.length) failures.push({ file: path.basename(file), name: entry.name, errors });
}

console.log(`compiled ${written} listings from ${path.basename(binary)}`);
console.log(`failures ${failures.length} (${((failures.length / Math.max(written, 1)) * 100).toFixed(2)}%)`);
const byKind = new Map<string, number>();
for (const failure of failures) {
  for (const error of failure.errors) {
    const kind = error.replace(/^'[^']*'[^:]*: /, '').replace(/^[A-Z]?\d+: /, '').slice(0, 44);
    byKind.set(kind, (byKind.get(kind) ?? 0) + 1);
  }
}
for (const [kind, n] of [...byKind].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${kind}`);
for (const failure of failures.slice(0, 12)) {
  console.log(`  ${failure.file} ${failure.name}`);
  for (const error of failure.errors.slice(0, 2)) console.log(`        ${error}`);
}
