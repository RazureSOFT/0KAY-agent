/**
 * The assessment runtime as tools: recorded traffic, evidence, interception
 * rules, notices, model failover, side questions, enrichment and reports.
 *
 * State is per session and lives outside the model. Every tool takes an
 * `action` and returns data; nothing here writes into the conversation, which
 * is what keeps a long assessment from growing its own context.
 */
import * as path from 'node:path';
import { Tool } from '../types.js';
import type { ToolContext, ToolResult, LlmCaller } from '../types.js';
import { success, failure } from '../helpers.js';
import { ensureDataDir } from '../deps.js';
import { TrafficStore, EvidenceStore } from '../../analysis/runtime/records.js';
import { RuleSet, Notifier } from '../../analysis/runtime/policy.js';
import { LlmPool, SideQuestionBus } from '../../analysis/runtime/llm.js';
import { enrichAsset, buildReport } from '../../analysis/runtime/report.js';
import type { Observation, ReportFinding } from '../../analysis/runtime/report.js';
import type { InterceptAction, RuleMatch } from '../../analysis/runtime/policy.js';

interface RuntimeState {
  traffic: TrafficStore;
  evidence: EvidenceStore;
  rules: RuleSet;
  notices: Notifier;
  pool: LlmPool;
  questions: SideQuestionBus;
  enriched: Map<string, ReturnType<typeof enrichAsset>>;
  trafficFile?: string;
  providersBound: boolean;
}

const states = new Map<string, RuntimeState>();

export function resetRuntime(key?: string): void {
  if (key) states.delete(key);
  else states.clear();
}

function stateKey(context: ToolContext): string {
  return context.sessionId || context.taskId || 'default';
}

function getState(context: ToolContext): RuntimeState {
  const key = stateKey(context);
  let state = states.get(key);
  if (!state) {
    state = {
      traffic: new TrafficStore(),
      evidence: new EvidenceStore(),
      rules: new RuleSet(),
      notices: new Notifier(),
      pool: new LlmPool(),
      questions: new SideQuestionBus(),
      enriched: new Map(),
      providersBound: false,
    };
    states.set(key, state);
  }
  return state;
}

async function withTrafficMirror(context: ToolContext): Promise<RuntimeState> {
  const state = getState(context);
  if (state.trafficFile) return state;
  try {
    const dir = await ensureDataDir('traffic');
    const safe = stateKey(context).replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 80);
    state.trafficFile = path.join(dir, `${safe}.jsonl`);
    state.traffic.setFile(state.trafficFile);
  } catch {
    // A read-only workspace still gets the in-memory ledger.
  }
  return state;
}

function asCaller(call: LlmCaller | undefined, label: string): ((prompt: string) => Promise<string | null>) | null {
  if (!call) return null;
  return async (prompt: string) => {
    const text = await call({ messages: [{ role: 'user', content: prompt }] });
    return text && text.trim() ? text : Promise.reject(new Error(`${label} returned no completion`));
  };
}

function bindProviders(state: RuntimeState, context: ToolContext): void {
  if (state.providersBound) return;
  const primary = asCaller(context.llm, 'primary model');
  const backup = asCaller(context.backgroundLlm, 'background model');
  if (primary) state.pool.register({ id: 'primary', label: 'primary model', call: primary });
  if (backup) state.pool.register({ id: 'background', label: 'background model', call: backup });
  state.providersBound = true;
}

