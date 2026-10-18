/**
 * Agent tool suite. The names and contracts follow the useful core of
 * opencode's tool set while keeping execution local to the Agent host.
 */

import { exec as execCallback, execFile } from 'child_process';
import { withWindowsShellHint } from './shell_hint.js';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { createHash, randomUUID } from 'crypto';
import { SkillRegistry, getSkillRegistry } from '../skills/skills.js';
import { egressFetch, callPluginTool, coreFetch, coreHeaders, coreHttpBase } from '../connection.js';
import type { ContextLedger } from '../context/ledger.js';
import { buildDocx, buildPptx, type DocBlock, type SlideSpec } from './office.js';
import { browserController } from './browser.js';
import { ensureNative, nativeAvailable } from './win_native.js';
import { posixInput, type PosixInput } from './posix_native.js';
import { isPathAllowed } from '../workspace/paths.js';
import { ScrapeTool } from './scrape.js';
import { CrawlTool } from './crawl.js';
import { ScreenshotToCodeTool } from './screenshot_to_code.js';
import { ReverseEngineerTool } from './reverse_engineer.js';
import { PentestTool } from './pentest.js';
import { DiagramTool } from './diagram.js';
import { SetupDepsTool } from './setup_deps.js';
import { GitHubSearchTool } from './github_search.js';
import { BackgroundTaskTool } from './background_task.js';
import { Tool, type ToolResult, type ToolContext, type TodoItem, type McpClientLike } from './types.js';
import {
  success, failure, clamp, limitOutput, spillOutput, resolvePath, globToRegex, walk, simpleDiff,
  MAX_FILE_BYTES as MAX_FILE_BYTES_LIMIT,
} from './helpers.js';
import { writeFileAtomic } from './atomic_write.js';
import { streamWriteFile } from './stream_write.js';

export { Tool };
export type { ToolResult, ToolContext, TodoItem, McpClientLike };
export type { JSONSchema, McpToolInfo } from './types.js';

const exec = promisify(execCallback);
// ESM has no __dirname; used to locate the sibling `life/src` package.
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const MAX_FILE_BYTES = MAX_FILE_BYTES_LIMIT;

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, any>;
  dangerous?: boolean;
}


/** Reject `promise` as soon as `signal` aborts (the underlying work is abandoned,
 *  not interrupted). Resolves/rejects with the original promise otherwise. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined, message: string): Promise<T> {
  if (!signal) return promise;
  const abortError = () => (signal.reason instanceof Error ? signal.reason : new Error(message));
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error) => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

export class ReadTool extends Tool {
  get name(): string { return 'read'; }
  get description(): string { return 'Read a text file with numbered lines. Use offset and limit for large files.'; }
  get parameters(): Record<string, any> {
    return { type: 'object', required: ['filePath'], properties: {
      filePath: { type: 'string', description: 'Absolute or task-relative file path.' },
      offset: { type: 'integer', minimum: 1, description: 'First line to read (default 1).' },
      limit: { type: 'integer', minimum: 1, maximum: 2000, description: 'Maximum lines to return (default 200).' },
    }};
  }
  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    try {
      const filePath = resolvePath(args.filePath, context.cwd);
      const stat = await fs.stat(filePath);
      if (stat.isDirectory()) {
        const entries = await fs.readdir(filePath, { withFileTypes: true });
        return success({ path: filePath, entries: entries.map((entry) => `${entry.name}${entry.isDirectory() ? '/' : ''}`).sort() });
      }
      if (stat.size > MAX_FILE_BYTES) throw new Error(`refusing to read ${stat.size} byte file (limit ${MAX_FILE_BYTES})`);
      const lines = (await fs.readFile(filePath, 'utf8')).split(/\r?\n/);
      const offset = clamp(args.offset, 1, 1, lines.length || 1);
      const limit = clamp(args.limit, 200, 1, 2000);
      const selected = lines.slice(offset - 1, offset - 1 + limit);
      return success({
        path: filePath,
        totalLines: lines.length,
        offset,
        hasMore: offset - 1 + selected.length < lines.length,
        content: selected.map((line, index) => `${offset + index}: ${line}`).join('\n'),
      });
    } catch (error) { return failure(error); }
  }
}

export class WriteTool extends Tool {
  get name(): string { return 'write'; }
  get description(): string { return 'Create or fully replace a text file. Content is streamed to the file so the Agent UI can show it being written; pass stream:false for a single atomic replace (secrets, generated files, anything that must never be observed half-written). Prefer edit for small targeted changes.'; }
  get dangerous(): boolean { return true; }
  get parameters(): Record<string, any> {
    return { type: 'object', required: ['filePath', 'content'], properties: {
      filePath: { type: 'string' }, content: { type: 'string' },
      stream: { type: 'boolean', description: 'Publish the content progressively so the UI can render it as it is typed. Default true; false writes atomically in one step.' },
    }};
  }
  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    try {
      const filePath = resolvePath(args.filePath, context.cwd);
      if (!isPathAllowed(filePath)) throw new Error('path not allowed: outside workspace roots');
      if (typeof args.content !== 'string') throw new Error('content must be a string');
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      const existed = await fs.stat(filePath).then(() => true).catch(() => false);
      const summary = { path: filePath, created: !existed, bytes: Buffer.byteLength(args.content), lines: args.content.split(/\r?\n/).length };

      if (args.stream === false) {
        await writeFileAtomic(filePath, args.content);
        return success({ ...summary, streamed: false });
      }

      // Streaming truncates the target immediately and appends over ~2.5s, so an
      // observer sees it grow. The previous contents are restored if this fails
      // or is cancelled (see stream_write.ts).
      const result = await streamWriteFile(filePath, args.content, context.signal);
      return success({ ...summary, streamed: result.paced, bytes: result.bytes });
    } catch (error) { return failure(error); }
  }
}

export class EditTool extends Tool {
  get name(): string { return 'edit'; }
  get description(): string { return 'Replace an exact unique text block in a file. Set replaceAll only when every occurrence is intended.'; }
  get dangerous(): boolean { return true; }
  get parameters(): Record<string, any> {
    return { type: 'object', required: ['filePath', 'oldString', 'newString'], properties: {
      filePath: { type: 'string' }, oldString: { type: 'string' }, newString: { type: 'string' },
      replaceAll: { type: 'boolean', description: 'Replace all exact occurrences; default false.' },
    }};
  }
  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    try {
      const filePath = resolvePath(args.filePath, context.cwd);
      if (!isPathAllowed(filePath)) throw new Error('path not allowed: outside workspace roots');
      if (typeof args.oldString !== 'string' || typeof args.newString !== 'string') throw new Error('oldString and newString must be strings');
      if (args.oldString === args.newString) throw new Error('oldString and newString are identical');
      const original = await fs.readFile(filePath, 'utf8');
      if (!args.oldString) throw new Error('oldString cannot be empty for an existing file; use write for a full replacement');
      const count = original.split(args.oldString).length - 1;
      if (count === 0) throw new Error('oldString was not found; re-read the file and include exact whitespace');
      if (count > 1 && args.replaceAll !== true) throw new Error('oldString occurs multiple times; include more surrounding context or set replaceAll');
      const updated = args.replaceAll === true ? original.split(args.oldString).join(args.newString) : original.replace(args.oldString, args.newString);
      await writeFileAtomic(filePath, updated);
      return success({ path: filePath, replacements: args.replaceAll === true ? count : 1, diff: simpleDiff(filePath, original, updated) });
    } catch (error) { return failure(error); }
  }
}

export class ApplyPatchTool extends Tool {
  get name(): string { return 'apply_patch'; }
  get description(): string { return 'Validate and apply exact file replacements, rolling back completed writes on failure. Each patch has filePath, oldString, newString, and optional replaceAll.'; }
  get dangerous(): boolean { return true; }
  get parameters(): Record<string, any> {
    return { type: 'object', required: ['patches'], properties: {
      patches: { type: 'array', minItems: 1, items: { type: 'object', required: ['filePath', 'oldString', 'newString'], properties: {
        filePath: { type: 'string' }, oldString: { type: 'string' }, newString: { type: 'string' }, replaceAll: { type: 'boolean' },
      }}},
    }};
  }
  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    try {
      if (!Array.isArray(args.patches) || args.patches.length === 0) throw new Error('patches must be a non-empty array');
      const staged: Array<{ filePath: string; original: string; updated: string }> = [];
      for (const patch of args.patches) {
        const filePath = resolvePath(patch?.filePath, context.cwd);
        if (!isPathAllowed(filePath)) throw new Error('path not allowed: outside workspace roots');
        if (typeof patch.oldString !== 'string' || typeof patch.newString !== 'string' || !patch.oldString) throw new Error(`invalid patch for ${filePath}`);
        const original = [...staged].reverse().find(p => p.filePath === filePath)?.updated ?? await fs.readFile(filePath, 'utf8');
        const count = original.split(patch.oldString).length - 1;
        if (!count) throw new Error(`oldString was not found in ${filePath}`);
        if (count > 1 && patch.replaceAll !== true) throw new Error(`oldString occurs multiple times in ${filePath}`);
        staged.push({ filePath, original, updated: patch.replaceAll === true ? original.split(patch.oldString).join(patch.newString) : original.replace(patch.oldString, patch.newString) });
      }
      const written: typeof staged = [];
      try {
        for (const patch of staged) {
          context.signal?.throwIfAborted();
          await writeFileAtomic(patch.filePath, patch.updated);
          written.push(patch);
        }
      } catch (error) {
        // Roll back what was already applied, and do not let a failing rollback
        // replace the original error — the caller needs to know which write
        // failed, not just that the undo failed too.
        const rollbackFailures: string[] = [];
        for (const patch of written.reverse()) {
          try {
            await writeFileAtomic(patch.filePath, patch.original);
          } catch (rollbackError: any) {
            rollbackFailures.push(`${patch.filePath}: ${rollbackError?.message || rollbackError}`);
          }
        }
        if (rollbackFailures.length) {
          throw new Error(
            `${(error as any)?.message || error} — additionally, rollback failed for: ${rollbackFailures.join('; ')}`,
          );
        }
        throw error;
      }
      return success({ files: staged.map((patch) => ({ path: patch.filePath, diff: simpleDiff(patch.filePath, patch.original, patch.updated) })) });
    } catch (error) { return failure(error); }
  }
}

export class GlobTool extends Tool {
  get name(): string { return 'glob'; }
  get description(): string { return 'Find files by glob pattern such as **/*.ts or src/**/*.vue.'; }
  get parameters(): Record<string, any> {
    return { type: 'object', required: ['pattern'], properties: {
      pattern: { type: 'string' }, path: { type: 'string', description: 'Search root; defaults to task working directory.' },
    }};
  }
  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    try {
      if (typeof args.pattern !== 'string' || !args.pattern) throw new Error('pattern is required');
      const root = args.path ? resolvePath(args.path, context.cwd) : context.cwd;
      const regex = globToRegex(args.pattern.replace(/\\/g, '/'));
      const files: string[] = [];
      const scanned = await walk(root, async (fullPath, relative) => {
        if (regex.test(relative)) files.push(fullPath);
        return files.length < 500;
      });
      return success({ root, pattern: args.pattern, files, truncated: files.length >= 500, scanned });
    } catch (error) { return failure(error); }
  }
}

