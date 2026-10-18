/**
 * JAR / Android-container analysis for the `reverse_engineer` tool.
 *
 * Why this exists: `reverse_engineer` used to route `.jar` through `parseZip`,
 * which only listed entry names. Nothing was decompiled, the manifest was
 * ignored, and a nested `META-INF/jars/*.jar` was invisible. So a jar "analysis"
 * returned a file listing and looked, correctly, as though the RE path had not
 * run at all.
 *
 * This module is the self-implemented path (no external decompiler): it reads the
 * JVM class-file constant pool, which yields the class name, superclass,
 * interfaces, field/method names and descriptors, and every class referenced by
 * name. That is the structural map a human reads first, and it works offline.
 * `jadx` is still used when present for full source recovery.
 */

import { inflateRawSync } from 'zlib';
import { buildZipRead, type ZipReadEntry } from './zip_read.js';

export interface Finding { kind: string; detail: any; }

/** Entries we are willing to inflate while analysing one archive. */
const MAX_INFLATED_ENTRIES = 400;
/** Classes parsed per archive (constant-pool parsing is cheap but unbounded input is not). */
const MAX_CLASSES = 250;
/** Nested jars followed inside one archive. */
const MAX_NESTED_JARS = 8;
/** Bytes per entry we will inflate. A jar bomb is otherwise trivial. */
const MAX_ENTRY_BYTES = 8 * 1024 * 1024;

/** Return an entry's uncompressed bytes, or null when it is not worth inflating. */
export function entryBytes(entry: ZipReadEntry): Buffer | null {
  if (entry.size > MAX_ENTRY_BYTES) return null;
  if (entry.method === 0) return entry.data;
  if (entry.method !== 8) return null;
  try {
    return inflateRawSync(entry.data, { maxOutputLength: MAX_ENTRY_BYTES });
  } catch {
    return null;
  }
}

export interface ClassFileInfo {
  /** Internal name, e.g. `tech/arrbrants/MioFucker`. */
  name: string;
  superName: string;
  interfaces: string[];
  access: number;
  major: number;
  minor: number;
  fields: Array<{ name: string; descriptor: string; access: number }>;
  methods: Array<{ name: string; descriptor: string; access: number }>;
  /** Classes referenced from the constant pool, de-duplicated and sorted. */
  references: string[];
  /** Utf8 constants that look like URLs / hosts / paths rather than identifiers. */
  interestingStrings: string[];
}

const CP_UTF8 = 1;
const CP_INTEGER = 3;
const CP_FLOAT = 4;
const CP_LONG = 5;
const CP_DOUBLE = 6;
const CP_CLASS = 7;
const CP_STRING = 8;
const CP_FIELDREF = 9;
const CP_METHODREF = 10;
const CP_INTERFACE_METHODREF = 11;
const CP_NAME_AND_TYPE = 12;
const CP_METHOD_HANDLE = 15;
const CP_METHOD_TYPE = 16;
const CP_DYNAMIC = 17;
const CP_INVOKE_DYNAMIC = 18;
const CP_MODULE = 19;
const CP_PACKAGE = 20;

const UTF8_MODIFIED = 2;

function readUtf8(data: Buffer, start: number, length: number): string {
  // Modified UTF-8 (JVMS 4.4.7) differs from standard UTF-8 only for NUL
  // (encoded as C0 80) and supplementary characters (surrogate pairs). For the
  // identifiers and descriptors we extract, a lenient decode is sufficient and
  // cannot throw.
  try {
    return data.toString('utf8', start, start + length).replace(/\u0000/g, '');
  } catch {
    return '';
  }
}

/**
 * Parse a JVM class file's constant pool and structure.
 * Returns null for anything that is not a well-formed class file.
 */
