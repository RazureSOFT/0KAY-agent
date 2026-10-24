import * as fs from 'fs/promises';
import * as path from 'path';
import { Tool, type ToolContext, type ToolResult } from './types.js';
import { success, failure, clamp, limitOutput } from './helpers.js';
import { resolveCli, runCli, ensureDataDir } from './deps.js';
import { buildZipRead } from './zip_read.js';
import { analyzeJar } from './jar_analysis.js';

interface Finding { kind: string; detail: any; }
interface AnalyzeOptions { includeStrings: boolean; minStringLength: number; stringLimit: number; provider?: 'auto' | 'ghidra' | 'jadx' | 'objdump' | 'none'; functionName?: string; }

const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx', '.json', '.md', '.txt', '.yaml', '.yml', '.xml', '.html', '.css', '.py', '.go', '.rs', '.java', '.cs', '.sh', '.ps1', '.sql']);

export function detectFormat(buffer: Buffer, filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (buffer.length >= 4 && buffer[0] === 0x7f && buffer.slice(1, 4).toString('ascii') === 'ELF') return 'elf';
  if (buffer.length >= 2 && buffer[0] === 0x4d && buffer[1] === 0x5a) return buffer.includes(Buffer.from('BSJB')) ? 'pe-dotnet' : 'pe';
  if (buffer.length >= 4) {
    const magic = buffer.readUInt32BE(0);
    if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes(magic)) return 'macho';
  }
  if (buffer.length >= 4 && buffer.slice(0, 4).toString('ascii') === '\0asm') return 'wasm';
  if (buffer.length >= 16 && buffer.slice(0, 16).toString('ascii') === 'SQLite format 3\0') return 'sqlite';
  if (buffer.length >= 4 && buffer.readUInt32BE(0) === 0xa1b2c3d4) return 'pcap';
  if (buffer.length >= 4 && buffer.readUInt32LE(0) === 0xa1b2c3d4) return 'pcap';
  if (buffer.length >= 4 && buffer.slice(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) return ext === '.asar' ? 'asar' : ext === '.apk' || ext === '.jar' ? ext.slice(1) : 'zip';
  if (TEXT_EXT.has(ext)) return ext === '.js' || ext === '.mjs' || ext === '.cjs' ? 'javascript' : 'text';
  return 'binary';
}

export function extractStrings(buffer: Buffer, minLength: number, limit: number): Array<{ offset: number; text: string }> {
  const out: Array<{ offset: number; text: string }> = [];
  const current: number[] = []; let start = 0;
  const flush = () => { if (current.length >= minLength) out.push({ offset: start, text: Buffer.from(current).toString('utf8') }); current.length = 0; };
  for (let i = 0; i < buffer.length && out.length < limit; i++) {
    const byte = buffer[i];
    if (byte >= 0x20 && byte <= 0x7e) { if (!current.length) start = i; current.push(byte); }
    else { flush(); }
  }
  flush();
  return out;
}

function entropy(data: Buffer): number {
  if (!data.length) return 0;
  const counts = new Array(256).fill(0);
  for (const byte of data) counts[byte]++;
  let h = 0;
  for (const c of counts) if (c) { const p = c / data.length; h -= p * Math.log2(p); }
  return Number(h.toFixed(3));
}

