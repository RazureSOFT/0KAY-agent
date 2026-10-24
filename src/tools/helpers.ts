import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import type { ToolResult } from './types.js';

const MAX_OUTPUT = 120_000;
const MAX_FILE_BYTES = 2_000_000;

export function success(data: any): ToolResult {
  return { success: true, data };
}

export function failure(error: unknown): ToolResult {
  return { success: false, data: null, error: error instanceof Error ? error.message : String(error) };
}

export function clamp(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

export function limitOutput(value: string): { text: string; truncated: boolean } {
  if (value.length <= MAX_OUTPUT) return { text: value, truncated: false };
  return { text: `${value.slice(0, MAX_OUTPUT)}\n\n[output truncated]`, truncated: true };
}

const SPILL_THRESHOLD = Number(process.env.OKAY_AGENT_OUTPUT_SPILL_BYTES || 30_000);

export async function spillOutput(value: string, taskId: string, label: string): Promise<{ text: string; truncated: boolean; fullPath?: string }> {
  if (value.length <= SPILL_THRESHOLD) return { text: value, truncated: false };
  const capped = limitOutput(value);
  try {
    const dir = path.join(os.tmpdir(), '0kay-agent-output');
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${(taskId || 'task').replace(/[^\w.-]+/g, '_')}-${label}-${randomUUID()}.log`);
    await fs.writeFile(file, value, 'utf8');
    return { text: `${capped.text}\n\n[full ${label} (${value.length} chars) saved to ${file}]`, truncated: true, fullPath: file };
  } catch {
    return capped;
  }
}

export function resolvePath(input: unknown, cwd: string): string {
  if (typeof input !== 'string' || !input.trim()) throw new Error('path is required');
  return path.resolve(cwd, input);
}

export function globToRegex(pattern: string): RegExp {
  let out = '^';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        i++;
        if (pattern[i + 1] === '/') i++;
        out += '.*';
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else if ('\\^$+.|()[]{}'.includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return new RegExp(`${out}$`, 'i');
}

export async function walk(root: string, onFile: (fullPath: string, relative: string) => boolean | Promise<boolean>, max = 2_000): Promise<number> {
  let seen = 0;
  const visit = async (dir: string): Promise<boolean> => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'dist') continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!(await visit(fullPath))) return false;
        continue;
      }
      if (!entry.isFile()) continue;
      seen++;
      if (!(await onFile(fullPath, path.relative(root, fullPath).replace(/\\/g, '/'))) || seen >= max) return false;
    }
    return true;
  };
  await visit(root);
  return seen;
}

export function simpleDiff(filePath: string, original: string, updated: string): string {
  const oldLines = original.split(/\r?\n/); const newLines = updated.split(/\r?\n/);
  const limit = 400; const out = [`--- a/${filePath}`, `+++ b/${filePath}`];
  const max = Math.max(oldLines.length, newLines.length);
  let oldNo = 1, newNo = 1, inHunk = false;
  for (let i = 0; i < max && out.length < limit; i++) {
    const before = oldLines[i]; const after = newLines[i];
    if (before === after) { oldNo++; newNo++; inHunk = false; continue; }
    if (!inHunk) { out.push(`@@ -${oldNo} +${newNo} @@`); inHunk = true; }
    if (before !== undefined) { out.push(`-${before}`); oldNo++; }
    if (after !== undefined) { out.push(`+${after}`); newNo++; }
  }
  if (out.length >= limit) out.push('[diff truncated]');
  return out.join('\n');
}

export { MAX_OUTPUT, MAX_FILE_BYTES };

export async function egressOrDirect(url: string, options: RequestInit = {}, timeoutMs = 60000): Promise<Response> {
  const { egressFetch } = await import('../connection.js');
  try {
    return await egressFetch(url, options, timeoutMs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/egress HTTP|not allowed|blocked/i.test(message)) {
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
      return fetch(url, { ...options, signal });
    }
    throw error;
  }
}
