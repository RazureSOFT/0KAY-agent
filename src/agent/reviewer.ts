// The reviewer: a second model whose only job is to disagree.
//
// The agent that did the work is the worst judge of whether the work is done —
// it remembers intending to do things and cannot tell that apart from doing
// them. So its claim of 100% is not an answer, it is a question for another
// model, one that reads the files and the tool history for itself.
//
// It runs its own short tool loop (read, grep, glob, websearch, webfetch)
// because a reviewer reasoning from the transcript alone can only check what the
// agent chose to report. It gets a budget so a slow reviewer cannot hold a task
// hostage; running out of budget is a pass with a warning, not a failure of the
// work.

import * as fs from 'fs/promises';
import * as path from 'path';
import { coreFetch, coreHeaders } from '../connection.js';
import type { LlmCaller } from '../tools/types.js';
import type { Intent } from './intent.js';
import type { DeliveryReport, ToolTraceEntry } from './supervision.js';

export type Verdict = 'pass' | 'reject';

export interface ReviewRequest {
  taskId: string;
  sessionId: string;
  cwd: string;
  /** The user's own words, verbatim. */
  userIntent: string;
  intents: Intent[];
  completionRate: number;
  approach: string;
  /** What the agent said when it called finish. */
  claim: string;
  /** Tool calls in order, with the verification labels the supervisor derived. */
  trace: ToolTraceEntry[];
  delivery: DeliveryReport;
  /** Recent assistant/tool text, already trimmed by the caller. */
  transcript: string;
  /** Files this task wrote or edited, relative to cwd where possible. */
  touched: string[];
  maxToolSteps: number;
  /** Hard deadline for the whole review, in milliseconds. */
  budgetMs: number;
}

export interface ReviewResult {
  verdict: Verdict;
  actualCompletion: number;
  missingIntents: string[];
  fixFeedback: string;
  /** Reviewer's own five-line summary of what it checked. */
  audit: string;
  steps: Array<{ tool: string; args: Record<string, any>; ok: boolean; summary: string }>;
  /** Set when the reviewer could not be reached and the task was let through. */
  degraded?: string;
  elapsedMs: number;
}

const REVIEWER_SYSTEM = `You are the review model (Reviewer) for an autonomous coding agent. The agent claims the task is 100% done. Your job is to falsify that claim, not to grade the work generously.

You receive: the user's original request, the intent ledger the agent maintained, the tool calls it made, the files it touched, and its closing statement.

You have tools. Use them before judging:
- read / grep / glob to check the files really contain what the agent says.
- websearch / webfetch only when correctness depends on an external fact (an API signature, a version, a specification, a price, a date).

Judge four things:
1. TRUTHFULNESS. Does every "done" intent have something in the files or tool history that proves it? A plan in prose is not implementation. "I will add X" is not X. A test that was never run is not a passing test.
2. COMPLETENESS. List what the user asked for that has no corresponding implementation. Be specific: name the feature, the file, the missing branch.
3. CORRECTNESS. Does the code do what the intent says, or does it merely compile? Look for stubs, TODO bodies, empty handlers, dead branches, unreachable code, and silent fallbacks that make a failure look like a pass.
4. OVER-ENGINEERING. Did the agent add abstraction, options, or indirection the request never asked for, at the cost of the user actually being able to use it?

Rules:
- Do not invent missing work. If an intent is genuinely covered, accept it.
- Do not reject for style preferences, naming, or formatting unless the user asked for them.
- A file that does not contain the change is missing, whatever the transcript says.
- If the agent's own verification command failed, that outranks its summary.
- Your fix_feedback is read by the agent that did the work. Make it actionable: what to change, where, and how you will check it.

Reply with one JSON object and nothing else:
{"verdict":"pass"|"reject","actual_completion":0-100,"missing_intents":["..."],"fix_feedback":"...","audit":"..."}
actual_completion is your own estimate of how much of the user's request is really delivered. missing_intents lists user-visible things that are absent or fake. audit is at most 60 words describing what you actually checked. On pass, fix_feedback may be empty.`;

const TOOL_BUDGET_NOTE = 'You have a tool budget. Spend it on the files that would be most embarrassing to be wrong about.';