export class GrepTool extends Tool {
  get name(): string { return 'grep'; }
  get description(): string { return 'Search file contents with a regular expression. Returns matching file paths, line numbers, and text.'; }
  get parameters(): Record<string, any> {
    return { type: 'object', required: ['pattern'], properties: {
      pattern: { type: 'string' }, path: { type: 'string' }, include: { type: 'string', description: 'Optional glob filter, for example *.ts.' },
    }};
  }
  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    try {
      if (typeof args.pattern !== 'string' || !args.pattern) throw new Error('pattern is required');
      const root = args.path ? resolvePath(args.path, context.cwd) : context.cwd;
      const pattern = new RegExp(args.pattern, 'i');
      const include = typeof args.include === 'string' && args.include ? globToRegex(args.include) : null;
      const matches: Array<{ path: string; line: number; text: string }> = [];
      await walk(root, async (fullPath, relative) => {
        if (include && !include.test(relative)) return true;
        const stat = await fs.stat(fullPath);
        if (stat.size > MAX_FILE_BYTES) return true;
        const text = await fs.readFile(fullPath, 'utf8').catch(() => '');
        for (const [index, line] of text.split(/\r?\n/).entries()) {
          pattern.lastIndex = 0;
          if (pattern.test(line)) matches.push({ path: fullPath, line: index + 1, text: line });
          if (matches.length >= 500) return false;
        }
        return matches.length < 500;
      });
      return success({ root, pattern: args.pattern, matches, truncated: matches.length >= 500 });
    } catch (error) { return failure(error); }
  }
}

interface ShellRequest {
  command: string;
  cwd?: string;
  timeout?: number;
  /** Distinguishes spill files when several commands run in parallel. */
  label: string;
}

export class ShellTool extends Tool {
  get name(): string { return 'bash'; }
  get description(): string {
    return `Run shell command(s) using ${process.platform === 'win32' ? 'Windows cmd.exe (NOT bash or PowerShell). Use dir/cd and &&, not pwd/ls or semicolons.' : '/bin/sh'}. Pass one command in command, or several independent ones in commands to run them all in parallel and get one result per command (e.g. build + test + lint at once). Use cwd and timeout (ms) when needed.`;
  }
  get dangerous(): boolean { return true; }
  get parameters(): Record<string, any> {
    return { type: 'object', properties: {
      command: { type: 'string', description: 'A single command to run.' },
      commands: { type: 'array', minItems: 1, description: 'Independent commands to run in parallel. Each entry is a string, or an object {command, cwd?, timeout?}.', items: { anyOf: [
        { type: 'string' },
        { type: 'object', properties: { command: { type: 'string' }, cwd: { type: 'string' }, timeout: { type: 'integer', minimum: 1000, maximum: 300000 } }, required: ['command'] },
      ] } },
      cwd: { type: 'string' }, timeout: { type: 'integer', minimum: 1000, maximum: 300000 },
    }};
  }
  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    try {
      const requests: ShellRequest[] = [];
      if (Array.isArray(args.commands) && args.commands.length) {
        args.commands.forEach((entry: any, index: number) => {
          const spec = typeof entry === 'string' ? { command: entry } : (entry || {});
          const command = String(spec.command ?? '');
          if (!command.trim()) throw new Error(`commands[${index}].command is required`);
          requests.push({
            command,
            cwd: spec.cwd != null ? String(spec.cwd) : undefined,
            timeout: spec.timeout != null ? Number(spec.timeout) : undefined,
            label: String(index + 1),
          });
        });
      } else {
        if (typeof args.command !== 'string' || !args.command.trim()) throw new Error('command is required (or pass commands:[] to run several in parallel)');
        requests.push({
          command: args.command,
          cwd: args.cwd != null ? String(args.cwd) : undefined,
          timeout: args.timeout != null ? Number(args.timeout) : undefined,
          label: '',
        });
      }
      const results = await Promise.all(requests.map((request) => this.runOne(request, args, context)));
      if (results.length === 1) return results[0];
      const failed = results.filter((result) => !result.success).length;
      return {
        success: failed === 0,
        data: { parallel: results.length, failed, results: results.map((result) => result.data) },
        error: failed ? `${failed} of ${results.length} parallel commands failed (see results[].stderr)` : undefined,
      };
    } catch (error) { return failure(error); }
  }

  private async runOne(request: ShellRequest, args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    try {
      const cwd = request.cwd ? resolvePath(request.cwd, context.cwd) : context.cwd;
      const timeout = clamp(request.timeout ?? args.timeout, 30_000, 1_000, 300_000);
      const stdoutLabel = request.label ? `stdout-${request.label}` : 'stdout';
      const stderrLabel = request.label ? `stderr-${request.label}` : 'stderr';
      try {
        const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
          const command = process.platform === 'win32' ? `chcp 65001 >nul & ${request.command}` : request.command;
          const child = execCallback(command, { cwd, maxBuffer: 10 * 1024 * 1024, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } }, (error, stdout, stderr) => {
            clearTimeout(timer);
            context.signal?.removeEventListener('abort', cancel);
            if (error) reject(Object.assign(error, { stdout, stderr }));
            else resolve({ stdout, stderr });
          });
          const cancel = () => {
            if (process.platform === 'win32' && child.pid) {
              execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {});
            } else {
              child.kill('SIGTERM');
              // Escalate in case the child ignores SIGTERM.
              setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already dead */ } }, 5000);
            }
          };
          const timer = setTimeout(cancel, timeout);
          context.signal?.addEventListener('abort', cancel, { once: true });
          if (context.signal?.aborted) cancel();
        });
        const stdout = await spillOutput(result.stdout || '', context.taskId, stdoutLabel);
        const stderr = await spillOutput(result.stderr || '', context.taskId, stderrLabel);
        return success({ command: request.command, cwd, stdout: stdout.text, stderr: stderr.text, exitCode: 0, truncated: stdout.truncated || stderr.truncated, fullOutputPath: stdout.fullPath || stderr.fullPath });
      } catch (error: any) {
        const stdout = await spillOutput(String(error.stdout || ''), context.taskId, stdoutLabel);
        // A failed command on Windows may have failed only because it used POSIX
        // syntax; cmd.exe's "not recognized" names neither the token nor the
        // equivalent, so the model retries with another POSIX spelling. Appending
        // the translation here is purely additive — it runs after the failure.
        const rawStderr = withWindowsShellHint(request.command, String(error.stderr || error.message || 'command failed'));
        const stderr = await spillOutput(rawStderr, context.taskId, stderrLabel);
        return { success: false, data: { command: request.command, cwd, stdout: stdout.text, stderr: stderr.text, exitCode: Number(error.code) || 1 }, error: stderr.text };
      }
    } catch (error) { return failure(error); }
  }
}