function parseElf(buffer: Buffer, findings: Finding[]): void {
  const is64 = buffer[4] === 2; const le = buffer[5] === 1;
  const r16 = (o: number) => (le ? buffer.readUInt16LE(o) : buffer.readUInt16BE(o));
  const r32 = (o: number) => (le ? buffer.readUInt32LE(o) : buffer.readUInt32BE(o));
  const r64 = (o: number) => Number(le ? buffer.readBigUInt64LE(o) : buffer.readBigUInt64BE(o));
  findings.push({ kind: 'elf.header', detail: { class: is64 ? 'ELF64' : 'ELF32', endianness: le ? 'little' : 'big', type: ['NONE', 'REL', 'EXEC', 'DYN', 'CORE'][r16(16)] || r16(16), machine: r16(18), entry: is64 ? r64(24) : r32(24) } });

  const phoff = is64 ? r64(32) : r32(28);
  const phentsize = r16(is64 ? 54 : 42); const phnum = r16(is64 ? 56 : 44);
  const programs: Array<{ type: number; flags: number; vaddr: number; memsz: number }> = [];
  for (let i = 0; i < Math.min(phnum, 128); i++) {
    const base = phoff + i * phentsize;
    const type = r32(base);
    const flags = is64 ? r32(base + 4) : r32(base + 24);
    const vaddr = is64 ? r64(base + 16) : r32(base + 8);
    const memsz = is64 ? r64(base + 40) : r32(base + 20);
    programs.push({ type, flags, vaddr, memsz });
  }
  findings.push({ kind: 'elf.programs', detail: programs });

  const shoff = is64 ? r64(40) : r32(32); const shentsize = r16(is64 ? 58 : 46); const shnum = r16(is64 ? 60 : 48); const shstrndx = r16(is64 ? 62 : 50);
  const readSection = (index: number) => { const base = shoff + index * shentsize; return { nameOffset: r32(base), type: r32(base + 4), flags: is64 ? r64(base + 8) : r32(base + 8), offset: is64 ? r64(base + 24) : r32(base + 16), size: is64 ? r64(base + 32) : r32(base + 20), link: r32(base + (is64 ? 40 : 24)), entsize: is64 ? r64(base + 56) : r32(base + 36) }; };
  const strtab = shnum > shstrndx && shstrndx !== 0 ? readSection(shstrndx) : null;
  const readName = (offset: number): string => { if (!strtab) return ''; const start = strtab.offset + offset; let end = start; while (end < strtab.offset + strtab.size && buffer[end] !== 0) end++; return buffer.slice(start, end).toString('utf8'); };
  const sections = [];
  for (let i = 0; i < Math.min(shnum, 128); i++) { const s = readSection(i); const name = readName(s.nameOffset); sections.push({ name, type: s.type, size: s.size, entropy: s.type === 1 && s.size ? entropy(buffer.slice(s.offset, s.offset + s.size)) : undefined }); }
  findings.push({ kind: 'elf.sections', detail: sections.filter((s) => s.name) });

  const neededLibs = [...new Set([...buffer.slice(0, Math.min(buffer.length, 4_000_000)).toString('latin1').matchAll(/lib[A-Za-z0-9_.+-]+\.so(\.[0-9]+)*/g)].map((m) => m[0]))].slice(0, 64);
  if (neededLibs.length) findings.push({ kind: 'elf.needed', detail: neededLibs });

  const hasGnuStack = buffer.includes(Buffer.from('.note.GNU-stack'));
  const hasRelro = buffer.includes(Buffer.from('GNU_RELRO'));
  const dynType = ['NONE', 'REL', 'EXEC', 'DYN', 'CORE'][r16(16)] || r16(16);
  const text = buffer.toString('latin1');
  findings.push({ kind: 'elf.mitigations', detail: { pie: dynType === 'DYN', nx: hasGnuStack, relro: hasRelro, canary: /\b__stack_chk_fail\b/.test(text), fortify: /\b__.*_chk\b/.test(text) } });

  const symbols: Array<{ name: string; value: number; type: string }> = [];
  const sections2 = [];
  for (let i = 0; i < Math.min(shnum, 128); i++) sections2.push(readSection(i));
  for (const section of sections2) {
    if ((section.type === 2 || section.type === 11) && section.entsize) {
      const strSection = section.link < shnum ? readSection(section.link) : null;
      const count = Math.floor(section.size / (is64 ? 24 : 16));
      for (let i = 0; i < Math.min(count, 2000); i++) {
        const base = section.offset + i * (is64 ? 24 : 16);
        const nameOff = r32(base);
        const value = is64 ? r64(base + 8) : r32(base + 4);
        const info = buffer[base + (is64 ? 4 : 12)];
        let name = '';
        if (strSection) { const s = strSection.offset + nameOff; let e = s; while (e < buffer.length && buffer[e] !== 0) e++; name = buffer.slice(s, Math.min(e, s + 200)).toString('utf8'); }
        if (name) symbols.push({ name, value, type: section.type === 2 ? 'sym' : 'dynsym' });
      }
    }
  }
  if (symbols.length) findings.push({ kind: 'elf.symbols', detail: symbols.slice(0, 500) });
}

