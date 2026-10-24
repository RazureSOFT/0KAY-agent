import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as http from 'node:http';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { deflateSync } from 'node:zlib';
import { buildDocx, buildPptx, buildZip } from '../tools/office.js';
import { extractDocumentText, isDocumentAttachment } from './attachment_text.js';

const dir = mkdtempSync(path.join(tmpdir(), 'okay-attach-'));

function save(name: string, data: Buffer | string): string {
  const target = path.join(dir, name);
  writeFileSync(target, data);
  return target;
}

function buildPdf(lines: string[], compress: boolean): Buffer {
  const content = `BT /F1 18 Tf 60 760 Td 22 TL\n${lines.map((line) => `(${line}) Tj T*`).join('\n')}\nET`;
  const body = compress ? deflateSync(Buffer.from(content, 'latin1')) : Buffer.from(content, 'latin1');
  const filter = compress ? ' /Filter /FlateDecode' : '';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = Buffer.from('%PDF-1.4\n', 'latin1');
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(out.length);
    if (object === null) {
      out = Buffer.concat([
        out,
        Buffer.from(`4 0 obj\n<< /Length ${body.length}${filter} >>\nstream\n`, 'latin1'),
        body,
        Buffer.from('\nendstream\nendobj\n', 'latin1'),
      ]);
    } else {
      out = Buffer.concat([out, Buffer.from(`${index + 1} 0 obj\n${object}\nendobj\n`, 'latin1')]);
    }
  });
  const xref = out.length;
  let tail = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) tail += `${String(offset).padStart(10, '0')} 00000 n \n`;
  tail += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.concat([out, Buffer.from(tail, 'latin1')]);
}

function buildXlsx(): Buffer {
  const xml = (body: string) => Buffer.from(`<?xml version="1.0"?>${body}`, 'utf8');
  return buildZip([
    { name: 'xl/sharedStrings.xml', data: xml('<sst count="4"><si><t>name</t></si><si><t>amount</t></si><si><t>alpha</t></si><si><t>beta</t></si></sst>') },
    {
      name: 'xl/worksheets/sheet1.xml',
      data: xml(
        '<worksheet><sheetData>' +
          '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
          '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>42</v></c></row>' +
          '<row r="3"><c r="A3" t="s"><v>3</v></c><c r="B3"><v>7.5</v></c></row>' +
          '</sheetData></worksheet>',
      ),
    },
  ]);
}

async function extract(name: string, mime: string, data: Buffer): Promise<string> {
  const file = save(name, data);
  const { text, note } = await extractDocumentText(file, name, mime, data);
  return text || `«${note}»`;
}

test('docx text is extracted', async () => {
  const docx = buildDocx({
    title: 'Quarterly report',
    blocks: [{ type: 'paragraph', text: 'Revenue grew 18% in Q3.' }, { type: 'bullet', text: 'APAC led growth' }],
  });
  const text = await extract('report.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', docx);
  assert.match(text, /Quarterly report/);
  assert.match(text, /Revenue grew 18% in Q3\./);
  assert.match(text, /APAC led growth/);
});

test('pptx slide text is extracted in order', async () => {
  const pptx = buildPptx({ title: 'Roadmap', slides: [{ title: 'Q4', bullets: ['Ship streaming write'] }] });
  const text = await extract('deck.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', pptx);
  assert.match(text, /# Slide 1/);
  assert.match(text, /Ship streaming write/);
});

test('xlsx cells are extracted with their shared strings resolved', async () => {
  const text = await extract('book.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buildXlsx());
  assert.match(text, /# Sheet 1/);
  assert.match(text, /name\tamount/);
  assert.match(text, /alpha\t42/);
  assert.match(text, /beta\t7\.5/);
});

test('pdf text layer is extracted from a compressed stream', async () => {
  const pdf = buildPdf(['0KAY operator manual', 'Step one: start the stack.'], true);
  const text = await extract('manual.pdf', 'application/pdf', pdf);
  assert.match(text, /0KAY operator manual/);
  assert.match(text, /Step one: start the stack\./);
});

test('pdf text layer is extracted from an uncompressed stream', async () => {
  const pdf = buildPdf(['Plain stream PDF', 'Second line of the page.'], false);
  const text = await extract('plain.pdf', 'application/pdf', pdf);
  assert.match(text, /Plain stream PDF/);
  assert.match(text, /Second line of the page\./);
});

test('a PDF without a text layer reports a note instead of garbage', async () => {
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n', 'latin1');
  const text = await extract('scan.pdf', 'application/pdf', pdf);
  assert.match(text, /no text layer/);
});

test('a binary container is not treated as a document', () => {
  assert.equal(isDocumentAttachment('archive.zip', 'application/zip'), false);
  assert.equal(isDocumentAttachment('photo.png', 'image/png'), false);
  assert.equal(isDocumentAttachment('report.pdf', 'application/pdf'), true);
  assert.equal(isDocumentAttachment('notes.md', 'text/markdown'), false);
  assert.equal(isDocumentAttachment('x.docx', ''), true);
});

test('collectAttachments saves the file and inlines the extracted text', async () => {
  const { Agent } = await import('./agent.js');
  const docx = buildDocx({ title: 'Contract', blocks: [{ type: 'paragraph', text: 'Payment is due in 30 days.' }] });
  const server = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.end(docx);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const saved = process.env.CORE_HTTP_ADDR;
  process.env.CORE_HTTP_ADDR = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const agent = new Agent();
    const refs = JSON.stringify([{ name: 'contract.docx', url: '/api/files?file=contract.docx', mime: '' }]);
    const result = await (agent as unknown as {
      collectAttachments(raw: string, signal: AbortSignal, taskId: string): Promise<{ text: string }>;
    }).collectAttachments(refs, new AbortController().signal, 'task-attach-1');

    assert.match(result.text, /contract\.docx/);
    assert.match(result.text, /Payment is due in 30 days\./, 'extracted text missing from the prompt');
    const savedPath = /saved at (.+?\.docx)/.exec(result.text)?.[1];
    assert.ok(savedPath, `prompt does not carry the saved path: ${result.text}`);
    assert.ok(existsSync(savedPath), `attachment was not written to ${savedPath}`);
  } finally {
    if (saved === undefined) delete process.env.CORE_HTTP_ADDR;
    else process.env.CORE_HTTP_ADDR = saved;
    server.close();
  }
});
