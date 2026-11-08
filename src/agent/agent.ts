import { MocrProvider, Message, MessagePart, GenerateRequest, GenerateResponse, ToolCall } from '../provider/mocr.js';
import { ToolRegistry, createDefaultRegistry, PluginTool, type ToolSchema } from '../tools/tools.js';
import { planPluginTools } from '../tools/plugin-tools.js';
import { SkillRegistry, getSkillRegistry } from '../skills/skills.js';
import { TaskManager, Task } from '../task/task.js';
import { McpManager, McpServerConfig } from '@0kay/mcp';
import { randomUUID } from 'crypto';
import { SubAgentRegistry } from './subagents.js';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { stat, readdir, mkdir, readFile, writeFile, mkdtemp, rm } from 'fs/promises';
import { ApprovalManager } from '../task/approvals.js';
import { SessionDirectives } from '../task/directives.js';
import { ContextLedger } from '../context/ledger.js';
import { inferContextWindow, compactPolicy, cacheProfileFor, decideCompactTier, type CompactPolicy } from '../context/window.js';
import { prefixHash } from '../context/prefix.js';
import { QuestionManager } from '../task/questions.js';
import * as os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
import { taskRecorder } from '../task/records.js';
import { coreFetch, coreHeaders, coreHttpBase, listPluginTools, executorIdentity } from '../connection.js';
import { browserController } from '../tools/browser.js';
import { WorkspaceRegistry, type Workspace } from '../workspace/registry.js';
import { allowTaskRoot, allowedWorkspaceRoots, isPathAllowed } from '../workspace/paths.js';
import { assertReadable, filterListing } from '../workspace/secrets.js';
import { SandboxPolicy, parseSandboxMode } from '../sandbox/policy.js';
import { TOOL_GROUPS, ALWAYS_LOADED, groupOf, isAlwaysLoaded } from '../tools/groups.js';
import { ReconGraph, FileGraphStore } from '../analysis/recon/graph.js';
import { AssessmentManager } from '../analysis/recon/tasks.js';
import { shellChoice } from '../tools/shell_choice.js';
import { DeliverySupervisor, supervisionDirective } from './supervision.js';
import { completeProgress } from '../tools/progress.js';
import { setEvolveGitHubToken, setEvolveBranchPrefix } from '../tools/self_evolve.js';
import { resolvePosture, postureDirective } from './posture.js';
import { resolveMode, type MultiAgentMode } from './modes.js';
import { buildHandoffDoc } from './handoff.js';
import { ensureAgentWorkspace, appendAgentNote } from './agent_workspace.js';
import { extractDocumentText, isDocumentAttachment } from './attachment_text.js';
import { PluginHost, toRegistryTool } from '../plugins/host.js';
import { agentEvents } from './events.js';
import { QualityGate, resolveGateMode, type GateMode } from './gate.js';
import { FactMemory } from './facts.js';
import { PermissionLedger } from './permission.js';
import { prepareTurn, libraryFor } from './library.js';
import { steering } from './steering.js';

const CORE_HTTP = process.env.CORE_HTTP_ADDR || process.env.CORE_HTTP || 'http://127.0.0.1:8080';

export interface AgentConfig {
  mocrAddress: string;
  maxIterations: number;
}

export const EXPLORE_AGENT_TYPE = 'code_explore';
export const EXPLORE_FANOUT = 5;
export const EXPLORE_TIMEOUT_MS = 180_000;

const EXPLORE_READ_ONLY_TOOLS = new Set([
  'read', 'glob', 'grep', 'webfetch', 'websearch', 'papersearch', 'apidocsearch',
  'todowrite', 'compress', 'decompress', 'search_context', 'acp_status', 'report_artifacts',
]);

// tools that cannot touch anything. they skip the approval gate even when the
// saved always_allow_tools predates them — a permission popup for a read-only
// call just makes the whole agent look broken.
// Tools that cannot touch the world, so an approval prompt would only be noise.
// `tools` lists and loads tool groups: it mutates an in-memory set and nothing else.
const ALWAYS_SAFE_TOOLS = new Set([
  'report_artifacts', 'tools', 'recon_graph', 'vuln_kb', 'assessments', 'session',
  // RECON graph surface: bookkeeping on the session's exploration graph and
  // trace store — no world-touching calls, so approval prompts would be noise.
  'graph_overview', 'list_goals', 'list_facts', 'list_findings', 'node_detail', 'expand_digest',
  'list_assets', 'list_untested_assets', 'add_task_scope', 'add_intent', 'prove_goal', 'goal_met',
  'kill_work', 'steer_work', 'record_fact', 'report_finding', 'insert_assets', 'add_hint',
  'set_goals', 'set_constraints', 'search_all_worker_traces', 'get_worker_trace',
]);

function envCount(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return Math.min(max, Math.floor(parsed));
}

export function formatTodoList(todo?: Array<{ content?: string; status?: string }>): string {
  const items = (todo || []).filter((item) => item && String(item.content || '').trim() && item.status !== 'cancelled');
  if (!items.length) return '';
  const mark = (status?: string) => status === 'completed' ? '[x]' : status === 'in_progress' ? '[>]' : '[ ]';
  const remaining = items.filter((item) => item.status !== 'completed').length;
  const lines = items.map((item) => `${mark(item.status)} ${String(item.content).trim()}`);
  return `Current todo list — ${remaining} item(s) remaining. Keep it current with todowrite and exactly one item in_progress:\n${lines.join('\n')}`;
}

// Tools that run without asking the user. The list is deliberately short: it
// holds only things that cannot act on the world.
//
// `read`, `glob` and `grep` are NOT here even though they only read. A read is
// half of the exfiltration pair — the other half is `webfetch` — and an
// injected instruction in a webpage or a repo is exactly what turns a harmless
// read into "read the key file and put it in this URL". Reading also has no
// visible side effect, so a user cannot tell from the transcript that it
// happened. The path gate in workspace/secrets.ts is the hard stop; this list
// is the second lock, and it costs one approval per unfamiliar directory.
// Reading and fetching run without a prompt: they are what an agent does all
// day, and a prompt per file or page makes it unusable.
//
// That pair is also the exfiltration chain — read a key, fetch a URL — so the
// chain is closed where it actually leaks rather than at every call site: the
// read gate in workspace/secrets.ts refuses credential files no matter what the
// workspace roots say, and `http_request` (the tool that takes an arbitrary
// method, body and host) stays out of this list.
export const DEFAULT_AUTO_APPROVE_TOOLS =
  'read,glob,grep,webfetch,websearch,papersearch,apidocsearch,todowrite,skill,compress,decompress,search_context,acp_status,report_artifacts,tools';

export const DUET_PLAN_SYSTEM_PROMPT =
  'You are the planning model (large model). Your job is to produce an implementation plan the execution model (weaker, with no conversation context) can follow directly. ' +
  'First give a short plan overview and step-by-step outline (citing concrete file paths and facts), then output a self-contained implementation prompt wrapped in <implementation_prompt></implementation_prompt>. ' +
  'The prompt must include: the goal, the files involved and their current state, step-by-step change requirements, constraints and acceptance criteria, ' +
  'and must not reference "above/as mentioned" — the execution model sees only this prompt. Do not re-explain the plan background inside the prompt.'

export const DUET_PLAN_USER_PROMPT =
  'Produce an implementation plan for the task below, and put the complete implementation prompt for the execution model inside <implementation_prompt> tags.'

export const DUET_IMPLEMENT_USER_PROMPT =
  'The plan and implementation prompt are ready. Implement strictly according to the <implementation_prompt> above; where it conflicts with reality, trust the actual code and note it in your progress. Do not re-plan.'

export const COMPACTION_SCHEMA_PROMPT =
  'Compress this execution transcript into a faithful, structured working summary so the run can continue after the raw history is dropped. Use EXACTLY these Markdown sections, in this order, and keep every section:\n' +
  '## Objective\n## Important Details\n## Work State\n## Next Move\n## Relevant Files\n' +
  'Objective: the current goal and what done means. Important Details: durable facts, decisions, constraints, file paths, IDs, tool results and errors, user answers, acceptance criteria, and questions already answered (never secrets). Work State: grouped as Completed / Active / Blocked, reporting only observed results and never inventing success. Next Move: the concrete immediate next step(s). Relevant Files: file_path:line references needed to continue. If a section has nothing, write none. Carry prior facts forward. Start directly with ## Objective; no preamble or restated instructions. Be terse and factual, no process narration. Do not execute tools. Keep under 4000 words.';

function serializeToolArgs(args: Record<string, any>): string {
  try {
    const clean: Record<string, any> = { ...(args || {}) };
    for (const key of ['content', 'oldString', 'newString']) delete clean[key];
    if (Array.isArray(clean.patches)) {
      clean.patches = clean.patches.map((patch: any) => {
        if (!patch || typeof patch !== 'object') return patch;
        const rest = { ...patch };
        delete rest.oldString;
        delete rest.newString;
        return rest;
      });
    }
    const json = JSON.stringify(clean) ?? '{}';
    return json.length > 12000 ? json.slice(0, 12000) + '…' : json;
  } catch {
    return '{}';
  }
}

function jsonObjectCandidates(text: string, limit = 5): string[] {
  const out: string[] = [];
  for (let start = text.indexOf('{'); start >= 0 && out.length < limit; start = text.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) { out.push(text.slice(start, i + 1)); break; }
    }
  }
  return out;
}

export interface AgentSettings {
  model_id?: string;
  temperature?: number;
  max_iterations?: number;
  max_concurrent_tasks?: number;
  default_agent_type?: string;
  sandbox_mode?: string;
  tool_disclosure?: string;
  enable_shell_tool?: boolean;
  enable_filesystem_tool?: boolean;
  enable_web_tools?: boolean;
  enable_computer_use?: boolean;
  enable_browser_tool?: boolean;
  enable_document_tool?: boolean;
  enable_slides_tool?: boolean;
  enable_terminal?: boolean;
  self_evolve_enabled?: boolean;
  self_evolve_repo?: string;
  github_token?: string;
  evolve_branch_prefix?: string;
  vision_model?: string;
  context_window?: number;
  compaction_model?: string;
  enable_mcp_tool?: boolean;
  enable_plugin_tools?: boolean;
  enable_task_tool?: boolean;
  mcp_servers_json?: string;
  enable_skills?: boolean;
  skills_dir?: string;
  /** Where agent extension plugins live. Empty means the bundled directory. */
  plugins_dir?: string;
  /** Comma-separated plugin names to load. Empty means "every plugin found". */
  plugins_enabled?: string;
  always_allow_tools?: string;
  minimal_mode?: boolean;
  duet_mode?: boolean;
  /** off = no gate; rules = intent ledger only; full = ledger + reviewer model. */
  gate_mode?: string;
  /** Model for the reviewer. Empty = the task's own model. */
  reviewer_model?: string;
  /** Reviews rejected in a row before the task stops for a human. */
  gate_max_rejects?: number;
  /** Tool calls the reviewer may make per review. */
  gate_max_tool_steps?: number;
  /** Wall-clock budget for one review, in seconds. */
  gate_budget_seconds?: number;
  /** Rules injected before the first message (the LIBRARY stage). */
  library_enabled?: boolean;
  /** Let the agent rewrite its own experience without a user/reviewer instruction. */
  agent_self_write?: boolean;
}

export interface AgentContext {
  taskId: string;
  prompt: string;
  history: Message[];
  todo: Array<{ id: string; content: string; status: 'pending' | 'in_progress' | 'completed' | 'cancelled'; priority?: 'high' | 'medium' | 'low' }>;
  signal: AbortSignal;
  sessionId: string;
  cwd: string;
  options: Record<string, string>;
  ledger?: ContextLedger;
  /** Intent ledger + 100% gate for this task. */
  gate?: QualityGate;
  /** fact_1..fact_10 for this task. */
  facts?: FactMemory;
  /** Checks memory and experience writes before they land. */
  permissions?: PermissionLedger;
  /** The learned rule library of the workspace this task runs in. */
  library?: ReturnType<typeof libraryFor>;
}

export function estimateTextTokens(text: string): number {
  let ascii = 0, wide = 0;
  for (const ch of text) { (ch.codePointAt(0) ?? 0) < 128 ? ascii++ : wide++; }
  return Math.round(ascii / 4 + wide);
}

const sessionPromptTokens = new Map<string, number>();
const MAX_SESSION_PROMPT_TOKENS = 1000;
const MAX_LOOP_ITERATIONS = 500;
function trackSessionPromptTokens(sessionId: string, tokens: number): void {
  sessionPromptTokens.set(sessionId, tokens);
  if (sessionPromptTokens.size > MAX_SESSION_PROMPT_TOKENS) {
    const oldest = sessionPromptTokens.keys().next().value;
    if (oldest) sessionPromptTokens.delete(oldest);
  }
}

// Last cacheable prefix seen per session. `prefix_changed` in context_usage
// answers "did this turn throw the provider's prefix cache away?", which is the
// difference between a cheap turn and a full-price one.
const sessionPrefix = new Map<string, string>();
function trackSessionPrefix(sessionId: string, hash: string): { hash: string; changed: boolean } {
  if (!sessionId) return { hash, changed: false };
  const previous = sessionPrefix.get(sessionId);
  sessionPrefix.set(sessionId, hash);
  if (sessionPrefix.size > MAX_SESSION_PROMPT_TOKENS) {
    const oldest = sessionPrefix.keys().next().value;
    if (oldest) sessionPrefix.delete(oldest);
  }
  return { hash, changed: previous !== undefined && previous !== hash };
}

const FILE_MUTATING_TOOLS = new Set(['write', 'edit', 'apply_patch', 'document', 'slides']);
let fileMutationChain: Promise<unknown> = Promise.resolve();
function serializeFileMutation<T>(tool: string, task: () => Promise<T>): Promise<T> {
  if (!FILE_MUTATING_TOOLS.has(tool)) return task();
  const run = fileMutationChain.then(task, task);
  fileMutationChain = run.catch(() => {});
  return run;
}

export class Agent {
  private mocr: MocrProvider;
  private activeModel = '';
  private tools: ToolRegistry;
  private skills: SkillRegistry;
  private taskManager: TaskManager;
  private mcp: McpManager;
  private config: AgentConfig;
  private settings: Required<AgentSettings>;
  private recorder = taskRecorder;
  private approvals = new ApprovalManager();
  /** Session UI directives (titles, toasts) — collected by core's inbox poll. */
  private directives = new SessionDirectives();
  private questions = new QuestionManager();
  private handoffs = new Map<string,string>();
  private workspaces = new WorkspaceRegistry();
  private pluginToolNames = new Set<string>();
  private lastPluginToolRefresh = 0;
  /**
   * Extensions that change how this agent behaves, as opposed to tools it can
   * call. Loaded from disk, so installing one is a directory copy rather than a
   * rebuild, and disabling one takes effect on the next task.
   */
  private extensions?: PluginHost;
  /** Tool names the current plugin generation registered, so a reload can drop them. */
  private pluginExtensionTools: string[] = [];
  /** What the last plugin-tool refresh did, for the status surface and logs. */
  private pluginToolReport: { registered: string[]; renamed: string[]; skipped: any[]; error?: string } =
    { registered: [], renamed: [], skipped: [] };
  private subagents = new SubAgentRegistry();
  /** Last context measurement, so the UI can show a meter instead of guessing. */
  lastContext: { used: number; window: number; tier: string; source: string } = { used: 0, window: 0, tier: 'none', source: 'default' };
  /** Groups a task has pulled into its prompt. */
  private taskGroups = new Map<string, Set<string>>();
  /** Asset + exploration graphs, one pair per task (the recon_graph tool). */
  private reconGraphs = new Map<string, ReconGraph>();
  /** Graphs are written through to disk so a restart continues the session. */
  private reconStoreField?: FileGraphStore;
  private reconSaves = new Map<string, Promise<void>>();
  /** Background assessment tasks (the assessments tool), persisted like the graphs. */
  private assessmentsField?: AssessmentManager;
  private get assessments(): AssessmentManager {
    if (this.assessmentsField) return this.assessmentsField;
    try {
      const dataDir = process.env.AGENT_DATA_DIR || './data/agent';
      this.assessmentsField = new AssessmentManager(
        (sessionId) => this.reconFor(sessionId),
        path.join(dataDir, 'assessments'),
      );
    } catch {
      // A data dir that cannot be created still leaves the manager working in
      // memory: tasks run, they just do not survive a restart.
      this.assessmentsField = new AssessmentManager((sessionId) => this.reconFor(sessionId));
    }
    return this.assessmentsField;
  }
  /** Lazy because a read-only or unwritable data dir disables persistence, not the agent. */
  private get reconStore(): FileGraphStore | undefined {
    if (this.reconStoreField) return this.reconStoreField;
    try {
      const dataDir = process.env.AGENT_DATA_DIR || './data/agent';
      this.reconStoreField = new FileGraphStore(path.join(dataDir, 'recon'));
      return this.reconStoreField;
    } catch {
      return undefined;
    }
  }
  /** The configured sandbox mode; tasks inherit it unless they pass their own. */
  get sandboxMode(): string { return this.settings.sandbox_mode || 'workspace-write' }
  takeHandoff(taskId:string):string {const value=this.handoffs.get(taskId)||'';this.handoffs.delete(taskId);return value}

