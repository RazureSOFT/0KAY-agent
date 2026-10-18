import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { LspClient, LspTool, encodeMessage, decodeMessages, resolveServerForFile } from './lsp.js';

test('encodeMessage/decodeMessages round-trip and tolerate partial frames', () => {
  const framed = encodeMessage({ jsonrpc: '2.0', id: 1, method: 'a' }) + encodeMessage({ jsonrpc: '2.0', id: 2, method: 'b' });
  const full = decodeMessages(framed);
  assert.equal(full.messages.length, 2);
  assert.equal(full.messages[0].id, 1);
  assert.equal(full.rest, '');

  const partial = encodeMessage({ jsonrpc: '2.0', id: 3 }).slice(0, 20);
  const half = decodeMessages(partial);
  assert.equal(half.messages.length, 0);
  assert.equal(half.rest, partial);
});

test('resolveServerForFile maps known extensions and rejects unknown ones', () => {
  assert.equal(resolveServerForFile('/a/b.ts')?.languageId, 'typescript');
  assert.equal(resolveServerForFile('/a/b.py')?.command, 'pyright-langserver');
  assert.equal(resolveServerForFile('/a/b.go')?.command, 'gopls');
  assert.equal(resolveServerForFile('/a/b.xyz'), null);
});

test('LspClient talks to a language server over stdio', async () => {
  const fixture = fileURLToPath(new URL('./__fixtures__/mock-lsp-server.mjs', import.meta.url));
  const client = await LspClient.start({ command: process.execPath, args: [fixture], languageId: 'typescript' }, process.cwd());
  try {
    const uri = 'file:///mock.ts';
    client.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'typescript', version: 1, text: 'const x = 1' } });
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(client.getDiagnostics(uri).length, 1);

    const def = await client.request('textDocument/definition', { textDocument: { uri }, position: { line: 0, character: 0 } });
    assert.ok(Array.isArray(def) && def.length === 1);
  } finally {
    await client.close();
  }
});

test('LspTool fails gracefully for an unsupported file type', async () => {
  const tool = new LspTool();
  assert.equal(tool.name, 'lsp');
  const result = await tool.execute({ action: 'diagnostics', file: '/tmp/x.unknown' }, { cwd: process.cwd(), taskId: 't', agentType: 'code' });
  assert.equal(result.success, false);
  assert.ok(String(result.error).includes('language server'));
});