function parsePe(buffer: Buffer, findings: Finding[]): void {
  const peOffset = buffer.readUInt32LE(0x3c);
  if (buffer.slice(peOffset, peOffset + 4).toString('ascii') !== 'PE\0\0') return;
  const machine = buffer.readUInt16LE(peOffset + 4); const sectionCount = buffer.readUInt16LE(peOffset + 6);
  const optionalSize = buffer.readUInt16LE(peOffset + 20);
  const optionalMagic = buffer.readUInt16LE(peOffset + 24); const is64 = optionalMagic === 0x20b;
  const dllCharacteristics = buffer.readUInt16LE(peOffset + 24 + (is64 ? 70 : 70));
  findings.push({ kind: 'pe.header', detail: { machine, sections: sectionCount, arch: is64 ? 'x64' : 'x86', subsystem: buffer.readUInt16LE(peOffset + 24 + 68) } });
  findings.push({ kind: 'pe.mitigations', detail: { aslr: !!(dllCharacteristics & 0x40), dep: !!(dllCharacteristics & 0x100), cfg: !!(dllCharacteristics & 0x4000), highEntropyVa: !!(dllCharacteristics & 0x20), seh: !!(dllCharacteristics & 0x400) } });

  const sectionTable = peOffset + 24 + optionalSize;
  const sections: Array<{ name: string; virtualSize: number; rawSize: number; entropy: number; virtualAddress: number; rawPtr: number }> = [];
  for (let i = 0; i < sectionCount; i++) {
    const base = sectionTable + i * 40;
    const name = buffer.slice(base, base + 8).toString('ascii').replace(/\0+$/, '');
    const virtualSize = buffer.readUInt32LE(base + 8); const virtualAddress = buffer.readUInt32LE(base + 12);
    const rawSize = buffer.readUInt32LE(base + 16); const rawPtr = buffer.readUInt32LE(base + 20);
    sections.push({ name, virtualSize, rawSize, virtualAddress, rawPtr, entropy: rawSize ? entropy(buffer.slice(rawPtr, rawPtr + rawSize)) : 0 });
  }
  findings.push({ kind: 'pe.sections', detail: sections.map(({ name, virtualSize, rawSize, entropy: e }) => ({ name, virtualSize, rawSize, entropy: e })) });

  const dataDirOffset = peOffset + 24 + (is64 ? 112 : 96);
  const importRva = buffer.readUInt32LE(dataDirOffset + 8);
  const rvaToOffset = (rva: number): number => {
    for (const section of sections) {
      const vsize = Math.max(section.rawSize, section.virtualSize);
      if (rva >= section.virtualAddress && rva < section.virtualAddress + vsize) return section.rawPtr + (rva - section.virtualAddress);
    }
    return rva;
  };
  const imports: Array<{ dll: string; functions: string[] }> = [];
  if (importRva && importRva < buffer.length) {
    let offset = rvaToOffset(importRva);
    for (let i = 0; i < 64 && offset + 20 <= buffer.length; i++) {
      const nameRva = buffer.readUInt32LE(offset + 12);
      if (!nameRva) break;
      const nameOff = rvaToOffset(nameRva);
      let end = nameOff; while (end < buffer.length && buffer[end] !== 0) end++;
      const dll = buffer.slice(nameOff, end).toString('ascii');
      const thunkRva = buffer.readUInt32LE(offset);
      const functions: string[] = [];
      if (thunkRva) {
        let to = rvaToOffset(thunkRva);
        for (let j = 0; j < 200 && to + (is64 ? 8 : 4) <= buffer.length; j++) {
          const thunk = is64 ? Number(buffer.readBigUInt64LE(to)) : buffer.readUInt32LE(to);
          if (!thunk) break;
          const hintName = rvaToOffset(thunk + 2);
          if (hintName < buffer.length) { let e = hintName; while (e < buffer.length && buffer[e] !== 0) e++; functions.push(buffer.slice(hintName, e).toString('ascii')); }
          to += is64 ? 8 : 4;
        }
      }
      imports.push({ dll, functions });
      offset += 20;
    }
  }
  if (imports.length) findings.push({ kind: 'pe.imports', detail: imports });
  if (buffer.includes(Buffer.from('BSJB'))) parseDotNet(buffer, findings);
}