  constructor(config: Partial<AgentConfig> = {}) {
    this.config = {
      mocrAddress: config.mocrAddress || 'localhost:50052',
      maxIterations: config.maxIterations || 10,
    };

    this.settings = {
      model_id: '',
      temperature: 0.7,
      max_iterations: this.config.maxIterations,
      max_concurrent_tasks: 5,
      default_agent_type: 'general',
      sandbox_mode: 'workspace-write',
      tool_disclosure: 'progressive',
      enable_shell_tool: true,
      enable_filesystem_tool: true,
      enable_web_tools: true,
      enable_computer_use: false,
      enable_browser_tool: false,
      enable_document_tool: true,
      enable_slides_tool: true,
      enable_terminal: false,
      self_evolve_enabled: false,
      self_evolve_repo: '',
      github_token: '',
      evolve_branch_prefix: 'self/',
      vision_model: '',
      context_window: 0,
      compaction_model: '',
      enable_mcp_tool: true,
      enable_plugin_tools: true,
      enable_task_tool: true,
      mcp_servers_json: '[]',
      enable_skills: true,
      skills_dir: '',
      plugins_dir: '',
      plugins_enabled: '',
      always_allow_tools: DEFAULT_AUTO_APPROVE_TOOLS,
      minimal_mode: false,
      duet_mode: false,
      gate_mode: 'full',
      reviewer_model: '',
      gate_max_rejects: 3,
      gate_max_tool_steps: 6,
      gate_budget_seconds: 120,
      library_enabled: true,
      agent_self_write: false,
    };

    this.mocr = new MocrProvider({ grpcAddress: this.config.mocrAddress });
    this.tools = createDefaultRegistry();
    this.skills = getSkillRegistry();
    this.mcp = new McpManager();
    this.taskManager = new TaskManager({ maxConcurrentTasks: this.settings.max_concurrent_tasks });
    this.applyToolToggles();

    this.taskManager.setOnComplete((task) => {
      console.log(`Task ${task.id} completed: ${task.state}`);
      agentEvents.forget(task.id);
      const completed = this.taskManager.getAllTasks().filter(t => !['PENDING', 'RUNNING'].includes(t.state));
      for (const old of completed.slice(0, -200)) this.taskManager.removeTask(old.id);
    });
  }

  applySettings(partial: AgentSettings): void {
    if (typeof partial.model_id === 'string') this.settings.model_id = partial.model_id.trim();
    if (typeof partial.temperature === 'number' && Number.isFinite(partial.temperature)) {
      this.settings.temperature = Math.max(0, Math.min(2, partial.temperature));
    }
    if (typeof partial.max_iterations === 'number' && partial.max_iterations >= 1) {
      this.settings.max_iterations = Math.floor(partial.max_iterations);
      this.config.maxIterations = this.settings.max_iterations;
    }
    if (typeof partial.max_concurrent_tasks === 'number' && partial.max_concurrent_tasks >= 1) {
      this.settings.max_concurrent_tasks = Math.floor(partial.max_concurrent_tasks);
      this.taskManager.setMaxConcurrentTasks(this.settings.max_concurrent_tasks);
    }
    if (typeof partial.default_agent_type === 'string' && partial.default_agent_type) {
      this.settings.default_agent_type = partial.default_agent_type;
    }
    if (typeof partial.tool_disclosure === 'string' && partial.tool_disclosure) {
      this.settings.tool_disclosure = partial.tool_disclosure === 'all' ? 'all' : 'progressive';
    }
    if (typeof partial.sandbox_mode === 'string' && partial.sandbox_mode) {
      // Normalised on the way in: an unknown value must not silently become
      // "no restriction".
      this.settings.sandbox_mode = parseSandboxMode(partial.sandbox_mode);
    }
    if (typeof partial.enable_shell_tool === 'boolean') {
      this.settings.enable_shell_tool = partial.enable_shell_tool;
    }
    if (typeof partial.enable_filesystem_tool === 'boolean') {
      this.settings.enable_filesystem_tool = partial.enable_filesystem_tool;
    }
    if (typeof partial.self_evolve_enabled === 'boolean') {
      this.settings.self_evolve_enabled = partial.self_evolve_enabled;
      this.applyToolToggles();
    }
    if (typeof partial.self_evolve_repo === 'string') this.settings.self_evolve_repo = partial.self_evolve_repo;
    if (typeof partial.github_token === 'string') this.settings.github_token = partial.github_token.trim();
    if (typeof partial.evolve_branch_prefix === 'string') this.settings.evolve_branch_prefix = partial.evolve_branch_prefix.trim();
    setEvolveGitHubToken(this.settings.github_token || '');
    setEvolveBranchPrefix(this.settings.evolve_branch_prefix || 'self/');
    if (typeof partial.enable_web_tools === 'boolean') this.settings.enable_web_tools = partial.enable_web_tools;
    if (typeof partial.enable_computer_use === 'boolean') this.settings.enable_computer_use = partial.enable_computer_use;
    if (typeof partial.enable_browser_tool === 'boolean') this.settings.enable_browser_tool = partial.enable_browser_tool;
    if (typeof partial.enable_document_tool === 'boolean') this.settings.enable_document_tool = partial.enable_document_tool;
    if (typeof partial.enable_slides_tool === 'boolean') this.settings.enable_slides_tool = partial.enable_slides_tool;
    if (typeof partial.enable_terminal === 'boolean') this.settings.enable_terminal = partial.enable_terminal;
    if (typeof partial.vision_model === 'string') this.settings.vision_model = partial.vision_model.trim();
    if (typeof partial.context_window === 'number' && partial.context_window >= 0) this.settings.context_window = Math.floor(partial.context_window);
    if (typeof partial.compaction_model === 'string') this.settings.compaction_model = partial.compaction_model.trim();
    if (typeof partial.enable_mcp_tool === 'boolean') this.settings.enable_mcp_tool = partial.enable_mcp_tool;
    if (typeof partial.enable_plugin_tools === 'boolean') this.settings.enable_plugin_tools = partial.enable_plugin_tools;
    if (typeof partial.enable_task_tool === 'boolean') this.settings.enable_task_tool = partial.enable_task_tool;
    if (typeof partial.mcp_servers_json === 'string' && partial.mcp_servers_json.trim() !== this.settings.mcp_servers_json) {
      this.settings.mcp_servers_json = partial.mcp_servers_json.trim() || '[]';
      try {
        const parsed = JSON.parse(this.settings.mcp_servers_json);
        if (!Array.isArray(parsed)) throw new Error('must be a JSON array');
        this.mcp.configure(parsed as McpServerConfig[]);
        void this.mcp.refresh().catch((error) => console.warn('[Agent] MCP refresh failed:', error.message));
      } catch (error: any) {
        console.warn('[Agent] ignoring invalid mcp_servers_json:', error.message);
      }
    }
    if (typeof partial.enable_skills === 'boolean') {
      this.settings.enable_skills = partial.enable_skills;
    }
    if (typeof partial.skills_dir === 'string' && partial.skills_dir.trim() !== this.settings.skills_dir) {
      this.settings.skills_dir = partial.skills_dir.trim();
      this.skills = new SkillRegistry();
      if (this.settings.skills_dir) {
        this.skills.loadDir(this.settings.skills_dir);
      }
    }
    if (typeof partial.always_allow_tools === 'string' && partial.always_allow_tools.trim() !== this.settings.always_allow_tools) {
      this.settings.always_allow_tools = partial.always_allow_tools.trim();
    }
    if (typeof partial.minimal_mode === 'boolean') this.settings.minimal_mode = partial.minimal_mode;
    if (typeof partial.duet_mode === 'boolean') this.settings.duet_mode = partial.duet_mode;
    if (partial.plugins_dir !== undefined || partial.plugins_enabled !== undefined) {
      const nextDir = typeof partial.plugins_dir === 'string' ? partial.plugins_dir.trim() : this.settings.plugins_dir;
      const nextEnabled = typeof partial.plugins_enabled === 'string' ? partial.plugins_enabled.trim() : this.settings.plugins_enabled;
      // The settings poll runs on a timer; reloading on every poll would re-import
      // every plugin module once a minute for no reason.
      if (nextDir !== this.settings.plugins_dir || nextEnabled !== this.settings.plugins_enabled) {
        this.settings.plugins_dir = nextDir;
        this.settings.plugins_enabled = nextEnabled;
        // The load is async and the caller is not; a task that starts in the
        // meantime sees the previous set, which is the same set it saw a moment
        // ago. Rejections are recorded on the host, not thrown into settings.
        void this.reloadExtensions();
      }
    }
    if (partial.gate_mode !== undefined) this.settings.gate_mode = resolveGateMode(partial.gate_mode);
    if (typeof partial.reviewer_model === 'string') this.settings.reviewer_model = partial.reviewer_model.trim();
    if (typeof partial.gate_max_rejects === 'number' && partial.gate_max_rejects >= 1) {
      this.settings.gate_max_rejects = Math.max(1, Math.min(10, Math.floor(partial.gate_max_rejects)));
    }
    if (typeof partial.gate_max_tool_steps === 'number' && partial.gate_max_tool_steps >= 0) {
      this.settings.gate_max_tool_steps = Math.max(0, Math.min(30, Math.floor(partial.gate_max_tool_steps)));
    }
    if (typeof partial.gate_budget_seconds === 'number' && partial.gate_budget_seconds >= 5) {
      this.settings.gate_budget_seconds = Math.max(5, Math.min(900, Math.floor(partial.gate_budget_seconds)));
    }
    if (typeof partial.library_enabled === 'boolean') this.settings.library_enabled = partial.library_enabled;
    if (typeof partial.agent_self_write === 'boolean') this.settings.agent_self_write = partial.agent_self_write;
    this.applyToolToggles();
    void this.refreshPluginTools();
    void this.reloadExtensions();
    void this.refreshMcpServers();
    void this.refreshPluginSkills();
  }

  getSettings(): Readonly<Required<AgentSettings>> {
    return { ...this.settings };
  }

  /**
   * Is this task allowed to skip approvals entirely?
   *
   * The request body used to decide this on its own, which meant the party most
   * likely to be compromised — whatever is submitting tasks — could grant itself
   * blanket permission with one field. Now the request may only ask; the
   * operator's saved setting has to agree.
   *
   * The setting is `always_allow_tools: "*"`, which the settings page documents
   * as "trust every tool for this executor". It is a deliberate, persistent
   * choice made by the person who owns the machine, not a per-request flag.
   */
  /**
   * The directory agent extension plugins are read from.
   *
   * `plugins_dir` when set, otherwise the directory next to this file. Both the
   * bundled plugins and a user's own copy are read, so an operator can drop a
   * plugin into their data directory without touching the install.
   */
  private extensionRoots(): string[] {
    const bundled = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../plugins');
    const configured = this.settings.plugins_dir;
    if (!configured) return [bundled];
    // An absolute path is used as given. A relative one is taken relative to the
    // agent, not to Core — the two processes have different working directories,
    // and silently resolving it against whichever is current is how a plugin
    // ends up installed in one place and read from another.
    return [path.resolve(configured), bundled];
  }

  /**
   * Reload plugins from disk.
   *
   * Re-reading rather than restarting is the point: editing a plugin's prompt
   * and sending another message should be enough to see the change. Tools are
   * re-registered in the same pass, so a removed plugin's tools disappear too.
   */
  async reloadExtensions(): Promise<void> {
    const enabled = this.settings.plugins_enabled
      ? new Set(this.settings.plugins_enabled.split(',').map((name) => name.trim()).filter(Boolean))
      : null;
    const host = new PluginHost(this.extensionRoots(), enabled);
    await host.load();
    // Tools from the previous generation are removed before the new ones land,
    // or a plugin that dropped a tool would keep answering for it.
    for (const name of this.pluginExtensionTools) this.tools.unregister(name);
    this.pluginExtensionTools = [];
    for (const { plugin, spec } of host.toolImplementations()) {
      this.tools.register(toRegistryTool(plugin, spec));
      this.pluginExtensionTools.push(spec.name);
    }
    this.extensions = host;
  }

  /** What settings shows: the plugins that actually loaded, and why the rest did not. */
  extensionReport(): { plugins: any[]; errors: any[]; hiddenTools: string[]; promptBytes: number } {
    if (!this.extensions) return { plugins: [], errors: [], hiddenTools: [], promptBytes: 0 };
    const report = this.extensions.describe();
    return {
      plugins: report.plugins,
      errors: report.errors,
      hiddenTools: [...this.extensions.hiddenTools()],
      promptBytes: this.extensions.promptBlock().length,
    };
  }

  private fullAccessGranted(context: AgentContext): boolean {
    if (context.options.permission_mode !== 'full_access') return false;
    const blanket = (this.settings.always_allow_tools || '')
      .split(',')
      .map((entry) => entry.trim())
      .some((entry) => entry === '*');
    if (!blanket) return false;
    return true;
  }

  private autoApproved(tool: string): boolean {
    if (!tool) return false;
    const allowed = this.settings.always_allow_tools
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    // "*" is the documented "trust every tool" value; without this branch it
    // matched no tool name and silently did nothing.
    return allowed.includes('*') || allowed.includes(tool);
  }

  private readOnlyComputerUse(tool: string, args: Record<string, any>): boolean {
    return tool === 'computeruse' && ['screenshot', 'listwindows'].includes(String(args?.action || ''));
  }

  private applyToolToggles(): void {
    this.tools = createDefaultRegistry(this.skills);
    if (!this.settings.self_evolve_enabled) {
      for (const name of ['evolve_begin', 'evolve_commit', 'evolve_upstream', 'evolve_finish']) this.tools.unregister(name);
    }
    if (!this.settings.enable_filesystem_tool) {
      for (const name of ['read', 'write', 'edit', 'apply_patch', 'glob', 'grep']) this.tools.unregister(name);
    }
    if (!this.settings.enable_shell_tool) {
      this.tools.unregister('bash');
    }
    if (!this.settings.enable_web_tools) for (const name of ['webfetch', 'websearch', 'papersearch', 'apidocsearch']) this.tools.unregister(name);
    if (!this.settings.enable_computer_use) this.tools.unregister('computeruse');
    if (!this.settings.enable_browser_tool) this.tools.unregister('browser');
    if (!this.settings.enable_document_tool) this.tools.unregister('document');
    if (!this.settings.enable_slides_tool) this.tools.unregister('slides');
    if (!this.settings.enable_mcp_tool) this.tools.unregister('mcp');
    if (!this.settings.enable_task_tool) this.tools.unregister('task');
    if (!this.settings.enable_skills) this.tools.unregister('skill');
    if (resolveGateMode(this.settings.gate_mode) === 'off') { this.tools.unregister('intent'); this.tools.unregister('fact'); }
  }

  private async refreshPluginTools(): Promise<void> {
    for (const name of this.pluginToolNames) this.tools.unregister(name);
    this.pluginToolNames.clear();
    this.pluginToolReport = { registered: [], renamed: [], skipped: [] };
    if (!this.settings.enable_plugin_tools) return;
    let defs: Array<any> = [];
    try {
      defs = await listPluginTools('agent');
    } catch (error: any) {
      this.pluginToolReport.error = error?.message || String(error);
      return;
    }
    const plan = planPluginTools(defs, this.tools.names());
    for (const entry of plan.register) {
      this.tools.register(new PluginTool({ ...entry.def, plugin: entry.def.plugin || 'plugin', name: entry.name, call: entry.declared }));
      this.pluginToolNames.add(entry.name);
      this.pluginToolReport.registered.push(entry.name);
      if (entry.renamed) this.pluginToolReport.renamed.push(`${entry.declared} -> ${entry.name}`);
    }
    this.pluginToolReport.skipped = plan.skipped;
    // A tool that could not be registered is a visible hole in the model's
    // toolbox, so say why rather than leaving it to be discovered.
    for (const skip of plan.skipped) {
      console.warn(`[plugin-tools] skipped ${skip.plugin}:${skip.declared}: ${skip.reason}`);
    }
  }

