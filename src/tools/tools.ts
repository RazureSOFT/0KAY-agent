/**
 * Agent tool suite. The names and contracts follow the useful core of
 * opencode's tool set while keeping execution local to the Agent host.
 */

import { exec as execCallback, execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { createHash, randomUUID } from 'crypto';
import { SkillRegistry, getSkillRegistry } from '../skills/skills.js';

const exec = promisify(execCallback);
const MAX_OUTPUT = 120_000;
const MAX_FILE_BYTES = 2_000_000;

export interface ToolResult {
  success: boolean;
  data: any;
  error?: string;
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, any>;
  dangerous?: boolean;
}

export interface TodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  priority?: 'high' | 'medium' | 'low';
}

export interface McpClientLike {
  listTools(): Array<{ server: string; name: string; description: string; inputSchema?: Record<string, any> }>;
  callTool(server: string, tool: string, args: Record<string, any>): Promise<any>;
}

export interface ToolContext {
  cwd: string;
  taskId: string;
  agentType: string;
  todo: TodoItem[];
  runSubAgent?: (prompt: string, agentType?: string) => Promise<string>;
  mcp?: McpClientLike;
  signal?: AbortSignal;
}

export abstract class Tool {
  abstract get name(): string;
  abstract get description(): string;
  get parameters(): Record<string, any> {
    return { type: 'object', properties: {} };
  }
  get dangerous(): boolean {
    return false;
  }
  abstract execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult>;
}

function success(data: any): ToolResult {
  return { success: true, data };
}

function failure(error: unknown): ToolResult {
  return { success: false, data: null, error: error instanceof Error ? error.message : String(error) };
}

