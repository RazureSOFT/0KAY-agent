import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'zlib';
import { analyzeJar, entryBytes, parseClassFile, parseManifest } from './jar_analysis.js';
import { buildZipRead } from './zip_read.js';

/**
 * Build a structurally valid JVM class file. Enough of one for the constant-pool
 * parser: this/super class, one field, one method, and a couple of interesting
 * strings. Hand-built so the test needs no JDK.
 */
function buildClassFile(options: {
  name?: string;
  superName?: string;
  methodName?: string;
  interesting?: string[];
} = {}): Buffer {
  const name = options.name ?? 'tech/arrbrants/MioFucker';
  const superName = options.superName ?? 'java/lang/Object';
  const methodName = options.methodName ?? 'exec';
  const interesting = options.interesting ?? [];

  const utf8s: string[] = [];
  const addUtf8 = (value: string): number => {
    utf8s.push(value);
    return utf8s.length; // pool index of the Utf8 (offset by +1 below)
  };

  // Reserve pool layout: Utf8 entries first, then Class/NameAndType/Methodref.
  const superUtf8 = addUtf8(superName);
  const thisUtf8 = addUtf8(name);
  const methodUtf8 = addUtf8(methodName);
  const descriptorUtf8 = addUtf8('(Ljava/lang/String;)Ljava/lang/Process;');
  const runtimeUtf8 = addUtf8('java/lang/Runtime');
  const stringUtf8s = interesting.map((value) => addUtf8(value));

  const base = utf8s.length; // next index after the Utf8 block
  const superClassIdx = base + 1;
  const thisClassIdx = base + 2;
  const runtimeClassIdx = base + 3;
  const nameAndTypeIdx = base + 4;
  const methodRefIdx = base + 5;
  const stringClassIdxs = interesting.map((_, i) => base + 6 + i);

  const pool: Buffer[] = [];
  const u1 = (v: number) => Buffer.from([v]);
  const u2 = (v: number) => { const b = Buffer.alloc(2); b.writeUInt16BE(v); return b; };

  for (const value of utf8s) {
    const bytes = Buffer.from(value, 'utf8');
    pool.push(Buffer.concat([u1(1), u2(bytes.length), bytes]));
  }
  pool.push(Buffer.concat([u1(7), u2(superUtf8)]));              // Class super
  pool.push(Buffer.concat([u1(7), u2(thisUtf8)]));               // Class this
  pool.push(Buffer.concat([u1(7), u2(runtimeUtf8)]));            // Class Runtime
  pool.push(Buffer.concat([u1(12), u2(methodUtf8), u2(descriptorUtf8)])); // NameAndType
  pool.push(Buffer.concat([u1(10), u2(runtimeClassIdx), u2(nameAndTypeIdx)])); // Methodref
  for (const stringUtf8 of stringUtf8s) {
    pool.push(Buffer.concat([u1(8), u2(stringUtf8)]));           // String
  }
  void stringClassIdxs;

  const constantPool = Buffer.concat(pool);
  const count = 1 + pool.length;

  const header = Buffer.concat([u2(0xCAFE), u2(0xBABE), u2(0), u2(52), u2(count)]);
  const classInfo = Buffer.concat([u2(0x0021), u2(thisClassIdx), u2(superClassIdx), u2(0)]); // no interfaces

  // one field: private static String key;
  const field = Buffer.concat([u2(0x000A), u2(methodUtf8), u2(descriptorUtf8), u2(0)]);
  // one method: public void exec(String)
  const method = Buffer.concat([u2(0x0001), u2(methodUtf8), u2(descriptorUtf8), u2(0)]);

  return Buffer.concat([header, constantPool, classInfo, u2(1), field, u2(1), method, u2(0)]);
}

/** Build a ZIP archive with stored (uncompressed) entries. */
function buildZip(entries: Array<{ name: string; data: Buffer; deflate?: boolean }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const payload = entry.deflate ? deflateRawSync(entry.data) : entry.data;
    const method = entry.deflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 14); // crc (unchecked by the reader)
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBytes, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);

    offset += 30 + nameBytes.length + payload.length;
  }

  const centralDir = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDir, eocd]);
}

test('parseClassFile reads the structure the analyser needs', () => {
  const info = parseClassFile(buildClassFile({ interesting: ['https://example.test/beacon'] }));
  assert.ok(info, 'should parse');
  assert.equal(info.name, 'tech/arrbrants/MioFucker');
  assert.equal(info.superName, 'java/lang/Object');
  assert.equal(info.major, 52);
  assert.equal(info.methods.length, 1);
  assert.equal(info.methods[0].name, 'exec');
  assert.equal(info.fields.length, 1);
  // Referenced classes come from Class entries AND from method descriptors.
  assert.ok(info.references.includes('java/lang/Runtime'));
  assert.ok(info.interestingStrings.includes('https://example.test/beacon'));
});

test('parseClassFile rejects non-class data instead of throwing', () => {
  assert.equal(parseClassFile(Buffer.from('not a class')), null);
  assert.equal(parseClassFile(Buffer.alloc(0)), null);
  // Correct magic, truncated body.
  const truncated = buildClassFile().slice(0, 40);
  assert.equal(parseClassFile(truncated), null);
});

