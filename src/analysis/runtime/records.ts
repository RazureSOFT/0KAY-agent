/**
 * Recorded exchanges and immutable evidence snapshots.
 *
 * Both are append-only ledgers. An exchange is what went over the wire; an
 * evidence record is what a finding is allowed to cite. They are separate on
 * purpose: a report that can quote traffic it never captured is a report that
 * can claim anything, and a hash over a snapshot is only meaningful if the
 * snapshot stops being editable once it is written.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** Header names whose value must never reach a log or a report. */
const SECRET_HEADERS = new Set([
  'authorization', 'proxy-authorization', 'cookie', 'set-cookie',
  'x-api-key', 'x-auth-token', 'x-csrf-token', 'x-session-token',
]);

/** Header names that are containers: redact the whole value, not individual keys. */
const SECRET_CONTAINERS = new Set(['cookie', 'set-cookie', 'authorization', 'proxy-authorization']);

const MAX_BODY = 64 * 1024;

export type Headers = Record<string, string>;

export function redactHeaders(headers: Headers | undefined): Headers {
  const out: Headers = {};
  for (const [name, value] of Object.entries(headers || {})) {
    const lower = name.toLowerCase();
    if (SECRET_CONTAINERS.has(lower) || SECRET_HEADERS.has(lower)) {
      out[name] = '[redacted]';
    } else if (/token|secret|password|credential|key/i.test(lower)) {
      out[name] = '[redacted]';
    } else {
      out[name] = String(value);
    }
  }
  return out;
}

/** Bodies are bounded: an upload must not turn a traffic log into a disk full. */
export function boundedBody(body: string | undefined, limit = MAX_BODY): { text: string; truncated: boolean } {
  const text = typeof body === 'string' ? body : '';
  return text.length <= limit ? { text, truncated: false } : { text: text.slice(0, limit), truncated: true };
}

export interface ExchangeInput {
  method: string;
  url: string;
  requestHeaders?: Headers;
  requestBody?: string;
  status: number;
  responseHeaders?: Headers;
  responseBody?: string;
  durationMs?: number;
  tags?: string[];
}

export interface TrafficExchange {
  id: string;
  at: number;
  method: string;
  url: string;
  host: string;
  requestHeaders: Headers;
  requestBody: string;
  requestTruncated: boolean;
  status: number;
  responseHeaders: Headers;
  responseBody: string;
  responseTruncated: boolean;
  durationMs: number | null;
  tags: string[];
}

export interface TrafficFilter {
  host?: string;
  method?: string;
  status?: number;
  since?: number;
  tag?: string;
  limit?: number;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return (url.split('/')[0] || '').toLowerCase();
  }
}

/**
 * An in-memory traffic ledger. `file` enables an append-only JSONL mirror;
 * leaving it out keeps everything in memory, which is what the tests do.
 * A bounded ring keeps a long-running session from growing without limit.
 */
export class TrafficStore {
  private rows: TrafficExchange[] = [];
  private seq = 0;
  constructor(
    private options: {
      max?: number;
      now?: () => number;
      file?: string;
    } = {},
  ) {}

  /** Turn on an append-only mirror after construction (the data dir is async). */
  setFile(file: string): void {
    this.options.file = file;
  }

  record(input: ExchangeInput): TrafficExchange {
    const req = boundedBody(input.requestBody);
    const res = boundedBody(input.responseBody);
    const row: TrafficExchange = {
      id: `tx_${++this.seq}`,
      at: (this.options.now || Date.now)(),
      method: String(input.method || 'GET').toUpperCase(),
      url: String(input.url || ''),
      host: hostOf(String(input.url || '')),
      requestHeaders: redactHeaders(input.requestHeaders),
      requestBody: req.text,
      requestTruncated: req.truncated,
      status: Number(input.status) || 0,
      responseHeaders: redactHeaders(input.responseHeaders),
      responseBody: res.text,
      responseTruncated: res.truncated,
      durationMs: Number.isFinite(input.durationMs) ? Number(input.durationMs) : null,
      tags: Array.isArray(input.tags) ? input.tags.map(String) : [],
    };
    this.rows.push(row);
    const max = Math.max(1, this.options.max ?? 2000);
    if (this.rows.length > max) this.rows.splice(0, this.rows.length - max);
    this.append(row);
    return row;
  }