  /**
   * Refresh plugin tools at most once a minute.
   *
   * A plugin that starts after the agent did used to contribute nothing until
   * the agent restarted. Refreshing on the way into a task fixes that without a
   * timer that would keep the process awake.
   */
  private async maybeRefreshPluginTools(): Promise<void> {
    const now = Date.now();
    if (now - this.lastPluginToolRefresh < 60_000) return;
    this.lastPluginToolRefresh = now;
    try {
      await this.refreshPluginTools();
    } catch (error: any) {
      this.pluginToolReport.error = error?.message || String(error);
    }
  }

  private async refreshMcpServers(): Promise<void> {
    const servers: McpServerConfig[] = [];
    try {
      const res = await coreFetch(`${CORE_HTTP}/api/settings/mcp`, { headers: coreHeaders(), signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const data: any = await res.json();
        const raw = data?.values?.servers;
        if (typeof raw === 'string' && raw.trim()) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) servers.push(...(parsed as McpServerConfig[]));
        }
      }
    } catch { }
    try {
      const res = await coreFetch(`${CORE_HTTP}/api/plugins/capabilities`, { headers: coreHeaders(), signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const caps: any = await res.json();
        const seen = new Set(servers.map((server) => server.id));
        for (const entry of caps?.mcp_servers || []) {
          const config = entry?.config as McpServerConfig | undefined;
          if (config?.id && !seen.has(config.id)) { servers.push(config); seen.add(config.id); }
        }
      }
    } catch { }
    if (servers.length) {
      try {
        this.mcp.configure(servers);
      } catch (error: any) {
        console.warn('[Agent] MCP configure rejected a server config:', error.message);
      }
      void this.mcp.refresh().catch((error) => console.warn('[Agent] MCP refresh failed:', error.message));
    }
  }

  private async refreshPluginSkills(): Promise<void> {
    if (!this.settings.enable_skills) return;
    try {
      const res = await coreFetch(`${CORE_HTTP}/api/plugins/capabilities`, { headers: coreHeaders(), signal: AbortSignal.timeout(8000) });
      if (!res.ok) return;
      const caps: any = await res.json();
      for (const skill of caps?.skills || []) {
        if (!skill?.path) continue;
        try { this.skills.loadDir(skill.path); } catch { }
      }
    } catch { }
  }

  async executeTask(taskId: string, prompt: string, agentType?: string, metadata: Record<string, string> = {}): Promise<string> {
    return this.executeTaskInternal(taskId, prompt, agentType, 0, metadata.session_id || '', metadata);
  }

  private isTextAttachment(name: string, mime: string): boolean {
    if (mime.startsWith('text/')) return true;
    if (['application/json', 'application/xml', 'application/javascript', 'application/x-yaml', 'application/yaml', 'application/toml'].includes(mime)) return true;
    return /\.(txt|md|markdown|json|ya?ml|toml|csv|tsv|log|py|js|mjs|cjs|ts|tsx|jsx|vue|go|rs|java|kt|c|h|cc|cpp|hpp|cs|rb|php|sh|ps1|bat|cmd|html?|css|scss|xml|ini|cfg|conf|sql|env)$/i.test(name);
  }