export function parseClassFile(data: Buffer): ClassFileInfo | null {
  if (data.length < 10) return null;
  if (data.readUInt32BE(0) !== 0xcafebabe) return null;

  const minor = data.readUInt16BE(4);
  const major = data.readUInt16BE(6);
  const count = data.readUInt16BE(8);
  if (count < 1 || count > 0xffff) return null;

  // Constant pool: index 1..count-1. Long/Double occupy two slots.
  const utf8: string[] = new Array(count);
  const classIndex: number[] = new Array(count);
  const stringIndex: number[] = new Array(count);
  const nameAndType: Array<[number, number]> = new Array(count);

  let offset = 10;
  for (let i = 1; i < count; i++) {
    if (offset + 1 > data.length) return null;
    const tag = data[offset++];
    switch (tag) {
      case CP_UTF8: {
        if (offset + 2 > data.length) return null;
        const length = data.readUInt16BE(offset);
        offset += 2;
        if (offset + length > data.length) return null;
        utf8[i] = readUtf8(data, offset, length);
        offset += length;
        break;
      }
      case CP_INTEGER:
      case CP_FLOAT:
        offset += 4;
        break;
      case CP_LONG:
      case CP_DOUBLE:
        offset += 8;
        i++; // takes two slots
        break;
      case CP_CLASS:
      case CP_STRING:
      case CP_METHOD_TYPE:
      case CP_MODULE:
      case CP_PACKAGE:
        if (offset + 2 > data.length) return null;
        if (tag === CP_CLASS) classIndex[i] = data.readUInt16BE(offset);
        else if (tag === CP_STRING) stringIndex[i] = data.readUInt16BE(offset);
        offset += 2;
        break;
      case CP_FIELDREF:
      case CP_METHODREF:
      case CP_INTERFACE_METHODREF:
      case CP_DYNAMIC:
      case CP_INVOKE_DYNAMIC:
        offset += 4;
        break;
      case CP_NAME_AND_TYPE:
        if (offset + 4 > data.length) return null;
        nameAndType[i] = [data.readUInt16BE(offset), data.readUInt16BE(offset + 2)];
        offset += 4;
        break;
      case CP_METHOD_HANDLE:
        offset += 3;
        break;
      default:
        // Unknown tag: the stream is no longer trustworthy.
        return null;
    }
    if (offset > data.length) return null;
  }

  const className = (index: number): string => {
    const target = classIndex[index];
    return target && utf8[target] ? utf8[target] : '';
  };

  const readAttributes = (): boolean => {
    if (offset + 2 > data.length) return false;
    const n = data.readUInt16BE(offset);
    offset += 2;
    for (let i = 0; i < n; i++) {
      if (offset + 6 > data.length) return false;
      const length = data.readUInt32BE(offset + 2);
      offset += 6 + length;
      if (offset > data.length) return false;
    }
    return true;
  };

  if (offset + 6 > data.length) return null;
  const access = data.readUInt16BE(offset);
  const thisClass = data.readUInt16BE(offset + 2);
  const superClass = data.readUInt16BE(offset + 4);
  offset += 6;

  if (offset + 2 > data.length) return null;
  const interfaceCount = data.readUInt16BE(offset);
  offset += 2;
  const interfaces: string[] = [];
  for (let i = 0; i < interfaceCount; i++) {
    if (offset + 2 > data.length) return null;
    const name = className(data.readUInt16BE(offset));
    if (name) interfaces.push(name);
    offset += 2;
  }

  const readMembers = (): Array<{ name: string; descriptor: string; access: number }> | null => {
    if (offset + 2 > data.length) return null;
    const n = data.readUInt16BE(offset);
    offset += 2;
    const out: Array<{ name: string; descriptor: string; access: number }> = [];
    for (let i = 0; i < n; i++) {
      if (offset + 8 > data.length) return null;
      const memberAccess = data.readUInt16BE(offset);
      const nameIndex = data.readUInt16BE(offset + 2);
      const descriptorIndex = data.readUInt16BE(offset + 4);
      offset += 6;
      if (!readAttributes()) return null;
      out.push({
        name: utf8[nameIndex] || '',
        descriptor: utf8[descriptorIndex] || '',
        access: memberAccess,
      });
    }
    return out;
  };

  const fields = readMembers();
  if (!fields) return null;
  const methods = readMembers();
  if (!methods) return null;

  const references = new Set<string>();
  const addReference = (candidate: string) => {
    if (!candidate || candidate === className(thisClass)) return;
    // Array types (`[B`, `[J`, `[Ljava/lang/Class;`) are Class entries too, but
    // they say nothing about what the class talks to.
    if (candidate.startsWith('[')) return;
    references.add(candidate);
  };
  for (let i = 1; i < count; i++) {
    if (classIndex[i]) addReference(className(i));
  }
  for (let i = 1; i < count; i++) {
    const pair = nameAndType[i];
    if (!pair) continue;
    const descriptor = utf8[pair[1]] || '';
    // A method descriptor embeds its parameter/return types: Lfoo/Bar;.
    for (const match of descriptor.matchAll(/L([\w$/]+);/g)) addReference(match[1]);
  }

  const interestingStrings = new Set<string>();
  for (let i = 1; i < count; i++) {
    const text = utf8[i];
    if (!text || text.length < 6 || text.length > 300) continue;
    if (/^(https?|wss?):\/\/|^[\w.-]+\.(com|net|org|io|cn|xyz|top|ru)\b/.test(text) ||
        /^\/[\w./-]{4,}$/.test(text) ||
        /^(AES|RSA|DES|ChaCha|XOR|Base64)/i.test(text)) {
      interestingStrings.add(text);
    }
  }

  return {
    name: className(thisClass),
    superName: className(superClass),
    interfaces,
    access,
    major,
    minor,
    fields,
    methods,
    references: [...references].sort(),
    interestingStrings: [...interestingStrings].sort().slice(0, 60),
  };
}

