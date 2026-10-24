let buffer = Buffer.alloc(0);

function send(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const sep = buffer.indexOf('\r\n\r\n');
    if (sep < 0) break;
    const header = buffer.slice(0, sep).toString('utf8');
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) {
      buffer = buffer.slice(sep + 4);
      continue;
    }
    const length = Number(match[1]);
    const start = sep + 4;
    if (buffer.length - start < length) break;
    const body = buffer.slice(start, start + length).toString('utf8');
    buffer = buffer.slice(start + length);
    let msg;
    try {
      msg = JSON.parse(body);
    } catch {
      continue;
    }
    if (msg.method === 'initialize') {
      send({ jsonrpc: '2.0', id: msg.id, result: { capabilities: { definitionProvider: true } } });
    } else if (msg.method === 'textDocument/definition') {
      send({ jsonrpc: '2.0', id: msg.id, result: [{ uri: 'file:///mock-target.ts', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }] });
    } else if (msg.method === 'textDocument/references') {
      send({ jsonrpc: '2.0', id: msg.id, result: [] });
    } else if (msg.method === 'textDocument/didOpen') {
      send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: msg.params.textDocument.uri, diagnostics: [{ message: 'mock error', severity: 1 }] } });
    } else if (msg.method === 'shutdown') {
      send({ jsonrpc: '2.0', id: msg.id, result: null });
    } else if (msg.method === 'exit') {
      process.exit(0);
    }
  }
});
