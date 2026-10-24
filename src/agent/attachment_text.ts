import { inflateRawSync, inflateSync } from 'zlib';

const DOCUMENT_EXTENSIONS = new Set([
  'pdf',
  'doc',
  'dot',
  'wps',
  'docx',
  'xlsx',
  'pptx',
  'odt',
  'ods',
  'odp',
]);

export function isDocumentAttachment(name: string, mime: string): boolean {
  const ext = extensionOf(name);
  if (DOCUMENT_EXTENSIONS.has(ext)) return true;
  return /^application\/(pdf|msword|vnd\.openxmlformats-officedocument|vnd\.oasis\.opendocument|vnd\.ms-)/i.test(
    mime,
  );
}

function extensionOf(name: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(name.trim());
  return match ? match[1].toLowerCase() : '';
}

interface ZipEntry {
  name: string;
  data: Buffer;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

function readZipEntries(buffer: Buffer): ZipEntry[] {
  const end = findEocd(buffer);
  if (end < 0) throw new Error('not a zip container');
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    offset += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/')) continue;
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) continue;
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(start, start + compressedSize);
    try {
      entries.push({ name, data: method === 0 ? Buffer.from(raw) : inflateRawSync(raw) });
    } catch {
    }
  }
  return entries;
}

function findEocd(buffer: Buffer): number {
  const stop = Math.max(0, buffer.length - 65_557);
  for (let i = buffer.length - 22; i >= stop; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  return -1;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body] ?? whole;
  });
}

function xmlToText(xml: string): string {
  const withBreaks = xml
    .replace(/<w:p\b[^>]*\/>/g, '\n')
    .replace(/<\/(w:p|a:p|text:p|text:h|row|si|c|w:tr)>/g, '\n')
    .replace(/<w:br\b[^>]*\/>/g, '\n')
    .replace(/<w:tab\b[^>]*\/>/g, '\t')
    .replace(/<\/c>/g, '\t');
  const text = withBreaks
    .replace(/<[^>]+>/g, '')
    .split('\n')
    .map((line) => decodeEntities(line).replace(/[ \t\u00a0]+/g, ' ').trim())
    .join('\n');
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

function extractDocxPackage(buffer: Buffer): string {
  const entries = readZipEntries(buffer);
  const pick = (name: string): string => entries.find((entry) => entry.name === name)?.data.toString('utf8') ?? '';
  const body = pick('word/document.xml');
  if (body) return xmlToText(body);
  return entries
    .filter((entry) => /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/.test(entry.name))
    .map((entry) => xmlToText(entry.data.toString('utf8')))
    .filter(Boolean)
    .join('\n\n');
}

function extractSpreadsheet(buffer: Buffer): string {
  const entries = readZipEntries(buffer);
  const shared = new Map<number, string>();
  const sharedXml = entries.find((entry) => entry.name === 'xl/sharedStrings.xml')?.data.toString('utf8');
  if (sharedXml) {
    const items = sharedXml.match(/<si\b[\s\S]*?<\/si>/g) ?? [];
    items.forEach((item, index) => {
      const text = (item.match(/<t\b[^>]*>([\s\S]*?)<\/t>/g) ?? [])
        .map((node) => decodeEntities(node.replace(/<[^>]+>/g, '')))
        .join('');
      shared.set(index, text);
    });
  }
  const sheets = entries
    .filter((entry) => /^xl\/worksheets\/sheet\d*\.xml$/.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const blocks: string[] = [];
  for (const sheet of sheets) {
    const xml = sheet.data.toString('utf8');
    const rows: string[] = [];
    for (const row of xml.match(/<row\b[\s\S]*?<\/row>/g) ?? []) {
      const cells: string[] = [];
      for (const cell of row.match(/<c\b[\s\S]*?<\/c>/g) ?? []) {
        const type = /\bt="([^"]+)"/.exec(cell)?.[1] ?? '';
        if (type === 's') {
          const index = Number((/<v>([\s\S]*?)<\/v>/.exec(cell)?.[1] ?? '').trim());
          cells.push(shared.get(index) ?? '');
          continue;
        }
        if (type === 'inlineStr') {
          cells.push((cell.match(/<t\b[^>]*>([\s\S]*?)<\/t>/g) ?? []).map((n) => decodeEntities(n.replace(/<[^>]+>/g, ''))).join(''));
          continue;
        }
        cells.push(decodeEntities((/<v>([\s\S]*?)<\/v>/.exec(cell)?.[1] ?? '').trim()));
      }
      if (cells.some(Boolean)) rows.push(cells.join('\t').replace(/\t+$/, ''));
    }
    if (rows.length) {
      const number = /sheet(\d+)/.exec(sheet.name)?.[1];
      blocks.push(`# Sheet ${number ?? 1}\n${rows.join('\n')}`);
    }
  }
  return blocks.join('\n\n');
}

function extractDeck(buffer: Buffer): string {
  const entries = readZipEntries(buffer);
  const slides = entries
    .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return slides
    .map((slide, index) => {
      const text = xmlToText(slide.data.toString('utf8'));
      return text ? `# Slide ${index + 1}\n${text}` : '';
    })
    .filter(Boolean)
    .join('\n\n');
}

function extractOdf(buffer: Buffer): string {
  const entries = readZipEntries(buffer);
  const content = entries.find((entry) => entry.name === 'content.xml')?.data.toString('utf8');
  return content ? xmlToText(content) : '';
}