  private isImageAttachment(name: string, mime: string): boolean {
    return mime.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp)$/i.test(name);
  }

  private async collectAttachments(raw: string, signal: AbortSignal, taskId: string): Promise<{ text: string; images: MessagePart[] }> {
    let refs: Array<{ name?: string; url?: string; mime?: string }> = [];
    try { refs = JSON.parse(raw); } catch { return { text: '', images: [] }; }
    if (!Array.isArray(refs) || refs.length === 0) return { text: '', images: [] };
    const lines: string[] = [];
    const images: MessagePart[] = [];
    const dropDir = path.join(os.tmpdir(), '0kay-attachments', String(taskId).replace(/[^\w.-]/g, '_'));
    const base = coreHttpBase();
    const baseOrigin = new URL(base).origin;
    for (const ref of refs) {
      const url = String(ref?.url || '');
      if (!url) continue;
      const name = String(ref?.name || path.basename(url.split('?')[0]));
      const mime = String(ref?.mime || '');
      let absolute = '';
      try {
        const resolved = new URL(url, base);
        if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') throw new Error('not an http(s) URL');
        if (resolved.origin !== baseOrigin) throw new Error('host is not the Core service');
        absolute = resolved.toString();
      } catch (error: any) {
        console.warn(`[Agent] rejected attachment URL '${url}': ${error?.message || error}`);
        lines.push(`- ${name || url} (attachment rejected: ${error?.message || 'invalid URL'})`);
        continue;
      }
      try {
        const headers = new URL(absolute).origin === baseOrigin ? coreHeaders() : {};
        const response = await coreFetch(absolute, { headers, signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const bytes = Buffer.from(await response.arrayBuffer());
        const size = `${bytes.length} bytes`;
        if (this.isImageAttachment(name, mime)) {
          const type = mime || 'image/png';
          images.push({ type: 'image', imageUrl: `data:${type};base64,${bytes.toString('base64')}`, mimeType: type });
          lines.push(`- ${name} (image attached to this turn)`);
          continue;
        }
        if (this.isTextAttachment(name, mime)) {
          const head = bytes.length > 200_000 ? bytes.subarray(0, 200_000).toString('utf8') : bytes.toString('utf8');
          const clipped = head.length > 12000 ? `${head.slice(0, 12000)}\n…(truncated)` : head;
          lines.push(`- ${name} (${mime || 'text'}, ${size}):\n\`\`\`\n${clipped}\n\`\`\``);
          continue;
        }
        const saved = await this.materializeAttachment(dropDir, name, bytes);
        const where = saved ? ` saved at ${saved}` : '';
        const label = `${mime || 'application/octet-stream'}, ${size}`;
        if (isDocumentAttachment(name, mime)) {
          const { text, note } = await extractDocumentText(saved || name, name, mime, bytes);
          if (text) {
            const clipped = text.length > 12000 ? `${text.slice(0, 12000)}\n…(truncated)` : text;
            lines.push(`- ${name} (${label})${where}. Extracted text:\n\`\`\`\n${clipped}\n\`\`\``);
          } else {
            lines.push(`- ${name} (${label})${where}. ${note || 'no text could be extracted'}; open it with a tool if the content matters.`);
          }
          continue;
        }
        lines.push(`- ${name} (${label})${where}. Binary file; use a tool on the saved path if its content matters.`);
      } catch (error: any) {
        if (signal.aborted) throw error;
        lines.push(`- ${url} (download failed: ${error?.message || error})`);
      }
    }
    return { text: lines.join('\n'), images };
  }

  private async materializeAttachment(dir: string, name: string, bytes: Buffer): Promise<string> {
    const safe = path.basename(name).replace(/[<>:"|?*\x00-\x1f]/g, '_').replace(/^\.+/, '').trim() || 'attachment';
    try {
      await mkdir(dir, { recursive: true });
      const target = path.join(dir, safe);
      await writeFile(target, bytes);
      return target;
    } catch (error: any) {
      console.warn(`[Agent] could not save attachment '${name}': ${error?.message || error}`);
      return '';
    }
  }

  private historyHasImages(messages: Message[]): boolean {
    return messages.some((message) => (message.parts || []).some((part) => part.type === 'image'));
  }

  private async *generateWithVisionFallback(request: GenerateRequest): AsyncGenerator<GenerateResponse> {
    try {
      yield* this.mocr.generate(request);
    } catch (error: any) {
      const vision = this.settings.vision_model;
      const message = String(error?.message || error);
      if (vision && vision !== request.modelId && this.historyHasImages(request.messages) && /image|vision|multimodal|modality|unsupported content|invalid content|content type|图片|不支持/i.test(message)) {
        console.warn(`[Agent] vision fallback ${request.modelId} -> ${vision}: ${message}`);
        yield* this.mocr.generate({ ...request, modelId: vision });
        return;
      }
      throw error;
    }
  }

  private async toolLlm(request: import('../tools/types.js').LlmRequest, context: { taskId: string; sessionId: string; signal?: AbortSignal }): Promise<string | null> {
    const modelId = this.activeModel || this.settings.model_id || '';
    const messages = request.messages.map((message) => ({
      role: message.role,
      content: message.content,
      ...(message.parts?.length ? { parts: message.parts.map((part) => ({ type: part.type, text: part.text, imageUrl: part.imageUrl, mimeType: part.mimeType })) } : {}),
    }));
    let text = '';
    try {
      for await (const chunk of this.mocr.generate({
        modelId: request.model || modelId,
        messages,
        systemPrompt: request.systemPrompt,
        maxTokens: request.maxTokens,
        temperature: request.temperature,
        tools: [],
        toolChoice: 'none',
        signal: context.signal,
        taskId: context.taskId,
        sessionId: context.sessionId,
      })) text += chunk.chunk || '';
      return text || null;
    } catch (error: any) {
      console.warn(`[Agent] tool model call failed: ${error?.message || error}`);
      return null;
    }
  }

  private thinkingDirective(intensity: string, difficultyHint: number): string {
    const level = intensity === 'off' || difficultyHint <= 0
      ? 'none'
      : difficultyHint <= 0.25 ? 'low'
      : difficultyHint < 0.7 ? 'medium'
      : difficultyHint < 1 ? 'high' : 'max';
    switch (level) {
      case 'none':
        return 'Thinking budget: minimal. Do not narrate your reasoning; answer directly and concisely.';
      case 'low':
        return 'Thinking budget: low. Think briefly, then answer; keep the reasoning short and skip exhaustive analysis.';
      case 'medium':
        return 'Thinking budget: medium. Think the problem through at a normal depth before answering.';
      case 'high':
        return 'Thinking budget: high. Reason thoroughly before answering: break the problem down, weigh alternatives, check edge cases, and verify your conclusion. In your reasoning, work through at least 4 distinct steps.';
      default:
        return 'Thinking budget: maximum. Reason as deeply as possible before answering: explore multiple angles, consider counter-examples and alternative approaches, and validate the conclusion. In your reasoning, work through at least 6 distinct steps.';
    }
  }

  private estimateTokens(messages: Message[]): number {
    let text = '';
    let images = 0;
    for (const message of messages) {
      text += message.content + JSON.stringify(message.toolCalls || []);
      for (const part of message.parts || []) {
        if (part.type === 'image') images += 1;
        else text += part.text || '';
      }
    }
    return estimateTextTokens(text) + images * 850;
  }

  private looksContextOverflow(error: any): boolean {
    return /context length|context_length|maximum context|max context|too long|token limit|too many tokens|reduce the length|exceeds? the maximum|上下文|超出/i.test(String(error?.message || error));
  }

  private static readonly SUMMARY_MARKER = '[context summary]';

  /** The summary produced by an earlier compaction, if any. */
  private existingSummary(context: AgentContext): string {
    for (const message of context.history) {
      if (message.role !== 'assistant' || typeof message.content !== 'string') continue;
      if (message.content.startsWith(Agent.SUMMARY_MARKER)) {
        return message.content.slice(Agent.SUMMARY_MARKER.length).trim();
      }
    }
    return '';
  }

  private async compactHistory(context: AgentContext, modelId: string, sessionId: string, _policy?: CompactPolicy): Promise<void> {
    if (context.history.length <= 3) return;
    // Keep the tail verbatim: after a fold the model still needs to see the tool
    // calls it was in the middle of, otherwise it restarts the work it just did.
    const keepTail = Math.max(2, Math.min(6, Math.round(context.history.length * 0.2)));
    const cut = Math.max(1, context.history.length - keepTail);
    const folded = context.history.slice(1, cut);
    if (folded.length === 0) return;
    const tail = context.history.slice(cut);

    const transcript = JSON.stringify(folded.map(({ parts, ...rest }) =>
      parts?.length ? { ...rest, content: `${rest.content}\n[${parts.filter(p => p.type === 'image').length} image attachment(s) omitted]` } : rest));

    // Re-summarising from scratch loses the early decisions that a previous
    // summary already captured. Merge into it instead.
    const previous = this.existingSummary(context);
    const prompt = previous
      ? `${COMPACTION_SCHEMA_PROMPT}\n\nAn earlier summary of this session already exists. Preserve every fact it states (decisions, file paths, commands, errors, open todos) and merge the new messages into it. Do not drop detail to make room.\n\nEARLIER SUMMARY:\n${previous}\n\nNEW MESSAGES:\n${transcript}`
      : `${COMPACTION_SCHEMA_PROMPT}\n\nMESSAGES:\n${transcript}`;

    // Compaction is one-shot, tool-free summarisation. Running it on the main
    // model is the most expensive per-token path in the session and it evicts
    // the conversation's prefix cache; a configured cheap model avoids both.
    const compactModel = this.settings.compaction_model || modelId;
    let summary = '';
    for await (const chunk of this.mocr.generate({ modelId: compactModel, messages: [{ role: 'user', content: prompt }], systemPrompt: COMPACTION_SCHEMA_PROMPT, tools: [], toolChoice: 'none', signal: context.signal, taskId: context.taskId, sessionId, maxTokens: 5000 })) summary += chunk.chunk || '';
    if (!summary.trim()) throw new Error('Context compaction returned no summary');

    const todoBlock = formatTodoList(context.todo);
    context.history = [
      context.history[0],
      { role: 'assistant', content: `${Agent.SUMMARY_MARKER} ${summary.trim()}${todoBlock ? `\n\n${todoBlock}` : ''}` },
      ...tail,
    ];
  }

  private async executeTaskInternal(taskId: string, prompt: string, agentType: string | undefined, depth: number, sessionId: string, options: Record<string, string> = {}): Promise<string> {
    const type = (agentType && agentType !== 'default' ? agentType : this.settings.default_agent_type) || 'general';
    let forceSkill = '';
    if (this.settings.enable_skills) {
      const slash = /^\s*\/([A-Za-z0-9_-]{1,64})(?:\s+([\s\S]*))?$/.exec(prompt);
      if (slash && this.skills.get(slash[1])) {
        forceSkill = slash[1];
        const rest = (slash[2] || '').trim();
        prompt = rest || `Follow the "${forceSkill}" skill to produce the standard output for this request.`;
      }
      if (!forceSkill && type && type !== 'general' && this.skills.get(type)) forceSkill = type;
    }
    this.taskManager.createTask(taskId, prompt, type);
    // Not awaited: refreshing must never delay the task reaching RUNNING. The
    // tool list this task sees is the one from the previous refresh.
    void this.maybeRefreshPluginTools();
    return this.taskManager.executeTask(taskId, async () => {
      let workdir = options.workdir;
      const workspaceSelector = options.workspace || options.project;
      if (!workdir && workspaceSelector) workdir = await this.resolveWorkspacePath(String(workspaceSelector));
      const cwd = workdir ? path.resolve(workdir) : process.cwd();
      allowTaskRoot(cwd);
      if (!(await stat(cwd)).isDirectory()) throw new Error(`Workspace is not a directory: ${cwd}`);
      const sessionId = String(options.session_id || '');
      if (sessionId) {
        const owner = await this.workspaces.resolveByPath(cwd).catch(() => undefined);
        if (owner) await owner.attachSession(sessionId, cwd).catch(() => { });
      }
      const signal = this.taskManager.signal(taskId);
      let initialParts: MessagePart[] | undefined;
      if (options.attachments) {
        const { text, images } = await this.collectAttachments(options.attachments, signal, taskId);
        if (text) prompt += `\n\nAttachments: the user uploaded these files. Text is extracted below where the format allows it, and every file is saved at the path shown — read it with a tool if you need the raw bytes.\n${text}`;
        if (images.length) initialParts = [{ type: 'text', text: prompt }, ...images];
      }
      const context: AgentContext = {
        taskId,
        prompt,
        history: [initialParts ? { role: 'user', content: '', parts: initialParts } : { role: 'user', content: prompt }],
        todo: [],
        signal,
        sessionId,
        cwd,
        options: forceSkill ? { ...options, force_skill: forceSkill } : options,
      };
      if (depth === 0) {
        try { await ensureAgentWorkspace(cwd) } catch { }
      }
      context.ledger = new ContextLedger(() => context.history);
      const supervisor = new DeliverySupervisor();
      const gateMode = (process.env.OKAY_EVIDENCE_GATE || '').trim().toLowerCase();
      const runtimeDirectives = [
        gateMode && gateMode !== '0' ? supervisionDirective() : '',
        postureDirective(resolvePosture(options.posture || process.env.OKAY_POSTURE)),
      ].filter(Boolean).join('\n\n');

      // --- USER MESSAGE -> LIBRARY -> MODEL ---------------------------------
      // The library runs before the first model call: it classifies the turn,
      // learns from a correction, and produces the rule block the loop injects.
      // Sub-agents inherit the parent's block instead of re-classifying.
      let libraryBlock = '';
      let turnKind: 'chat' | 'task' = 'task';
      if (depth === 0) {
        try {
          const verdict = await prepareTurn(cwd, context.prompt, [
            `Workspace: ${cwd}`,
            ...(options.session_title ? [`Session: ${options.session_title}`] : []),
          ]);
          libraryBlock = verdict.injection;
          turnKind = verdict.kind;
          context.library = libraryFor(cwd);
          agentEvents.emit({
            type: 'task.started',
            taskId, sessionId, at: Date.now(),
            data: {
              kind: verdict.kind,
              reason: verdict.reason,
              rules: verdict.rules.map((rule) => rule.text),
              learned: verdict.learned?.text || '',
              workspace: cwd,
            },
          });
        } catch (error: any) {
          console.warn('[Agent] library stage failed; continuing without injected rules:', error?.message);
        }
      } else if (options.library_block) {
        libraryBlock = options.library_block;
      }

      // --- the gate and the two task-scoped stores --------------------------
      // Reviewers are expensive, so a chat turn gets no gate at all: there is no
      // work to check, and a "hello" that returns a reject is worse than no gate.
      const selfWrites = options.agent_self_write === '1' || this.settings.agent_self_write;
      const gateModeSetting: GateMode = turnKind === 'chat' ? 'off' : resolveGateMode(
        options.gate_mode || this.settings.gate_mode,
        'full',
      );
      const gate = new QualityGate({
        settings: {
          mode: gateModeSetting,
          reviewerModel: options.reviewer_model || this.settings.reviewer_model,
          maxRejects: Number(options.gate_max_rejects) || this.settings.gate_max_rejects,
          maxToolSteps: Number.isFinite(Number(options.gate_max_tool_steps)) ? Number(options.gate_max_tool_steps) : this.settings.gate_max_tool_steps,
          budgetMs: (Number(options.gate_budget_seconds) || this.settings.gate_budget_seconds) * 1000,
        },
        events: agentEvents,
      });
      context.gate = gate;
      context.facts = new FactMemory();
      context.permissions = new PermissionLedger(cwd, { allowAgentSelfWrite: selfWrites });
      steering.open(taskId);
      // Plugins see the task before it starts. A plugin that wants to add a rule
      // for the duration of one task does it here; the hook budget resets, so a
      // long session cannot accumulate against a previous task's count.
      if (depth === 0 && this.extensions) {
        this.extensions.startTask();
        await this.extensions.taskStart({ prompt: context.prompt, cwd, taskId, sessionId: context.sessionId });
      }
      const gateDirective = gate.directive();
      if (depth === 0 && gateModeSetting !== 'off') {
        void this.recordIntentState(context, gate);
      }

      let result = '';
      let lastModel = this.settings.model_id;
      let lastPromptTokens = 0;
      let gateBlocks = 0;
      /** How many turns were cut short by the token ceiling in this task. */
      let truncatedTurns = 0;
      let humanTakeover = false;

      try {
        const note = await this.workspaceContext(cwd);
        if (note) context.options.workspace_note = note;
      } catch { }

      const multiAgentMode = resolveMode(options.multi_agent_mode);
      if (type === EXPLORE_AGENT_TYPE && depth === 0 && options.skip_explore !== '1') {
        const baseType = options.base_agent_type || 'code';
        if (multiAgentMode.readOnly) context.options.read_only_tools = '1';
        const proposals = await this.exploreSolutions(context, taskId, context.prompt, baseType, multiAgentMode);
        context.history.push({ role: 'user', content: this.explorationDigest(proposals, multiAgentMode) });
      }

      const intMatch = /\[thinking_intensity=(\w+)\]/i.exec(context.prompt)
      const intensity = (options.thinking_intensity || intMatch?.[1] || 'medium').toLowerCase()
      const numericIntensity=Number(intensity)
      const difficultyHint = Number.isFinite(numericIntensity) ? Math.max(0,Math.min(100,numericIntensity))/100 : ({ off:0, low: 0.2, medium: 0.5, high: 0.75, max: 1.0 }[intensity] ?? 0.5)
      const requireThinking = intensity !== 'off' && difficultyHint > 0
      const minimal = options.minimal_mode === '1' || (options.minimal_mode !== '0' && this.settings.minimal_mode);
      const maxTokens = Math.max(4096, Math.round(difficultyHint * 32768))

      const duet = options.duet_mode === '1' || (options.duet_mode !== '0' && this.settings.duet_mode);
      const userPinnedModel = !!(options.model_id && options.model_id !== 'MOCR') || !!this.settings.model_id;
      let duetOutputModel = '';
      if (duet && !userPinnedModel) {
        try {
          const pair = await this.mocr.chooseModelPair(context.prompt, requireThinking, difficultyHint, context.signal);
          let planText = '';
          for await (const chunk of this.mocr.generate({
            modelId: pair.thinkModel,
            messages: [{ role: 'user', content: DUET_PLAN_USER_PROMPT + '\n\nTask:\n' + context.prompt }],
            systemPrompt: DUET_PLAN_SYSTEM_PROMPT,
            tools: [], toolChoice: 'none', signal: context.signal,
            taskId: context.taskId, sessionId: context.sessionId,
            maxTokens: Math.max(4096, maxTokens),
          })) planText += chunk.chunk || '';
          const impl = /<implementation_prompt>([\s\S]*?)<\/implementation_prompt>/i.exec(planText);
          const implPrompt = (impl ? impl[1] : planText).trim();
          if (!implPrompt) throw new Error('duet plan phase returned no implementation prompt');
          context.history.push(
            { role: 'assistant', content: planText.trim() },
            { role: 'user', content: DUET_IMPLEMENT_USER_PROMPT },
          );
          duetOutputModel = pair.outputModel;
        } catch (e: any) {
          if (context.signal.aborted) throw e;
          console.warn('[Agent] duet plan phase failed; continuing with the normal loop:', e?.message);
        }
      }

      for (let i = 0; ; i++) {
        context.signal.throwIfAborted();
        if (i >= MAX_LOOP_ITERATIONS) {
          throw new Error(`Agent loop exceeded ${MAX_LOOP_ITERATIONS} iterations without finishing`);
        }
        let modelId = options.model_id === 'MOCR' ? '' : options.model_id || this.settings.model_id;
        if (!modelId && duetOutputModel) modelId = duetOutputModel;
        if (!modelId) {
          modelId = await this.mocr.chooseModels(
            context.prompt,
            requireThinking,
            difficultyHint,
            context.signal,
          );
        }
        lastModel = modelId;
        this.activeModel = modelId;

        // Resolve the window from the cheapest source that knows it: the
        // operator's setting, then the provider, then the model name. The old
        // code only asked the provider when the setting was 0 and otherwise
        // never compacted at all, so a fresh install ran until the upstream
        // returned a 400.
        let providerWindow = 0;
        if (!this.settings.context_window && typeof (this.mocr as any).modelContextLength === 'function') {
          providerWindow = await this.mocr.modelContextLength(modelId, context.signal).catch(() => 0);
        }
        const windowInfo = inferContextWindow(modelId, this.settings.context_window || 0, providerWindow);
        const contextLimit = windowInfo.tokens;
        const compactThresholds = compactPolicy(modelId);
        const usedTokens = lastPromptTokens || this.estimateTokens(context.history);
        const tier = decideCompactTier(usedTokens, contextLimit, compactThresholds);
        this.lastContext = { used: usedTokens, window: contextLimit, tier, source: windowInfo.source };
        if (tier === 'compact' || tier === 'reactive' || tier === 'ceiling') {
          await this.compactHistory(context, modelId, context.sessionId, compactThresholds);
          lastPromptTokens = 0;
        }

        const todoBlock = formatTodoList(context.todo);
        // The intent ledger and the recall block change on the model's own
        // action, so they sit outside the cached prefix for the same reason the
        // todo list does: they change without the prompt changing.
        const intentBlock = gate.ledger.promptBlock();
        const factBlock = context.facts?.promptBlock() || '';
        // Plugin text sits outside the cached prefix for the same reason the
        // todo list does: a plugin's beforeModelCall hook changes it per turn.
        const extensionBlock = this.extensions?.promptBlock() || '';
        const turnExtension = this.extensions
          ? await this.extensions.beforeModelCall({ iteration: i + 1, model: modelId })
          : '';

        // The quiet moment: the previous tool results are in, the next turn is
        // not chosen. Anything the user said meanwhile lands here, as one turn.
        this.applySteering(context);

        let fullResponse = '';
        let finalText = '';
        let fullReasoning = '';
        let receivedNativeCalls = false;
        // The cacheable prefix is the base system prompt plus the tool schemas.
        // The iteration counter and todo list below are deliberately outside it:
        // they change every step, and putting them in the prefix would throw the
        // provider's cache away on every single request.
        const requestTools = [...this.tools.listTools(this.toolVisible(context.taskId)),{name:'question',description:'Ask the user a question with suggested options and a free-text answer.',parameters:{type:'object',required:['question'],properties:{question:{type:'string'},options:{type:'array',items:{type:'string'}}}}}];
        const baseSystem = this.getSystemPrompt(context.prompt, context.cwd, context.options.force_skill || '', minimal, context.taskId);
        const prefix = trackSessionPrefix(context.sessionId, prefixHash({ system: baseSystem, tools: requestTools }));
        if (context.ledger) context.ledger.prefixChanged = prefix.changed;
        try {
        for await (const chunk of this.generateWithVisionFallback({
          modelId,
          messages: context.history,
          systemPrompt: baseSystem
            + (minimal
              ? `\nPreferred UI language: ${options.language === 'en' ? 'English' : 'Chinese'}. Iteration ${i + 1}. Continue until complete or cancelled. Ask the user with question when blocked; do not repeat failing actions without new evidence. ${this.thinkingDirective(intensity, difficultyHint)}\n\n${this.minimalDirective(options.language)}`
              : `\nPreferred UI language: ${options.language === 'en' ? 'English' : 'Chinese'}. Match the user language in progress, questions and replies.\nIteration ${i + 1}. Continue until complete or cancelled. Ask the user with question when blocked; do not repeat failing actions without new evidence. ${this.thinkingDirective(intensity, difficultyHint)}`)
            + (runtimeDirectives ? '\n\n' + runtimeDirectives : '')
            + (todoBlock ? `\n\n${todoBlock}` : '') + (context.options.workspace_note ? `\n\nWorkspace context:\n${context.options.workspace_note}` : '')
            + (gateDirective ? `\n\n${gateDirective}` : '')
            + (intentBlock ? `\n\n${intentBlock}` : '')
            + (factBlock ? `\n\n${factBlock}` : '')
            + (extensionBlock ? `\n\n${extensionBlock}` : '')
            + (turnExtension ? `\n\n${turnExtension}` : ''),
          temperature: this.settings.temperature,
          thinking: requireThinking,
          difficultyHint,
          requireThinking,
          maxTokens,
          tools: requestTools,
          toolChoice: 'auto',
          signal: context.signal,
          taskId: context.taskId,
          sessionId: context.sessionId,
        })) {
          if (chunk.chunk) {
            fullResponse += chunk.chunk;
          }
          if (chunk.thinkingContent) {
            fullReasoning += chunk.thinkingContent;
          }
          if (chunk.usage && Number(chunk.usage.promptTokens) > 0) {
              lastPromptTokens = Number(chunk.usage.promptTokens);
            if (context.sessionId) trackSessionPromptTokens(context.sessionId, lastPromptTokens);
              if (context.ledger) context.ledger.lastPromptTokens = lastPromptTokens;
          }
          if (chunk.done) {
            // A length stop is a truncated answer, not a failed one. Throwing
            // here ended the task with the reasoning block frozen mid-sentence,
            // which is what "思维链卡住" looks like from the outside. The partial
            // turn is kept and the loop asks for the rest.
            if (chunk.finishReason === 'FINISH_REASON_LENGTH') truncatedTurns += 1;
            if (chunk.finishReason === 'FINISH_REASON_ERROR' || chunk.finishReason === 'FINISH_REASON_CONTENT_FILTER') {
              throw new Error(`Model generation stopped: ${chunk.finishReason}`);
            }
            if (chunk.text) finalText = chunk.text;
            const nativeCalls = chunk.toolCalls || [];
            if (nativeCalls.length) {
              receivedNativeCalls = true;
              context.history.push({
                role: 'assistant',
                content: finalText || fullResponse,
                toolCalls: nativeCalls,
                reasoningContent: fullReasoning || undefined,
              });
              const settled = await Promise.allSettled(nativeCalls.map(toolCall => this.executeToolCall(toolCall, context, type, depth)));
              const desktopImages: MessagePart[] = [];
              for (let idx = 0; idx < nativeCalls.length; idx++) {
                const toolCall = nativeCalls[idx];
                const item = settled[idx];
                if (item.status === 'rejected') throw item.reason;
                const toolResult = item.value;
                supervisor.recordToolCall(toolCall.name, toolCall.arguments, toolResult.success);
                this.emitToolEvent(context, toolCall.name, toolCall.arguments, toolResult, Date.now());
                if (toolCall.name === 'finish' && toolResult.success) {
                  const output = toolResult.data?.output || 'Task completed';
                  const ruleGate = this.gateFinish(output, supervisor);
                  if (ruleGate.blocked && gateBlocks < 3) {
                    gateBlocks++;
                    context.history.push({ role: 'tool', toolCallId: toolCall.id, content: JSON.stringify({ success: true, data: { output: ruleGate.message } }) });
                    break;
                  }
                  const gateOutcome = await this.runGate(context, gate, supervisor, output, toolCall.id);
                  if (!gateOutcome.pass) {
                    // The reviewer's verdict goes back as the tool's response,
                    // never as a user-facing message: the loop keeps the thread.
                    context.history.push({ role: 'tool', toolCallId: toolCall.id, content: JSON.stringify({ success: true, data: gateOutcome.payload }) });
                    if (gateOutcome.exhausted) { humanTakeover = true; result = this.takeoverMessage(gateOutcome.payload, output); }
                    break;
                  }
                  result = this.reviewedResult(output, gateOutcome.payload);
                  await completeProgress(context.taskId, context.sessionId);
                  break;
                }
                context.history.push({
                  role: 'tool',
                  toolCallId: toolCall.id,
                  content: JSON.stringify(this.desktopResult(toolCall.name, toolResult, desktopImages)),
                });
              }
              if (desktopImages.length) context.history.push({ role: 'user', content: '', parts: desktopImages });
              if (result) break;
            }
            break;
          }
        }
        } catch (error: any) {
          if (this.looksContextOverflow(error) && context.history.length > 2) {
            await this.compactHistory(context, modelId, context.sessionId);
            lastPromptTokens = 0;
            continue;
          }
          throw error;
        }

        if (result) break;
        if (receivedNativeCalls) continue;
        const toolCall = this.parseToolCall(finalText || fullResponse);
        if (toolCall) {
          const toolResult = await this.executeToolCall({ id: `fallback_${i}`, name: toolCall.name, arguments: JSON.stringify(toolCall.args) }, context, type, depth);
          supervisor.recordToolCall(toolCall.name, JSON.stringify(toolCall.args), toolResult.success);
          this.emitToolEvent(context, toolCall.name, JSON.stringify(toolCall.args), toolResult, Date.now());
          context.history.push({ role: 'assistant', content: finalText || fullResponse, toolCalls: [{ id: `fallback_${i}`, name: toolCall.name, arguments: JSON.stringify(toolCall.args) }], reasoningContent: fullReasoning || undefined });
          const desktopImages: MessagePart[] = [];
          context.history.push({ role: 'tool', toolCallId: `fallback_${i}`, content: JSON.stringify(this.desktopResult(toolCall.name, toolResult, desktopImages)) });
          if (desktopImages.length) context.history.push({ role: 'user', content: '', parts: desktopImages });

          if (toolResult.success && toolCall.name === 'finish') {
            const output = toolResult.data?.output || 'Task completed';
            const ruleGate = this.gateFinish(output, supervisor);
            if (ruleGate.blocked && gateBlocks < 3) {
              gateBlocks++;
              context.history.push({ role: 'user', content: ruleGate.message });
              continue;
            }
            const gateOutcome = await this.runGate(context, gate, supervisor, output, `fallback_${i}`);
            if (!gateOutcome.pass) {
              context.history.push({ role: 'user', content: `Review verdict on your finish: ${JSON.stringify(gateOutcome.payload)}` });
              if (gateOutcome.exhausted) { humanTakeover = true; result = this.takeoverMessage(gateOutcome.payload, output); }
              continue;
            }
            result = this.reviewedResult(output, gateOutcome.payload);
            break;
          }
        } else {
          result = finalText || fullResponse;
          break;
        }
      }

      if (!result.trim() || result.startsWith('[mocr offline]')) throw new Error(result || 'Model returned an empty response');
      context.signal.throwIfAborted();
      const caller=String(options.caller_id||'').toLowerCase();
      const lifeCaller=caller==='life'||caller.startsWith('life:')||caller.startsWith('plugin:life');
      if(depth===0&&lifeCaller){
        try {
          let handoff='';
          for await(const chunk of this.mocr.generate({modelId:lastModel,messages:[{role:'user',content:result}],systemPrompt:'Extract the completed task handoff. Return JSON only: {"artifacts":[{"path":"","usage":""}],"outcome":"","limitations":""}. Use only explicit facts from the final result; never invent file paths or success. Keep under 1200 characters.',tools:[],toolChoice:'none',signal:context.signal,taskId,sessionId,maxTokens:600})) handoff+=chunk.chunk||'';
          const parsed=JSON.parse(handoff.replace(/^```(?:json)?\s*|\s*```$/g,''));
          this.handoffs.set(taskId,JSON.stringify(parsed));
          if (this.handoffs.size > 100) {
            const oldest = this.handoffs.keys().next().value;
            if (oldest) this.handoffs.delete(oldest);
          }
        }catch{this.handoffs.set(taskId,JSON.stringify({artifacts:[],outcome:'The task ended but the handoff could not be extracted; see the agent session for details.'}))}
      }
      if (depth === 0 && process.env.OKAY_HANDOFF_DOC === '1') {
        try {
          const doc = buildHandoffDoc({ taskId, prompt: context.prompt, result, status: 'done' });
          const dir = path.join(process.env.AGENT_DATA_DIR || './data/agent', 'handoffs');
          await mkdir(dir, { recursive: true });
          await writeFile(path.join(dir, `${String(taskId).replace(/[^a-zA-Z0-9_.-]/g, '_')}.md`), doc, 'utf8');
        } catch { }
      }
      if (depth === 0) {
        try {
          const outcome = String(result || '').slice(0, 2000);
          await appendAgentNote(cwd, 'memory', `Task: ${String(context.prompt).slice(0, 600)}\nOutcome: ${outcome}`);
          const report = supervisor.report();
          await appendAgentNote(cwd, 'review', `Status: ${report.status}\n${report.reasons.join('\n')}\nEvidence: ${report.evidence.join(', ') || 'none'}`);
          const plan = formatTodoList(context.todo);
          if (plan.trim()) await appendAgentNote(cwd, 'plan', plan);
        } catch { }
      }
      if (gateMode && gateMode !== '0') {
        try {
          const report = supervisor.report();
          await taskRecorder.record({ task_id: context.taskId, caller_id: 'agent', kind: 'delivery-gate', session_id: context.sessionId, state: report.status, result: JSON.stringify(report) });
        } catch { }
      }
      // A turn cut off by the token ceiling is invisible otherwise: the reply
      // just stops. Say so once, at the end, so the reader knows the answer is
      // short because of a limit and not because the agent decided it was done.
      if (truncatedTurns > 0 && result) {
        // English, like every other line the agent writes on its own behalf:
        // this is a note about the tool chain, not localised UI copy.
        result += `

_(Answer truncated by the model's output limit in ${truncatedTurns} place(s). Raise max_tokens, or ask it to continue in parts, for the rest.)_`;
      }
      return result;
    }, depth > 0);
  }

  private async exploreSolutions(context: AgentContext, taskId: string, prompt: string, baseType: string, mode: MultiAgentMode): Promise<Array<{ angle: string; result: string }>> {
    const angles = [
      'Prefer the simplest correct change with the smallest diff.',
      'Prefer robustness: enumerate edge cases and failure modes.',
      'Prefer performance and resource efficiency.',
      "Prefer consistency with this codebase's existing patterns and idioms.",
      'Prefer clarity and maintainability; consider a cleaner alternative design.',
      'Prefer backwards compatibility and the least disruptive migration.',
      'Prefer security: least privilege, input validation, no new attack surface.',
      'Prefer testability: how would this change be verified cheaply and confidently?',
    ];
    const fanout = envCount('OKAY_EXPLORE_FANOUT', mode.fanout, 1, angles.length);
    const timeoutMs = envCount('OKAY_EXPLORE_TIMEOUT_MS', EXPLORE_TIMEOUT_MS, 10_000, 600_000);
    const selected = angles.slice(0, fanout);
    const proposals: Array<{ angle: string; result: string } | undefined> = new Array(selected.length);
    let settled = false;
    const runs = selected.map((angle, index) => {
      const subTaskId = `${taskId}:explore:${index}`;
      const subPrompt = `You are explorer #${index + 1} of ${selected.length}. Produce a concrete solution proposal for the problem below: a short plan, the exact changes (file paths and key code) and why it works. ${angle}\nBe efficient: inspect only the files that matter with targeted read/grep — avoid broad globs — and if the problem is not about this repository, answer directly without exploring it. You run strictly read-only (editing and execution tools are disabled); return a focused proposal, not an implementation.\n\nPROBLEM:\n${prompt}`;
      return this.recorder
        .run('subagent', `explore #${index + 1}`, taskId, context.sessionId,
          () => this.executeTaskInternal(subTaskId, subPrompt, baseType, 1, context.sessionId,
            { ...context.options, skip_explore: '1', read_only_tools: '1', no_subagents: '1' }),
          subTaskId)
        .then((result) => { if (!settled) proposals[index] = { angle, result: String(result || '') }; })
        .catch((error: any) => { if (!settled) proposals[index] = { angle, result: `(exploration failed: ${error?.message || error})` }; });
    });
    const timer = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));
    await Promise.race([Promise.allSettled(runs).then(() => undefined), timer]);
    settled = true;
    for (let i = 0; i < selected.length; i++) {
      if (!proposals[i]) {
        this.taskManager.cancelTask(`${taskId}:explore:${i}`);
        proposals[i] = { angle: selected[i], result: '(exploration timed out)' };
      }
    }
    return proposals.map((proposal) => proposal as { angle: string; result: string });
  }

  private explorationDigest(proposals: Array<{ angle: string; result: string }>, mode: MultiAgentMode): string {
    const blocks = proposals.map((proposal, index) => {
      const text = (proposal.result || '').trim();
      const clipped = text.length > 4000 ? `${text.slice(0, 4000)}\n…(truncated)` : text;
      return `### Candidate ${index + 1} — ${proposal.angle}\n${clipped || '(no output)'}`;
    }).join('\n\n');
    return `${mode.digestLead} (${proposals.length} seats)\n\n${blocks}`;
  }

  private async workspaceContext(cwd: string): Promise<string> {
    const git = async (args: string[]): Promise<string> => {
      try {
        const { stdout } = await execFileAsync('git', args, { cwd, timeout: 4000, maxBuffer: 256 * 1024, windowsHide: true });
        return String(stdout || '').trim();
      } catch {
        return '';
      }
    };
    const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD']);
    if (!branch) return '';
    const [status, log, diff] = await Promise.all([
      git(['status', '--porcelain']),
      git(['log', '--oneline', '-5']),
      git(['diff', '--stat', 'HEAD']),
    ]);
    const lines = [`git branch: ${branch}`, `changed files: ${status ? status.split('\n').filter(Boolean).length : 0}`];
    if (log) lines.push('recent commits:\n' + log);
    if (diff) lines.push('uncommitted diff stat:\n' + diff.split('\n').slice(0, 20).join('\n'));
    return lines.join('\n');
  }

  private minimalDirective(language: string): string {
    const userLang = language === 'en' ? 'English' : 'Chinese';
    return [
      'MINIMAL MODE (strict token economy) — overrides any conflicting instruction above:',
      '1. ALL internal output — reasoning, todos, notes, progress text, tool arguments — in English only and as short as possible. Do not narrate steps, explain changes, or restate the task; emit no assistant text before tool calls.',
      '2. Make the smallest possible change: fewest files, fewest lines, smallest replaceable region (prefer edit over write). No reformatting, renames, drive-by fixes or new comments; reuse existing code and helpers.',
      `3. If information required to start is missing or ambiguous, stop BEFORE doing anything and ask the user one concise question (question tool) in ${userLang}. Never guess.`,
      `4. Only the final answer is written in ${userLang}, and it stays under ~6 lines: what changed (file:line), verification result, blockers. No process summary, no extra suggestions.`,
    ].join('\n');
  }

  /** Groups loaded for a task; `all` disclosure ignores this entirely. */
  private loadedGroups(taskId: string): Set<string> {
    let groups = this.taskGroups.get(taskId)
    if (!groups) {
      groups = new Set(ALWAYS_LOADED)
      this.taskGroups.set(taskId, groups)
    }
    return groups
  }

  private loadGroup(taskId: string, group: string): boolean {
    if (!TOOL_GROUPS[group]) return false;
    this.loadedGroups(taskId).add(group);
    return true;
  }

  /**
   * Which tools appear in the prompt and in the native tool array. A tool that
   * is filtered out here can still be called by name — executeToolCall loads its
   * group on the way through — so this decides what the model is *told*, not
   * what it is allowed to do.
   */
  private toolVisible(taskId: string) {
    // A plugin can hide a tool it replaces, or one this deployment must not use.
    const hidden = this.extensions?.hiddenTools();
    const notHidden = hidden && hidden.size ? (name: string) => !hidden.has(name) : () => true;
    if (this.settings.tool_disclosure === 'all') return notHidden;
    const groups = this.loadedGroups(taskId);
    return (name: string) => notHidden(name) && (isAlwaysLoaded(name) || groups.has(groupOf(name) || ''));
  }

  /**
   * One line per group that is not loaded, so the model knows what exists
   * without paying for its schema. Calling a deferred tool by name still works:
   * executeToolCall loads its group first.
   */
  private deferredIndex(taskId: string): string {
    if (this.settings.tool_disclosure === 'all') return '';
    const loaded = this.loadedGroups(taskId);
    const lines: string[] = [];
    for (const [group, definition] of Object.entries(TOOL_GROUPS)) {
      if (loaded.has(group) || ALWAYS_LOADED.includes(group)) continue;
      const available = definition.tools.filter((name) => this.tools.get(name));
      if (!available.length) continue;
      lines.push(`- ${group} (${available.join(', ')}): ${definition.hint}`);
    }
    if (!lines.length) return '';
    return `\n\nMore tools, not loaded (call one by name and it works; or tools(action:"load", group:"<name>") to add the whole group):\n${lines.join('\n')}`;
  }

  /**
   * One graph per session key, loaded from disk on first touch. Writes go
   * through the store behind the graph's onChange hook, chained per key so two
   * rapid mutations cannot interleave half a document.
   */
  private async reconFor(key: string): Promise<ReconGraph> {
    let graph = this.reconGraphs.get(key);
    if (graph) return graph;
    let restored: ReconGraph | null = null;
    if (this.reconStore) {
      const data = await this.reconStore.load(key).catch(() => null);
      if (data) {
        try { restored = ReconGraph.fromJSON(data); } catch { restored = null; }
      }
    }
    graph = restored || new ReconGraph();
    if (this.reconStore) {
      const store = this.reconStore;
      graph.onChange(() => {
        const run = (this.reconSaves.get(key) || Promise.resolve())
          .catch(() => {})
          .then(() => store.save(key, graph!.toJSON()))
          .catch(() => {});
        this.reconSaves.set(key, run);
      });
    }
    this.reconGraphs.set(key, graph);
    return graph;
  }

  /** The view of the groups a tool sees. */
  private toolGroupsApi(taskId: string) {
    return {
      list: () => Object.entries(TOOL_GROUPS).map(([group, definition]) => ({
        group,
        hint: definition.hint,
        loaded: ALWAYS_LOADED.includes(group) || this.loadedGroups(taskId).has(group),
        tools: definition.tools.filter((name) => this.tools.get(name)),
      })),
      load: (group: string) => this.loadGroup(taskId, group),
      unload: (group: string) => {
        if (ALWAYS_LOADED.includes(group) || !TOOL_GROUPS[group]) return false;
        return this.loadedGroups(taskId).delete(group);
      },
    };
  }

  /**
   * One line per tool, plus a terse signature line. The full schema travels
   * natively in the API tools parameter; this copy exists for models without
   * native function calling, and it needs names, types and required — not the
   * prose. Property descriptions are the bulk of the old block and are the
   * first thing a model asks the tool help for anyway (tools(action:"help")).
   */
  private compactToolBlock(tools: ToolSchema[]): string {
    const firstSentences = (text: string, max = 220): string => {
      const clean = String(text || '').replace(/\s+/g, ' ').trim();
      const sentences = clean.split(/(?<=[.!?;])\s+/);
      let out = '';
      for (const sentence of sentences) {
        if (!sentence) continue;
        if (out && `${out} ${sentence}`.length > max) break;
        out = out ? `${out} ${sentence}` : sentence;
      }
      return (out || clean.slice(0, max)).trim();
    };
    const typeOf = (param: any): string => {
      if (Array.isArray(param?.type)) return param.type.join('|');
      if (param?.type) return String(param.type);
      if (Array.isArray(param?.enum)) return 'enum';
      if (param?.properties) return 'object';
      return 'any';
    };
    const renderProps = (props: Record<string, any>, required: string[]): string =>
      Object.entries(props || {})
        .map(([name, param]) => {
          const optional = required.includes(name) ? '' : '?';
          const type = typeOf(param);
          const values = Array.isArray(param?.enum) && param.enum.length && param.enum.length <= 8
            ? `=${param.enum.map((value: any) => String(value)).join('|')}`
            : '';
          return `${name}${optional}:${type}${values}`;
        })
        .join(', ');
    const signature = (schema: any): string => {
      const props = (schema?.properties || {}) as Record<string, any>;
      const required: string[] = schema?.required || [];
      const lines = [renderProps(props, required)];
      for (const [name, param] of Object.entries(props)) {
        const item = param?.items;
        if (param?.type === 'array' && item?.properties) {
          lines.push(`${name}[]{${renderProps(item.properties, item.required || [])}}`);
        }
        if (param?.type === 'object' && param?.properties) {
          lines.push(`${name}{${renderProps(param.properties, param.required || [])}}`);
        }
      }
      return lines.filter((line) => line && line !== ' ').join(' | ');
    };
    return tools
      .map((tool) => `- ${tool.name}: ${firstSentences(tool.description)}\n  args: ${signature(tool.parameters)}`)
      .join('\n');
  }

  private getSystemPrompt(taskPrompt?: string, cwd = process.cwd(), forceSkill = '', minimal = false, taskId = ''): string {
    const tools = this.tools.listTools(this.toolVisible(taskId));
    const toolDescriptions = this.compactToolBlock(tools);

    const skillBlock = this.settings.enable_skills
      ? `\n\n${this.skills.contextBlock(taskPrompt || '', forceSkill)}`
      : '';

    const evolveBlock = this.settings.self_evolve_enabled
      ? '\n\nSelf-iteration (this repository): call evolve_begin to get a worktree on a self/<slug> branch, edit files ONLY inside that worktree, then evolve_commit. If the base moved, evolve_upstream merges origin/main into the branch and reports conflicts for you to resolve. Finish with evolve_finish — but ask the user first with the question tool whether they want a pull request, and pass open_pr=true only when they said yes. If they decline, the branch stays local and their working checkout is untouched, which is the point.'
      : '';

    if (minimal) {
      return `You are an AI agent that can use tools to complete tasks.
Host OS: ${process.platform}. Working directory: ${cwd}.
The bash tool actually runs ${shellChoice().describe()}.
Use write/edit for code files. Tool/program errors may be the correct diagnostic result; report them honestly instead of forcing success.
Report progress with the progress tool (percent + one-line note) when you start, after each step, and at 100 when done.
Verify every factual claim against evidence you retrieved and cite its source (file path, URL, DOI); never invent facts, citations or paths.

Available tools:
${toolDescriptions}${this.deferredIndex(taskId)}
${skillBlock}${evolveBlock}

Use native tool calls when your model supports them; batch independent calls. Without native function calling, output exactly one JSON object:
{"tool": "tool_name", "args": {"param": "value"}}
Continue until the task is complete, then return a concise plain-text final answer.

If the turn produced files, call report_artifacts once (absolute path + one-line description each) just before the final answer.`;
    }

    return `You are an AI agent that can use tools to complete tasks.

Host OS: ${process.platform}. Working directory: ${cwd}.
Bash runs ${shellChoice().describe()}.
Use write/edit for code files, not shell echo. Report progress in assistant text before tool actions. Choose the smallest change that satisfies the request; avoid speculative features and repeated probes.
For multi-step work, first call todowrite with a short checklist and keep exactly one item in_progress; update it as items finish. Skip it for trivial requests.
Progress: call the progress tool when you start, after each meaningful step, and once at the end — percent (0-100, honest), a one-line note about the current action, and a phase. Set 100 only when everything asked for is done and verified; the user sees this as a progress bar.
A tool/program error can be the correct diagnostic result — report it honestly instead of forcing success.
Verification: back every factual claim with evidence you retrieved (tool result, file path, URL, DOI); label anything unverified. Never invent citations, URLs, DOIs, versions, figures, quotes or API signatures; prefer primary sources.

Available tools:
${toolDescriptions}${this.deferredIndex(taskId)}
${skillBlock}${evolveBlock}

Use native tool calls when supported; batch independent calls (they run in parallel). Without native function calling, output exactly one JSON object:
{"tool": "tool_name", "args": {"param": "value"}}

Continue until the task is complete, then return a concise plain-text final answer with sources for factual claims and unverified items marked.

Deliverables: when the turn produced or modified files, call report_artifacts once (every deliverable, absolute path + one-line description) immediately before your final answer, so the UI can show the user a clickable list. Only list files that actually exist on disk; skip the call entirely when the turn produced nothing.`;
  }

  private contextBreakdown(cwd: string, conversationTokens: number, window: number) {
    // Estimate with the SAME rendering the real prompt uses — the compact tool
    // block and the fresh-session visibility set. The old copy here still
    // rendered full JSON schemas, so the panel reported a tools block that no
    // longer exists (and squeezed the system row down to 0).
    const toolList = this.tools.listTools(this.toolVisible(''))
    const toolDescriptions = this.compactToolBlock(toolList)
    const skillBlock = this.settings.enable_skills ? `\n\n${this.skills.contextBlock('', undefined)}` : ''
    let mcpText = ''
    try { mcpText = this.mcp ? JSON.stringify(this.mcp.listTools()) : '' } catch { mcpText = '' }
    const full = this.getSystemPrompt('', cwd, '')
    const system = Math.max(0, estimateTextTokens(full) - estimateTextTokens(toolDescriptions) - estimateTextTokens(skillBlock))
    const toolTokens = estimateTextTokens(toolDescriptions)
    const skillTokens = estimateTextTokens(skillBlock)
    const mcpTokens = estimateTextTokens(mcpText)
    const conversation = Math.max(0, Math.round(conversationTokens))
    return { window, system, tools: toolTokens, skills: skillTokens, mcp: mcpTokens, conversation, used: system + toolTokens + skillTokens + mcpTokens + conversation }
  }

  private desktopResult(tool: string, result: any, images: MessagePart[]) {
    if (tool !== 'computeruse' || !result.success || !result.data?.base64) return result;
    const { base64, ...data } = result.data;
    images.push({ type: 'text', text: `Desktop screenshot: ${data.width}x${data.height}. Use original screen pixel coordinates.` },
      { type: 'image', imageUrl: `data:${data.mime};base64,${base64}`, mimeType: data.mime });
    return { ...result, data: { ...data, image: 'attached as visual input' } };
  }

  /**
   * Drain what the user said while the agent was working, as one turn.
   *
   * The framing matters: an instruction that arrives mid-task is not a new
   * request, and the model must not treat it as permission to restart. It is an
   * amendment to the task in hand, applied on top of the work already done.
   */
  private applySteering(context: AgentContext): void {
    const drained = steering.drain(context.taskId);
    if (!drained.length) return;
    const text = drained.length === 1
      ? drained[0].text
      : drained.map((entry, index) => `${index + 1}. ${entry.text}`).join('\n');
    context.history.push({
      role: 'user',
      content: `The user added this while you were working. Treat it as an amendment to the current task, not a new one: keep what you have already done, adjust the plan, and continue.\n\n${text}`,
    });
    agentEvents.emit({
      type: 'intent.updated',
      taskId: context.taskId,
      sessionId: context.sessionId,
      at: Date.now(),
      data: { steering: text, ...context.gate?.ledger.serialize() },
    });
  }

  /** Tool results on the event bus, so the UI can show COT and steps live. */
  private emitToolEvent(context: AgentContext, name: string, rawArgs: string, result: import('../tools/types.js').ToolResult, at: number): void {
    agentEvents.emit({
      type: 'tool.result',
      taskId: context.taskId,
      sessionId: context.sessionId,
      at,
      data: {
        tool: name,
        ok: result.success !== false,
        error: result.error || '',
        args: String(rawArgs || '').slice(0, 1200),
        summary: String(result.error || JSON.stringify(result.data ?? '')).slice(0, 600),
      },
    });
  }

  /**
   * Run the 100% gate and persist the review outcome where the UI reads tasks.
   * The reviewer sits on top of the rule-based supervisor: rules catch provable
   * problems (no verification command, a loop), the reviewer catches the ones
   * only reading the files can find.
   */
  private async runGate(
    context: AgentContext,
    gate: QualityGate,
    supervisor: DeliverySupervisor,
    output: string,
    toolCallId: string,
  ): Promise<{ pass: boolean; exhausted: boolean; payload: Record<string, any> }> {
    if (!gate.enabled) return { pass: true, exhausted: false, payload: { status: 'success' } };
    const report = supervisor.report();
    const touched = this.touchedFiles(context, supervisor);
    const outcome = await gate.evaluate({
      taskId: context.taskId,
      sessionId: context.sessionId,
      cwd: context.cwd,
      userIntent: context.prompt,
      claim: output,
      approach: gate.ledger.current.approach,
      completionRate: 100,
      trace: (supervisor as any).trace ?? [],
      delivery: report,
      transcript: this.recentTranscript(context),
      touched,
    }, (request) => this.reviewerLlm(request, context));

    void this.recordIntentState(context, gate, outcome.payload);
    if (outcome.pass) {
      agentEvents.emit({
        type: 'task.finished',
        taskId: context.taskId,
        sessionId: context.sessionId,
        at: Date.now(),
        data: { passed: true, intent: outcome.intent, toolCallId },
      });
    }
    return { pass: outcome.pass, exhausted: outcome.exhausted, payload: outcome.payload };
  }

  /** The reviewer's model call: separate model when configured, no tools here. */
  private async reviewerLlm(request: import('../tools/types.js').LlmRequest, context: AgentContext): Promise<string | null> {
    const modelId = this.settings.reviewer_model || this.activeModel || this.settings.model_id || '';
    const messages = request.messages.map((message) => ({ role: message.role, content: message.content }));
    let text = '';
    try {
      for await (const chunk of this.mocr.generate({
        modelId,
        messages,
        systemPrompt: request.systemPrompt,
        maxTokens: request.maxTokens || 2600,
        temperature: request.temperature ?? 0.1,
        tools: [],
        toolChoice: 'none',
        signal: AbortSignal.timeout(90_000),
        taskId: context.taskId,
        sessionId: context.sessionId,
      })) text += chunk.chunk || '';
      return text || null;
    } catch (error: any) {
      console.warn(`[Agent] reviewer model call failed: ${error?.message || error}`);
      return null;
    }
  }

  /** Files the task wrote or edited, pulled from the tool trace. */
  private touchedFiles(context: AgentContext, supervisor: DeliverySupervisor): string[] {
    const trace: any[] = (supervisor as any).trace ?? [];
    const out: string[] = [];
    for (const entry of trace) {
      if (!['write', 'edit', 'apply_patch', 'patch'].includes(entry.name)) continue;
      const match = /"path":"((?:[^"\\]|\\.)*)"/.exec(entry.fingerprint || '');
      if (!match) continue;
      const file = match[1].replace(/\\\\/g, '\\');
      if (!out.includes(file)) out.push(file);
    }
    // A review with no touched files is legitimate (an answer-only turn), but
    // the reviewer should still see what the workspace looks like.
    return out.slice(0, 40);
  }

  /** Only the tail: the reviewer needs the claim's context, not the whole log. */
  private recentTranscript(context: AgentContext): string {
    const tail = context.history.slice(-14);
    return tail.map((message) => {
      const role = message.role;
      const content = typeof message.content === 'string' ? message.content : '';
      const calls = (message as any).toolCalls?.map((call: any) => `${call.name}(${String(call.arguments || '').slice(0, 200)})`).join('; ') || '';
      return `[${role}] ${content.slice(0, 1200)}${calls ? `\n  calls: ${calls}` : ''}`;
    }).join('\n');
  }

  /** The final text when the reviewer passed: the claim, plus any caveat it found. */
  private reviewedResult(output: string, payload: Record<string, any>): string {
    if (payload?.degraded) return `${output}\n\n[review skipped] ${payload.degraded}`;
    return output;
  }

  /** What the user sees when the gate gives up: the gap, not a hang. */
  private takeoverMessage(payload: Record<string, any>, output: string): string {
    const missing = Array.isArray(payload?.missing_intents) && payload.missing_intents.length
      ? `\n\nStill missing:\n${payload.missing_intents.map((item: string) => `- ${item}`).join('\n')}`
      : '';
    const feedback = payload?.fix_feedback ? `\n\nReviewer's last note: ${payload.fix_feedback}` : '';
    return `I stopped rather than claim this was finished: the review rejected it ${payload?.max_attempts ?? 3} times in a row, so this needs you to take over.${missing}${feedback}\n\nWhat I did complete:\n${output}`;
  }

  /** Push the intent state onto the same task row the UI already polls. */
  private async recordIntentState(context: AgentContext, gate: QualityGate, verdict?: Record<string, any>): Promise<void> {
    const state = gate.ledger.serialize();
    await this.recorder.record({
      task_id: context.taskId,
      caller_id: 'agent',
      session_id: context.sessionId || '',
      kind: 'agent',
      state: 'running',
      intent: JSON.stringify(state),
      ...(verdict ? { review: JSON.stringify(verdict) } : {}),
    }).catch(() => undefined);
  }

  private gateFinish(output: string, supervisor: DeliverySupervisor): { blocked: boolean; result: string; message: string } {
    const mode = (process.env.OKAY_EVIDENCE_GATE || '').trim().toLowerCase();
    if (mode !== '1' && mode !== 'warn' && mode !== '2' && mode !== 'strict') {
      return { blocked: false, result: output, message: '' };
    }
    const report = supervisor.evaluateDelivery(output);
    const annotated = report.status === 'GREEN'
      ? output
      : `${output}\n\n[Delivery gate ${report.status}] ${report.reasons.join('; ')}${report.evidence.length ? `; verified: ${report.evidence.join(', ')}` : '; no verification command found'}`;
    const strict = mode === '2' || mode === 'strict';
    if (strict && report.status !== 'GREEN') {
      return {
        blocked: true,
        result: annotated,
        message: `Delivery gate ${report.status}: ${report.reasons.join('; ')}. Add verifiable evidence (run tests / build / typecheck and paste the result), or change strategy, then call finish again.`,
      };
    }
    return { blocked: false, result: annotated, message: '' };
  }

  private async executeToolCall(toolCall: ToolCall, context: AgentContext, agentType: string, depth: number) {
    context.signal.throwIfAborted();
    let args: Record<string, any> = {};
    try {
      args = toolCall.arguments ? JSON.parse(toolCall.arguments) : {};
    } catch {
      return { success: false, data: null, error: `invalid JSON arguments for ${toolCall.name}` };
    }
    if (toolCall.name === 'finish') return { success: true, data: { output: String(args.output ?? args.result ?? '') } };
    if(toolCall.name==='question')return {success:true,data:{answer:await this.questions.ask(context.taskId,context.sessionId,args,context.signal)}};
    if (context.options.read_only_tools === '1' && !EXPLORE_READ_ONLY_TOOLS.has(toolCall.name)) {
      return { success: false, data: null, error: `${toolCall.name} is disabled: explorer sub-agents run strictly read-only` };
    }
    // A deferred tool is still callable by name; loading its group here is what
    // makes progressive disclosure safe rather than a guessing game.
    const toolGroup = groupOf(toolCall.name);
    if (toolGroup) this.loadGroup(context.taskId, toolGroup);
    // Plugins run before approval, not after: a plugin that refuses a call
    // should spare the user the prompt, and one that rewrites the arguments
    // should get the operator's approval for what will actually run.
    if (this.extensions) {
      const verdict = await this.extensions.beforeToolCall({ tool: toolCall.name, args, cwd: context.cwd });
      if (verdict.block) {
        return { success: false, data: null, error: verdict.block };
      }
      if (verdict.args) args = verdict.args;
    }
    if (!this.fullAccessGranted(context) && !this.autoApproved(toolCall.name) && !this.readOnlyComputerUse(toolCall.name, args) && !ALWAYS_SAFE_TOOLS.has(toolCall.name)) {
      try { await this.approvals.request(context.taskId, context.sessionId, toolCall.name, args, context.cwd, context.signal); }
      catch (error: any) { context.signal.throwIfAborted(); return { success:false, data:null, error:error.message }; }
    }
    // Resolved before the (synchronous) tool-context closure below: the graph
    // may need a disk read the first time a session touches it.
    const recon = await this.reconFor(context.sessionId || context.taskId);
    const call = () => serializeFileMutation(toolCall.name, () => this.recorder.run('tool', toolCall.name, context.taskId, context.sessionId, () => this.tools.call(toolCall.name, args, {
      cwd: context.cwd,
      taskId: context.taskId,
      sessionId: context.sessionId,
      agentType,
      todo: context.todo,
      mcp: this.mcp,
      history: context.history,
      ledger: context.ledger,
      signal: context.signal,
      llm: (request) => this.toolLlm(request, context),
      // Background assessment tasks outlive this call, so their model calls
      // must not inherit this context's abort signal.
      backgroundLlm: (request) => this.toolLlm(request, { taskId: context.taskId, sessionId: context.sessionId }),
      assessments: this.assessments,
      reconRun: this.assessments.activeFor(context.sessionId || context.taskId),
      sessionDirectives: this.directives,
      runSubAgent: depth >= 2 || context.options.no_subagents === '1'
        ? undefined
        : async (subPrompt, subType) => {
            const subTaskId = `${context.taskId}:sub:${randomUUID()}`;
            return this.recorder.run('subagent', subPrompt, context.taskId, context.sessionId,
              () => this.executeTaskInternal(subTaskId, subPrompt, subType || agentType, depth + 1, context.sessionId, context.options),
              subTaskId);
          },
      // The policy every write and shell call is checked against. Defaults to
      // workspace-write; a task can only widen it by saying so in its metadata.
      sandbox: new SandboxPolicy(parseSandboxMode(context.options.sandbox_mode), allowedWorkspaceRoots()),
      toolGroups: this.toolGroupsApi(context.taskId),
      // Keyed by session, not task: the graph is about the target you are
      // working on, which outlives one task and is shared by its subagents.
      // It also has to match the direct path below (stateKey), or a UI reading
      // the graph would see a different one than the model wrote to.
      recon,
      // Same depth rule as runSubAgent: a child two levels down gets no
      // sub-agent tool, so the tree cannot grow past depth 2.
      subagents: depth >= 2 || context.options.no_subagents === '1'
        ? undefined
        : {
            spawn: (spec: any) => this.subagents.spawn(spec, () => {
              const subTaskId = `${context.taskId}:sub:${randomUUID()}`;
              return this.recorder.run('subagent', spec.prompt, context.taskId, context.sessionId,
                () => this.executeTaskInternal(subTaskId, spec.prompt, spec.agentType || agentType, depth + 1, context.sessionId, context.options),
                subTaskId);
            }),
            list: () => this.subagents.list(),
            cancel: (id: string) => this.subagents.cancel(id),
          },
    }), undefined, serializeToolArgs(args)));
    if (!this.extensions) return call();
    // The after hook observes, it cannot rewrite: by this point the side effect
    // has happened, and a plugin that could change the reported result would be
    // a plugin that can lie to the model about what it just did.
    const result = await call();
    await this.extensions.afterToolCall({
      tool: toolCall.name,
      args,
      success: !!result?.success,
      output: this.extensionOutput(result),
    });
    return result;
  }

  /** A bounded, textual view of a tool result, for afterToolCall plugins. */
  private extensionOutput(result: any): string {
    if (!result) return '';
    const payload = result.success ? result.data : result.error;
    try {
      const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
      return (text || '').slice(0, 2000);
    } catch {
      return '';
    }
  }

  private parseToolCall(response: string): { name: string; args: Record<string, any> } | null {
    const candidates: string[] = [];
    const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(response);
    if (fenced && fenced[1].trim().startsWith('{')) candidates.push(fenced[1].trim());
    candidates.push(...jsonObjectCandidates(response));
    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate);
        if (typeof parsed?.tool === 'string' && parsed.tool.trim()) {
          return {
            name: parsed.tool,
            args: parsed.args && typeof parsed.args === 'object' && !Array.isArray(parsed.args) ? parsed.args : {},
          };
        }
      } catch {
      }
    }
    return null;
  }

  getTaskManager(): TaskManager {
    return this.taskManager;
  }

  async close(): Promise<void> {
    for (const task of this.taskManager.getActiveTasks()) this.taskManager.cancelTask(task.id);
    await this.mcp.close();
    await browserController.close().catch(() => {});
  }

  async flushTaskRecords(): Promise<void> {
    await this.recorder.record();
  }

  getTools(): ToolRegistry {
    return this.tools;
  }

  private async pickFolder(description: string): Promise<{ success: boolean; result: string; error: string }> {
    try {
      if (process.platform === 'win32') {
        const safe = String(description || 'Select a folder').replace(/'/g, "''")
        const script = [
          'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
          '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
          `$d.Description = '${safe}'`,
          '$d.ShowNewFolderButton = $true',
          'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }',
        ].join('; ')
        const encoded = Buffer.from(script, 'utf16le').toString('base64')
        const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-STA', '-EncodedCommand', encoded], { timeout: 300000, windowsHide: true })
        const chosen = String(stdout || '').trim()
        return chosen
          ? { success: true, result: JSON.stringify({ path: chosen }), error: '' }
          : { success: false, result: JSON.stringify({ cancelled: true }), error: '' }
      }
      if (process.platform === 'darwin') {
        const { stdout } = await execFileAsync('osascript', ['-e', 'POSIX path of (choose folder)'], { timeout: 300000 })
        const chosen = String(stdout || '').trim().replace(/\/$/, '')
        return chosen
          ? { success: true, result: JSON.stringify({ path: chosen }), error: '' }
          : { success: false, result: JSON.stringify({ cancelled: true }), error: '' }
      }
      return { success: false, result: '', error: 'native folder picker is only available on Windows and macOS hosts' }
    } catch (error: any) {
      return { success: false, result: JSON.stringify({ cancelled: true }), error: '' }
    }
  }

  private async resolveWorkspacePath(selector: string): Promise<string> {
    const workspace = await this.workspaces.resolve(selector);
    if (!workspace) throw new Error(`unknown project '${selector}'`);
    return workspace.path;
  }

  private workspaceView(workspace: Workspace, exists?: boolean): Record<string, unknown> {
    return {
      id: workspace.id,
      title: workspace.title,
      path: workspace.path,
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
      sessionIds: [...workspace.sessionIds],
      ...(exists === undefined ? {} : { exists }),
    };
  }

  private async handleWorkspaceAdmin(parsed: any): Promise<any> {
    await this.workspaces.init();
    const action = String(parsed.action || 'list').toLowerCase();
    const selector = String(parsed.id || parsed.name || parsed.workspace || parsed.project || '');
    const view = async (workspace: Workspace) => this.workspaceView(workspace, (await workspace.status()) === 'ok');
    switch (action) {
      case 'list': {
        return { workspaces: await Promise.all(this.workspaces.list().map(view)) };
      }
      case 'create':
      case 'save': {
        const workspace = await this.workspaces.create(String(parsed.path || ''), String(parsed.title || parsed.name || ''));
        return { workspace: await view(workspace) };
      }
      case 'get': {
        const workspace = parsed.id ? this.workspaces.get(String(parsed.id)) : await this.workspaces.resolve(selector);
        return { workspace: workspace ? await view(workspace) : null };
      }
      case 'resolve':
      case 'path': {
        const workspace = parsed.path != null
          ? await this.workspaces.resolveByPath(String(parsed.path))
          : await this.workspaces.resolve(selector);
        return { workspace: workspace ? await view(workspace) : null };
      }
      case 'use': {
        return { name: selector, path: await this.resolveWorkspacePath(selector) };
      }
      case 'delete': {
        const workspace = await this.workspaces.resolve(selector);
        if (!workspace) throw new Error(`project '${selector}' not found`);
        return { deleted: await this.workspaces.delete(workspace.id) };
      }
      case 'rename': {
        const workspace = await this.workspaces.resolve(selector);
        if (!workspace) throw new Error(`unknown project '${selector}'`);
        await workspace.setTitle(String(parsed.to || parsed.title || parsed.new_name || ''));
        return { workspace: await view(workspace) };
      }
      case 'reorder':
      case 'move': {
        const workspace = await this.workspaces.resolve(selector);
        if (!workspace) throw new Error(`unknown project '${selector}'`);
        const beforeSelector = parsed.before == null || parsed.before === '' ? undefined : String(parsed.before);
        const before = beforeSelector ? await this.workspaces.resolve(beforeSelector) : undefined;
        if (beforeSelector && !before) throw new Error(`unknown project '${beforeSelector}'`);
        const order = await this.workspaces.insertBefore(workspace.id, before?.id);
        return { order: order.map((id) => this.workspaces.get(id)?.title || id) };
      }
      case 'attach': {
        const workspace = await this.workspaces.resolve(selector);
        if (!workspace) throw new Error(`unknown project '${selector}'`);
        await workspace.attachSession(String(parsed.session || parsed.session_id || ''), parsed.cwd == null ? undefined : String(parsed.cwd));
        return { workspace: await view(workspace) };
      }
      case 'detach': {
        const workspace = await this.workspaces.resolve(selector);
        if (!workspace) throw new Error(`unknown project '${selector}'`);
        await workspace.detachSession(String(parsed.session || parsed.session_id || ''));
        return { workspace: await view(workspace) };
      }
      case 'move-session':
      case 'move_session': {
        const targetSelector = String(parsed.to || parsed.workspace || '');
        const workspace = await this.workspaces.resolve(targetSelector);
        if (!workspace) throw new Error(`unknown project '${targetSelector}'`);
        await this.workspaces.moveSession(String(parsed.session || parsed.session_id || ''), workspace.id);
        return { workspace: await view(workspace) };
      }
      case 'status': {
        const workspace = await this.workspaces.resolve(selector);
        if (!workspace) throw new Error(`unknown project '${selector}'`);
        return { status: await workspace.status() };
      }
      case 'archive': {
        await this.workspaces.archiveSession(String(parsed.session || parsed.session_id || ''));
        return { archived: [...this.workspaces.archivedSessionIds] };
      }
      case 'unarchive': {
        await this.workspaces.unarchiveSession(String(parsed.session || parsed.session_id || ''));
        return { archived: [...this.workspaces.archivedSessionIds] };
      }
      default:
        throw new Error(`unknown workspace_admin action: ${action}`);
    }
  }

  async runDirect(tool: string, args: string, sessionId = ''): Promise<{ success: boolean; result: string; error: string }> {
    // Per-session, not per-call: a recon graph or a loaded tool group that resets
    // on every direct call is not state, it is decoration.
    const stateKey = sessionId || sessionIdOrEmpty();
    if (tool === 'computeruse' && !this.settings.enable_computer_use) {
      return { success: false, result: '', error: 'computer-use-disabled: enable it in Agent settings' };
    }
    let parsed: Record<string, any> = {}
    if (args && args.trim()) {
      try {
        parsed = JSON.parse(args)
      } catch {
        parsed = { input: args, command: args }
      }
    }

    if(tool==='question_list')return {success:true,result:JSON.stringify(this.questions.list()),error:''};
    if(tool==='session_directives')return {success:true,result:JSON.stringify(this.directives.list(String(parsed.session_id||''))),error:''};
    if(tool==='session_directives_ack')return {success:true,result:JSON.stringify({removed:this.directives.ack(Array.isArray(parsed.ids)?parsed.ids.map(String):[])}),error:''};
    if(tool==='question_answer'){const ok=typeof parsed.answer==='string'&&this.questions.answer(String(parsed.id),parsed.answer);return {success:ok,result:'',error:ok?'':'Question expired or invalid answer'}};
    if(tool==='extensions_list')return {success:true,result:JSON.stringify(this.extensionReport()),error:''};
    if(tool==='extensions_reload'){
      // The settings page's toggle path: rewrite the enabled list, reload from
      // disk, and report what actually came up rather than what was requested.
      if(typeof parsed.enabled==='string')this.settings.plugins_enabled=parsed.enabled.trim();
      await this.reloadExtensions();
      const report=this.extensionReport();
      return {success:true,result:JSON.stringify({...report,loaded:report.plugins.map((p:any)=>p.manifest.name)}),error:''};
    }
    if (tool === 'task_steer') {
      // The UI's "say something while it works" path. The text is queued and
      // applied at the next tool boundary, so it cannot cut a write in half.
      const taskId = String(parsed.task_id || '');
      const text = String(parsed.text || '');
      if (!taskId) return { success: false, result: '', error: 'task_id required' };
      const queued = steering.push(taskId, String(parsed.session_id || ''), text);
      return { success: queued.ok, result: JSON.stringify({ queued: queued.queued, reason: queued.reason || '' }), error: queued.ok ? '' : (queued.reason || 'not queued') };
    }
    if (tool === 'task_steer_status') {
      return { success: true, result: JSON.stringify({ active: steering.activeTasks, pending: steering.pending(String(parsed.task_id || '')) }), error: '' };
    }
    if (tool === 'workspace_admin' || tool === 'projects_admin') {
      try {
        return { success: true, result: JSON.stringify(await this.handleWorkspaceAdmin(parsed)), error: '' };
      } catch (error: any) {
        return { success: false, result: '', error: error?.message || 'workspace_admin failed' };
      }
    }
    if (tool === 'workspace_pick') {
      return this.pickFolder(String(parsed.title || parsed.description || 'Select a folder'));
    }
    if (tool === 'skills_admin') {
      try {
        const dir = this.settings.skills_dir || this.skills.writableDir();
        const action = String(parsed.action || 'list').toLowerCase();
        if (action === 'list') {
          return { success: true, result: JSON.stringify({
            dir,
            skills: this.skills.list().map((s) => ({ name: s.name, description: s.description, tags: s.tags, source: s.source })),
          }), error: '' };
        }
        if (action === 'save') {
          const skill = this.skills.save(String(parsed.name || ''), String(parsed.content || ''), dir);
          return { success: true, result: JSON.stringify({ name: skill.name, description: skill.description, source: skill.source }), error: '' };
        }
        if (action === 'delete') {
          const ok = this.skills.remove(String(parsed.name || ''), dir);
          return { success: ok, result: JSON.stringify({ deleted: ok }), error: ok ? '' : `skill '${parsed.name}' not found` };
        }
        return { success: false, result: '', error: `unknown skills_admin action: ${action}` };
      } catch (error: any) {
        return { success: false, result: '', error: error?.message || 'skills_admin failed' };
      }
    }
    if (tool === 'workspace_browse') {
      try {
        const directory = path.resolve(parsed.path || process.cwd());
        const entries = await readdir(directory, { withFileTypes: true });
        const roots: string[] = [];
        if (process.platform === 'win32') {
          for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
            const root = `${letter}:\\`;
            if (await stat(root).then(s => s.isDirectory()).catch(() => false)) roots.push(root);
          }
        } else roots.push('/');
        return { success: true, error: '', result: JSON.stringify({ path: directory, parent: path.dirname(directory), roots,
          directories: entries.filter(entry => entry.isDirectory()).map(entry => ({ name: entry.name, path: path.join(directory, entry.name) })).sort((a,b) => a.name.localeCompare(b.name)) }) };
      } catch (error: any) { return { success: false, result: '', error: error.message }; }
    }
    if (tool === 'workspace_tree') {
      try {
        const directory = path.resolve(parsed.path || process.cwd());
        const entries = await readdir(directory, { withFileTypes: true });
        const roots: string[] = [];
        if (process.platform === 'win32') {
          for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
            const root = `${letter}:\\`;
            if (await stat(root).then(s => s.isDirectory()).catch(() => false)) roots.push(root);
          }
        } else roots.push('/');
        // A tree that names the credential files tells an injected prompt exactly
        // what to ask for next, even though it does not return the contents.
        const visible = new Set(await filterListing(directory, entries.map(entry => entry.name)));
        const items = entries
          .filter(entry => entry.name !== '.git' && entry.name !== 'node_modules' && visible.has(entry.name))
          .map(entry => ({ name: entry.name, path: path.join(directory, entry.name), dir: entry.isDirectory() }))
          .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
        return { success: true, error: '', result: JSON.stringify({ path: directory, parent: path.dirname(directory), roots, entries: items }) };
      } catch (error: any) { return { success: false, result: '', error: error.message }; }
    }
    if (tool === 'workspace_read') {
      try {
        const file = path.resolve(String(parsed.path || ''));
        if (!isPathAllowed(file)) throw new Error('path not allowed: outside workspace roots');
        // The workspace roots say which directories this task is about; they do
        // not say which files are secrets. This endpoint is the panel's file
        // viewer, and it served providers.json — plaintext API keys — to anyone
        // who asked, because the roots included the repo that Core keeps its
        // data in.
        await assertReadable(file);
        const s = await stat(file);
        if (s.isDirectory()) return { success: false, result: '', error: 'is a directory' };
        if (s.size > 1_500_000) return { success: false, result: '', error: `file too large (${s.size} bytes)` };
        const text = await readFile(file, 'utf8');
        const lines = text.split(/\r?\n/);
        const offset = Math.max(1, Number(parsed.offset) || 1);
        const limit = Math.max(1, Math.min(Number(parsed.limit) || 2000, 5000));
        const slice = lines.slice(offset - 1, offset - 1 + limit);
        return { success: true, error: '', result: JSON.stringify({ path: file, totalLines: lines.length, content: slice.join('\n') }) };
      } catch (error: any) { return { success: false, result: '', error: error.message }; }
    }
    if (tool === 'workspace_write') {
      try {
        if (!parsed.path) throw new Error('path is required');
        if (typeof parsed.content !== 'string') throw new Error('content must be a string');
        const file = path.resolve(String(parsed.path));
        if (!isPathAllowed(file)) throw new Error('path not allowed: outside workspace roots');
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, parsed.content, 'utf8');
        return { success: true, error: '', result: JSON.stringify({ path: file, bytes: Buffer.byteLength(parsed.content) }) };
      } catch (error: any) { return { success: false, result: '', error: error?.message || 'workspace_write failed' }; }
    }
    if (tool === 'workspace_read_binary') {
      try {
        if (!parsed.path) throw new Error('path is required');
        const file = path.resolve(String(parsed.path));
        if (!isPathAllowed(file)) throw new Error('path not allowed: outside workspace roots');
        await assertReadable(file);
        const s = await stat(file);
        if (s.isDirectory()) return { success: false, result: '', error: 'is a directory' };
        if (s.size > 30 * 1024 * 1024) return { success: false, result: '', error: `file too large (${s.size} bytes)` };
        const buffer = await readFile(file);
        return { success: true, error: '', result: JSON.stringify({ path: file, size: buffer.length, base64: buffer.toString('base64') }) };
      } catch (error: any) { return { success: false, result: '', error: error?.message || 'workspace_read_binary failed' }; }
    }
    if (tool === 'workspace_convert') {
      try {
        if (!parsed.path) throw new Error('path is required');
        const file = path.resolve(String(parsed.path));
        const target = String(parsed.target || 'pdf').toLowerCase().replace(/[^a-z0-9]/g, '');
        const soffice = await findSoffice();
        if (!soffice) return { success: false, result: '', error: 'libreoffice-not-found' };
        const outDir = await mkdtemp(path.join(os.tmpdir(), '0kay-convert-'));
        const profileDir = await mkdtemp(path.join(os.tmpdir(), '0kay-lo-profile-'));
        try {
          const profileUrl = `file:///${profileDir.replace(/\\/g, '/')}`;
          await runSofficeSerialized(() => execFileAsync(soffice, ['--headless', '--norestore', '--nolockcheck', `-env:UserInstallation=${profileUrl}`, '--convert-to', target, '--outdir', outDir, file], { timeout: 150000, windowsHide: true, maxBuffer: 1024 * 1024 }));
          const outPath = path.join(outDir, `${path.basename(file).replace(/\.[^.]+$/, '')}.${target}`);
          const buffer = await readFile(outPath);
          return { success: true, error: '', result: JSON.stringify({ path: outPath, mime: target === 'pdf' ? 'application/pdf' : 'application/octet-stream', size: buffer.length, base64: buffer.toString('base64') }) };
        } finally {
          await rm(outDir, { recursive: true, force: true }).catch(() => {});
          await rm(profileDir, { recursive: true, force: true }).catch(() => {});
        }
      } catch (error: any) {
        return { success: false, result: '', error: error?.message || 'convert failed' };
      }
    }
    if (tool === 'workspace_extract_text') {
      try {
        if (!parsed.path) throw new Error('path is required');
        const file = path.resolve(String(parsed.path));
        const ext = path.extname(file).toLowerCase().replace('.', '');
        let text = '';
        if (ext === 'doc' || ext === 'dot' || ext === 'wps') {
          // @ts-ignore - word-extractor ships no type declarations
          const WordExtractor = (await import('word-extractor')).default;
          const document = await new WordExtractor().extract(file);
          text = [document.getBody?.(), document.getHeaders?.(), document.getFooters?.(), document.getFootnotes?.(), document.getEndnotes?.()]
            .filter((part: unknown) => typeof part === 'string' && part.trim()).join('\n\n');
        } else if (ext === 'ppt' || ext === 'pot' || ext === 'pps') {
          text = await extractPptText(file);
        } else {
          throw new Error(`unsupported legacy format: .${ext}`);
        }
        return { success: true, error: '', result: JSON.stringify({ path: file, content: text }) };
      } catch (error: any) {
        return { success: false, result: '', error: error?.message || 'extract failed' };
      }
    }
    if (tool === 'workspace_mkdir') {
      try {
        const parent = path.resolve(String(parsed.path || process.cwd()));
        const name = String(parsed.name || '').trim();
        if (!name || name === '.' || name === '..' || /[\\/<>:"|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name)) throw new Error('Invalid folder name');
        if (!(await stat(parent)).isDirectory()) throw new Error('Parent directory does not exist');
        const target = path.join(parent, name);
        await mkdir(target);
        return { success:true, result:JSON.stringify({path:target}), error:'' };
      } catch (error: any) { return { success:false, result:'', error:error.message }; }
    }
    if (tool === 'approval_list') return {success:true,result:JSON.stringify(this.approvals.list(String(parsed.session_id || ''))),error:''};
    if (tool === 'approval_decide') {
      if (typeof parsed.allow !== 'boolean') return {success:false,result:'',error:'allow must be boolean'};
      const ok=this.approvals.decide(String(parsed.id || ''),parsed.allow,String(parsed.executor_id || ''));
      return {success:ok,result:JSON.stringify({ok}),error:ok?'':'Approval expired, not found, or owned by another executor'};
    }
    if (tool === 'context_usage') {
      try {
        const cwd = typeof parsed.cwd === 'string' && parsed.cwd ? parsed.cwd : process.cwd()
        const sessionId = String(parsed.session_id || '')
        const modelId = this.activeModel || this.settings.model_id || ''
        // A caller that does not know the window used to send 0, which made the
        // meter divide by zero and show nothing. Resolve it the same way the
        // loop does, so the panel and the compaction threshold agree.
        const windowInfo = inferContextWindow(modelId, this.settings.context_window || 0)
        const window = Number(parsed.window) || windowInfo.tokens
        const breakdown = this.contextBreakdown(cwd, Number(parsed.conversation_tokens) || 0, window)
        const lastPrompt = sessionId ? (sessionPromptTokens.get(sessionId) || 0) : 0
        return {
          success: true,
          result: JSON.stringify({
            ...breakdown,
            last_prompt_tokens: lastPrompt,
            window_source: windowInfo.source,
            compact_tier: decideCompactTier(lastPrompt || breakdown.used, window, compactPolicy(modelId)),
            cache: {
              prefix_hash: sessionId ? (sessionPrefix.get(sessionId) || '') : '',
              cache_profile: cacheProfileFor(modelId),
            },
          }),
          error: '',
        }
      } catch (error: any) { return { success: false, result: '', error: error?.message || 'context_usage failed' } }
    }
    if (tool === 'host_status') {
      const sample = () => os.cpus().reduce((sum, cpu) => ({ idle: sum.idle + cpu.times.idle, total: sum.total + Object.values(cpu.times).reduce((a,b) => a+b,0) }), {idle:0,total:0});
      const before = sample();
      await new Promise(resolve => setTimeout(resolve, 250));
      const after = sample();
      return { success: true, error: '', result: JSON.stringify({ cpu_percent: Math.max(0,Math.min(100,100*(1-(after.idle-before.idle)/Math.max(1,after.total-before.total)))), memory_percent:100*(1-os.freemem()/os.totalmem()), sampled_at:new Date().toISOString() }) };
    }

    if (tool === 'browser_status') {
      const status = await browserController.probe();
      return { success: true, error: '', result: JSON.stringify({ ...status, enabled: this.settings.enable_browser_tool }) };
    }
    if (tool === 'browser_view') {
      const status = await browserController.probe();
      if (!status.running) {
        return { success: true, error: '', result: JSON.stringify({ running: false, enabled: this.settings.enable_browser_tool, available: status.available, image: '' }) };
      }
      try {
        const shot = await browserController.action('screenshot', { format: 'jpeg' });
        const current = browserController.getStatus();
        return { success: true, error: '', result: JSON.stringify({ running: true, enabled: this.settings.enable_browser_tool, url: current.url, title: current.title, canGoBack: current.canGoBack, canGoForward: current.canGoForward, tabs: current.tabs, viewportWidth: current.viewportWidth, viewportHeight: current.viewportHeight, mime: shot.mime, image: shot.base64 }) };
      } catch (error: any) {
        return { success: true, error: '', result: JSON.stringify({ running: true, url: status.url, image: '', error: error?.message || String(error) }) };
      }
    }
    if (tool === 'browser_frame') {
      const status = await browserController.probe();
      if (!status.running) return { success: true, error: '', result: JSON.stringify({ running: false, image: '' }) };
      try {
        const shot = await browserController.action('frame', {});
        return { success: true, error: '', result: JSON.stringify({ running: true, image: shot.image || '', mime: shot.mime || 'image/jpeg', at: shot.at || 0 }) };
      } catch (error: any) {
        return { success: true, error: '', result: JSON.stringify({ running: true, image: '', error: error?.message || String(error) }) };
      }
    }

    if (tool === 'computeruse_status') {
      return { success: true, error: '', result: JSON.stringify({ enabled: !!this.settings.enable_computer_use, supported: ['win32', 'darwin', 'linux'].includes(process.platform) }) };
    }
    if (tool === 'computeruse_frame') {
      if (!this.settings.enable_computer_use) {
        return { success: true, error: '', result: JSON.stringify({ running: false, enabled: false, image: '' }) };
      }
      const capture = this.tools.get('computeruse') as any;
      if (!capture || typeof capture.streamFrame !== 'function') {
        return { success: true, error: '', result: JSON.stringify({ running: false, enabled: true, image: '', error: 'capture unavailable' }) };
      }
      try {
        const isWin = process.platform === 'win32';
        const after = Number(parsed.after) || 0;
        const frame = await capture.streamFrame(isWin ? undefined : {
          cwd: process.cwd(),
          taskId: stateKey,
          agentType: this.settings.default_agent_type,
          todo: [],
          mcp: this.mcp,
        }, after);
        if (frame?.image) {
          return { success: true, error: '', result: JSON.stringify({ running: true, enabled: true, image: frame.image, mime: frame.mime || 'image/jpeg', width: frame.width, height: frame.height, at: frame.at }) };
        }
        const alive = typeof capture.streamAlive === 'function' ? capture.streamAlive() : false;
        return { success: true, error: '', result: JSON.stringify({ running: alive, enabled: true, image: '', at: frame?.at, warming: alive }) };
      } catch (error: any) {
        return { success: true, error: '', result: JSON.stringify({ running: false, enabled: true, image: '', error: error?.message || String(error) }) };
      }
    }

    if (tool === 'terminal_exec') {
      try {
        if (!this.settings.enable_terminal) throw new Error('terminal-disabled: enable it in the agent plugin settings');
        const command = String(parsed.command || '');
        if (!command.trim()) throw new Error('command is required');
        const cwd = path.resolve(parsed.cwd ? String(parsed.cwd) : process.cwd());
        const timeoutMs = Math.max(1000, Math.min(Number(parsed.timeout) || 120000, 300000));
        const label = await getOemLabel();
        try { await this.approvals.request(stateKey, 'direct', tool, parsed, cwd); }
        catch (error: any) { return { success: false, result: '', error: error.message }; }
        const { stdout, stderr, exitCode } = await runTerminalCommand(command, cwd, timeoutMs, label);
        return { success: true, error: '', result: JSON.stringify({ cwd, stdout, stderr, exitCode }) };
      } catch (error: any) {
        return { success: false, result: '', error: error?.message || 'terminal_exec failed' };
      }
    }

    if (tool === 'finish') {
      return { success: true, result: String(parsed.output ?? parsed.result ?? args ?? ''), error: '' }
    }

    // One identity for the whole call: `stateKey` is the session the panel is
    // looking at. A fresh `direct:<ts>` per call made assessments(action:"list")
    // return nothing — create() filed the task under an id nobody could ask for
    // again — and filed approvals somewhere the session's inbox never looks.
    const directId = stateKey;
    // A tool is exempt from approval for one reason only: it cannot act on the
    // world. Three exemptions used to sit here for other reasons and each was a
    // hole — `computeruse` and `browser` drive the screen and the network, and
    // an MCP server named "mail" is still an arbitrary server chosen by whoever
    // configured it. Name-based privilege is not privilege; ask the user.
    if (!this.autoApproved(tool) && !ALWAYS_SAFE_TOOLS.has(tool)) {
      try {await this.approvals.request(directId,'direct',tool,parsed,process.cwd())}
      catch(error:any) {return {success:false,result:'',error:error.message}}
    }
    const res = await this.tools.call(tool, parsed, {
      cwd: process.cwd(),
      taskId: stateKey,
      sessionId: stateKey,
      agentType: this.settings.default_agent_type,
      todo: [],
      mcp: this.mcp,
      // The direct path used to skip the sandbox entirely, which made /api/run a
      // way around the policy the loop enforces.
      sandbox: new SandboxPolicy(parseSandboxMode(this.settings.sandbox_mode), allowedWorkspaceRoots()),
      toolGroups: this.toolGroupsApi(stateKey),
      recon: await this.reconFor(stateKey),
      assessments: this.assessments,
      reconRun: this.assessments.activeFor(stateKey),
      sessionDirectives: this.directives,
      // No signal here to inherit: the direct path has no tool-call lifecycle,
      // so plain toolLlm is already detached. runSubAgent lets assessment
      // workers started from the panel run as real tool-carrying sub-agents.
      backgroundLlm: (request) => this.toolLlm(request, { taskId: stateKey, sessionId: stateKey }),
      runSubAgent: (subPrompt, subType) => this.recorder.run(
        'subagent', subPrompt, directId, 'direct',
        () => this.executeTaskInternal(`${directId}:sub:${randomUUID()}`, subPrompt, subType || this.settings.default_agent_type, 1, directId, {}),
        `${directId}:sub`,
      ),
    })
    if (res.success) {
      let result = ''
      try {
        result = typeof res.data === 'string' ? res.data : JSON.stringify(res.data)
      } catch {
        result = String(res.data)
      }
      return { success: true, result, error: '' }
    }
    return { success: false, result: '', error: res.error || 'tool failed' }
  }
}

