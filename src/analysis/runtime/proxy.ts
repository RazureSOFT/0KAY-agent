/**
 * A loopback recording proxy: traffic goes through it, and what went through
 * is written to the ledger and, optionally, to an evidence snapshot.
 *
 * Plain HTTP is recorded in full. HTTPS arrives as a CONNECT tunnel, which we
 * do not decrypt — the tunnel is recorded as one entry naming the host and
 * port, and the entry says the contents were not inspected. Claiming to have
 * captured an encrypted request would be worse than not capturing it.
 */
import * as http from 'node:http';
import * as net from 'node:net';
import type { Socket } from 'node:net';
import type { EvidenceStore, TrafficExchange, TrafficStore } from './records.js';

export interface ProxyOptions {
  store: TrafficStore;
  evidence?: EvidenceStore;
  host?: string;
  port?: number;
  /** Bodies beyond this many bytes are truncated in the ledger. */
  maxBody?: number;
}

interface Tunnel {
  socket: Socket;
  upstream: Socket;
}

export class RecordingProxy {
  private server: http.Server | null = null;
  private tunnels = new Set<Tunnel>();
  private address = { host: '127.0.0.1', port: 0 };
  private recorded = 0;
  private tunnelled = 0;
  private failures = 0;

  constructor(private readonly options: ProxyOptions) {}

  async start(): Promise<{ host: string; port: number }> {
    if (this.server) return this.address;
    const server = http.createServer((req, res) => { void this.forward(req, res); });
    server.on('connect', (req, socket, head) => this.tunnel(req, socket as Socket, head));
    server.on('clientError', (_error, socket) => {
      if (!socket.destroyed) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.options.port ?? 0, this.options.host ?? '127.0.0.1', () => resolve());
    });
    const info = server.address();
    if (!info || typeof info === 'string') throw new Error('proxy did not bind a TCP address');
    this.address = { host: info.address, port: info.port };
    this.server = server;
    return this.address;
  }

  async stop(): Promise<void> {
    for (const tunnel of this.tunnels) {
      tunnel.socket.destroy();
      tunnel.upstream.destroy();
    }
    this.tunnels.clear();
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  status(): { running: boolean; host: string; port: number; recorded: number; tunnels: number; failures: number } {
    return {
      running: this.server !== null,
      host: this.address.host,
      port: this.address.port,
      recorded: this.recorded,
      tunnels: this.tunnelled,
      failures: this.failures,
    };
  }

  private async forward(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const raw = String(req.url || '');
    let target: URL;
    try {
      target = new URL(raw);
    } catch {
      this.fail(res, 400, `proxy needs an absolute URL, got ${raw || '(empty)'}`);
      return;
    }
    if (target.protocol !== 'http:') {
      this.fail(res, 501, `the recording proxy forwards http only; https needs CONNECT, which is recorded as a tunnel`);
      return;
    }
    const limit = this.options.maxBody ?? 64 * 1024;
    const requestBody = await readBounded(req, limit);
    const headers = hopByHopFree(req.headers, target.host);
    const started = Date.now();

    const upstream = http.request({
      host: target.hostname,
      port: target.port || 80,
      path: `${target.pathname}${target.search}`,
      method: req.method,
      headers,
    });
    upstream.on('error', (error) => {
      this.failures += 1;
      this.record({
        method: req.method || 'GET', url: target.toString(),
        requestHeaders: req.headers as Record<string, string>, requestBody,
        status: 0, responseBody: `upstream error: ${error.message}`,
        durationMs: Date.now() - started, tags: ['proxy', 'error'],
      });
      this.fail(res, 502, `upstream error: ${error.message}`);
    });
    upstream.on('response', (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      const chunks: Buffer[] = [];
      let size = 0;
      upstreamRes.on('data', (chunk: Buffer) => {
        if (size < limit) {
          const room = limit - size;
          chunks.push(chunk.length <= room ? chunk : chunk.subarray(0, room));
          size += Math.min(chunk.length, room);
        }
        res.write(chunk);
      });
      upstreamRes.on('end', () => {
        res.end();
        this.recorded += 1;
        this.record({
          method: req.method || 'GET', url: target.toString(),
          requestHeaders: req.headers as Record<string, string>, requestBody,
          status: upstreamRes.statusCode || 0,
          responseHeaders: upstreamRes.headers as Record<string, string>,
          responseBody: Buffer.concat(chunks).toString('utf8'),
          durationMs: Date.now() - started, tags: ['proxy'],
        });
      });
    });
    upstream.end(requestBody);
  }

  private tunnel(req: http.IncomingMessage, socket: Socket, head: Buffer): void {
    const [host, portText] = String(req.url || '').split(':');
    const port = Number(portText) || 443;
    const upstream = net.connect(port, host, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
      this.tunnelled += 1;
      this.record({
        method: 'CONNECT', url: `${host}:${port}`,
        requestHeaders: req.headers as Record<string, string>,
        status: 200, tags: ['proxy', 'tunnel'],
        responseBody: 'tunnel established; encrypted contents were not inspected',
      });
    });
    const entry: Tunnel = { socket, upstream };
    this.tunnels.add(entry);
    const drop = () => {
      this.tunnels.delete(entry);
      socket.destroy();
      upstream.destroy();
    };
    upstream.on('error', (error) => {
      this.failures += 1;
      if (!socket.destroyed) socket.end(`HTTP/1.1 502 Bad Gateway\r\n\r\n${error.message}`);
      drop();
    });
    socket.on('error', drop);
    upstream.on('close', drop);
    socket.on('close', drop);
  }

  private fail(res: http.ServerResponse, status: number, message: string): void {
    this.failures += 1;
    if (!res.headersSent) res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(message);
  }

  private record(input: Parameters<TrafficStore['record']>[0]): TrafficExchange {
    const exchange = this.options.store.record(input);
    if (this.options.evidence) {
      this.options.evidence.save({
        findingId: 'traffic',
        kind: 'exchange',
        exchangeId: exchange.id,
        request: { method: exchange.method, url: exchange.url, headers: exchange.requestHeaders },
        response: { status: exchange.status, headers: exchange.responseHeaders, body: exchange.responseBody },
        note: 'recorded by the loopback proxy',
      });
    }
    return exchange;
  }
}

function readBounded(stream: NodeJS.ReadableStream, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    stream.on('data', (chunk: Buffer) => {
      if (size >= limit) return;
      const room = limit - size;
      chunks.push(chunk.length <= room ? chunk : chunk.subarray(0, room));
      size += Math.min(chunk.length, room);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', reject);
  });
}

const HOP_BY_HOP = new Set([
  'connection', 'proxy-connection', 'keep-alive', 'proxy-authenticate',
  'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

function hopByHopFree(headers: http.IncomingHttpHeaders, host: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || lower === 'host') continue;
    out[name] = value;
  }
  out.host = host;
  return out;
}
