/**
 * Expose this agent's tools over MCP, so another client can drive them.
 *
 * The server binds loopback only and requires a bearer token that it generates
 * on start: an unauthenticated tool endpoint on a developer machine is a
 * remote-execution surface with a friendly name. Dangerous tools are hidden
 * unless the caller explicitly opts in.
 */
import * as http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Tool, type ToolContext, type ToolResult } from './types.js';
import { success, failure } from './helpers.js';
import type { ToolRegistry } from './tools.js';

const MAX_BODY = 2 * 1024 * 1024;
const DEFAULT_PROTOCOL = '2024-11-05';

export interface McpServerOptions {
  registry: ToolRegistry;
  context: () => ToolContext;
  host?: string;
  port?: number;
  token?: string;
  allowDangerous?: boolean;
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, any>;
}

export class McpHttpServer {
  private server: http.Server | null = null;
  private address = { host: '127.0.0.1', port: 0 };
  private readonly token: string;
  private requests = 0;
  private errors = 0;

  constructor(private readonly options: McpServerOptions) {
    this.token = options.token && options.token.trim() ? options.token.trim() : randomBytes(24).toString('base64url');
  }

  async start(): Promise<{ url: string; token: string; tools: number; allowDangerous: boolean }> {
    if (this.server) return this.describe();
    const server = http.createServer((req, res) => { void this.handle(req, res); });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.options.port ?? 0, this.options.host ?? '127.0.0.1', () => resolve());
    });
    const info = server.address();
    if (!info || typeof info === 'string') throw new Error('MCP server did not bind a TCP address');
    this.address = { host: info.address, port: info.port };
    this.server = server;
    return this.describe();
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  status(): { running: boolean; url: string; tools: number; requests: number; errors: number; allowDangerous: boolean } {
    const described = this.describe();
    return {
      running: this.server !== null,
      url: described.url,
      tools: described.tools,
      requests: this.requests,
      errors: this.errors,
      allowDangerous: described.allowDangerous,
    };
  }

  private describe() {
    return {
      url: `http://${this.address.host}:${this.address.port}/mcp`,
      token: this.token,
      tools: this.exposed().length,
      allowDangerous: this.options.allowDangerous === true,
    };
  }

  private exposed() {
    return this.options.registry.listTools((name) => this.options.allowDangerous === true || !this.options.registry.get(name)?.dangerous);
  }

  private authorized(req: http.IncomingMessage): boolean {
    const header = String(req.headers.authorization || '');
    const supplied = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
    if (!supplied) return false;
    const a = Buffer.from(supplied);
    const b = Buffer.from(this.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.url && !req.url.startsWith('/mcp')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found; POST /mcp' }));
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST', 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'method not allowed' }));
      return;
    }
    if (!this.authorized(req)) {
      this.errors += 1;
      res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'invalid or missing bearer token' } }));
      return;
    }
    const body = await readBody(req);
    let message: JsonRpcRequest;
    try {
      message = JSON.parse(body || '{}');
    } catch {
      this.errors += 1;
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'invalid JSON' } }));
      return;
    }
    this.requests += 1;
    const reply = await this.dispatch(message);
    if (reply === null) {
      res.writeHead(202);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(reply));
  }

  private async dispatch(message: JsonRpcRequest): Promise<Record<string, any> | null> {
    const id = message.id ?? null;
    const method = String(message.method || '');
    const params = message.params || {};
    const ok = (result: unknown) => ({ jsonrpc: '2.0', id, result });
    const err = (code: number, text: string) => ({ jsonrpc: '2.0', id, error: { code, message: text } });

    switch (method) {
      case 'initialize':
        return ok({
          protocolVersion: String(params.protocolVersion || DEFAULT_PROTOCOL),
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: '0kay-agent', version: '0.1.4' },
          instructions: 'Tools from the local 0KAY agent. Dangerous tools are hidden unless the server was started with allowDangerous.',
        });
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null;
      case 'ping':
        return ok({});
      case 'tools/list':
        return ok({
          tools: this.exposed().map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.parameters || { type: 'object', properties: {} },
          })),
        });
      case 'tools/call': {
        const name = String(params.name || '');
        const tool = this.options.registry.get(name);
        if (!tool) return err(-32602, `unknown tool: ${name}`);
        if (tool.dangerous && this.options.allowDangerous !== true) {
          return err(-32602, `tool ${name} is dangerous and this server does not expose dangerous tools`);
        }
        let result: ToolResult;
        try {
          result = await tool.execute((params.arguments || {}) as Record<string, any>, this.options.context());
        } catch (error) {
          this.errors += 1;
          const message = error instanceof Error ? error.message : String(error);
          return ok({ content: [{ type: 'text', text: message }], isError: true });
        }
        if (!result.success) this.errors += 1;
        return ok({
          content: [{
            type: 'text',
            text: result.success ? JSON.stringify(result.data ?? null) : String(result.error || 'tool failed'),
          }],
          isError: !result.success,
        });
      }
      default:
        return err(-32601, `method not found: ${method}`);
    }
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error(`request body exceeds ${MAX_BODY} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

let running: McpHttpServer | null = null;

export function runningMcpServer(): McpHttpServer | null { return running; }

export class McpServeTool extends Tool {
  constructor(private readonly registry: ToolRegistry) { super(); }
  get name(): string { return 'mcp_serve'; }
  get dangerous(): boolean { return true; }
  get description(): string {
    return [
      'Expose this agent\'s tools over MCP on loopback, for another client to call.',
      'action=start binds 127.0.0.1 (random port unless given) and generates a bearer token; action=status reports the URL, tool count and request count; action=stop closes it.',
      'Dangerous tools are hidden unless allowDangerous is true. The token is a credential: treat it like one.',
    ].join(' ');
  }
  get parameters(): Record<string, any> {
    return { type: 'object', required: ['action'], properties: {
      action: { type: 'string', enum: ['start', 'stop', 'status'] },
      port: { type: 'integer', minimum: 1, maximum: 65535 },
      token: { type: 'string', description: 'Fixed token instead of a generated one.' },
      allowDangerous: { type: 'boolean', description: 'Expose tools marked dangerous. Off by default.' },
    }};
  }
  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    try {
      switch (args.action) {
        case 'start': {
          if (running) return success({ ...running.status(), note: 'already running' });
          const server = new McpHttpServer({
            registry: this.registry,
            context: () => context,
            port: args.port != null ? Number(args.port) : 0,
            token: typeof args.token === 'string' ? args.token : undefined,
            allowDangerous: args.allowDangerous === true,
          });
          const started = await server.start();
          running = server;
          return success({ ...started, note: 'keep the token private; it authorizes every tool call' });
        }
        case 'status':
          return success(running ? running.status() : { running: false });
        case 'stop': {
          if (!running) return success({ running: false, note: 'nothing was running' });
          await running.stop();
          running = null;
          return success({ running: false });
        }
        default:
          return failure(`unknown action: ${args.action}`);
      }
    } catch (error) { return failure(error); }
  }
}