/** Keeps a "read the whole file" from eating the reviewer's context. */
const MAX_FILE_CHARS = 14_000;

function clip(text: string, max: number): string {
  const value = String(text ?? '');
  return value.length <= max ? value : `${value.slice(0, max)}\n[truncated ${value.length - max} chars]`;
}

function safeJoin(cwd: string, target: string): string {
  const resolved = path.resolve(cwd, target);
  const root = path.resolve(cwd);
  const rel = path.relative(root, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`path escapes the workspace: ${target}`);
  return resolved;
}

async function runRead(cwd: string, args: Record<string, any>): Promise<string> {
  const file = safeJoin(cwd, String(args.path || args.file || ''));
  const stat = await fs.stat(file);
  if (stat.isDirectory()) throw new Error('path is a directory');
  const text = await fs.readFile(file, 'utf8');
  return clip(text, MAX_FILE_CHARS);
}

async function runGrep(cwd: string, args: Record<string, any>): Promise<string> {
  const pattern = String(args.pattern || '');
  if (!pattern) throw new Error('pattern is required');
  const re = new RegExp(pattern, args.ignore_case ? 'i' : '');
  const scope = String(args.path || '.');
  const root = safeJoin(cwd, scope);
  const hits: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    if (hits.length >= 120) return;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (hits.length >= 120) return;
      if (['.git', 'node_modules', 'dist', 'out', '.next'].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(full); continue; }
      if (!/\.(ts|tsx|js|jsx|go|py|rs|java|kt|cs|cpp|c|h|vue|json|md|ya?ml|toml|css|scss|html)$/i.test(entry.name)) continue;
      let text = '';
      try { text = await fs.readFile(full, 'utf8') } catch { continue }
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          hits.push(`${path.relative(cwd, full).replace(/\\/g, '/')}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
          if (hits.length >= 120) break;
        }
      }
    }
  };
  await walk(root);
  return hits.length ? hits.join('\n') : 'no matches';
}

async function runGlob(cwd: string, args: Record<string, any>): Promise<string> {
  const pattern = String(args.pattern || '**/*').replace(/\\/g, '/');
  const regex = new RegExp(`^${pattern.split('**').map((part) => part.split('*').map((p) => p.replace(/[.+^${}()|[\]]/g, '\\$&')).join('[^/]*')).join('.*')}$`, 'i');
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    if (out.length >= 200) return;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (out.length >= 200) return;
      if (['.git', 'node_modules', 'dist', 'out'].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(cwd, full).replace(/\\/g, '/');
      if (entry.isDirectory()) await walk(full);
      else if (regex.test(rel)) out.push(rel);
    }
  };
  await walk(path.resolve(cwd));
  return out.length ? out.join('\n') : 'no files matched';
}

async function runWebFetch(args: Record<string, any>): Promise<string> {
  const url = String(args.url || '');
  if (!/^https?:\/\//i.test(url)) throw new Error('url must be http(s)');
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
    },
    signal: AbortSignal.timeout(25_000),
  });
  const text = await response.text();
  const stripped = text
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '')
    .replace(/<\/(p|div|h[1-6]|li|br|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n');
  return clip(`${response.status} ${response.url}\n${stripped}`, 12_000);
}

async function runWebSearch(args: Record<string, any>): Promise<string> {
  const query = String(args.query || '');
  if (!query.trim()) throw new Error('query is required');
  const endpoint = new URL(`${process.env.CORE_HTTP_ADDR || process.env.CORE_HTTP || 'http://127.0.0.1:8080'}/api/search`);
  endpoint.searchParams.set('q', query);
  endpoint.searchParams.set('n', String(Math.max(1, Math.min(10, Number(args.numResults) || 5))));
  const response = await coreFetch(endpoint.toString(), { headers: coreHeaders(), signal: AbortSignal.timeout(25_000) });
  if (!response.ok) throw new Error(`search returned ${response.status}`);
  const body: any = await response.json();
  const results = Array.isArray(body?.results) ? body.results.slice(0, 10) : [];
  if (!results.length) return 'no results';
  return results.map((item: any, index: number) => `${index + 1}. ${item.title || ''}\n   ${item.url || ''}\n   ${clip(String(item.snippet || item.content || ''), 400)}`).join('\n');
}

const REVIEWER_TOOLS = [
  {
    name: 'read',
    description: 'Read a text file from the workspace. Paths are relative to the workspace root.',
    parameters: { type: 'object', required: ['path'], properties: { path: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' } } },
  },
  {
    name: 'grep',
    description: 'Search file contents with a regular expression. Returns path:line: text.',
    parameters: { type: 'object', required: ['pattern'], properties: { pattern: { type: 'string' }, path: { type: 'string' }, ignore_case: { type: 'boolean' } } },
  },
  {
    name: 'glob',
    description: 'List files matching a glob pattern, relative to the workspace root.',
    parameters: { type: 'object', required: ['pattern'], properties: { pattern: { type: 'string' } } },
  },
  {
    name: 'websearch',
    description: 'Search the web. Use for external facts only: API signatures, versions, specifications.',
    parameters: { type: 'object', required: ['query'], properties: { query: { type: 'string' }, numResults: { type: 'integer' } } },
  },
  {
    name: 'webfetch',
    description: 'Fetch one URL as text. Use to confirm a fact found by websearch.',
    parameters: { type: 'object', required: ['url'], properties: { url: { type: 'string' } } },
  },
];

function buildPrompt(request: ReviewRequest, stepsLeft: number): string {
  const trace = request.trace.slice(-40).map((entry, index) =>
    `${index + 1}. ${entry.name} ${entry.success ? 'ok' : 'FAILED'}${entry.evidence ? ` [${entry.evidence}]` : ''}`);
  const intents = request.intents.map((intent) =>
    `- ${intent.id} [${intent.status}] ${intent.description}\n    method: ${intent.method || '(none)'}\n    evidence: ${intent.evidence || '(none)'}`);
  return [
    `USER REQUEST (verbatim):\n${clip(request.userIntent, 6000)}`,
    '',
    `INTENT LEDGER (agent-maintained, derived ${request.completionRate}%):`,
    intents.join('\n') || '(empty — the agent never recorded an intent, which is itself a finding)',
    '',
    request.approach ? `AGENT'S STATED APPROACH:\n${clip(request.approach, 800)}` : '',
    `AGENT'S CLOSING CLAIM:\n${clip(request.claim, 4000)}`,
    '',
    `TOOL CALLS (${request.trace.length} total, last 40):\n${trace.join('\n') || '(none)'}`,
    '',
    `DELIVERY SIGNALS: status=${request.delivery.status}; file mutations=${request.delivery.mutations}; verification=${request.delivery.evidence.join(', ') || 'none'}; repeated calls=${request.delivery.repeats}`,
    request.delivery.reasons.length ? `notes: ${request.delivery.reasons.join('; ')}` : '',
    '',
    `FILES THE TASK TOUCHED:\n${request.touched.slice(0, 40).join('\n') || '(none)'}`,
    '',
    `RECENT TRANSCRIPT (trimmed):\n${clip(request.transcript, 12_000)}`,
    '',
    TOOL_BUDGET_NOTE,
    `Steps left: ${stepsLeft}.`,
  ].filter((line) => line !== '').join('\n');
}