let sofficePromise: Promise<string> | null = null;
function findSoffice(): Promise<string> {
  if (!sofficePromise) {
    sofficePromise = (async () => {
      const explicit = process.env.OKAY_SOFFICE_PATH;
      if (explicit && await stat(explicit).then((s) => s.isFile()).catch(() => false)) return explicit;
      const candidates = [
        path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'LibreOffice', 'program', 'soffice.exe'),
        path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'LibreOffice', 'program', 'soffice.exe'),
        process.env['LocalAppData'] ? path.join(process.env['LocalAppData'], 'Programs', 'LibreOffice', 'program', 'soffice.exe') : '',
        '/usr/bin/soffice', '/usr/bin/libreoffice', '/Applications/LibreOffice.app/Contents/MacOS/soffice',
      ].filter(Boolean);
      for (const candidate of candidates) {
        if (await stat(candidate).then((s) => s.isFile()).catch(() => false)) return candidate;
      }
      try {
        const { stdout } = await execFileAsync('where', ['soffice']);
        const found = String(stdout).split(/\r?\n/)[0].trim();
        if (found) return found;
      } catch { }
      return '';
    })();
  }
  return sofficePromise.then((found) => { if (!found) sofficePromise = null; return found; });
}

let sofficeChain: Promise<unknown> = Promise.resolve();
function runSofficeSerialized<T>(task: () => Promise<T>): Promise<T> {
  const run = sofficeChain.then(task, task);
  sofficeChain = run.catch(() => {});
  return run;
}