test('parseManifest reads main-section attributes and continuations', () => {
  const manifest = [
    'Manifest-Version: 1.0',
    'Main-Class: nick.Loader',
    'Fabric-Loom-Version: 1.10.5',
    'Implementation-Title: mio',
    '   -continued',
    '',
    'Name: other-section',
    'Main-Class: ignored',
  ].join('\r\n');
  const attributes = parseManifest(manifest);
  assert.equal(attributes['Main-Class'], 'nick.Loader');
  assert.equal(attributes['Fabric-Loom-Version'], '1.10.5');
  assert.equal(attributes['Implementation-Title'], 'mio-continued');
});

test('entryBytes inflates deflate and passes through stored entries', () => {
  const text = Buffer.from('hello world '.repeat(50));
  const zip = buildZip([
    { name: 'stored.txt', data: text },
    { name: 'deflated.txt', data: text, deflate: true },
  ]);
  const entries = buildZipRead(zip);
  for (const entry of entries) {
    assert.deepEqual(entryBytes(entry), text, `${entry.name} should round-trip`);
  }
});

test('analyzeJar extracts manifest, class structure and entry points', () => {
  const findings: Array<{ kind: string; detail: any }> = [];
  const zip = buildZip([
    {
      name: 'META-INF/MANIFEST.MF',
      data: Buffer.from('Manifest-Version: 1.0\r\nMain-Class: tech/arrbrants/MioFucker\r\n\r\n'),
    },
    { name: 'tech/arrbrants/MioFucker.class', data: buildClassFile({ interesting: ['https://example.test/beacon'] }) },
    { name: 'assets/icon.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
  ]);

  analyzeJar(zip, findings);

  const kinds = findings.map((finding) => finding.kind);
  assert.ok(kinds.includes('jar.entries'));
  assert.ok(kinds.includes('jar.manifest'));
  assert.ok(kinds.includes('jar.classes'), `got: ${kinds.join(', ')}`);

  const manifest = findings.find((finding) => finding.kind === 'jar.manifest')!;
  assert.equal(manifest.detail['Main-Class'], 'tech/arrbrants/MioFucker');

  const classes = findings.find((finding) => finding.kind === 'jar.classes')!;
  assert.equal(classes.detail.count, 1);
  assert.equal(classes.detail.parsed, 1);
  assert.equal(classes.detail.summary[0].name, 'tech/arrbrants/MioFucker');

  // The manifest's Main-Class must be surfaced with its methods.
  const entrypoint = findings.find((finding) => finding.kind === 'jar.entrypoint');
  assert.ok(entrypoint, 'Main-Class should be reported as an entry point');
  assert.ok(entrypoint!.detail.methods.some((method: string) => method.startsWith('exec')));
});

test('analyzeJar follows a nested jar and analyses its classes', () => {
  const inner = buildZip([
    { name: 'com/hidden/Payload.class', data: buildClassFile({ name: 'com/hidden/Payload' }) },
  ]);
  const outer = buildZip([
    { name: 'META-INF/jars/mio.jar', data: inner },
    { name: 'fabric.mod.json', data: Buffer.from(JSON.stringify({ id: 'mio', version: '1.0', entrypoints: { main: ['nick.Loader'] } })) },
  ]);

  const findings: Array<{ kind: string; detail: any }> = [];
  analyzeJar(outer, findings);

  const mod = findings.find((finding) => finding.kind === 'jar.mod')!;
  assert.equal(mod.detail.id, 'mio');
  assert.deepEqual(mod.detail.entrypoints, { main: ['nick.Loader'] });

  const nested = findings.find((finding) => finding.kind === 'jar.nested')!;
  assert.deepEqual(nested.detail, ['META-INF/jars/mio.jar']);

  // The nested archive's class is parsed, not just listed.
  const nestedClasses = findings.find((finding) => finding.kind === 'jar.nested:META-INF/jars/mio.jar.classes');
  assert.ok(nestedClasses, `got: ${findings.map((f) => f.kind).join(', ')}`);
  assert.equal(nestedClasses!.detail.summary[0].name, 'com/hidden/Payload');
});

test('analyzeJar reports protection markers and opaque payloads', () => {
  const bins = Array.from({ length: 6 }, (_, i) => ({ name: `mio/${i}.bin`, data: Buffer.from([i, i, i]) }));
  const zip = buildZip([
    { name: '.PROTECTED BY ARRSHIELD.class', data: buildClassFile({ name: 'protected' }) },
    ...bins,
  ]);
  const findings: Array<{ kind: string; detail: any }> = [];
  analyzeJar(zip, findings);

  const protection = findings.find((finding) => finding.kind === 'jar.protection');
  assert.ok(protection, 'ARR SHIELD marker should be reported');
  // The entry name spells it without a space; both spellings are markers.
  assert.ok(protection!.detail.markers.some((marker: string) => /ARRSHIELD|ARR SHIELD/.test(marker)));

  const payload = findings.find((finding) => finding.kind === 'jar.payload');
  assert.ok(payload, 'a cluster of .bin payloads should be reported');
  assert.equal(payload!.detail.count, 6);
});

test('analyzeJar survives a corrupt archive', () => {
  const findings: Array<{ kind: string; detail: any }> = [];
  analyzeJar(Buffer.from('PK\x03\x04 but not really a zip'), findings);
  // Must not throw; reporting nothing useful is acceptable, crashing is not.
  assert.ok(Array.isArray(findings));
});