function clamp(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function limitOutput(value: string): { text: string; truncated: boolean } {
  if (value.length <= MAX_OUTPUT) return { text: value, truncated: false };
  return { text: `${value.slice(0, MAX_OUTPUT)}\n\n[output truncated]`, truncated: true };
}

function resolvePath(input: unknown, cwd: string): string {
  if (typeof input !== 'string' || !input.trim()) throw new Error('path is required');
  return path.resolve(cwd, input);
}

function globToRegex(pattern: string): RegExp {
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

async function walk(root: string, onFile: (fullPath: string, relative: string) => boolean | Promise<boolean>, max = 2_000): Promise<number> {
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
  get description(): string { return 'Create or fully replace a text file. Prefer edit for small targeted changes.'; }
  get dangerous(): boolean { return true; }
  get parameters(): Record<string, any> {
    return { type: 'object', required: ['filePath', 'content'], properties: {
      filePath: { type: 'string' }, content: { type: 'string' },
    }};
  }
  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    try {
      const filePath = resolvePath(args.filePath, context.cwd);
      if (typeof args.content !== 'string') throw new Error('content must be a string');
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      const existed = await fs.stat(filePath).then(() => true).catch(() => false);
      await fs.writeFile(filePath, args.content, 'utf8');
      return success({ path: filePath, created: !existed, bytes: Buffer.byteLength(args.content), lines: args.content.split(/\r?\n/).length });
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
      if (typeof args.oldString !== 'string' || typeof args.newString !== 'string') throw new Error('oldString and newString must be strings');
      if (args.oldString === args.newString) throw new Error('oldString and newString are identical');
      const original = await fs.readFile(filePath, 'utf8');
      if (!args.oldString) throw new Error('oldString cannot be empty for an existing file; use write for a full replacement');
      const count = original.split(args.oldString).length - 1;
      if (count === 0) throw new Error('oldString was not found; re-read the file and include exact whitespace');
      if (count > 1 && args.replaceAll !== true) throw new Error('oldString occurs multiple times; include more surrounding context or set replaceAll');
      const updated = args.replaceAll === true ? original.split(args.oldString).join(args.newString) : original.replace(args.oldString, args.newString);
      await fs.writeFile(filePath, updated, 'utf8');
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
          await fs.writeFile(patch.filePath, patch.updated, 'utf8');
          written.push(patch);
        }
      } catch (error) {
        for (const patch of written.reverse()) await fs.writeFile(patch.filePath, patch.original, 'utf8');
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

export class ShellTool extends Tool {
  get name(): string { return 'bash'; }
  get description(): string { return `Run a command using ${process.platform === 'win32' ? 'Windows cmd.exe (NOT bash or PowerShell). Use dir/cd and &&, not pwd/ls or semicolons.' : '/bin/sh' } Use cwd and timeout when needed.`; }
  get dangerous(): boolean { return true; }
  get parameters(): Record<string, any> {
    return { type: 'object', required: ['command'], properties: {
      command: { type: 'string' }, cwd: { type: 'string' }, timeout: { type: 'integer', minimum: 1000, maximum: 300000 },
    }};
  }
  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    try {
      if (typeof args.command !== 'string' || !args.command.trim()) throw new Error('command is required');
      const cwd = args.cwd ? resolvePath(args.cwd, context.cwd) : context.cwd;
      const timeout = clamp(args.timeout, 30_000, 1_000, 300_000);
      try {
        const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
          const command = process.platform === 'win32' ? `chcp 65001 >nul & ${args.command}` : args.command;
          const child = execCallback(command, { cwd, maxBuffer: MAX_OUTPUT, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } }, (error, stdout, stderr) => {
            clearTimeout(timer);
            context.signal?.removeEventListener('abort', cancel);
            if (error) reject(Object.assign(error, { stdout, stderr }));
            else resolve({ stdout, stderr });
          });
          const cancel = () => {
            if (process.platform === 'win32' && child.pid) {
              execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {});
            } else child.kill('SIGTERM');
          };
          const timer = setTimeout(cancel, timeout);
          context.signal?.addEventListener('abort', cancel, { once: true });
          if (context.signal?.aborted) cancel();
        });
        const stdout = limitOutput(result.stdout || '');
        const stderr = limitOutput(result.stderr || '');
        return success({ cwd, stdout: stdout.text, stderr: stderr.text, exitCode: 0, truncated: stdout.truncated || stderr.truncated });
      } catch (error: any) {
        const stdout = limitOutput(String(error.stdout || ''));
        const stderr = limitOutput(String(error.stderr || error.message || 'command failed'));
        return { success: false, data: { cwd, stdout: stdout.text, stderr: stderr.text, exitCode: Number(error.code) || 1 }, error: stderr.text };
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
      const response = await fetch(args.url, { signal, headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      }, redirect: 'follow' });
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
  get description(): string { return 'Search the web through configured SearXNG and return titles, URLs, and snippets.'; }
  get parameters(): Record<string, any> {
    return { type: 'object', required: ['query'], properties: {
      query: { type: 'string' }, numResults: { type: 'integer', minimum: 1, maximum: 20 },
    }};
  }
  async execute(args: Record<string, any>, context?: ToolContext): Promise<ToolResult> {
    try {
      if (typeof args.query !== 'string' || !args.query.trim()) throw new Error('query is required');
      const base = (process.env.SEARXNG_URL || 'http://127.0.0.1:8888').replace(/\/$/, '');
      const endpoint = new URL(`${base}/search`);
      endpoint.searchParams.set('q', args.query);
      endpoint.searchParams.set('format', 'json');
      const timeout = AbortSignal.timeout(30000);
      const response = await fetch(endpoint, { headers: { Accept: 'application/json' }, signal: context?.signal ? AbortSignal.any([timeout, context.signal]) : timeout });
      if (!response.ok) throw new Error(`SearXNG returned ${response.status}`);
      const body: any = await response.json();
      const limit = clamp(args.numResults, 5, 1, 20);
      const results = Array.isArray(body.results) ? body.results.slice(0, limit).map((item: any) => ({ title: item.title || '', url: item.url || '', snippet: item.content || '' })) : [];
      return success({ query: args.query, engine: body?.answers?.length ? 'searxng' : 'searxng', results });
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
      context.todo.splice(0, context.todo.length, ...todos);
      return success({ todos: context.todo });
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
      return success({ server: args.server, tool: args.tool, result: await context.mcp.callTool(args.server, args.tool, args.args && typeof args.args === 'object' ? args.args : {}) });
    } catch (error) { return failure(error); }
  }
}