function parseMacho(buffer: Buffer, findings: Finding[]): void {
  const magic = buffer.readUInt32BE(0);
  const is64 = magic === 0xfeedfacf || magic === 0xcffaedfe;
  const le = magic === 0xfeedface || magic === 0xfeedfacf;
  const r32 = (o: number) => (le ? buffer.readUInt32LE(o) : buffer.readUInt32BE(o));
  const r64 = (o: number) => Number(le ? buffer.readBigUInt64LE(o) : buffer.readBigUInt64BE(o));
  const cpuType = r32(4); const fileType = r32(8); const ncmds = r32(16);
  findings.push({ kind: 'macho.header', detail: { is64, cpuType, fileType: ['OBJECT', 'EXECUTE', 'FVMLIB', 'CORE', 'PRELOAD', 'DYLIB', 'DYLINKER', 'BUNDLE'][fileType] || fileType, ncmds } });
  let offset = is64 ? 32 : 28;
  const segments: Array<{ name: string; vmSize: number }> = [];
  const dylibs: string[] = [];
  for (let i = 0; i < Math.min(ncmds, 512) && offset + 8 <= buffer.length; i++) {
    const cmd = r32(offset); const cmdsize = r32(offset + 4);
    if (cmd === 0x19 && is64) {
      const name = buffer.slice(offset + 8, offset + 24).toString('ascii').replace(/\0+$/, '');
      segments.push({ name, vmSize: r64(offset + 32) });
    } else if (cmd === 0x19 || cmd === 0x1) {
      const name = buffer.slice(offset + 8, offset + 24).toString('ascii').replace(/\0+$/, '');
      segments.push({ name, vmSize: r32(offset + 32) });
    }
    if (cmd === 0xc || cmd === 0xd || cmd === 0x18 || cmd === 0x1f) {
      const nameOffset = r32(offset + (is64 ? 24 : 20));
      const start = offset + nameOffset; let end = start; while (end < buffer.length && buffer[end] !== 0) end++;
      dylibs.push(buffer.slice(Math.min(start, buffer.length), Math.min(end, start + 300)).toString('utf8'));
    }
    offset += cmdsize || 8;
  }
  findings.push({ kind: 'macho.segments', detail: segments });
  if (dylibs.length) findings.push({ kind: 'macho.dylibs', detail: dylibs });
}

function parseWasm(buffer: Buffer, findings: Finding[]): void {
  let offset = 8;
  const names = ['custom', 'type', 'import', 'function', 'table', 'memory', 'global', 'export', 'start', 'element', 'code', 'data', 'datacount'];
  const sections: Array<{ id: number; name: string; size: number }> = [];
  const imports: string[] = []; const exports: string[] = [];
  const readLeb = (): number => { let result = 0; let shift = 0; let byte = 0; do { byte = buffer[offset++]; result |= (byte & 0x7f) << shift; shift += 7; } while (byte & 0x80); return result; };
  while (offset < buffer.length) {
    const id = buffer[offset++]; const size = readLeb(); const body = buffer.slice(offset, offset + size);
    sections.push({ id, name: names[id] || `section${id}`, size });
    if (id === 2) { let p = 0; const count = body[p++]; for (let i = 0; i < count && p < body.length; i++) { const modLen = body[p++]; const mod = body.slice(p, p + modLen).toString('utf8'); p += modLen; const nameLen = body[p++]; const name = body.slice(p, p + nameLen).toString('utf8'); p += nameLen; imports.push(`${mod}.${name}`); p++; } }
    if (id === 7) { let p = 0; const count = body[p++]; for (let i = 0; i < count && p < body.length; i++) { const nameLen = body[p++]; exports.push(body.slice(p, p + nameLen).toString('utf8')); p += nameLen; p++; while (body[p] & 0x80) p++; p++; } }
    offset += size;
  }
  findings.push({ kind: 'wasm.sections', detail: sections });
  if (imports.length) findings.push({ kind: 'wasm.imports', detail: imports });
  if (exports.length) findings.push({ kind: 'wasm.exports', detail: exports });
}

function parseZip(buffer: Buffer, findings: Finding[], label: string): void {
  try {
    const entries = buildZipRead(buffer).map((entry) => ({ name: entry.name, size: entry.size }));
    findings.push({ kind: `${label}.entries`, detail: entries.slice(0, 500) });
  } catch { }
}