export class WebFetchTool extends Tool {
  get name(): string { return 'webfetch'; }
  get description(): string { return 'Fetch a URL and return text, markdown-like HTML stripping, or raw HTML.'; }
  get parameters(): Record<string, any> {
    return { type: 'object', required: ['url'], properties: {
      url: { type: 'string', format: 'uri' }, format: { type: 'string', enum: ['text', 'markdown', 'html'] }, timeout: { type: 'integer', minimum: 1, maximum: 120 },
    }};
  }
  async execute(args: Record<string, any>, context?: ToolContext): Promise<ToolResult> {
    try {
      if (typeof args.url !== 'string' || !/^https?:\/\//i.test(args.url)) throw new Error('url must be an http(s) URL');
      const timeout = AbortSignal.timeout(clamp(args.timeout, 30, 1, 120) * 1000);
      const signal = context?.signal ? AbortSignal.any([timeout, context.signal]) : timeout;
      const response = await egressFetch(args.url, { signal, headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      } }, clamp(args.timeout, 30, 1, 120) * 1000);
      const html = await response.text();
      const format = args.format || 'markdown';
      const content = format === 'html' ? html : html
        .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '')
        .replace(/<\/(p|div|h[1-6]|li|br|tr)>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      const limited = limitOutput(content);
      return success({ url: response.url, status: response.status, contentType: response.headers.get('content-type') || '', content: limited.text, truncated: limited.truncated });
    } catch (error) { return failure(error); }
  }
}

export class WebSearchTool extends Tool {
  get name(): string { return 'websearch'; }
  get description(): string { return 'Search the web through Core and return titles, URLs, and snippets.'; }
  get parameters(): Record<string, any> {
    return { type: 'object', required: ['query'], properties: {
      query: { type: 'string' }, numResults: { type: 'integer', minimum: 1, maximum: 20 },
    }};
  }
  async execute(args: Record<string, any>, context?: ToolContext): Promise<ToolResult> {
    try {
      if (typeof args.query !== 'string' || !args.query.trim()) throw new Error('query is required');
      const endpoint = new URL(`${coreHttpBase()}/api/search`);
      endpoint.searchParams.set('q', args.query);
      const limit = clamp(args.numResults, 5, 1, 20);
      endpoint.searchParams.set('n', String(limit));
      const timeout = AbortSignal.timeout(30000);
      const signal = context?.signal ? AbortSignal.any([timeout, context.signal]) : timeout;
      // Core owns the built-in search (no separate SearXNG service/port).
      const response = await coreFetch(endpoint.toString(), { headers: coreHeaders(), signal });
      if (!response.ok) throw new Error(`search returned ${response.status}`);
      const body: any = await response.json();
      const results = Array.isArray(body.results)
        ? body.results.slice(0, limit).map((item: any) => ({ title: item.title || '', url: item.url || '', snippet: item.snippet || item.content || '' }))
        : [];
      return success({ query: args.query, engine: body?.engine || 'core', results });
    } catch (error) { return failure(error); }
  }
}

/** Shared parser for Core's {results:[{title,url,snippet,engine}]} envelope. */
function readSearchResults(body: any, limit: number): Array<Record<string, string>> {
  if (!Array.isArray(body?.results)) return [];
  return body.results.slice(0, limit).map((item: any) => ({
    title: item.title || '', url: item.url || '', snippet: item.snippet || '', source: item.engine || '',
  }));
}

/** Academic paper search (arXiv / Crossref / OpenAlex), separate from websearch. */
export class PaperSearchTool extends Tool {
  get name(): string { return 'papersearch'; }
  get description(): string { return 'Search academic papers (arXiv, Crossref, OpenAlex). Returns title, authors, year, venue, URL and an abstract snippet so results can be cited.'; }
  get parameters(): Record<string, any> {
    return { type: 'object', required: ['query'], properties: {
      query: { type: 'string' }, numResults: { type: 'integer', minimum: 1, maximum: 20 },
    }};
  }
  async execute(args: Record<string, any>, context?: ToolContext): Promise<ToolResult> {
    try {
      if (typeof args.query !== 'string' || !args.query.trim()) throw new Error('query is required');
      const limit = clamp(args.numResults, 6, 1, 20);
      const endpoint = new URL(`${coreHttpBase()}/api/search/papers`);
      endpoint.searchParams.set('q', args.query);
      endpoint.searchParams.set('n', String(limit));
      const timeout = AbortSignal.timeout(30000);
      const signal = context?.signal ? AbortSignal.any([timeout, context.signal]) : timeout;
      const response = await coreFetch(endpoint.toString(), { headers: coreHeaders(), signal });
      if (!response.ok) throw new Error(`paper search returned ${response.status}`);
      return success({ query: args.query, results: readSearchResults(await response.json(), limit) });
    } catch (error) { return failure(error); }
  }
}

/** API documentation search (MDN / MS Learn / Stack Overflow), separate from websearch. */
export class ApiDocSearchTool extends Tool {
  get name(): string { return 'apidocsearch'; }
  get description(): string { return 'Search API documentation (MDN, Microsoft Learn, Stack Overflow, official doc sites). Use for library/API signatures, usage and examples.'; }
  get parameters(): Record<string, any> {
    return { type: 'object', required: ['query'], properties: {
      query: { type: 'string' }, numResults: { type: 'integer', minimum: 1, maximum: 20 },
    }};
  }
  async execute(args: Record<string, any>, context?: ToolContext): Promise<ToolResult> {
    try {
      if (typeof args.query !== 'string' || !args.query.trim()) throw new Error('query is required');
      const limit = clamp(args.numResults, 6, 1, 20);
      const endpoint = new URL(`${coreHttpBase()}/api/search/apidocs`);
      endpoint.searchParams.set('q', args.query);
      endpoint.searchParams.set('n', String(limit));
      const timeout = AbortSignal.timeout(30000);
      const signal = context?.signal ? AbortSignal.any([timeout, context.signal]) : timeout;
      const response = await coreFetch(endpoint.toString(), { headers: coreHeaders(), signal });
      if (!response.ok) throw new Error(`api docs search returned ${response.status}`);
      return success({ query: args.query, results: readSearchResults(await response.json(), limit) });
    } catch (error) { return failure(error); }
  }
}