export class TrafficLogTool extends Tool {
  get name(): string { return 'traffic_log'; }
  get description(): string {
    return [
      'Append-only HTTP exchange ledger, scoped to the session.',
      'action=record stores one request/response pair (secret headers are redacted, bodies are bounded); action=list filters by host/method/status/tag; action=get reads one id; action=search looks through URL and bodies; action=stats counts by status and host.',
      'Use it to keep the wire evidence behind a finding without pasting raw traffic into the conversation.',
    ].join(' ');
  }
  get parameters(): Record<string, any> {
    return { type: 'object', required: ['action'], properties: {
      action: { type: 'string', enum: ['record', 'list', 'get', 'search', 'stats'] },
      id: { type: 'string' }, method: { type: 'string' }, url: { type: 'string' },
      requestHeaders: { type: 'object' }, requestBody: { type: 'string' },
      status: { type: 'integer' }, responseHeaders: { type: 'object' }, responseBody: { type: 'string' },
      durationMs: { type: 'number' }, tags: { type: 'array', items: { type: 'string' } },
      host: { type: 'string' }, tag: { type: 'string' }, since: { type: 'number' },
      query: { type: 'string', description: 'search: substring to look for.' },
      limit: { type: 'integer', minimum: 1, maximum: 2000 },
    }};
  }
  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    try {
      const state = await withTrafficMirror(context);
      switch (args.action) {
        case 'record': {
          if (!args.url) return failure('record needs a url');
          const row = state.traffic.record({
            method: args.method, url: args.url,
            requestHeaders: args.requestHeaders, requestBody: args.requestBody,
            status: args.status, responseHeaders: args.responseHeaders, responseBody: args.responseBody,
            durationMs: args.durationMs, tags: args.tags,
          });
          return success(row);
        }
        case 'list': return success(state.traffic.list({ host: args.host, method: args.method, status: args.status, since: args.since, tag: args.tag, limit: args.limit }));
        case 'get': return success(state.traffic.get(String(args.id || '')) || null);
        case 'search': return success(state.traffic.search(String(args.query || ''), args.limit));
        case 'stats': return success({ ...state.traffic.stats(), file: state.trafficFile || null });
        default: return failure(`unknown action: ${args.action}`);
      }
    } catch (error) { return failure(error); }
  }
}

export class EvidenceTool extends Tool {
  get name(): string { return 'evidence'; }
  get description(): string {
    return [
      'Write-once evidence snapshots behind findings.',
      'action=save stores a request/response snapshot with a SHA-256 hash; action=verify recomputes it and reports tampering; action=list shows snapshots for a finding; action=get reads one.',
      'A finding without an attached snapshot is treated as unverified by the report tool.',
    ].join(' ');
  }
  get parameters(): Record<string, any> {
    return { type: 'object', required: ['action'], properties: {
      action: { type: 'string', enum: ['save', 'get', 'list', 'verify'] },
      id: { type: 'string' }, findingId: { type: 'string' }, kind: { type: 'string' },
      exchangeId: { type: 'string' }, request: {}, response: {}, note: { type: 'string' },
    }};
  }
  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    try {
      const state = getState(context);
      switch (args.action) {
        case 'save': {
          if (!args.findingId) return failure('save needs a findingId');
          return success(state.evidence.save({
            findingId: args.findingId, kind: args.kind, exchangeId: args.exchangeId,
            request: args.request, response: args.response, note: args.note,
          }));
        }
        case 'get': return success(state.evidence.get(String(args.id || '')) || null);
        case 'list': return success(state.evidence.list(args.findingId ? String(args.findingId) : undefined));
        case 'verify': return success(state.evidence.verify(String(args.id || '')));
        default: return failure(`unknown action: ${args.action}`);
      }
    } catch (error) { return failure(error); }
  }
}

export class InterceptRuleTool extends Tool {
  get name(): string { return 'intercept_rule'; }
  get description(): string {
    return [
      'Rules that decide a request before an approval prompt is shown.',
      'action=add registers a rule (block | allow | rewrite) matching method/host/path tail/substring; action=remove deletes one; action=list shows the table; action=check evaluates a request; action=judge also asks an injected model when no rule matched.',
      'A block always wins over an allow, and an unmatched request falls back to prompt — never to a silent allow. No built-in dangerous-command table: an empty rule set means the usual approval flow.',
    ].join(' ');
  }
  get parameters(): Record<string, any> {
    return { type: 'object', required: ['action'], properties: {
      action: { type: 'string', enum: ['add', 'remove', 'list', 'check', 'judge'] },
      id: { type: 'string' }, ruleAction: { type: 'string', enum: ['block', 'allow', 'rewrite'], description: 'The rule action (named ruleAction to avoid colliding with the tool action).' },
      match: { type: 'object', description: '{method, host, pathEndsWith, contains}' },
      setHeaders: { type: 'object' }, setBody: { type: 'string' }, note: { type: 'string' },
      method: { type: 'string' }, url: { type: 'string' }, headers: { type: 'object' }, body: { type: 'string' },
    }};
  }
  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    try {
      const state = getState(context);
      switch (args.action) {
        case 'add': {
          if (!args.ruleAction) return failure('add needs ruleAction');
          const rule = state.rules.add({
            action: args.ruleAction as InterceptAction,
            match: (args.match || {}) as RuleMatch,
            setHeaders: args.setHeaders, setBody: args.setBody, note: args.note,
          });
          return success(rule);
        }
        case 'remove': return success({ removed: state.rules.remove(String(args.id || '')) });
        case 'list': return success(state.rules.list());
        case 'check': return success(state.rules.evaluate({ method: String(args.method || 'GET'), url: String(args.url || ''), headers: args.headers, body: args.body }));
        case 'judge': {
          const ask = asCaller(context.llm || context.backgroundLlm, 'judge');
          return success(await state.rules.judge(
            { method: String(args.method || 'GET'), url: String(args.url || ''), headers: args.headers, body: args.body },
            ask ? async (prompt) => { try { return await ask(prompt); } catch { return null; } } : undefined,
          ));
        }
        default: return failure(`unknown action: ${args.action}`);
      }
    } catch (error) { return failure(error); }
  }
}

