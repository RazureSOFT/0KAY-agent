import { createRequire } from 'module';
import { runCli, resolveCli, optionalImport } from './deps.js';
import { buildZipRead } from './zip_read.js';

const require = createRequire(import.meta.url);

export interface ExtractionResult {
  kind: string;
  text: string;
  meta?: Record<string, any>;
  via: string;
}

function inflate(entry: { data: Buffer; method: number }): Buffer {
  if (entry.method === 0) return entry.data;
  try {
    const zlib = require('zlib');
    return zlib.inflateRawSync(entry.data);
  } catch {
    return entry.data;
  }
}

export async function extractPdf(buffer: Buffer, signal?: AbortSignal): Promise<ExtractionResult> {
  const meta: Record<string, any> = { bytes: buffer.length, version: /%PDF-(\d\.\d)/.exec(buffer.toString('latin1'))?.[1] };
  const pages = (buffer.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
  if (pages) meta.pages = pages;

  let text = '';
  try {
    const raw = buffer.toString('latin1');
    const streams: string[] = [];
    const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(raw))) streams.push(match[1]);
    const zlib = require('zlib');
    for (const stream of streams) {
      let decoded = '';
      try { decoded = zlib.inflateSync(Buffer.from(stream, 'latin1')).toString('latin1'); }
      catch { decoded = stream; }
      const tjRe = /\((?:\\.|[^\\()])*\)\s*Tj|\[(.*?)\]\s*TJ/g;
      let tj: RegExpExecArray | null;
      while ((tj = tjRe.exec(decoded))) {
        const chunk = tj[0];
        const parts = [...chunk.matchAll(/\((?:\\.|[^\\()])*\)/g)].map((m) => m[0].slice(1, -1));
        text += parts.map(unescapePdfString).join('') + ' ';
        if (chunk.endsWith('Tj')) text += '\n';
      }
    }
  } catch { }
  text = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (text.length > 40) return { kind: 'pdf', text, meta, via: 'builtin-pdf' };

  const pdfParse = await optionalImport<any>('pdf-parse');
  if (pdfParse) {
    try {
      const parsed = await pdfParse(buffer);
      if (parsed?.text?.trim()) return { kind: 'pdf', text: parsed.text.trim(), meta: { ...meta, pages: parsed.numpages ?? meta.pages }, via: 'pdf-parse' };
    } catch { }
  }

  const pdftotext = await resolveCli('pdftotext');
  if (pdftotext.available) {
    const tmp = await writeTemp(buffer, '.pdf');
    const out = tmp.replace(/\.pdf$/, '.txt');
    try {
      await runCli(pdftotext.command, ['-layout', tmp, out], { signal });
      const ext = (await import('fs/promises')).readFile;
      const cliText = await ext(out, 'utf8').catch(() => '');
      if (cliText.trim()) return { kind: 'pdf', text: cliText.trim(), meta, via: 'pdftotext' };
    } catch { }
    finally { cleanupTemp([tmp, out]); }
  }

  const tesseract = await resolveCli('tesseract');
  if (tesseract.available && process.env.OKAY_PDF_OCR === '1') {
    const tmp = await writeTemp(buffer, '.pdf');
    try {
      const outBase = tmp.replace(/\.pdf$/, '');
      await runCli(tesseract.command, [tmp, outBase, '-l', process.env.OKAY_OCR_LANG || 'eng'], { signal });
      const fs = await import('fs/promises');
      const ocr = await fs.readFile(`${outBase}.txt`, 'utf8').catch(() => '');
      if (ocr.trim()) return { kind: 'pdf', text: ocr.trim(), meta, via: 'tesseract-ocr' };
    } catch { }
    finally { cleanupTemp([tmp]); }
  }

  return { kind: 'pdf', text, meta: { ...meta, note: 'no text layer found; set OKAY_PDF_OCR=1 with tesseract, or install pdf-parse' }, via: 'builtin-pdf-empty' };
}

function unescapePdfString(value: string): string {
  return value.replace(/\\([nrtbf()\\]|\d{1,3})/g, (_m, code: string) => {
    if (/^\d+$/.test(code)) return String.fromCharCode(parseInt(code, 8));
    return ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' } as Record<string, string>)[code] ?? code;
  });
}

export async function extractDocx(buffer: Buffer): Promise<ExtractionResult> {
  const mammoth = await optionalImport<any>('mammoth');
  if (mammoth) {
    try {
      const result = await mammoth.extractRawText({ buffer });
      if (result?.value?.trim()) return { kind: 'docx', text: result.value.trim(), via: 'mammoth' };
    } catch { }
  }
  try {
    const entries = buildZipRead(buffer);
    const doc = entries.find((entry) => entry.name === 'word/document.xml');
    if (doc) {
      const xml = inflate(doc).toString('utf8');
      const text = xml
        .replace(/<w:p[ >][^>]*>/g, '\n')
        .replace(/<w:tab\/>/g, '\t')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
        .replace(/\n{3,}/g, '\n\n').trim();
      return { kind: 'docx', text, via: 'builtin-docx' };
    }
  } catch { }
  return { kind: 'docx', text: '', meta: { note: 'could not read word/document.xml; install mammoth' }, via: 'builtin-docx-empty' };
}