export class TodoWriteTool extends Tool {
  get name(): string { return 'todowrite'; }
  get description(): string { return 'Replace the current task todo list with explicit pending/in_progress/completed items.'; }
  get parameters(): Record<string, any> {
    return { type: 'object', required: ['todos'], properties: { todos: { type: 'array', items: { type: 'object', required: ['content', 'status'], properties: {
      id: { type: 'string' }, content: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled'] }, priority: { type: 'string', enum: ['high', 'medium', 'low'] },
    }}}}};
  }
  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    try {
      if (!Array.isArray(args.todos)) throw new Error('todos must be an array');
      const todos: TodoItem[] = args.todos.map((item: any, index: number) => {
        if (!item || typeof item.content !== 'string' || !item.content.trim()) throw new Error(`todo ${index + 1} needs content`);
        if (!['pending', 'in_progress', 'completed', 'cancelled'].includes(item.status)) throw new Error(`todo ${index + 1} has invalid status`);
        return { id: typeof item.id === 'string' && item.id ? item.id : randomUUID(), content: item.content.trim(), status: item.status, priority: item.priority };
      });
      const current = context.todo ?? (context.todo = []);
      current.splice(0, current.length, ...todos);
      return success({ todos: current });
    } catch (error) { return failure(error); }
  }
}

export class SkillTool extends Tool {
  constructor(private readonly skills: SkillRegistry) { super(); }
  get name(): string { return 'skill'; }
  get description(): string { return 'Load the full instructions for an available Agent skill.'; }
  get parameters(): Record<string, any> {
    return { type: 'object', required: ['name'], properties: { name: { type: 'string' } } };
  }
  async execute(args: Record<string, any>): Promise<ToolResult> {
    if (typeof args.name !== 'string' || !args.name.trim()) return failure('name is required');
    const skill = this.skills.get(args.name.trim());
    if (!skill) return failure(`skill '${args.name}' not found`);
    return success({ name: skill.name, description: skill.description, content: skill.content, tags: skill.tags });
  }
}

export class TaskTool extends Tool {
  get name(): string { return 'task'; }
  get description(): string { return 'Delegate a focused subtask to a sub-agent and return its final result.'; }
  get parameters(): Record<string, any> {
    return { type: 'object', required: ['prompt'], properties: { prompt: { type: 'string' }, agentType: { type: 'string', description: 'Optional sub-agent type such as code or research.' } } };
  }
  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    if (!context.runSubAgent) return failure('sub-agent execution is unavailable');
    if (typeof args.prompt !== 'string' || !args.prompt.trim()) return failure('prompt is required');
    try { return success({ result: await context.runSubAgent(args.prompt, typeof args.agentType === 'string' ? args.agentType : undefined) }); } catch (error) { return failure(error); }
  }
}

export class McpTool extends Tool {
  get name(): string { return 'mcp'; }
  get description(): string { return 'List or call tools supplied by configured MCP servers.'; }
  get parameters(): Record<string, any> {
    return { type: 'object', required: ['action'], properties: { action: { type: 'string', enum: ['list', 'call'] }, server: { type: 'string' }, tool: { type: 'string' }, args: { type: 'object' } } };
  }
  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    if (!context.mcp) return failure('0kay-mcp is not configured');
    try {
      if (args.action === 'list') return success({ tools: context.mcp.listTools() });
      if (args.action !== 'call') throw new Error('action must be list or call');
      if (typeof args.server !== 'string' || typeof args.tool !== 'string') throw new Error('server and tool are required for a call');
      // The manager's callTool takes no signal, so race the abort to stop waiting
      // on a hung server when the task is cancelled.
      const call = context.mcp.callTool(args.server, args.tool, args.args && typeof args.args === 'object' ? args.args : {});
      const result = await raceAbort(call, context.signal, `MCP call ${args.server}:${args.tool} aborted`);
      return success({ server: args.server, tool: args.tool, result });
    } catch (error) { return failure(error); }
  }
}

/** macOS virtual keycodes for special keys (used by `osascript ... key code N`). */
const MAC_KEY_CODES: Record<string, number> = {
  return: 36, enter: 36, tab: 48, space: 49, delete: 51, backspace: 51, escape: 53, esc: 53,
  left: 123, right: 124, down: 125, up: 126, home: 115, end: 119, pageup: 116, pagedown: 121,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111,
};

/** AppleScript modifier clauses for a leading hotkey token. */
const MAC_MODIFIERS: Record<string, string> = {
  cmd: 'command down', command: 'command down', meta: 'command down', super: 'command down',
  ctrl: 'control down', control: 'control down', alt: 'option down', option: 'option down', shift: 'shift down',
};

/** xdotool keysym names for tokens that differ from the plain name. */
const LINUX_KEYS: Record<string, string> = {
  cmd: 'super', command: 'super', meta: 'super', win: 'super',
  ctrl: 'ctrl', control: 'ctrl', alt: 'alt', shift: 'shift',
  return: 'Return', enter: 'Return', escape: 'Escape', esc: 'Escape', space: 'space', tab: 'Tab',
  delete: 'Delete', backspace: 'BackSpace', left: 'Left', right: 'Right', up: 'Up', down: 'Down',
  home: 'Home', end: 'End', pageup: 'Prior', pagedown: 'Next',
};

function appleScriptEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n');
}

/** Build the AppleScript statement that emits a hotkey such as `cmd+shift+t` or `return`. */
export function appleScriptForKey(raw: string): string {
  const parts = raw.split('+').map((part) => part.trim()).filter(Boolean);
  const key = parts.pop() || '';
  if (!key) throw new Error('key is required');
  const modifiers: string[] = [];
  for (const part of parts) {
    const clause = MAC_MODIFIERS[part.toLowerCase()];
    if (clause && !modifiers.includes(clause)) modifiers.push(clause);
  }
  const using = modifiers.length ? ` using {${modifiers.join(', ')}}` : '';
  const code = MAC_KEY_CODES[key.toLowerCase()];
  if (code !== undefined) return `key code ${code}${using}`;
  if ([...key].length === 1) return `keystroke "${appleScriptEscape(key)}"${using}`;
  throw new Error(`unsupported key: ${raw}`);
}

/** Map a canonical `ctrl+shift+t` hotkey to an xdotool key expression. */
export function linuxKeyExpression(raw: string): string {
  return raw.split('+').map((part) => part.trim()).filter(Boolean)
    .map((part) => LINUX_KEYS[part.toLowerCase()] ?? part).join('+');
}

/**
 * One live desktop frame for the WebUI's "AI is using the computer" window.
 * `image` is base64 of a downscaled JPEG preview.
 */
export interface DesktopFrame {
  image: string;
  mime: string;
  width: number;
  height: number;
  at: number;
}

/** Preview geometry and cadence for the live-view stream. */
const STREAM_WIDTH = 1024;
const STREAM_QUALITY = 50;
const STREAM_MIN_INTERVAL_MS = 66;

/**
 * Operate the host desktop (screenshot, list windows, mouse, keyboard).
 *
 * Backends: Windows native via `koffi` (user32/gdi32/gdiplus — no PowerShell),
 * macOS `screencapture` + `osascript` + `cliclick`, Linux
 * `grim`/`scrot`/ImageMagick + `xdotool`. A missing backend is reported as a
 * clear, actionable error.
 */
export class ComputerUseTool extends Tool {
  private tail: Promise<unknown> = Promise.resolve();
  private streamFrameCache: DesktopFrame | null = null;
  private streamFrameAt = 0;
  get name(): string { return 'computeruse'; }
  get description(): string { return 'Operate the Agent host computer: screenshot, list open windows, move/click the mouse, type text, or press keys. Supports Windows, macOS and Linux hosts. Requires explicit computer-use permission.'; }
  get dangerous(): boolean { return true; }
  get parameters(): Record<string, any> {
    return { type: 'object', required: ['action'], properties: {
      action: { type: 'string', enum: ['screenshot', 'listwindows', 'move', 'click', 'doubleclick', 'scroll', 'drag', 'type', 'key'] }, x: { type: 'integer' }, y: { type: 'integer' }, x2: { type: 'integer' }, y2: { type: 'integer' }, button: { type: 'string', enum: ['left', 'right'] }, text: { type: 'string' }, key: { type: 'string' }, delta: { type: 'integer', minimum: -20, maximum: 20, description: 'Scroll notches: positive down, negative up' }, duration: { type: 'integer', minimum: 0, maximum: 5000, description: 'Drag duration in ms (drag only)' },
    }};
  }
  async execute(args: Record<string, any>, context?: ToolContext): Promise<ToolResult> {
    // 桌面状态只有一个，批量工具调用不能让截图、移动、键盘互相抢占。
    const run = this.tail.then(() => this.executeDesktop(args, context));
    this.tail = run.catch(() => undefined);
    return run;
  }
  private async executeDesktop(args: Record<string, any>, context?: ToolContext): Promise<ToolResult> {
    try {
      context?.signal?.throwIfAborted();
      const action = String(args.action || '');
      switch (action) {
        case 'listwindows': return success(await this.listWindows(context));
        case 'screenshot': return success(await this.screenshot(context));
        case 'type': return success(await this.typeText(args, context));
        case 'key': return success(await this.pressKey(args, context));
        case 'move': return success(await this.pointer(args, false, context));
        case 'click': return success(await this.pointer(args, true, context));
        case 'doubleclick':
          return success(await this.pointer({ ...args, double: true }, true, context));
        case 'scroll': return success(await this.scroll(args, context));
        case 'drag': return success(await this.drag(args, context));
        default: throw new Error('invalid computer action');
      }
    } catch (error) { return failure(error); }
  }