export class NotifyTool extends Tool {
  get name(): string { return 'notify'; }
  get description(): string {
    return [
      'Outbound notices with deduplication and a rate limit.',
      'action=send records a notice and delivers it through the configured channel; action=list shows history; action=stats reports delivered/failed/suppressed.',
      'A failed or suppressed delivery is recorded on the notice instead of being reported as sent.',
    ].join(' ');
  }
  get parameters(): Record<string, any> {
    return { type: 'object', required: ['action'], properties: {
      action: { type: 'string', enum: ['send', 'list', 'stats'] },
      level: { type: 'string', enum: ['info', 'warn', 'error'] }, title: { type: 'string' },
      body: { type: 'string' }, channel: { type: 'string' },
    }};
  }
  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    try {
      const state = getState(context);
      switch (args.action) {
        case 'send': {
          if (!args.title) return failure('send needs a title');
          const notice = await state.notices.send({ level: args.level, title: args.title, body: args.body, channel: args.channel });
          return success(notice);
        }
        case 'list': return success(state.notices.list(args.level));
        case 'stats': return success(state.notices.stats());
        default: return failure(`unknown action: ${args.action}`);
      }
    } catch (error) { return failure(error); }
  }
}

export class LlmPoolTool extends Tool {
  get name(): string { return 'llm_pool'; }
  get description(): string {
    return [
      'Model failover with a per-call record.',
      'action=call completes a prompt through the available model callers, skipping providers that are cooling down after repeated failures; action=status shows each provider; action=records shows recent calls; action=reset clears a cooldown.',
      'When nothing is available it returns an error rather than an empty answer.',
    ].join(' ');
  }
  get parameters(): Record<string, any> {
    return { type: 'object', required: ['action'], properties: {
      action: { type: 'string', enum: ['call', 'status', 'records', 'reset'] },
      prompt: { type: 'string' }, id: { type: 'string' }, limit: { type: 'integer' },
    }};
  }
  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    try {
      const state = getState(context);
      bindProviders(state, context);
      switch (args.action) {
        case 'call': {
          if (!args.prompt) return failure('call needs a prompt');
          return success(await state.pool.complete(String(args.prompt)));
        }
        case 'status': return success(state.pool.status());
        case 'records': return success(state.pool.records(args.limit));
        case 'reset': state.pool.reset(args.id ? String(args.id) : undefined); return success(state.pool.status());
        default: return failure(`unknown action: ${args.action}`);
      }
    } catch (error) { return failure(error); }
  }
}

export class SideQuestionTool extends Tool {
  get name(): string { return 'side_question'; }
  get description(): string {
    return [
      'Questions resolved beside the main loop, without entering its context.',
      'action=ask opens a question; action=resolve answers it through an injected model caller; action=get/list/answers read results. Only answers a caller explicitly reads reach a later round.',
    ].join(' ');
  }
  get parameters(): Record<string, any> {
    return { type: 'object', required: ['action'], properties: {
      action: { type: 'string', enum: ['ask', 'resolve', 'get', 'list', 'answers'] },
      question: { type: 'string' }, context: { type: 'string' }, id: { type: 'string' },
      status: { type: 'string', enum: ['pending', 'answered', 'failed'] },
    }};
  }
  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    try {
      const state = getState(context);
      switch (args.action) {
        case 'ask': {
          if (!args.question) return failure('ask needs a question');
          return success(state.questions.ask(String(args.question), String(args.context || '')));
        }
        case 'resolve': {
          const ask = asCaller(context.llm || context.backgroundLlm, 'side-question model');
          if (!ask) return failure('no model caller is available to resolve the question');
          return success(await state.questions.resolve(String(args.id || ''), ask));
        }
        case 'get': return success(state.questions.get(String(args.id || '')) || null);
        case 'list': return success(state.questions.list(args.status));
        case 'answers': return success(state.questions.answers());
        default: return failure(`unknown action: ${args.action}`);
      }
    } catch (error) { return failure(error); }
  }
}