function parseGoBuildInfo(buffer: Buffer, findings: Finding[]): void {
  const text = buffer.toString('latin1');
  const version = /go1\.\d+(\.\d+)?/.exec(text)?.[0];
  if (!version) return;
  const deps = new Set<string>();
  for (const m of text.matchAll(/\b([a-z0-9.-]+\.[a-z]{2,}\/[A-Za-z0-9_./-]+)@v?(\d+\.[0-9A-Za-z.+-]+)/g)) { deps.add(`${m[1]}@${m[2]}`); if (deps.size >= 300) break; }
  findings.push({ kind: 'go.buildinfo', detail: { goVersion: version, modules: [...deps] } });
}
function parseRustAuditable(buffer: Buffer, findings: Finding[]): void {
  const text = buffer.toString('latin1');
  if (!/(rustc|cargo|rust_begin_unwind|core::panicking|cargo-auditable)/.test(text)) return;
  const crates = new Set<string>();
  for (const m of text.matchAll(/([a-z0-9_-]+)-([0-9]+\.[0-9]+\.[0-9]+)/g)) { if (m[1].length > 2) crates.add(`${m[1]}@${m[2]}`); if (crates.size >= 300) break; }
  if (crates.size >= 5) findings.push({ kind: 'rust.crates', detail: [...crates] });
}

function parseDotNet(buffer: Buffer, findings: Finding[]): void {
  const text = buffer.toString('latin1');
  const refs = new Set<string>();
  for (const m of text.matchAll(/([A-Za-z0-9_.]+),\s*Version=([0-9.]+)/g)) { refs.add(`${m[1]}@${m[2]}`); if (refs.size >= 200) break; }
  if (refs.size) findings.push({ kind: 'dotnet.references', detail: [...refs] });
  const types = new Set<string>();
  for (const m of text.matchAll(/\b([A-Z][A-Za-z0-9_]*(?:\.[A-Z][A-Za-z0-9_]*)+)\b/g)) { if (/System\.|Microsoft\./.test(m[1]) || m[1].split('.').length >= 3) types.add(m[1]); if (types.size >= 400) break; }
  if (types.size) findings.push({ kind: 'dotnet.types', detail: [...types].slice(0, 300) });
  findings.push({ kind: 'dotnet.metadata', detail: { present: buffer.includes(Buffer.from('BSJB')) } });
}