  /** Run a command with a bounded lifetime and no console window. */
  private run(file: string, args: string[], context?: ToolContext, timeout = 30_000): Promise<{ stdout: string; stderr: string }> {
    return promisify(execFile)(file, args, { timeout, windowsHide: true, signal: context?.signal, maxBuffer: 32 << 20 }) as Promise<{ stdout: string; stderr: string }>;
  }

  private async hasCommand(name: string, context?: ToolContext): Promise<boolean> {
    try {
      if (process.platform === 'win32') await this.run('where', [name], context, 8000);
      else await this.run('/bin/sh', ['-c', `command -v ${name}`], context, 8000);
      return true;
    } catch { return false; }
  }

  private async requireCommand(name: string, context: ToolContext | undefined, hint: string): Promise<void> {
    if (!(await this.hasCommand(name, context))) throw new Error(`computeruse needs \`${name}\` on this host (${hint})`);
  }

  /** Run a native macOS/Linux input action; false when native is unavailable or
   *  fails, so the caller falls back to the shell tools. */
  private tryNative(action: (native: PosixInput) => boolean | void): boolean {
    const native = posixInput();
    if (!native) return false;
    try { return action(native) !== false; } catch { return false; }
  }

  /** Latest live frame for the WebUI stream. Windows captures natively through
   *  koffi; other platforms capture on demand with their own tools. `after` is
   *  the last frame timestamp the caller already has, so an unchanged frame is
   *  returned with an empty `image` instead of re-sending the pixels. */
  async streamFrame(context?: ToolContext, after = 0): Promise<DesktopFrame | null> {
    const now = Date.now();
    if (!this.streamFrameCache || now - this.streamFrameAt >= STREAM_MIN_INTERVAL_MS) {
      if (process.platform === 'win32') {
        if (!nativeAvailable()) return null;
        const shot = ensureNative().capture(STREAM_WIDTH, STREAM_QUALITY);
        this.streamFrameCache = { image: shot.buffer.toString('base64'), mime: 'image/jpeg', width: shot.width, height: shot.height, at: now };
      } else {
        const shot = await this.screenshot(context);
        this.streamFrameCache = { image: shot.base64, mime: shot.mime, width: shot.width || 0, height: shot.height || 0, at: now };
      }
      this.streamFrameAt = now;
    }
    const frame = this.streamFrameCache;
    return frame.at <= after ? { ...frame, image: '' } : frame;
  }

  /** True while a capture backend is up (lets a warming stream stay open). */
  streamAlive(): boolean {
    return process.platform === 'win32' ? nativeAvailable() : true;
  }

  // --- screenshot -----------------------------------------------------------
  private async screenshot(context?: ToolContext) {
    if (process.platform === 'win32') {
      const shot = ensureNative().capture(0, 82);
      const file = path.join(os.tmpdir(), `0kay-screen-${Date.now()}-${randomUUID()}.jpg`);
      await fs.writeFile(file, shot.buffer);
      return {
        path: file,
        preview: file,
        sha256: createHash('sha256').update(shot.buffer).digest('hex'),
        width: shot.width,
        height: shot.height,
        mime: 'image/jpeg',
        base64: shot.buffer.toString('base64'),
        coordinateSpace: 'original screen pixels (width/height)',
      };
    }
    const stamp = `${Date.now()}-${randomUUID()}`;
    const png = path.join(os.tmpdir(), `0kay-screen-${stamp}.png`);
    const jpg = path.join(os.tmpdir(), `0kay-screen-${stamp}.jpg`);
    let previewPath = png;
    let mime = 'image/png';
    if (process.platform === 'darwin') {
      await this.run('screencapture', ['-x', png], context);
      previewPath = (await this.downscaleMac(png, jpg, context)) ? jpg : png;
      mime = previewPath === jpg ? 'image/jpeg' : 'image/png';
    } else if (process.platform === 'linux') {
      await this.captureLinux(png, context);
      previewPath = (await this.downscaleLinux(png, jpg, context)) ? jpg : png;
      mime = previewPath === jpg ? 'image/jpeg' : 'image/png';
    } else {
      throw new Error(`computeruse is not supported on ${process.platform}`);
    }
    const pngBytes = await fs.readFile(png);
    const previewBytes = await fs.readFile(previewPath);
    return {
      path: png,
      preview: previewPath,
      sha256: createHash('sha256').update(pngBytes).digest('hex'),
      width: pngBytes.length > 24 ? pngBytes.readUInt32BE(16) : undefined,
      height: pngBytes.length > 24 ? pngBytes.readUInt32BE(20) : undefined,
      mime,
      base64: previewBytes.toString('base64'),
      coordinateSpace: 'original screen pixels (width/height), not resized preview pixels',
    };
  }

  private async downscaleMac(png: string, jpg: string, context?: ToolContext): Promise<boolean> {
    try { await this.run('sips', ['-Z', '1280', '-s', 'format', 'jpeg', png, '--out', jpg], context); } catch { return false; }
    return fs.stat(jpg).then(() => true).catch(() => false);
  }

  private async downscaleLinux(png: string, jpg: string, context?: ToolContext): Promise<boolean> {
    const attempts: Array<[string, string[]]> = [
      ['magick', ['-resize', '1280x', '-quality', '82', png, jpg]],
      ['convert', ['-resize', '1280x', '-quality', '82', png, jpg]],
      ['ffmpeg', ['-y', '-loglevel', 'error', '-i', png, '-vf', 'scale=1280:-1', jpg]],
      ['python3', ['-c', 'import sys\nfrom PIL import Image\nim=Image.open(sys.argv[1]);im.thumbnail((1280,1280));im.convert("RGB").save(sys.argv[2],"JPEG",quality=82)', png, jpg]],
    ];
    for (const [cmd, args] of attempts) {
      if (!(await this.hasCommand(cmd, context))) continue;
      try { await this.run(cmd, args, context); } catch { continue; }
      if (await fs.stat(jpg).then(() => true).catch(() => false)) return true;
    }
    return false;
  }

  private async captureLinux(png: string, context?: ToolContext): Promise<void> {
    const backends: Array<[string, string[]]> = [
      ['grim', [png]],
      ['scrot', ['-o', png]],
      ['import', ['-window', 'root', png]],
      ['gnome-screenshot', ['-f', png]],
      ['spectacle', ['-b', '-n', '-o', png]],
    ];
    for (const [cmd, args] of backends) {
      if (!(await this.hasCommand(cmd, context))) continue;
      await this.run(cmd, args, context, 40_000);
      return;
    }
    throw new Error('computeruse screenshot needs grim, scrot, ImageMagick import, gnome-screenshot or spectacle on Linux');
  }

  // --- windows list ---------------------------------------------------------
  private async listWindows(context?: ToolContext) {
    let windows: string[];
    if (process.platform === 'win32') {
      windows = ensureNative().listWindows();
    } else if (process.platform === 'darwin') {
      const script = 'tell application "System Events" to get name of (processes where background only is false)';
      const { stdout } = await this.run('osascript', ['-e', script], context);
      windows = String(stdout || '').split(/,\s*/).map((line) => line.trim()).filter(Boolean);
    } else if (process.platform === 'linux') {
      windows = await this.listWindowsLinux(context);
    } else {
      throw new Error(`computeruse is not supported on ${process.platform}`);
    }
    return { windows, count: windows.length };
  }