export class EnrichTool extends Tool {
  get name(): string { return 'asset_enrich'; }
  get description(): string {
    return [
      'Fill in asset attributes from observations, and say what could not be established.',
      'action=apply takes a key plus observations (dns/http/tls/port/header/text) and returns host, port, scheme, IP, server, title, technologies and open ports; action=get/list read earlier results.',
      'Only what an observation actually establishes is filled in — unknown fields are listed rather than guessed.',
    ].join(' ');
  }
  get parameters(): Record<string, any> {
    return { type: 'object', required: ['action'], properties: {
      action: { type: 'string', enum: ['apply', 'get', 'list'] },
      key: { type: 'string', description: 'Asset key: URL, host:port or hostname.' },
      observations: { type: 'array', items: { type: 'object' }, description: '[{kind, value, name?}]' },
    }};
  }
  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    try {
      const state = getState(context);
      switch (args.action) {
        case 'apply': {
          if (!args.key) return failure('apply needs an asset key');
          const rows = (Array.isArray(args.observations) ? args.observations : []) as Observation[];
          const asset = enrichAsset(String(args.key), rows);
          state.enriched.set(asset.key, asset);
          return success(asset);
        }
        case 'get': return success(state.enriched.get(String(args.key || '')) || null);
        case 'list': return success([...state.enriched.values()]);
        default: return failure(`unknown action: ${args.action}`);
      }
    } catch (error) { return failure(error); }
  }
}

export class AssessmentReportTool extends Tool {
  get name(): string { return 'assessment_report'; }
  get description(): string {
    return [
      'Assemble a report from findings, evidence snapshots and recorded exchanges.',
      'Findings with an attached evidence snapshot are confirmed; the rest are listed as unverified observations with the reason. Scope without a declared denominator is called out.',
      'action=build returns the markdown and a structured summary; action=write also saves it to a file inside the workspace.',
    ].join(' ');
  }
  get parameters(): Record<string, any> {
    return { type: 'object', required: ['action'], properties: {
      action: { type: 'string', enum: ['build', 'write'] },
      title: { type: 'string' }, scope: { type: 'array', items: { type: 'string' } },
      findings: { type: 'array', items: { type: 'object' }, description: '[{id, title, severity?, asset?, detail?}]' },
      out: { type: 'string', description: 'write: path for the markdown file.' },
    }};
  }
  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    try {
      const state = getState(context);
      const report = buildReport({
        title: String(args.title || 'Assessment report'),
        scope: Array.isArray(args.scope) ? args.scope.map(String) : [],
        findings: (Array.isArray(args.findings) ? args.findings : []) as ReportFinding[],
        evidence: state.evidence.list(),
        exchanges: state.traffic.list({ limit: 2000 }),
      });
      if (args.action === 'write') {
        if (!args.out) return failure('write needs an out path');
        const target = path.resolve(context.cwd, String(args.out));
        const root = path.resolve(context.cwd);
        if (target !== root && !target.startsWith(root + path.sep)) {
          return failure('out must stay inside the workspace');
        }
        const { writeFile, mkdir } = await import('node:fs/promises');
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, report.markdown, 'utf8');
        return success({ ...report, out: target });
      }
      return success(report);
    } catch (error) { return failure(error); }
  }
}

export const RUNTIME_TOOLS = [
  new TrafficLogTool(),
  new EvidenceTool(),
  new InterceptRuleTool(),
  new NotifyTool(),
  new LlmPoolTool(),
  new SideQuestionTool(),
  new EnrichTool(),
  new AssessmentReportTool(),
];