/** Parse `META-INF/MANIFEST.MF` into its main-section attributes. */
export function parseManifest(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  let lastKey = '';
  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine.trim()) break; // end of the main section
    if (/^\s/.test(rawLine) && lastKey) {
      out[lastKey] += rawLine.trim();
      continue;
    }
    const sep = rawLine.indexOf(':');
    if (sep < 1) continue;
    const key = rawLine.slice(0, sep).trim();
    out[key] = rawLine.slice(sep + 1).trim();
    lastKey = key;
  }
  return out;
}

/** Markers that mean the payload is deliberately protected. */
const PROTECTION_MARKERS = [
  // The observed mod ships `.PROTECTED BY ARRSHIELD.class`; the product name is
  // spelled with and without the space depending on the file.
  'ARR SHIELD',
  'ARRSHIELD',
  'PROTECTED BY',
  'Allatori',
  'ZKM',
  'zelix',
  'StringFog',
  'ClassGuard',
  'DashO',
  'ProGuard',
  'obfuscated',
];

function analyseArchive(buffer: Buffer, findings: Finding[], label: string, depth = 0): void {
  let entries: ZipReadEntry[];
  try {
    entries = buildZipRead(buffer);
  } catch {
    findings.push({ kind: `${label}.error`, detail: { note: 'central directory unreadable' } });
    return;
  }

  findings.push({
    kind: `${label}.entries`,
    detail: entries.slice(0, 500).map((entry) => ({ name: entry.name, size: entry.size })),
  });

  const classes = entries.filter((entry) => entry.name.endsWith('.class'));
  const nestedJars = entries.filter((entry) => /\.jar$/i.test(entry.name));
  const manifestEntry = entries.find((entry) => /^META-INF\/MANIFEST\.MF$/i.test(entry.name));

  // --- manifest -------------------------------------------------------------
  if (manifestEntry) {
    const bytes = entryBytes(manifestEntry);
    if (bytes) {
      const attributes = parseManifest(bytes.toString('utf8'));
      const wanted = ['Main-Class', 'Premain-Class', 'Agent-Class', 'Launcher-Agent-Class',
        'Implementation-Title', 'Implementation-Version', 'Implementation-Vendor',
        'Specification-Title', 'Specification-Version', 'Multi-Release',
        'Fabric-Loom-Version', 'Fabric-Minecraft-Version', 'Fabric-Loader-Version'];
      const picked: Record<string, string> = {};
      for (const key of wanted) if (attributes[key]) picked[key] = attributes[key];
      // Fabric/Mixin metadata is useful even when it is not on the wanted list.
      for (const [key, value] of Object.entries(attributes)) {
        if (/^(Fabric|Mixin|Automatic-Module-Name)/i.test(key) && !picked[key]) picked[key] = value;
      }
      findings.push({ kind: `${label}.manifest`, detail: picked });
    }
  }

  // --- mod / plugin descriptors --------------------------------------------
  for (const name of ['fabric.mod.json', 'quilt.mod.json', 'plugin.yml', 'paper-plugin.yml', 'mods.toml', 'META-INF/neoforge.mods.toml']) {
    const entry = entries.find((candidate) => candidate.name === name);
    if (!entry) continue;
    const bytes = entryBytes(entry);
    if (!bytes) continue;
    const text = bytes.toString('utf8');
    if (name.endsWith('.json')) {
      try {
        const parsed = JSON.parse(text);
        findings.push({
          kind: `${label}.mod`,
          detail: {
            file: name,
            id: parsed.id,
            name: parsed.name,
            version: parsed.version,
            environment: parsed.environment,
            entrypoints: parsed.entrypoints,
            mixins: parsed.mixins,
            depends: parsed.depends,
            accessWidener: parsed.accessWidener,
          },
        });
      } catch {
        findings.push({ kind: `${label}.mod`, detail: { file: name, note: 'unparseable JSON' } });
      }
    } else {
      const interesting = text.split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => /^(id|name|version|modId|modLoader|main|entrypoint|mixin)\s*=/.test(line))
        .slice(0, 40);
      findings.push({ kind: `${label}.mod`, detail: { file: name, lines: interesting } });
    }
  }

  // --- class files ----------------------------------------------------------
  if (classes.length) {
    const parsed: ClassFileInfo[] = [];
    for (const entry of classes.slice(0, MAX_CLASSES)) {
      const bytes = entryBytes(entry);
      if (!bytes) continue;
      const info = parseClassFile(bytes);
      if (info) parsed.push(info);
    }

    if (parsed.length) {
      const versions = [...new Set(parsed.map((info) => `${info.major}.${info.minor}`))].sort();
      findings.push({
        kind: `${label}.classes`,
        detail: {
          count: classes.length,
          parsed: parsed.length,
          classVersions: versions,
          // A short structural map: the classes a human reads first.
          summary: parsed.slice(0, 120).map((info) => ({
            name: info.name,
            extends: info.superName || undefined,
            implements: info.interfaces.length ? info.interfaces : undefined,
            methods: info.methods.length,
            fields: info.fields.length,
          })),
        },
      });

      // Entry points named in the mod descriptor are the interesting ones.
      const manifestBytes = manifestEntry ? entryBytes(manifestEntry) : null;
      const manifest = manifestBytes ? parseManifest(manifestBytes.toString('utf8')) : {};
      const entryPoints = new Set<string>();
      for (const key of ['Main-Class', 'Premain-Class', 'Agent-Class', 'Launcher-Agent-Class']) {
        if (manifest[key]) entryPoints.add(manifest[key].replace(/\./g, '/'));
      }
      for (const info of parsed) {
        if (entryPoints.has(info.name)) {
          findings.push({
            kind: `${label}.entrypoint`,
            detail: {
              class: info.name,
              extends: info.superName,
              methods: info.methods.map((method) => `${method.name}${method.descriptor}`).slice(0, 40),
            },
          });
        }
      }

      // Bytecode-level class references, which is how you find what a class
      // actually talks to when the source is absent.
      const referenced = new Set<string>();
      for (const info of parsed) for (const ref of info.references) referenced.add(ref);
      const external = [...referenced]
        .filter((ref) => !ref.startsWith('java/') && !ref.startsWith('javax/') && !ref.startsWith('jdk/') && !ref.startsWith('sun/'))
        .sort();
      if (external.length) {
        findings.push({ kind: `${label}.references`, detail: external.slice(0, 200) });
      }

      const strings = new Set<string>();
      for (const info of parsed) for (const text of info.interestingStrings) strings.add(text);
      if (strings.size) findings.push({ kind: `${label}.strings`, detail: [...strings].slice(0, 120) });
    }
  }

  // --- protection / obfuscation markers ------------------------------------
  const allText = buffer.toString('latin1');
  const detected = PROTECTION_MARKERS.filter((marker) => allText.includes(marker));
  if (detected.length) {
    findings.push({ kind: `${label}.protection`, detail: { markers: detected, note: 'class names/strings may be encrypted or renamed' } });
  }

  // A cluster of opaque binaries is the signature of an encrypted payload.
  const opaque = entries.filter((entry) => /\.bin$/i.test(entry.name));
  if (opaque.length >= 5) {
    findings.push({
      kind: `${label}.payload`,
      detail: {
        note: 'opaque .bin payloads — likely encrypted/embedded resources, not code',
        count: opaque.length,
        sample: opaque.slice(0, 12).map((entry) => ({ name: entry.name, size: entry.size })),
      },
    });
  }

  // --- nested jars ----------------------------------------------------------
  if (nestedJars.length && depth < 1) {
    const names: string[] = [];
    for (const entry of nestedJars.slice(0, MAX_NESTED_JARS)) {
      const bytes = entryBytes(entry);
      if (!bytes) continue;
      names.push(entry.name);
      analyseArchive(bytes, findings, `${label}.nested:${entry.name}`, depth + 1);
    }
    if (names.length) findings.push({ kind: `${label}.nested`, detail: names });
  }
}

/** Analyse a JAR/APK/ZIP-shaped container. */
export function analyzeJar(buffer: Buffer, findings: Finding[], label = 'jar'): void {
  analyseArchive(buffer, findings, label);
}