  private async listWindowsLinux(context?: ToolContext): Promise<string[]> {
    if (await this.hasCommand('wmctrl', context)) {
      const { stdout } = await this.run('wmctrl', ['-l'], context);
      return String(stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
        .map((line) => line.replace(/^\S+\s+\S+\s+\S+\s+/, ''));
    }
    await this.requireCommand('xdotool', context, 'install xdotool or wmctrl');
    const { stdout } = await this.run('xdotool', ['search', '--onlyvisible', '--name', '.*', 'getwindowname', '%@'], context);
    return String(stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  }

  // --- keyboard -------------------------------------------------------------
  private async typeText(args: Record<string, any>, context?: ToolContext) {
    const text = String(args.text ?? '');
    if (!text) throw new Error('text is required');
    if (process.platform === 'win32') {
      ensureNative().typeText(text);
    } else if (process.platform === 'darwin') {
      if (!this.tryNative((native) => native.typeText(text))) {
        await this.run('osascript', ['-e', `tell application "System Events" to keystroke "${appleScriptEscape(text)}"`], context);
      }
    } else if (process.platform === 'linux') {
      if (!this.tryNative((native) => native.typeText(text))) {
        await this.requireCommand('xdotool', context, 'install xdotool');
        await this.run('xdotool', ['type', '--', text], context);
      }
    } else {
      throw new Error(`computeruse is not supported on ${process.platform}`);
    }
    return { action: 'type', sent: text };
  }

  private async pressKey(args: Record<string, any>, context?: ToolContext) {
    const raw = String(args.key ?? '');
    if (!raw) throw new Error('key is required');
    if (process.platform === 'win32') {
      ensureNative().pressHotkey(raw);
    } else if (process.platform === 'darwin') {
      if (!this.tryNative((native) => native.pressHotkey(raw))) {
        await this.run('osascript', ['-e', `tell application "System Events" to ${appleScriptForKey(raw)}`], context);
      }
    } else if (process.platform === 'linux') {
      if (!this.tryNative((native) => native.pressHotkey(raw))) {
        await this.requireCommand('xdotool', context, 'install xdotool');
        await this.run('xdotool', ['key', '--', linuxKeyExpression(raw)], context);
      }
    } else {
      throw new Error(`computeruse is not supported on ${process.platform}`);
    }
    return { action: 'key', sent: raw };
  }

  // --- pointer --------------------------------------------------------------
  private async scroll(args: Record<string, any>, context?: ToolContext) {
    const delta = args.delta;
    if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 20) throw new Error('delta must be a nonzero integer between -20 and 20');
    if (process.platform === 'win32') {
      ensureNative().scroll(delta);
    } else if (process.platform === 'linux') {
      if (!this.tryNative((native) => native.scroll(delta))) {
        await this.requireCommand('xdotool', context, 'install xdotool');
        await this.run('xdotool', ['click', '--repeat', String(Math.abs(delta)), '--delay', '30', delta > 0 ? '5' : '4'], context);
      }
    } else if (process.platform === 'darwin') {
      if (!this.tryNative((native) => native.scroll(delta))) {
        await this.requireCommand('osascript', context, 'macOS automation permission required');
        await this.run('osascript', ['-l', 'JavaScript', '-e', `ObjC.import('CoreGraphics'); $.CGEventPost($.kCGHIDEventTap, $.CGEventCreateScrollWheelEvent(null, 1, 1, ${-delta}));`], context);
      }
    } else throw new Error(`computeruse is not supported on ${process.platform}`);
    return { action: 'scroll', delta };
  }

  private async drag(args: Record<string, any>, context?: ToolContext) {
    const fromX = clamp(args.x, -1, 0, 100000), fromY = clamp(args.y, -1, 0, 100000);
    const toX = clamp(args.x2, -1, 0, 100000), toY = clamp(args.y2, -1, 0, 100000);
    if (fromX < 0 || fromY < 0 || toX < 0 || toY < 0) throw new Error('x, y, x2 and y2 are required');
    const button = args.button === 'right' ? 'right' : 'left';
    const duration = clamp(args.duration, 300, 0, 5000);
    if (process.platform === 'win32') {
      ensureNative().drag(fromX, fromY, toX, toY, button, duration);
    } else if (process.platform === 'darwin') {
      if (!this.tryNative((native) => native.drag(fromX, fromY, toX, toY, button, duration))) {
        await this.requireCommand('cliclick', context, 'brew install cliclick');
        await this.run('cliclick', [`dd:${fromX},${fromY}`, `dm:${toX},${toY}`, `du:${toX},${toY}`], context);
      }
    } else if (process.platform === 'linux') {
      if (!this.tryNative((native) => native.drag(fromX, fromY, toX, toY, button, duration))) {
        await this.requireCommand('xdotool', context, 'install xdotool');
        const code = button === 'right' ? '3' : '1';
        await this.run('xdotool', ['mousemove', String(fromX), String(fromY), 'mousedown', code], context);
        await this.run('xdotool', ['mousemove', String(toX), String(toY)], context);
        await this.run('xdotool', ['mouseup', code], context);
      }
    } else throw new Error(`computeruse is not supported on ${process.platform}`);
    return { action: 'drag', from: { x: fromX, y: fromY }, to: { x: toX, y: toY }, button };
  }

  private async pointer(args: Record<string, any>, click: boolean, context?: ToolContext) {
    const x = clamp(args.x, -1, 0, 100000);
    const y = clamp(args.y, -1, 0, 100000);
    if (x < 0 || y < 0) throw new Error('x and y are required');
    const button = args.button === 'right' ? 'right' : 'left';
    if (process.platform === 'win32') {
      const native = ensureNative();
      if (click) native.click(x, y, button, !!args.double);
      else native.moveMouse(x, y);
    } else if (process.platform === 'darwin') {
      if (!this.tryNative((native) => (click ? native.click(x, y, button, !!args.double) : native.moveMouse(x, y)))) {
        await this.requireCommand('cliclick', context, 'brew install cliclick');
        const command = click ? `${args.double ? 'dc' : button === 'right' ? 'rc' : 'c'}:${x},${y}` : `m:${x},${y}`;
        await this.run('cliclick', [command], context);
      }
    } else if (process.platform === 'linux') {
      if (!this.tryNative((native) => (click ? native.click(x, y, button, !!args.double) : native.moveMouse(x, y)))) {
        await this.requireCommand('xdotool', context, 'install xdotool');
        const args2 = click ? ['mousemove', String(x), String(y), 'click', '--repeat', args.double ? '2' : '1', '--delay', '60', button === 'right' ? '3' : '1'] : ['mousemove', String(x), String(y)];
        await this.run('xdotool', args2, context);
      }
    } else {
      throw new Error(`computeruse is not supported on ${process.platform}`);
    }
    return { action: click ? 'click' : 'move', x, y, button: click ? button : undefined };
  }
}

/** Turn lightweight Markdown into structured doc blocks. */
function parseDocBlocks(text: string): DocBlock[] {
  const blocks: DocBlock[] = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) continue;
    if (line.startsWith('### ')) blocks.push({ type: 'subheading', text: line.slice(4) });
    else if (line.startsWith('## ')) blocks.push({ type: 'heading', text: line.slice(3) });
    else if (line.startsWith('# ')) blocks.push({ type: 'heading', text: line.slice(2) });
    else if (/^\s*[-*•]\s+/.test(line)) blocks.push({ type: 'bullet', text: line.replace(/^\s*[-*•]\s+/, '') });
    else blocks.push({ type: 'paragraph', text: line });
  }
  return blocks;
}