async function extractPptText(file: string): Promise<string> {
  // @ts-ignore - cfb ships no type declarations
  const cfbModule: any = await import('cfb');
  const CFB = cfbModule.default || cfbModule;
  const container = CFB.read(await readFile(file), { type: 'buffer' });
  const stream = CFB.find(container, 'PowerPoint Document');
  if (!stream?.content) return '';
  const data: Buffer = Buffer.isBuffer(stream.content) ? stream.content : Buffer.from(stream.content);
  const out: string[] = [];
  const walk = (start: number, end: number) => {
    let i = start;
    while (i + 8 <= end) {
      const verInstance = data.readUInt16LE(i);
      const recType = data.readUInt16LE(i + 2);
      const recLen = data.readUInt32LE(i + 4);
      const body = i + 8;
      if (body + recLen > end) break;
      if ((verInstance & 0x000f) === 0x0f) walk(body, body + recLen);
      else if (recType === 0x0fa0) out.push(data.subarray(body, body + recLen).toString('utf16le'));
      else if (recType === 0x0fa8) out.push(data.subarray(body, body + recLen).toString('latin1'));
      i = body + recLen;
      if (recLen === 0 && recType === 0) i++;
    }
  };
  walk(0, data.length);
  return out.map((value) => value.replace(/\r/g, '')).join('\n').trim();
}

