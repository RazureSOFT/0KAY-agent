/**
 * Minimal LSP client + tool — a 0kay adaptation of Tianshu-harness's deep LSP
 * integration: language-server definition / references / diagnostics become
 * agent capabilities, and post-edit diagnostics can be fed back into the loop.
 *
 * Dependency-free: speaks LSP (JSON-RPC 2.0, Content-Length framed) over the
 * server's stdio. Servers are resolved from the file extension; a missing
 * server degrades to a clear error rather than throwing.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { readFile } from 'fs/promises';
import { extname } from 'path';
import { Tool, ToolContext, ToolResult, ok, fail } from './types.js';

export interface LspServerSpec {
  command: string;
  args: string[];
  languageId: string;
}

/** Extension → language server. Commands are looked up on PATH at spawn time. */
const SERVERS: Record<string, LspServerSpec> = {
  '.ts': { command: 'typescript-language-server', args: ['--stdio'], languageId: 'typescript' },
  '.tsx': { command: 'typescript-language-server', args: ['--stdio'], languageId: 'typescriptreact' },
  '.js': { command: 'typescript-language-server', args: ['--stdio'], languageId: 'javascript' },
  '.jsx': { command: 'typescript-language-server', args: ['--stdio'], languageId: 'javascriptreact' },
  '.py': { command: 'pyright-langserver', args: ['--stdio'], languageId: 'python' },
  '.go': { command: 'gopls', args: [], languageId: 'go' },
  '.rs': { command: 'rust-analyzer', args: [], languageId: 'rust' },
};

export function resolveServerForFile(file: string): LspServerSpec | null {
  return SERVERS[extname(String(file || '')).toLowerCase()] || null;
}

/** Frame a JSON-RPC payload with a Content-Length header. */
export function encodeMessage(payload: unknown): string {
  const body = JSON.stringify(payload);
  return `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`;
}

/** Pull as many complete Content-Length framed messages out of a buffer. */
export function decodeMessages(buffer: string): { messages: any[]; rest: string } {
  const messages: any[] = [];
  let rest = buffer;
  for (;;) {
    const headerEnd = rest.indexOf('\r\n\r\n');
    if (headerEnd < 0) break;
    const header = rest.slice(0, headerEnd);
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) {
      rest = rest.slice(headerEnd + 4);
      continue;
    }
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    if (rest.length - bodyStart < length) break;
    const body = rest.slice(bodyStart, bodyStart + length);
    rest = rest.slice(bodyStart + length);
    try {
      messages.push(JSON.parse(body));
    } catch {
      // Skip a malformed frame rather than desyncing the whole stream.
    }
  }
  return { messages, rest };
}

/** A live language-server session over stdio. */
export class LspClient {
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private readonly diagnostics = new Map<string, any[]>();

  private constructor(private readonly proc: ChildProcessWithoutNullStreams) {
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => this.onData(chunk));
    proc.on('exit', () => {
      for (const { reject } of this.pending.values()) reject(new Error('language server exited'));
      this.pending.clear();
    });
  }

  static start(spec: LspServerSpec, rootPath: string): Promise<LspClient> {
    const proc = spawn(spec.command, spec.args, { stdio: ['pipe', 'pipe', 'pipe'], cwd: rootPath }) as ChildProcessWithoutNullStreams;
    const client = new LspClient(proc);
    return new Promise((resolve, reject) => {
      proc.once('error', reject);
      client
        .request('initialize', {
          processId: process.pid,
          rootUri: `file://${rootPath.replace(/\\/g, '/')}`,
          capabilities: { textDocument: { publishDiagnostics: {} } },
        })
        .then(() => {
          client.notify('initialized', {});
          resolve(client);
        })
        .catch(reject);
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    const { messages, rest } = decodeMessages(this.buffer);
    this.buffer = rest;
    for (const message of messages) {
      if (message.id !== undefined && this.pending.has(message.id)) {
        const entry = this.pending.get(message.id)!;
        this.pending.delete(message.id);
        if (message.error) entry.reject(new Error(message.error.message || 'lsp error'));
        else entry.resolve(message.result);
      } else if (message.method === 'textDocument/publishDiagnostics') {
        this.diagnostics.set(message.params.uri, message.params.diagnostics || []);
      }
    }
  }

  request(method: string, params: any): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(encodeMessage({ jsonrpc: '2.0', id, method, params }));
    });
  }

  notify(method: string, params: any): void {
    this.proc.stdin.write(encodeMessage({ jsonrpc: '2.0', method, params }));
  }

  getDiagnostics(uri: string): any[] {
    return this.diagnostics.get(uri) || [];
  }

  async close(): Promise<void> {
    try {
      await this.request('shutdown', null);
      this.notify('exit', null);
    } catch {
      // Server already gone; fall through to a hard kill.
    }
    this.proc.kill();
  }
}

/** Agent tool: definition / references / diagnostics for one file. */
export class LspTool extends Tool {
  get name(): string {
    return 'lsp';
  }

  get description(): string {
    return 'Query a language server: "diagnostics" (errors/warnings for a file), "definition" or "references" at a position. Requires the matching language server on PATH.';
  }

  get parameters(): Record<string, any> {
    return {
      type: 'object',
      required: ['action', 'file'],
      properties: {
        action: { type: 'string', enum: ['diagnostics', 'definition', 'references'] },
        file: { type: 'string', description: 'absolute path to the source file' },
        line: { type: 'number', description: '1-based line (definition/references)' },
        character: { type: 'number', description: '1-based column (definition/references)' },
      },
    };
  }

  async execute(args: Record<string, any>, ctx: ToolContext): Promise<ToolResult> {
    const action = String(args.action || '').trim();
    const file = String(args.file || '').trim();
    if (!action || !file) return fail('lsp requires action and file');
    const spec = resolveServerForFile(file);
    if (!spec) return fail(`no language server configured for ${extname(file) || 'this file'}`);

    let client: LspClient;
    try {
      client = await LspClient.start(spec, ctx.cwd);
    } catch (error: any) {
      return fail(`could not start ${spec.command}: ${error?.message || error}`);
    }

    try {
      const text = await readFile(file, 'utf8');
      const uri = `file://${file.replace(/\\/g, '/')}`;
      client.notify('textDocument/didOpen', {
        textDocument: { uri, languageId: spec.languageId, version: 1, text },
      });

      if (action === 'diagnostics') {
        // Diagnostics arrive asynchronously; give the server a brief window.
        await new Promise((resolve) => setTimeout(resolve, 400));
        return ok({ file, diagnostics: client.getDiagnostics(uri) });
      }

      const line = Math.max(0, Number(args.line || 1) - 1);
      const character = Math.max(0, Number(args.character || 1) - 1);
      const method = action === 'definition' ? 'textDocument/definition' : 'textDocument/references';
      const params: any = { textDocument: { uri }, position: { line, character } };
      if (action === 'references') params.context = { includeDeclaration: true };
      const result = await client.request(method, params);
      return ok({ file, action, result: result ?? null });
    } catch (error: any) {
      return fail(`lsp ${action} failed: ${error?.message || error}`);
    } finally {
      void client.close();
    }
  }
}