/** Write a .docx (default), .md or .txt document. */
export class DocumentTool extends Tool {
  get name(): string { return 'document'; }
  get description(): string { return 'Create a Word document (.docx) or a Markdown/text file. Provide a title and the body as Markdown (headings #, ##, bullets -, paragraphs); it is converted to a real .docx by default.'; }
  get dangerous(): boolean { return true; }
  get parameters(): Record<string, any> {
    return { type: 'object', required: ['path'], properties: {
      path: { type: 'string', description: 'Output file path, e.g. report.docx or notes.md.' },
      title: { type: 'string' },
      content: { type: 'string', description: 'Body as Markdown.' },
      blocks: { type: 'array', items: { type: 'object', required: ['text'], properties: { type: { type: 'string', enum: ['title', 'heading', 'subheading', 'paragraph', 'bullet'] }, text: { type: 'string' } } } },
      format: { type: 'string', enum: ['docx', 'md', 'txt'], description: 'Defaults to the file extension.' },
    }};
  }
  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    try {
      const filePath = resolvePath(args.path, context.cwd);
      if (!isPathAllowed(filePath)) throw new Error('path not allowed: outside workspace roots');
      const ext = path.extname(filePath).toLowerCase().replace('.', '');
      const format = String(args.format || ext || 'docx').toLowerCase();
      const blocks: DocBlock[] = Array.isArray(args.blocks) && args.blocks.length
        ? args.blocks.map((b: any) => ({ type: b?.type || 'paragraph', text: String(b?.text ?? '') }))
        : parseDocBlocks(String(args.content ?? ''));
      const title = String(args.title ?? '').trim();
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      if (format === 'md' || format === 'txt') {
        const lines: string[] = [];
        if (title) lines.push(`# ${title}`);
        for (const block of blocks) {
          if (block.type === 'heading') lines.push(`## ${block.text}`);
          else if (block.type === 'subheading') lines.push(`### ${block.text}`);
          else if (block.type === 'bullet') lines.push(`- ${block.text}`);
          else lines.push(block.text);
        }
        const text = lines.join('\n') + '\n';
        await fs.writeFile(filePath, text, 'utf8');
        return success({ path: filePath, format, bytes: Buffer.byteLength(text), blocks: blocks.length });
      }
      const buffer = buildDocx({ title, blocks });
      await fs.writeFile(filePath, buffer);
      return success({ path: filePath, format: 'docx', bytes: buffer.length, blocks: blocks.length });
    } catch (error) { return failure(error); }
  }
}

/** Write a PowerPoint deck (.pptx). */
export class SlidesTool extends Tool {
  get name(): string { return 'slides'; }
  get description(): string { return 'Create a PowerPoint presentation (.pptx) from a title and a list of slides (each with a title and bullet points).'; }
  get dangerous(): boolean { return true; }
  get parameters(): Record<string, any> {
    return { type: 'object', required: ['path', 'slides'], properties: {
      path: { type: 'string', description: 'Output .pptx path.' },
      title: { type: 'string', description: 'Deck title (used only if the first slide has no title).' },
      slides: { type: 'array', minItems: 1, items: { type: 'object', properties: {
        title: { type: 'string' }, bullets: { type: 'array', items: { type: 'string' } },
      } } },
    }};
  }
  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    try {
      if (!Array.isArray(args.slides) || args.slides.length === 0) throw new Error('slides must be a non-empty array');
      const filePath = resolvePath(args.path, context.cwd);
      if (!isPathAllowed(filePath)) throw new Error('path not allowed: outside workspace roots');
      const slides: SlideSpec[] = args.slides.map((s: any) => ({
        title: String(s?.title ?? ''),
        bullets: Array.isArray(s?.bullets) ? s.bullets.map((b: any) => String(b)) : [],
      }));
      const buffer = buildPptx({ title: String(args.title ?? ''), slides });
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, buffer);
      return success({ path: filePath, format: 'pptx', bytes: buffer.length, slides: slides.length });
    } catch (error) { return failure(error); }
  }
}

/** Drive a real browser over the Chrome DevTools Protocol. */
export class BrowserTool extends Tool {
  get name(): string { return 'browser'; }
  get description(): string { return 'Automate a real browser: goto/open a URL, screenshot, read text/html, click, type, press keys (combos like ctrl+a, shift+tab), run JavaScript, wait for a selector, go back/forward/reload, or start/stop the browser. Call action "status" for the live state.'; }
  get dangerous(): boolean { return true; }
  get parameters(): Record<string, any> {
    return { type: 'object', required: ['action'], properties: {
      action: { type: 'string', enum: ['status', 'start', 'goto', 'open', 'screenshot', 'frame', 'text', 'html', 'click', 'mouse', 'wheel', 'type', 'press', 'eval', 'wait', 'back', 'forward', 'reload', 'tabs', 'newtab', 'activate', 'closetab', 'stop', 'close'] },
      id: { type: 'string', description: 'Tab id for activate/closetab.' },
      url: { type: 'string' }, selector: { type: 'string' }, text: { type: 'string' }, key: { type: 'string' }, expression: { type: 'string' },
      x: { type: 'integer' }, y: { type: 'integer' }, button: { type: 'string', enum: ['left', 'right'] },
      fullPage: { type: 'boolean' }, timeout: { type: 'integer' },
    }};
  }
  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    try {
      const command = String(args.action || '').toLowerCase();
      if (!command) throw new Error('action is required');
      const result = await browserController.action(command, args, context.signal);
      return success(result);
    } catch (error) { return failure(error); }
  }
}

/** Locate the `life/src` package dir that hosts `life.tools.research`. */
export function resolveResearchSrc(): string {
  const candidates: string[] = [];
  if (process.env.LIFE_SRC) candidates.push(process.env.LIFE_SRC);
  if (process.env.KAY_ROOT) candidates.push(path.join(process.env.KAY_ROOT, 'life', 'src'));
  for (const start of [MODULE_DIR, process.cwd()]) {
    let dir = start;
    for (let i = 0; i < 8; i++) {
      candidates.push(path.join(dir, 'life', 'src'));
      candidates.push(dir);
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  for (const candidate of candidates) {
    try {
      if (existsSync(path.join(candidate, 'life', 'tools', 'research', '__main__.py'))) return candidate;
    } catch { /* keep looking */ }
  }
  throw new Error('life.tools.research not found — set LIFE_SRC to the life/src directory');
}

/** Generate publication artifacts with the standard `life.tools.research` toolkit. */
export class ResearchTool extends Tool {
  get name(): string { return 'research'; }
  get description(): string {
    return [
      'Produce publication artifacts with the standard `life.tools.research` toolkit (deterministic, CJK fonts ready).',
      'action="figure": spec={kind:"line|bar|grouped_bar|scatter|heatmap", path?, ...chart kwargs} -> PNG.',
      'action="table": spec={header:[...], rows:[[...]], caption?, label?, stem?} -> three-line .html/.tex/.docx.',
      'action="paper": spec={markdown?|markdown_path?, title?, stem?} -> published .html + .docx.',
      'action="experiment": spec={script:"exp.py", name?, params?} -> runs the script main()/run() and records runs/<ts>/ {meta,stdout,result}.',
      'Files are written under `out` (default the task workdir); the result lists the produced paths.',
    ].join('\n');
  }
  get parameters(): Record<string, any> {
    return { type: 'object', required: ['action'], properties: {
      action: { type: 'string', enum: ['figure', 'table', 'paper', 'experiment'] },
      spec: { type: 'object', description: 'Action-specific arguments (see the tool description).' },
      out: { type: 'string', description: 'Output directory (default: the task working directory).' },
      kind: { type: 'string', enum: ['line', 'bar', 'grouped_bar', 'scatter', 'heatmap'], description: 'Figure kind (figure action).' },
      path: { type: 'string', description: 'Output image path (figure action).' },
    }};
  }
  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    try {
      const action = String(args.action || '').toLowerCase();
      if (!['figure', 'table', 'paper', 'experiment'].includes(action)) throw new Error('action must be figure, table, paper or experiment');
      const outDir = path.resolve(context.cwd, typeof args.out === 'string' && args.out.trim() ? args.out : '.');
      if (!isPathAllowed(outDir)) throw new Error('path not allowed: outside workspace roots');
      await fs.mkdir(outDir, { recursive: true });
      const src = resolveResearchSrc();
      const python = process.env.RESEARCH_PYTHON || process.env.PYTHON || 'python';
      const env = { ...process.env, PYTHONPATH: [src, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter), PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
      const spec: Record<string, any> = { ...(args.spec && typeof args.spec === 'object' ? args.spec : {}) };
      const tmp = path.join(os.tmpdir(), `0kay-research-${randomUUID()}.json`);
      try {
      const run = async (cliArgs: string[]): Promise<string> => {
        const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
          const child = execFile(python, ['-m', 'life.tools.research', ...cliArgs], { cwd: context.cwd, env, maxBuffer: 10 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
            context.signal?.removeEventListener('abort', cancel);
            if (error) reject(Object.assign(error, { stdout, stderr }));
            else resolve({ stdout: stdout || '', stderr: stderr || '' });
          });
          const cancel = () => child.kill('SIGTERM');
          context.signal?.addEventListener('abort', cancel, { once: true });
          if (context.signal?.aborted) cancel();
        });
        return `${result.stdout}${result.stderr}`.trim();
      };

      if (action === 'figure') {
        if (!spec.kind && args.kind) spec.kind = args.kind;
        if (!spec.path && args.path) spec.path = args.path;
        if (!spec.path) spec.path = path.join(outDir, `${spec.kind || 'figure'}.png`);
        if (!path.isAbsolute(spec.path)) spec.path = path.resolve(outDir, spec.path);
        if (!isPathAllowed(spec.path)) throw new Error('path not allowed: outside workspace roots');
        await fs.writeFile(tmp, JSON.stringify(spec));
        const output = await run(['plot', tmp, '-o', outDir]);
        return success({ action, file: spec.path, output });
      }
      if (action === 'table') {
        spec.stem = spec.stem || 'table';
        await fs.writeFile(tmp, JSON.stringify(spec));
        const output = await run(['table', tmp, '-o', outDir]);
        const stem = String(spec.stem);
        return success({ action, files: [path.join(outDir, `${stem}.html`), path.join(outDir, `${stem}.tex`), path.join(outDir, `${stem}.docx`)], output });
      }
      if (action === 'paper') {
        let markdownPath = spec.markdown_path || spec.path;
        if (!markdownPath && typeof spec.markdown === 'string') {
          markdownPath = path.join(outDir, `${spec.stem || 'paper'}.md`);
          await fs.writeFile(markdownPath, spec.markdown, 'utf8');
        }
        if (!markdownPath) throw new Error('paper needs markdown or markdown_path');
        if (!path.isAbsolute(markdownPath)) markdownPath = path.resolve(context.cwd, markdownPath);
        const cliArgs = ['paper', markdownPath, '-o', outDir];
        if (spec.title) cliArgs.push('--title', String(spec.title));
        if (spec.stem) cliArgs.push('--stem', String(spec.stem));
        const output = await run(cliArgs);
        // Surface the produced paths so the WebUI can open the .docx directly;
        // `build_paper` prints "<kind>: <path>" for html and docx.
        const files: string[] = [];
        for (const line of output.split(/\r?\n/)) {
          const match = /^(?:html|docx):\s*(.+)$/i.exec(line.trim());
          if (match) files.push(match[1].trim());
        }
        const docx = files.find((file) => file.toLowerCase().endsWith('.docx')) || path.join(outDir, `${spec.stem || 'paper'}.docx`);
        return success({ action, out: outDir, file: docx, files: files.length ? files : [docx], output });
      }
      await fs.writeFile(tmp, JSON.stringify(spec));
      const output = await run(['experiment', tmp, '-o', outDir]);
      return success({ action, output });
      } finally {
        await fs.rm(tmp, { force: true }).catch(() => {});
      }
    } catch (error) { return failure(error); }
  }
}