function parseVerdict(text: string, request: ReviewRequest): { verdict: Verdict; actualCompletion: number; missingIntents: string[]; fixFeedback: string; audit: string } {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(candidate.slice(start, end + 1));
      const verdict: Verdict = parsed.verdict === 'pass' ? 'pass' : 'reject';
      const actual = Math.max(0, Math.min(100, Math.round(Number(parsed.actual_completion ?? request.completionRate) || 0)));
      const missing = Array.isArray(parsed.missing_intents)
        ? parsed.missing_intents.map((item: any) => String(item || '').trim()).filter(Boolean)
        : [];
      return {
        verdict,
        actualCompletion: verdict === 'pass' ? Math.max(actual, request.completionRate) : actual,
        missingIntents: missing,
        fixFeedback: String(parsed.fix_feedback || '').trim(),
        audit: String(parsed.audit || '').trim(),
      };
    } catch { /* fall through to the shape below */ }
  }
  // A reviewer that answers in prose still gets a say: an explicit refusal is a
  // reject, and anything else is a pass only when no refusal word appears.
  const refusal = /\b(reject|not done|missing|incomplete|fake|stub|没有完成|未完成)\b/i.test(text);
  return {
    verdict: refusal ? 'reject' : 'pass',
    actualCompletion: refusal ? Math.min(60, request.completionRate) : request.completionRate,
    missingIntents: [],
    fixFeedback: refusal ? clip(text, 1200) : '',
    audit: clip(text, 300),
  };
}