  private append(row: TrafficExchange): void {
    const file = this.options.file;
    if (!file) return;
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
  }

  get(id: string): TrafficExchange | undefined {
    return this.rows.find((row) => row.id === id);
  }

  list(filter: TrafficFilter = {}): TrafficExchange[] {
    const limit = Math.max(1, Math.min(filter.limit ?? 100, 2000));
    const out = this.rows.filter((row) =>
      (!filter.host || row.host.includes(filter.host.toLowerCase())) &&
      (!filter.method || row.method === String(filter.method).toUpperCase()) &&
      (filter.status == null || row.status === filter.status) &&
      (filter.since == null || row.at >= filter.since) &&
      (!filter.tag || row.tags.includes(filter.tag)),
    );
    return out.slice(-limit).reverse();
  }

  /** Full-text search across URL and both bodies; headers are deliberately excluded. */
  search(needle: string, limit = 50): TrafficExchange[] {
    const q = needle.toLowerCase();
    if (!q) return [];
    return this.rows.filter((row) =>
      row.url.toLowerCase().includes(q) ||
      row.requestBody.toLowerCase().includes(q) ||
      row.responseBody.toLowerCase().includes(q),
    ).slice(-Math.max(1, Math.min(limit, 500))).reverse();
  }

  stats(): { total: number; byStatus: Record<string, number>; byHost: Record<string, number>; oldest: number | null } {
    const byStatus: Record<string, number> = {};
    const byHost: Record<string, number> = {};
    for (const row of this.rows) {
      const bucket = `${Math.floor(row.status / 100)}xx`;
      byStatus[bucket] = (byStatus[bucket] || 0) + 1;
      byHost[row.host] = (byHost[row.host] || 0) + 1;
    }
    return { total: this.rows.length, byStatus, byHost, oldest: this.rows.length ? this.rows[0].at : null };
  }
}

export interface EvidenceInput {
  findingId: string;
  kind?: string;
  /** The exchange id this snapshot came from, when there is one. */
  exchangeId?: string;
  request?: unknown;
  response?: unknown;
  note?: string;
}

export interface EvidenceRecord {
  id: string;
  findingId: string;
  kind: string;
  exchangeId: string | null;
  at: number;
  note: string;
  snapshot: { request: unknown; response: unknown };
  hash: string;
}

/** Stable stringify: key order must not change the hash of the same snapshot. */
function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${stable(obj[key])}`).join(',')}}`;
}

export function snapshotHash(snapshot: unknown): string {
  return createHash('sha256').update(stable(snapshot)).digest('hex');
}

/**
 * Evidence is write-once. `save` returns the existing record for a repeated
 * id rather than overwriting it, and `verify` recomputes the hash so a later
 * edit to the snapshot is visible instead of silently accepted.
 */
export class EvidenceStore {
  private rows = new Map<string, EvidenceRecord>();
  private seq = 0;
  constructor(private readonly now: () => number = Date.now) {}

  save(input: EvidenceInput): EvidenceRecord {
    const snapshot = { request: input.request ?? null, response: input.response ?? null };
    const record: EvidenceRecord = {
      id: `ev_${++this.seq}`,
      findingId: String(input.findingId || ''),
      kind: String(input.kind || 'observation'),
      exchangeId: input.exchangeId ? String(input.exchangeId) : null,
      at: this.now(),
      note: String(input.note || ''),
      snapshot,
      hash: snapshotHash(snapshot),
    };
    this.rows.set(record.id, record);
    return record;
  }

  get(id: string): EvidenceRecord | undefined { return this.rows.get(id); }

  list(findingId?: string): EvidenceRecord[] {
    const all = [...this.rows.values()];
    return findingId ? all.filter((row) => row.findingId === findingId) : all;
  }

  verify(id: string): { ok: boolean; expected?: string; actual?: string; reason?: string } {
    const row = this.rows.get(id);
    if (!row) return { ok: false, reason: 'evidence not found' };
    const actual = snapshotHash(row.snapshot);
    return actual === row.hash
      ? { ok: true, expected: row.hash, actual }
      : { ok: false, expected: row.hash, actual, reason: 'snapshot was modified after it was recorded' };
  }
}