export class ToolRegistry {
  private tools = new Map<string, Tool>();
  register(tool: Tool): void { this.tools.set(tool.name, tool); }
  get(name: string): Tool | undefined { return this.tools.get(name); }
  unregister(name: string): boolean { return this.tools.delete(name); }
  async call(name: string, args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    context.signal?.throwIfAborted();
    const tool = this.tools.get(name);
    if (!tool) return failure(`Tool '${name}' not found`);
    return tool.execute(args, context);
  }
  listTools(): ToolSchema[] {
    return [...this.tools.values()].map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters, dangerous: tool.dangerous }));
  }
}

/** Model-driven context compression (adapted from the billion-context idea). */
export class CompressContextTool extends Tool {
  get name(): string { return 'compress'; }
  get description(): string {
    return 'Fold a range of earlier conversation messages into one high-fidelity summary to free context. Provide from/to (0-based indices into the visible history) and a summary that preserves decisions, file paths/commands, results and open threads. The originals are kept and can be restored with decompress; search_context can look inside them.';
  }
  get parameters(): Record<string, any> {
    return { type: 'object', required: ['from', 'to', 'summary'], properties: {
      from: { type: 'integer' }, to: { type: 'integer' }, summary: { type: 'string' },
    }};
  }
  async execute(args: Record<string, any>, context?: ToolContext): Promise<ToolResult> {
    if (!context?.ledger) return failure('context ledger unavailable');
    const block = context.ledger.compress(Number(args.from), Number(args.to), String(args.summary || ''));
    if (!block) return failure('invalid range or empty summary');
    return success({ block: block.id, folded_messages: block.messages.length, tokens_freed: block.tokens });
  }
}

export class DecompressContextTool extends Tool {
  get name(): string { return 'decompress'; }
  get description(): string { return 'Restore a previously compressed range when exact details are needed again. Pass the block id returned by compress (or its 1-based number).'; }
  get parameters(): Record<string, any> {
    return { type: 'object', required: ['block'], properties: { block: { type: 'string' } } };
  }
  async execute(args: Record<string, any>, context?: ToolContext): Promise<ToolResult> {
    if (!context?.ledger) return failure('context ledger unavailable');
    return context.ledger.decompress(String(args.block || '')) ? success({ restored: String(args.block) }) : failure('unknown block');
  }
}

export class SearchContextTool extends Tool {
  get name(): string { return 'search_context'; }
  get description(): string { return 'Keyword search over compressed summaries and visible messages, to find details that were folded away.'; }
  get parameters(): Record<string, any> {
    return { type: 'object', required: ['query'], properties: { query: { type: 'string' }, limit: { type: 'integer' } } };
  }
  async execute(args: Record<string, any>, context?: ToolContext): Promise<ToolResult> {
    if (!context?.ledger) return failure('context ledger unavailable');
    return success({ results: context.ledger.search(String(args.query || ''), clamp(args.limit, 10, 1, 50)) });
  }
}

export class AcpStatusTool extends Tool {
  get name(): string { return 'acp_status'; }
  get description(): string { return 'Context-usage overview: visible message count, estimated tokens, last prompt tokens and the compressed blocks.'; }
  async execute(_args: Record<string, any>, context?: ToolContext): Promise<ToolResult> {
    if (!context?.ledger) return failure('context ledger unavailable');
    return success(context.ledger.status());
  }
}

/** A tool contributed by a plugin; execution is routed through Core. */
export interface PluginToolDef {
  plugin: string;
  name: string;
  description?: string;
  parameters?: Record<string, any>;
  dangerous?: boolean;
  scopes?: string[];
}

export class PluginTool extends Tool {
  private readonly def: PluginToolDef;
  constructor(def: PluginToolDef) { super(); this.def = def; }
  get name(): string { return this.def.name; }
  get description(): string { return this.def.description || `Tool contributed by plugin ${this.def.plugin}.`; }
  get parameters(): Record<string, any> {
    const params = this.def.parameters;
    return params && typeof params === 'object' ? params : { type: 'object', properties: {} };
  }
  get dangerous(): boolean { return !!this.def.dangerous; }
  async execute(args: Record<string, any>, context?: ToolContext): Promise<ToolResult> {
    const result = await callPluginTool(this.def.name, args || {}, context?.sessionId || context?.taskId || '', `agent:${context?.agentType || 'general'}`);
    if (result.success) return success(result.result);
    return failure(result.error || 'plugin tool failed');
  }
}

/** Create the opencode-style built-in tool registry. */
export function createDefaultRegistry(skills: SkillRegistry = getSkillRegistry()): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of [
    new ReadTool(), new WriteTool(), new EditTool(), new ApplyPatchTool(), new GlobTool(), new GrepTool(), new ShellTool(),
    new WebFetchTool(), new WebSearchTool(), new PaperSearchTool(), new ApiDocSearchTool(), new TodoWriteTool(), new SkillTool(skills), new TaskTool(), new McpTool(), new ComputerUseTool(),
    new BrowserTool(), new DocumentTool(), new SlidesTool(), new ResearchTool(),
    new ScrapeTool(), new CrawlTool(), new ScreenshotToCodeTool(), new ReverseEngineerTool(), new PentestTool(), new DiagramTool(), new SetupDepsTool(),
    new GitHubSearchTool(), new BackgroundTaskTool(),
    new CompressContextTool(), new DecompressContextTool(), new SearchContextTool(), new AcpStatusTool(),
  ]) registry.register(tool);
  return registry;
}