export async function extractXlsx(buffer: Buffer): Promise<ExtractionResult> {
  const exceljs = await optionalImport<any>('exceljs');
  if (exceljs) {
    try {
      const wb = new exceljs.Workbook();
      await wb.xlsx.load(buffer);
      const lines: string[] = [];
      wb.eachSheet((sheet: any) => {
        lines.push(`# ${sheet.name}`);
        sheet.eachRow((row: any) => lines.push(row.values.slice(1).map((v: any) => (v == null ? '' : String(v))).join('\t')));
      });
      return { kind: 'xlsx', text: lines.join('\n'), via: 'exceljs' };
    } catch { }
  }
  try {
    const entries = buildZipRead(buffer);
    const shared = entries.find((entry) => entry.name === 'xl/sharedStrings.xml');
    const strings: string[] = [];
    if (shared) {
      const xml = inflate(shared).toString('utf8');
      for (const m of xml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) strings.push(m[1]);
    }
    const sheet = entries.find((entry) => /^xl\/worksheets\/sheet\d+\.xml$/.test(entry.name));
    const lines: string[] = [];
    if (sheet) {
      const xml = inflate(sheet).toString('utf8');
      for (const row of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
        const cells: string[] = [];
        for (const cell of row[1].matchAll(/<c[^>]*?(?:\st="(\w+)")?[^>]*>([\s\S]*?)<\/c>/g)) {
          const value = /<v>([\s\S]*?)<\/v>/.exec(cell[2])?.[1] ?? '';
          cells.push(cell[1] === 's' ? (strings[Number(value)] ?? value) : value);
        }
        lines.push(cells.join('\t'));
      }
    }
    return { kind: 'xlsx', text: lines.join('\n'), via: lines.length ? 'builtin-xlsx' : 'builtin-xlsx-empty' };
  } catch {
    return { kind: 'xlsx', text: '', meta: { note: 'install exceljs for full sheet support' }, via: 'builtin-xlsx-empty' };
  }
}

export async function probeMedia(buffer: Buffer, name: string, signal?: AbortSignal): Promise<ExtractionResult> {
  const ffmpeg = await resolveCli('ffmpeg');
  if (!ffmpeg.available) return { kind: 'media', text: '', meta: { file: name, bytes: buffer.length, note: 'install ffmpeg for media metadata and frames' }, via: 'none' };
  const tmp = await writeTemp(buffer, `.${name.split('.').pop() || 'bin'}`);
  try {
    const probe = await runCli((process.platform === 'win32' ? 'ffprobe' : 'ffprobe'), ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', tmp], { signal });
    let meta: Record<string, any> = {};
    try { meta = JSON.parse(probe.stdout); } catch { }
    return { kind: 'media', text: '', meta: { file: name, ...(meta.format || {}), streams: (meta.streams || []).map((s: any) => ({ codec_type: s.codec_type, codec_name: s.codec_name, width: s.width, height: s.height, duration: s.duration })) }, via: 'ffprobe' };
  } finally { cleanupTemp([tmp]); }
}

export async function extractVideoFrames(buffer: Buffer, name: string, count: number, signal?: AbortSignal): Promise<{ frames: string[]; via: string }> {
  const ffmpeg = await resolveCli('ffmpeg');
  if (!ffmpeg.available) return { frames: [], via: 'none' };
  const fs = await import('fs/promises');
  const os = await import('os');
  const path = await import('path');
  const tmpIn = await writeTemp(buffer, `.${name.split('.').pop() || 'mp4'}`);
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), '0kay-frames-'));
  try {
    const outPattern = path.join(outDir, 'frame-%03d.png');
    await runCli(ffmpeg.command, ['-i', tmpIn, '-vf', `thumbnail=${Math.max(1, count)}`, '-frames:v', String(count), outPattern], { signal, timeout: 180_000 });
    const files = (await fs.readdir(outDir)).filter((f) => f.endsWith('.png')).sort();
    const frames = await Promise.all(files.slice(0, count).map(async (f) => `data:image/png;base64,${(await fs.readFile(path.join(outDir, f))).toString('base64')}`));
    return { frames, via: 'ffmpeg' };
  } catch {
    return { frames: [], via: 'ffmpeg-error' };
  } finally {
    cleanupTemp([tmpIn]);
    await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function writeTemp(buffer: Buffer, ext: string): Promise<string> {
  const fs = await import('fs/promises');
  const os = await import('os');
  const path = await import('path');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), '0kay-doc-'));
  const file = path.join(dir, `doc${ext}`);
  await fs.writeFile(file, buffer);
  return file;
}

function cleanupTemp(files: string[]): void {
  import('fs/promises').then((fs) => Promise.all(files.map((file) => fs.rm(file, { force: true }).catch(() => {})))).catch(() => {});
}

export function detectDocumentKind(buffer: Buffer, name = ''): string {
  const head = buffer.slice(0, 8).toString('latin1');
  const ext = name.toLowerCase().split('.').pop() || '';
  if (head.startsWith('%PDF-')) return 'pdf';
  if (head.startsWith('PK')) {
    if (ext === 'docx') return 'docx';
    if (ext === 'xlsx') return 'xlsx';
    try {
      const entries = buildZipRead(buffer);
      if (entries.some((entry) => entry.name.startsWith('word/'))) return 'docx';
      if (entries.some((entry) => entry.name.startsWith('xl/'))) return 'xlsx';
    } catch { }
    return 'zip';
  }
  if (head.startsWith('ID3') || head.startsWith('RIFF')) return 'media';
  if (['mp4', 'mov', 'webm', 'mkv', 'avi', 'mp3', 'wav', 'm4a', 'ogg', 'flac'].includes(ext)) return 'media';
  if (['csv', 'tsv'].includes(ext)) return 'csv';
  if (['txt', 'md', 'json', 'xml', 'html', 'htm'].includes(ext)) return 'text';
  return 'binary';
}