export class ComputerUseTool extends Tool {
  get name(): string { return 'computeruse'; }
  get description(): string { return 'Operate the Agent host computer: screenshot, mouse move/click, type text, or press keys. Requires explicit computer-use permission.'; }
  get dangerous(): boolean { return true; }
  get parameters(): Record<string, any> {
    return { type: 'object', required: ['action'], properties: {
      action: { type: 'string', enum: ['screenshot', 'move', 'click', 'type', 'key'] }, x: { type: 'integer' }, y: { type: 'integer' }, button: { type: 'string', enum: ['left', 'right'] }, text: { type: 'string' }, key: { type: 'string' },
    }};
  }
  async execute(args: Record<string, any>, context?: ToolContext): Promise<ToolResult> {
    if (process.platform !== 'win32') return failure('computeruse currently supports Windows Agent hosts only');
    try {
      const action = args.action;
      const ps = (script: string) => promisify(execFile)('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { timeout: 30_000, windowsHide: true, signal: context?.signal });
      if (action === 'screenshot') {
        const output = path.join(os.tmpdir(), `0kay-screen-${Date.now()}.png`);
        const script = "Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height; $g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); $bmp.Save('" + output.replace(/'/g, "''") + "',[System.Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $bmp.Dispose()";
        await ps(script);
        return success({ path: output, sha256: createHash('sha256').update(await fs.readFile(output)).digest('hex') });
      }
      if (action === 'type' || action === 'key') {
        let raw = String(action === 'type' ? args.text ?? '' : args.key ?? '');
        if (!raw) throw new Error(`${action === 'type' ? 'text' : 'key'} is required`);
        if (action === 'type') raw = raw.replace(/[+^%~(){}\[\]]/g, char => `{${char}}`);
        await ps(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${raw.replace(/'/g, "''")}')`);
        return success({ action, sent: raw });
      }
      if (!['move', 'click'].includes(action)) throw new Error('invalid computer action');
      const x = clamp(args.x, -1, 0, 100000); const y = clamp(args.y, -1, 0, 100000);
      if (x < 0 || y < 0) throw new Error('x and y are required');
      const click = action === 'click' ? (args.button === 'right' ? '0x0008;0x0010' : '0x0002;0x0004') : '';
      const script = "Add-Type @'\nusing System; using System.Runtime.InteropServices; public class Mouse { [DllImport(\"user32.dll\")] public static extern bool SetCursorPos(int X,int Y); [DllImport(\"user32.dll\")] public static extern void mouse_event(int f,int dx,int dy,int d,UIntPtr e); }\n'@; [Mouse]::SetCursorPos(" + x + ',' + y + ");" + (click ? click.split(';').map((flag) => `[Mouse]::mouse_event(${flag},0,0,0,[UIntPtr]::Zero)`).join(';') : '');
      await ps(script);
      return success({ action, x, y, button: action === 'click' ? (args.button || 'left') : undefined });
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

/** Create the opencode-style built-in tool registry. */
export function createDefaultRegistry(skills: SkillRegistry = getSkillRegistry()): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of [
    new ReadTool(), new WriteTool(), new EditTool(), new ApplyPatchTool(), new GlobTool(), new GrepTool(), new ShellTool(),
    new WebFetchTool(), new WebSearchTool(), new TodoWriteTool(), new SkillTool(skills), new TaskTool(), new McpTool(), new ComputerUseTool(),
  ]) registry.register(tool);
  return registry;
}

function simpleDiff(filePath: string, original: string, updated: string): string {
  const oldLines = original.split(/\r?\n/); const newLines = updated.split(/\r?\n/);
  const limit = 400; const out = [`--- a/${filePath}`, `+++ b/${filePath}`];
  const max = Math.max(oldLines.length, newLines.length);
  // Aligned comparison (writes are positional): group consecutive changes into a
  // hunk and emit `@@ -old +new @@` so the UI can show the changed line numbers.
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