function readPdfLiteral(source: string, start: number): { value: string; next: number } {
  let depth = 0;
  let out = '';
  let i = start;
  for (; i < source.length; i++) {
    const ch = source[i];
    if (ch === '\\') {
      const next = source[i + 1] ?? '';
      const escapes: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };
      if (next in escapes) {
        out += escapes[next];
        i += 1;
      } else if (/[0-7]/.test(next)) {
        const octal = /^[0-7]{1,3}/.exec(source.slice(i + 1))?.[0] ?? '';
        out += String.fromCharCode(parseInt(octal, 8));
        i += octal.length;
      } else if (next === '\n' || next === '\r') {
        i += 1;
      } else {
        out += next;
        i += 1;
      }
      continue;
    }
    if (ch === '(') {
      depth += 1;
      if (depth > 1) out += ch;
      continue;
    }
    if (ch === ')') {
      depth -= 1;
      if (depth === 0) return { value: out, next: i + 1 };
      out += ch;
      continue;
    }
    out += ch;
  }
  return { value: out, next: i };
}

function readPdfHex(source: string, start: number): { value: string; next: number } {
  const end = source.indexOf('>', start);
  if (end < 0) return { value: '', next: source.length };
  const hex = source.slice(start + 1, end).replace(/[^0-9a-fA-F]/g, '');
  const bytes: number[] = [];
  for (let i = 0; i + 1 < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
  const text = hex.length % 4 === 0 && hex.length > 2
    ? Buffer.from(hex, 'hex').swap16().toString('utf16le')
    : Buffer.from(bytes).toString('latin1');
  return { value: text, next: end + 1 };
}

function pdfContentText(content: string): string {
  let out = '';
  const pending: string[] = [];
  let i = 0;
  while (i < content.length) {
    const ch = content[i];
    if (ch === '(') {
      const { value, next } = readPdfLiteral(content, i);
      pending.push(value);
      i = next;
      continue;
    }
    if (ch === '<' && content[i + 1] !== '<') {
      const { value, next } = readPdfHex(content, i);
      pending.push(value);
      i = next;
      continue;
    }
    if (ch === '<' && content[i + 1] === '<') {
      i += 2;
      continue;
    }
    if (/[A-Za-z'"]/.test(ch)) {
      let end = i;
      while (end < content.length && /[A-Za-z'"]/.test(content[end])) end += 1;
      const operator = content.slice(i, end);
      if (operator === 'Tj' || operator === 'TJ' || operator === "'" || operator === '"') {
        out += pending.join('');
        if (operator !== 'TJ') out += '\n';
      } else if (operator === 'Td' || operator === 'TD' || operator === 'T*' || operator === 'ET' || operator === 'BT') {
        out += '\n';
      }
      pending.length = 0;
      i = end;
      continue;
    }
    i += 1;
  }
  return out;
}

function extractPdfText(buffer: Buffer): string {
  const source = buffer.toString('latin1');
  const chunks: string[] = [];
  const streamPattern = /stream\r?\n?/g;
  let match: RegExpExecArray | null;
  while ((match = streamPattern.exec(source))) {
    const start = match.index + match[0].length;
    const end = source.indexOf('endstream', start);
    if (end < 0) break;
    streamPattern.lastIndex = end;
    const header = source.slice(Math.max(0, match.index - 800), match.index);
    if (!/\/FlateDecode/.test(header) && !/\bTj\b|\bTJ\b/.test(source.slice(start, end))) continue;
    const raw = Buffer.from(source.slice(start, end), 'latin1');
    let decoded: string | null = null;
    try {
      decoded = inflateSync(raw).toString('latin1');
    } catch {
      try {
        decoded = inflateRawSync(raw).toString('latin1');
      } catch {
        decoded = null;
      }
    }
    const content = decoded ?? raw.toString('latin1');
    if (!/\bTj\b|\bTJ\b/.test(content)) continue;
    const text = pdfContentText(content);
    if (text.trim()) chunks.push(text);
  }
  const joined = chunks.join('\n');
  return joined.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

export interface ExtractedText {
  text: string;
  note?: string;
}

export async function extractDocumentText(
  filePath: string,
  name: string,
  mime: string,
  buffer: Buffer,
): Promise<ExtractedText> {
  const ext = extensionOf(name) || extensionOf(filePath);
  try {
    if (ext === 'doc' || ext === 'dot' || ext === 'wps' || ext === 'docx') {
      // @ts-ignore - word-extractor ships no type declarations
      const WordExtractor = (await import('word-extractor')).default;
      const document = await new WordExtractor().extract(filePath);
      const text = [document.getBody?.(), document.getHeaders?.(), document.getFooters?.()]
        .filter((part: unknown): part is string => typeof part === 'string' && part.trim().length > 0)
        .join('\n\n');
      return gate(text, 'the document text could not be read');
    }
    if (ext === 'xlsx') return gate(extractSpreadsheet(buffer), 'no readable cells found');
    if (ext === 'pptx') return gate(extractDeck(buffer), 'no readable slide text found');
    if (ext === 'odt' || ext === 'ods' || ext === 'odp') return gate(extractOdf(buffer), 'no readable text found');
    if (ext === 'pdf' || mime === 'application/pdf') return gate(extractPdfText(buffer), 'no text layer found (scanned or image-only PDF)');
    return { text: '', note: 'unsupported document type' };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { text: '', note: `extraction failed: ${message}` };
  }
}

function gate(text: string, failureNote: string): ExtractedText {
  const trimmed = text.trim();
  if (trimmed.length < 24) return { text: '', note: failureNote };
  const printable = trimmed.replace(/[^\p{L}\p{N}\p{P}\p{Zs}\n\r\t]/gu, '').length;
  if (printable / trimmed.length < 0.85) return { text: '', note: failureNote };
  return { text: trimmed };
}