function sessionIdOrEmpty(): string {
  return `direct:${Date.now()}`;
}

const CODEPAGE_LABELS: Record<number, string> = {
  874: 'windows-874', 932: 'shift_jis', 936: 'gbk', 949: 'euc-kr', 950: 'big5',
  1250: 'windows-1250', 1251: 'windows-1251', 1252: 'windows-1252',
  1253: 'windows-1253', 1254: 'windows-1254', 1255: 'windows-1255',
  1256: 'windows-1256', 1257: 'windows-1257', 1258: 'windows-1258', 65001: 'utf-8',
};
let oemLabelPromise: Promise<string> | null = null;
function getOemLabel(): Promise<string> {
  if (!oemLabelPromise) {
    oemLabelPromise = new Promise((resolve) => {
      if (process.platform !== 'win32') return resolve('utf-8');
      execFile('reg', ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage', '/v', 'OEMCP'], { windowsHide: true }, (error, stdout) => {
        if (error) return resolve('utf-8');
        const match = /OEMCP\s+REG_SZ\s+(\d+)/.exec(String(stdout));
        resolve(CODEPAGE_LABELS[Number(match?.[1])] || 'utf-8');
      });
    });
  }
  return oemLabelPromise;
}
function decodeTerminalOutput(value: Buffer | string | undefined, label: string): string {
  if (!value) return '';
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  if (!buffer.length) return '';
  const utf8 = buffer.toString('utf8');
  if (!utf8.includes('\uFFFD') || label === 'utf-8') return utf8;
  try { return new TextDecoder(label).decode(buffer); } catch { return utf8; }
}
function runTerminalCommand(command: string, cwd: string, timeoutMs: number, label: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const isWin = process.platform === 'win32';
  const file = isWin ? 'cmd.exe' : '/bin/sh';
  const args = isWin ? ['/d', '/s', '/c', `chcp 65001 >nul & ${command}`] : ['-c', command];
  return new Promise((resolve) => {
    let child: any;
    let settled = false;
    const finish = (error: any, stdout: Buffer, stderr: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout: decodeTerminalOutput(stdout, label),
        stderr: decodeTerminalOutput(stderr, label) || (error ? String(error.message || '') : ''),
        exitCode: error ? (Number(error.code) || 1) : 0,
      });
    };
    child = execFile(file, args, {
      cwd, maxBuffer: 10 * 1024 * 1024, windowsHide: true, encoding: 'buffer',
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    } as any, (error: any, stdout: any, stderr: any) => finish(error, stdout, stderr));
    const timer = setTimeout(() => {
      try {
        if (isWin && child?.pid) execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {});
        else {
          child?.kill('SIGTERM');
          setTimeout(() => { try { child?.kill('SIGKILL'); } catch { } }, 5000);
        }
      } catch { }
    }, timeoutMs);
  });
}