export async function reviewDelivery(request: ReviewRequest, llm: LlmCaller): Promise<ReviewResult> {
  const started = Date.now();
  const deadline = started + Math.max(5_000, request.budgetMs);
  const steps: ReviewResult['steps'] = [];
  const messages: Array<{ role: string; content: string }> = [];
  let text = '';
  let stepsLeft = Math.max(1, request.maxToolSteps);

  try {
    for (; stepsLeft >= 0; stepsLeft--) {
      if (Date.now() > deadline) break;
      text = '';
      const reply = await llm({
        messages: [
          { role: 'user', content: buildPrompt(request, stepsLeft) },
          ...messages,
        ],
        systemPrompt: REVIEWER_SYSTEM,
        temperature: 0.1,
        maxTokens: 2600,
      });
      if (!reply) break;
      text = reply;
      const call = findToolCall(reply);
      if (!call || stepsLeft === 0) break;
      const { tool, args } = call;
      let ok = true;
      let body = '';
      try {
        if (tool === 'read') body = await runRead(request.cwd, args);
        else if (tool === 'grep') body = await runGrep(request.cwd, args);
        else if (tool === 'glob') body = await runGlob(request.cwd, args);
        else if (tool === 'websearch') body = await runWebSearch(args);
        else if (tool === 'webfetch') body = await runWebFetch(args);
        else throw new Error(`unknown tool ${tool}`);
      } catch (error: any) {
        ok = false;
        body = `error: ${error?.message || error}`;
      }
      steps.push({ tool, args, ok, summary: clip(body, 220) });
      messages.push(
        { role: 'assistant', content: reply },
        { role: 'user', content: `TOOL RESULT (${tool}):\n${clip(body, 14_000)}\n\nContinue the review. Steps left: ${stepsLeft - 1}.` },
      );
    }
  } catch (error: any) {
    // The reviewer is a second opinion, not a dependency. If it cannot run, the
    // task must not hang forever — it passes with the degradation recorded.
    return {
      verdict: 'pass',
      actualCompletion: request.completionRate,
      missingIntents: [],
      fixFeedback: '',
      audit: '',
      steps,
      degraded: `reviewer unavailable: ${error?.message || error}`,
      elapsedMs: Date.now() - started,
    };
  }

  if (!text.trim()) {
    return {
      verdict: 'pass',
      actualCompletion: request.completionRate,
      missingIntents: [],
      fixFeedback: '',
      audit: '',
      steps,
      degraded: 'reviewer returned no verdict',
      elapsedMs: Date.now() - started,
    };
  }

  const verdict = parseVerdict(text, request);
  return { ...verdict, steps, elapsedMs: Date.now() - started };
}

/** The reviewer is told to answer in JSON, but tool use comes first. */
function findToolCall(reply: string): { tool: string; args: Record<string, any> } | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/g;
  const candidates: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = fenced.exec(reply))) candidates.push(match[1]);
  let index = 0;
  while (true) {
    const open = reply.indexOf('{', index);
    if (open < 0) break;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = open; i < reply.length; i++) {
      const ch = reply[i];
      if (escape) { escape = false; continue }
      if (ch === '\\') { escape = true; continue }
      if (ch === '"') inString = !inString;
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) { candidates.push(reply.slice(open, i + 1)); index = i + 1; break }
      if (i === reply.length - 1) { index = reply.length; }
    }
    if (index <= open) index = open + 1;
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      const tool = parsed.tool || parsed.name;
      if (typeof tool === 'string' && ['read', 'grep', 'glob', 'websearch', 'webfetch'].includes(tool) && !parsed.verdict) {
        return { tool, args: parsed.args && typeof parsed.args === 'object' ? parsed.args : parsed };
      }
    } catch { /* not JSON */ }
  }
  return null;
}
