import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReverseEngineerTool } from './reverse_engineer.js';
import type { ToolContext } from './types.js';

// The tool's whole value is that it reports facts about a binary without running
// it, so the tests check the facts, not the shape of the JSON.

const here = path.dirname(fileURLToPath(import.meta.url));
const ctx = { cwd: process.cwd(), taskId: 're-test', sessionId: 're-test' } as ToolContext;
const tool = new ReverseEngineerTool();

function scratch(): string {
  return mkdtempSync(path.join(tmpdir(), 're-test-'));
}

function kind(findings: any[], name: string): any {
  return findings.find((finding) => finding.kind === name);
}

// A minimal PE32+ header: enough for the parser to name the architecture and the
// mitigations, which is exactly what an analyst reads first.
function syntheticPe(): Buffer {
  const buffer = Buffer.alloc(0x400);
  buffer.write('MZ', 0, 'ascii');
  const pe = 0x80;
  buffer.writeUInt32LE(pe, 0x3c);
  buffer.write('PE\0\0', pe, 'ascii');
  buffer.writeUInt16LE(0x8664, pe + 4); // machine: x64
  buffer.writeUInt16LE(3, pe + 6); // section count
  buffer.writeUInt16LE(0xf0, pe + 20); // optional header size
  buffer.writeUInt16LE(0x20b, pe + 24); // PE32+
  buffer.writeUInt16LE(0x140, pe + 24 + 70); // dllCharacteristics: ASLR | DEP
  buffer.writeUInt16LE(3, pe + 24 + 68); // subsystem: console
  return buffer;
}

test('a PE reports its architecture and mitigations without running it', async () => {
  const dir = scratch();
  try {
    const file = path.join(dir, 'sample.exe');
    writeFileSync(file, syntheticPe());
    const result = await tool.execute({ path: file, includeStrings: false }, ctx);
    assert.equal(result.success, true, result.error);
    const data: any = result.data;
    assert.equal(data.format, 'pe');
    const header = kind(data.findings, 'pe.header');
    assert.equal(header.detail.arch, 'x64');
    assert.equal(header.detail.sections, 3);
    const mitigations = kind(data.findings, 'pe.mitigations');
    assert.equal(mitigations.detail.aslr, true);
    assert.equal(mitigations.detail.dep, true);
    assert.equal(mitigations.detail.cfg, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a JavaScript bundle is parsed as source, not as a blob', async () => {
  const bundle = path.resolve(here, '../../../core/data/plugin-ui/webui/chat.js');
  if (!existsSync(bundle)) return; // a checkout without built bundles
  const result = await tool.execute({ path: bundle, includeStrings: true, stringLimit: 20 }, ctx);
  assert.equal(result.success, true, result.error);
  const data: any = result.data;
  assert.equal(data.format, 'javascript');
  assert.ok(data.size > 1000);
  assert.ok(Array.isArray(data.findings) && data.findings.length > 0);
});

test('a directory becomes an inventory grouped by format', async () => {
  const dir = scratch();
  try {
    writeFileSync(path.join(dir, 'a.js'), 'console.log(1)\n');
    writeFileSync(path.join(dir, 'b.txt'), 'hello\n');
    writeFileSync(path.join(dir, 'c.exe'), syntheticPe());
    const result = await tool.execute({ path: dir }, ctx);
    assert.equal(result.success, true, result.error);
    const data: any = result.data;
    assert.equal(data.files.length, 3);
    assert.ok(data.byFormat.javascript >= 1);
    assert.ok(data.byFormat.pe >= 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing file fails instead of inventing a report', async () => {
  const result = await tool.execute({ path: path.join(tmpdir(), 'definitely-not-here-0kay.bin') }, ctx);
  assert.equal(result.success, false);
});