function parseSqlite(buffer: Buffer, findings: Finding[]): void {
  const pageSize = buffer.readUInt16BE(16) || 4096; const enc = buffer.readUInt32BE(56);
  findings.push({ kind: 'sqlite.header', detail: { pageSize, encoding: enc === 1 ? 'utf8' : enc === 2 ? 'utf16le' : enc === 3 ? 'utf16be' : String(enc) } });
  const text = buffer.toString('latin1');
  const tables = new Set<string>();
  for (const m of text.matchAll(/CREATE TABLE\s+["'`\[]?([A-Za-z0-9_]+)/gi)) tables.add(m[1]);
  if (tables.size) findings.push({ kind: 'sqlite.tables', detail: [...tables].slice(0, 300) });
  const indexes = new Set<string>();
  for (const m of text.matchAll(/CREATE (?:UNIQUE )?INDEX\s+["'`\[]?([A-Za-z0-9_]+)/gi)) indexes.add(m[1]);
  if (indexes.size) findings.push({ kind: 'sqlite.indexes', detail: [...indexes] });
}

function analyzeJavaScript(source: string, findings: Finding[]): void {
  const imports = new Set<string>(); const requires = new Set<string>();
  for (const m of source.matchAll(/(?:^|\n)\s*import\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/g)) imports.add(m[1]);
  for (const m of source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) requires.add(m[1]);
  for (const m of source.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) imports.add(m[1]);
  findings.push({ kind: 'javascript.imports', detail: [...imports] });
  findings.push({ kind: 'javascript.requires', detail: [...requires] });
  const ipc = new Set<string>();
  for (const m of source.matchAll(/ipcRenderer\.(?:invoke|send|on)\(\s*['"]([^'"]+)['"]/g)) ipc.add(m[1]);
  for (const m of source.matchAll(/ipcMain\.(?:handle|on)\(\s*['"]([^'"]+)['"]/g)) ipc.add(m[1]);
  if (ipc.size) findings.push({ kind: 'javascript.electron.ipc', detail: [...ipc] });
  const routes = new Set<string>();
  for (const m of source.matchAll(/\.(?:get|post|put|delete|patch)\(\s*['"]([^'"]+)['"]/g)) routes.add(m[1]);
  if (routes.size) findings.push({ kind: 'javascript.routes', detail: [...routes].slice(0, 200) });
  if (/sourceMappingURL=/.test(source)) findings.push({ kind: 'javascript.sourcemap', detail: /sourceMappingURL=([^\s*]+)/.exec(source)?.[1] });
}

function parsePcap(buffer: Buffer, findings: Finding[]): void {
  const le = buffer.readUInt32BE(0) !== 0xa1b2c3d4;
  const r32 = (o: number) => (le ? buffer.readUInt32LE(o) : buffer.readUInt32BE(o));
  const network = r32(20);
  findings.push({ kind: 'pcap.header', detail: { linkType: network, endianness: le ? 'little' : 'big' } });
  let offset = 24; const endpoints = new Set<string>(); const dns = new Set<string>(); let packets = 0;
  while (offset + 16 <= buffer.length && packets < 20000) {
    const inclLen = r32(offset + 8); offset += 16;
    if (offset + inclLen > buffer.length) break;
    const frame = buffer.slice(offset, offset + inclLen); offset += inclLen; packets++;
    if (inclLen >= 34 && network === 1) {
      const ipStart = 14;
      const src = `${frame[ipStart + 12]}.${frame[ipStart + 13]}.${frame[ipStart + 14]}.${frame[ipStart + 15]}`;
      const dst = `${frame[ipStart + 16]}.${frame[ipStart + 17]}.${frame[ipStart + 18]}.${frame[ipStart + 19]}`;
      endpoints.add(`${src} -> ${dst}`);
      if (frame[ipStart + 9] === 17) {
        const udpStart = ipStart + 20;
        const dport = (frame[udpStart + 2] << 8) | frame[udpStart + 3];
        if (dport === 53) {
          let p = udpStart + 8 + 12; let name = '';
          while (p < frame.length && frame[p] !== 0) { const len = frame[p]; name += frame.slice(p + 1, p + 1 + len).toString('ascii') + '.'; p += 1 + len; }
          if (name) dns.add(name.replace(/\.$/, ''));
        }
      }
    }
  }
  findings.push({ kind: 'pcap.summary', detail: { packets, endpoints: [...endpoints].slice(0, 300), dns: [...dns].slice(0, 200) } });
}

function extractIocs(text: string): Record<string, string[]> {
  const urls = [...new Set([...text.matchAll(/https?:\/\/[^\s"'<>)]+/g)].map((m) => m[0]))].slice(0, 100);
  const ips = [...new Set([...text.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)].map((m) => m[0]))].slice(0, 100);
  const domains = [...new Set([...text.matchAll(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\.(?:com|net|org|io|cn|ru|onion|xyz|top)\b/gi)].map((m) => m[0]))].slice(0, 100);
  const emails = [...new Set([...text.matchAll(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g)].map((m) => m[0]))].slice(0, 100);
  const hashes = [...new Set([...text.matchAll(/\b[a-f0-9]{32,64}\b/gi)].map((m) => m[0]))].slice(0, 100);
  return { urls, ips, domains, emails, hashes };
}

async function runProvider(format: string, filePath: string, options: AnalyzeOptions, signal?: AbortSignal): Promise<Finding[]> {
  const findings: Finding[] = [];
  const provider = options.provider || 'auto';
  if (provider === 'none') return findings;

  if (provider === 'ghidra' || (provider === 'auto' && ['elf', 'pe', 'pe-dotnet', 'macho'].includes(format))) {
    const ghidra = await resolveCli('ghidra');
    if (ghidra.available) {
      const outDir = await fs.mkdtemp(path.join((await import('os')).tmpdir(), '0kay-ghidra-'));
      const args = [path.dirname(ghidra.command.split(' ')[0]), '-import', filePath, '-postScript', 'ExportDecompiler.py', outDir, '-deleteProject'];
      const result = await runCli(ghidra.command, [ '-import', filePath, '-analyzeHeadless', outDir, 'temp', '-deleteProject' ], { timeout: 300_000, signal, maxBuffer: 32 * 1024 * 1024 }).catch(() => null);
      findings.push({ kind: 'provider.ghidra', detail: { ran: !!result, exit: result?.code, note: 'Ghidra headless run; pseudocode output depends on project scripts', args } });
    }
  }
  if (provider === 'jadx' || (provider === 'auto' && (format === 'apk' || format === 'jar'))) {
    const jadx = await resolveCli('jadx');
    if (jadx.available) {
      const outDir = await fs.mkdtemp(path.join((await import('os')).tmpdir(), '0kay-jadx-'));
      const result = await runCli(jadx.command, ['-d', outDir, '-q', filePath], { timeout: 300_000, signal, maxBuffer: 32 * 1024 * 1024 }).catch(() => null);
      let decompiled: string[] = [];
      try { decompiled = (await fs.readdir(outDir, { recursive: true })).filter((f) => String(f).endsWith('.java')).map(String).slice(0, 200); } catch { }

      const sources: Array<{ file: string; code: string }> = [];
      for (const file of decompiled.slice(0, 6)) {
        try {
          const code = await fs.readFile(path.join(outDir, file), 'utf8');
          sources.push({ file, code: code.slice(0, 4_000) });
        } catch { }
      }

      findings.push({
        kind: 'provider.jadx',
        detail: {
          ran: !!result,
          exit: result?.code,
          outDir,
          javaFileCount: decompiled.length,
          javaFiles: decompiled.slice(0, 60),
          sources,
          ...(result?.code ? { stderr: String(result.stderr || '').slice(0, 2_000) } : {}),
        },
      });
    } else {
      findings.push({ kind: 'provider.jadx', detail: { ran: false, note: 'jadx not installed; used the built-in class-file analyser. Run setup_deps to install jadx for full source recovery.' } });
    }
  }
  if (provider === 'objdump' || (provider === 'auto' && ['elf', 'pe', 'macho'].includes(format) && options.functionName)) {
    const objdump = await resolveCli('objdump');
    if (objdump.available) {
      const args = options.functionName ? ['-d', '--start-address=0', filePath] : ['-h', filePath];
      const result = await runCli(objdump.command, args, { timeout: 120_000, signal, maxBuffer: 32 * 1024 * 1024 }).catch(() => null);
      if (result && result.code === 0) findings.push({ kind: 'provider.objdump', detail: { text: result.stdout.slice(0, 60000) } });
    }
  }
  return findings;
}

export class ReverseEngineerTool extends Tool {
  get name(): string { return 'reverse_engineer'; }
  get description(): string {
    return [
      'Statically analyze a binary/bundle and report structure with evidence (full REA static surface).',
      'Parses ELF (headers/sections/symbols/needed/mitigations), PE/.NET (imports/exports/sections/CLR), Mach-O, WASM, ASAR/ZIP/APK/JAR, SQLite, PCAP, JavaScript/Electron.',
      'Reports Go build info, Rust crates, .NET references/types, mitigations, per-section entropy, strings with offsets, and extracted IOCs.',
      'provider:auto runs ghidra/jadx/objdump decompilation when installed (run setup_deps to check). path may be a file or a directory (inventory).',
      'Read-only: the target is never executed. Only analyze artifacts you are authorized to inspect.',
    ].join('\n');
  }
  get parameters(): Record<string, any> {
    return { type: 'object', required: ['path'], properties: {
      path: { type: 'string', description: 'File to analyze, or a directory to inventory.' },
      includeStrings: { type: 'boolean' }, minStringLength: { type: 'integer', minimum: 4, maximum: 32 }, stringLimit: { type: 'integer', minimum: 1, maximum: 5000 },
      provider: { type: 'string', enum: ['auto', 'ghidra', 'jadx', 'objdump', 'none'], description: 'Deeper analysis provider; default auto.' },
      functionName: { type: 'string', description: 'Focus a provider disassembly on a function (objdump).' },
      out: { type: 'string' },
    }};
  }

  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    try {
      const target = path.resolve(context.cwd, String(args.path || ''));
      const stat = await fs.stat(target);
      const findings: Finding[] = [];
      const options: AnalyzeOptions = { includeStrings: args.includeStrings !== false, minStringLength: clamp(args.minStringLength, 6, 4, 32), stringLimit: clamp(args.stringLimit, 400, 1, 5000), provider: ['auto', 'ghidra', 'jadx', 'objdump', 'none'].includes(args.provider) ? args.provider : 'auto', functionName: typeof args.functionName === 'string' ? args.functionName : undefined };

      if (stat.isDirectory()) {
        const files: Array<{ path: string; format: string; size: number }> = [];
        const byFormat: Record<string, number> = {};
        const walkDir = async (dir: string, depth: number): Promise<void> => {
          if (depth > 8 || files.length >= 5000) return;
          const entries = await fs.readdir(dir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.name === '.git' || entry.name === 'node_modules') continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { await walkDir(full, depth + 1); continue; }
            const buffer = await fs.readFile(full).catch(() => null);
            const format = buffer ? detectFormat(buffer, full) : 'unreadable';
            byFormat[format] = (byFormat[format] || 0) + 1;
            files.push({ path: path.relative(target, full).replace(/\\/g, '/'), format, size: buffer?.length || 0 });
          }
        };
        await walkDir(target, 0);
        findings.push({ kind: 'directory.inventory', detail: { root: target, byFormat, files: files.slice(0, 1000) } });
        const limited = limitOutput(JSON.stringify({ root: target, byFormat, files: files.slice(0, 1000), truncated: files.length > 1000 }));
        let outPath: string | undefined;
        if (typeof args.out === 'string' && args.out.trim()) { outPath = path.resolve(context.cwd, args.out); await fs.mkdir(path.dirname(outPath), { recursive: true }); await fs.writeFile(outPath, limited.text, 'utf8'); }
        return success({ root: target, byFormat, files: files.slice(0, 1000), ...(outPath ? { out: outPath } : {}) });
      }

      const buffer = await fs.readFile(target);
      const format = detectFormat(buffer, target);
      const summary: Record<string, any> = { path: target, size: stat.size, format };

      if (format === 'elf') parseElf(buffer, findings);
      else if (format === 'pe' || format === 'pe-dotnet') { parsePe(buffer, findings); if (format === 'pe-dotnet' || buffer.includes(Buffer.from('BSJB'))) parseDotNet(buffer, findings); }
      else if (format === 'macho') parseMacho(buffer, findings);
      else if (format === 'wasm') { parseWasm(buffer, findings); const wasm2wat = await resolveCli('wabt'); if (wasm2wat.available && options.provider !== 'none') { const { runCli: run } = await import('./deps.js'); const r = await run(wasm2wat.command === 'wasm2wat' ? 'wasm2wat' : wasm2wat.command, [target], { timeout: 60000, signal: context.signal }).catch(() => null); if (r?.stdout) findings.push({ kind: 'wasm.wat', detail: r.stdout.slice(0, 60000) }); } }
      else if (format === 'sqlite') parseSqlite(buffer, findings);
      else if (format === 'pcap') parsePcap(buffer, findings);
      else if (['zip', 'asar', 'apk', 'jar'].includes(format)) {
        if (format === 'jar' || format === 'apk') analyzeJar(buffer, findings, format);
        else parseZip(buffer, findings, format);
      }

      if (format === 'elf' || format === 'pe' || format === 'pe-dotnet') { parseGoBuildInfo(buffer, findings); parseRustAuditable(buffer, findings); }
      if (format === 'javascript') analyzeJavaScript(buffer.toString('utf8'), findings);

      if (options.includeStrings) {
        const strings = extractStrings(buffer, options.minStringLength, options.stringLimit);
        summary.stringCount = strings.length;
        findings.push({ kind: 'strings', detail: strings });
        findings.push({ kind: 'iocs', detail: extractIocs(strings.map((s) => s.text).join('\n')) });
      }

      const providerFindings = await runProvider(format, target, options, context.signal);
      findings.push(...providerFindings);

      const payload = { ...summary, findings };
      const limited = limitOutput(JSON.stringify(payload));
      let outPath: string | undefined;
      if (typeof args.out === 'string' && args.out.trim()) { outPath = path.resolve(context.cwd, args.out); await fs.mkdir(path.dirname(outPath), { recursive: true }); await fs.writeFile(outPath, limited.text, 'utf8'); }
      return success({ ...payload, ...(outPath ? { out: outPath } : {}), truncated: limited.truncated });
    } catch (error) { return failure(error); }
  }
}
