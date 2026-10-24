import { MocrProvider, Message, MessagePart, GenerateRequest, GenerateResponse, ToolCall } from '../provider/mocr.js';
import { ToolRegistry, createDefaultRegistry, PluginTool } from '../tools/tools.js';
import { SkillRegistry, getSkillRegistry } from '../skills/skills.js';
import { TaskManager, Task } from '../task/task.js';
import { McpManager, McpServerConfig } from '@0kay/mcp';
import { randomUUID } from 'crypto';
import * as path from 'path';
import { stat, readdir, mkdir, readFile, writeFile, mkdtemp, rm } from 'fs/promises';
import { ApprovalManager } from '../task/approvals.js';
import { ContextLedger } from '../context/ledger.js';
import { QuestionManager } from '../task/questions.js';
import * as os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
import { taskRecorder } from '../task/records.js';
import { coreFetch, coreHeaders, coreHttpBase, listPluginTools, executorIdentity } from '../connection.js';
import { browserController } from '../tools/browser.js';
import { WorkspaceRegistry, type Workspace } from '../workspace/registry.js';
import { allowTaskRoot, isPathAllowed } from '../workspace/paths.js';
import { DeliverySupervisor, supervisionDirective } from './supervision.js';
import { resolvePosture, postureDirective } from './posture.js';
import { resolveMode, type MultiAgentMode } from './modes.js';
import { buildHandoffDoc } from './handoff.js';
import { ensureAgentWorkspace, appendAgentNote } from './agent_workspace.js';
import { extractDocumentText, isDocumentAttachment } from './attachment_text.js';

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
const ALWAYS_SAFE_TOOLS = new Set(['report_artifacts']);

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

export const DEFAULT_AUTO_APPROVE_TOOLS =
  'read,glob,grep,webfetch,websearch,papersearch,apidocsearch,todowrite,skill,document,slides,compress,decompress,search_context,acp_status,report_artifacts';

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
  vision_model?: string;
  context_window?: number;
  enable_mcp_tool?: boolean;
  enable_plugin_tools?: boolean;
  enable_task_tool?: boolean;
  mcp_servers_json?: string;
  enable_skills?: boolean;
  skills_dir?: string;
  always_allow_tools?: string;
  minimal_mode?: boolean;
  duet_mode?: boolean;
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
  private questions = new QuestionManager();
  private handoffs = new Map<string,string>();
  private workspaces = new WorkspaceRegistry();
  private pluginToolNames = new Set<string>();
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
      vision_model: '',
      context_window: 0,
      enable_mcp_tool: true,
      enable_plugin_tools: true,
      enable_task_tool: true,
      mcp_servers_json: '[]',
      enable_skills: true,
      skills_dir: '',
      always_allow_tools: DEFAULT_AUTO_APPROVE_TOOLS,
      minimal_mode: false,
      duet_mode: false,
    };

    this.mocr = new MocrProvider({ grpcAddress: this.config.mocrAddress });
    this.tools = createDefaultRegistry();
    this.skills = getSkillRegistry();
    this.mcp = new McpManager();
    this.taskManager = new TaskManager({ maxConcurrentTasks: this.settings.max_concurrent_tasks });
    this.applyToolToggles();

    this.taskManager.setOnComplete((task) => {
      console.log(`Task ${task.id} completed: ${task.state}`);
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
    if (typeof partial.enable_web_tools === 'boolean') this.settings.enable_web_tools = partial.enable_web_tools;
    if (typeof partial.enable_computer_use === 'boolean') this.settings.enable_computer_use = partial.enable_computer_use;
    if (typeof partial.enable_browser_tool === 'boolean') this.settings.enable_browser_tool = partial.enable_browser_tool;
    if (typeof partial.enable_document_tool === 'boolean') this.settings.enable_document_tool = partial.enable_document_tool;
    if (typeof partial.enable_slides_tool === 'boolean') this.settings.enable_slides_tool = partial.enable_slides_tool;
    if (typeof partial.enable_terminal === 'boolean') this.settings.enable_terminal = partial.enable_terminal;
    if (typeof partial.vision_model === 'string') this.settings.vision_model = partial.vision_model.trim();
    if (typeof partial.context_window === 'number' && partial.context_window >= 0) this.settings.context_window = Math.floor(partial.context_window);
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
    this.applyToolToggles();
    void this.refreshPluginTools();
    void this.refreshMcpServers();
    void this.refreshPluginSkills();
  }

  getSettings(): Readonly<Required<AgentSettings>> {
    return { ...this.settings };
  }

  private autoApproved(tool: string): boolean {
    if (!tool) return false;
    return this.settings.always_allow_tools
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .includes(tool);
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
  }

  private async refreshPluginTools(): Promise<void> {
    for (const name of this.pluginToolNames) this.tools.unregister(name);
    this.pluginToolNames.clear();
    if (!this.settings.enable_plugin_tools) return;
    const defs = await listPluginTools('agent');
    for (const def of defs) {
      if (!def?.name || this.tools.get(def.name)) continue;
      this.tools.register(new PluginTool(def));
      this.pluginToolNames.add(def.name);
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

  private async compactHistory(context: AgentContext, modelId: string, sessionId: string): Promise<void> {
    let summary = '';
    const transcript = JSON.stringify(context.history.map(({ parts, ...rest }) => parts?.length ? { ...rest, content: `${rest.content}\n[${parts.filter(p => p.type === 'image').length} image attachment(s) omitted]` } : rest));
    for await (const chunk of this.mocr.generate({ modelId, messages: [{ role: 'user', content: transcript }], systemPrompt: COMPACTION_SCHEMA_PROMPT, tools: [], toolChoice: 'none', signal: context.signal, taskId: context.taskId, sessionId, maxTokens: 5000 })) summary += chunk.chunk || '';
    if (!summary.trim()) throw new Error('Context compaction returned no summary');
    const todoBlock = formatTodoList(context.todo);
    context.history = [
      { role: 'user', content: context.prompt },
      { role: 'assistant', content: `Structured context summary:\n${summary}${todoBlock ? `\n\n${todoBlock}` : ''}` },
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

      let result = '';
      let lastModel = this.settings.model_id;
      let lastPromptTokens = 0;
      let gateBlocks = 0;

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
            messages: [{ role: 'user', content: DUET_PLAN_USER_PROMPT + '\n\n任务：\n' + context.prompt }],
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

        let contextLimit = this.settings.context_window || 0;
        if (!contextLimit && typeof (this.mocr as any).modelContextLength === 'function') {
          contextLimit = await this.mocr.modelContextLength(modelId, context.signal).catch(() => 0);
        }
        if (contextLimit > 0 && (lastPromptTokens || this.estimateTokens(context.history)) > contextLimit * 0.85) {
          await this.compactHistory(context, modelId, context.sessionId);
          lastPromptTokens = 0;
        }

        const todoBlock = formatTodoList(context.todo);

        let fullResponse = '';
        let finalText = '';
        let fullReasoning = '';
        let receivedNativeCalls = false;
        try {
        for await (const chunk of this.generateWithVisionFallback({
          modelId,
          messages: context.history,
          systemPrompt: this.getSystemPrompt(context.prompt, context.cwd, context.options.force_skill || '', minimal)
            + (minimal
              ? `\nPreferred UI language: ${options.language === 'en' ? 'English' : 'Chinese'}. Iteration ${i + 1}. Continue until complete or cancelled. Ask the user with question when blocked; do not repeat failing actions without new evidence. ${this.thinkingDirective(intensity, difficultyHint)}\n\n${this.minimalDirective(options.language)}`
              : `\nPreferred UI language: ${options.language === 'en' ? 'English' : 'Chinese'}. Match the user language in progress, questions and replies.\nIteration ${i + 1}. Continue until complete or cancelled. Ask the user with question when blocked; do not repeat failing actions without new evidence. ${this.thinkingDirective(intensity, difficultyHint)}`)
            + (runtimeDirectives ? '\n\n' + runtimeDirectives : '')
            + (todoBlock ? `\n\n${todoBlock}` : '') + (context.options.workspace_note ? `\n\nWorkspace context:\n${context.options.workspace_note}` : ''),
          temperature: this.settings.temperature,
          thinking: requireThinking,
          difficultyHint,
          requireThinking,
          maxTokens,
          tools: [...this.tools.listTools(),{name:'question',description:'Ask the user a question with suggested options and a free-text answer.',parameters:{type:'object',required:['question'],properties:{question:{type:'string'},options:{type:'array',items:{type:'string'}}}}}],
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
            if (chunk.finishReason === 'FINISH_REASON_ERROR' || chunk.finishReason === 'FINISH_REASON_LENGTH' || chunk.finishReason === 'FINISH_REASON_CONTENT_FILTER') throw new Error(`Model generation stopped: ${chunk.finishReason}`);
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
                if (toolCall.name === 'finish' && toolResult.success) {
                  const gate = this.gateFinish(toolResult.data?.output || 'Task completed', supervisor);
                  if (gate.blocked && gateBlocks < 3) {
                    gateBlocks++;
                    context.history.push({ role: 'tool', toolCallId: toolCall.id, content: JSON.stringify({ success: true, data: { output: gate.message } }) });
                    break;
                  }
                  result = gate.result;
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
          context.history.push({ role: 'assistant', content: finalText || fullResponse, toolCalls: [{ id: `fallback_${i}`, name: toolCall.name, arguments: JSON.stringify(toolCall.args) }], reasoningContent: fullReasoning || undefined });
          const desktopImages: MessagePart[] = [];
          context.history.push({ role: 'tool', toolCallId: `fallback_${i}`, content: JSON.stringify(this.desktopResult(toolCall.name, toolResult, desktopImages)) });
          if (desktopImages.length) context.history.push({ role: 'user', content: '', parts: desktopImages });

          if (toolResult.success && toolCall.name === 'finish') {
            const gate = this.gateFinish(toolResult.data?.output || 'Task completed', supervisor);
            if (gate.blocked && gateBlocks < 3) {
              gateBlocks++;
              context.history.push({ role: 'user', content: gate.message });
              continue;
            }
            result = gate.result;
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
        }catch{this.handoffs.set(taskId,JSON.stringify({artifacts:[],outcome:'任务已结束，产物信息提取失败，请查看 Agent 会话。'}))}
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

  private getSystemPrompt(taskPrompt?: string, cwd = process.cwd(), forceSkill = '', minimal = false): string {
    const tools = this.tools.listTools();
    const toolDescriptions = tools
      .map(t => `- ${t.name}: ${t.description}\n  schema: ${JSON.stringify(t.parameters)}`)
      .join('\n');

    const skillBlock = this.settings.enable_skills
      ? `\n\n${this.skills.contextBlock(taskPrompt || '', forceSkill)}`
      : '';

    const evolveBlock = this.settings.self_evolve_enabled
      ? '\n\nSelf-iteration (this repository): call evolve_begin to get a worktree on a self/<slug> branch, edit files ONLY inside that worktree, then evolve_commit. If the base moved, evolve_upstream merges origin/main into the branch and reports conflicts for you to resolve. Finish with evolve_finish — but ask the user first with the question tool whether they want a pull request, and pass open_pr=true only when they said yes. If they decline, the branch stays local and their working checkout is untouched, which is the point.'
      : '';

    if (minimal) {
      return `You are an AI agent that can use tools to complete tasks.
Host OS: ${process.platform}. Working directory: ${cwd}.
The bash tool actually runs ${process.platform === 'win32' ? 'Windows cmd.exe: use cd/dir, && for chaining, no pwd/ls/Unix heredocs/semicolons; use the cwd argument.' : '/bin/sh'}.
Use write/edit for code files. Tool/program errors may be the correct diagnostic result; report them honestly instead of forcing success.
Verify every factual claim against evidence you retrieved and cite its source (file path, URL, DOI); never invent facts, citations or paths.

Available tools:
${toolDescriptions}
${skillBlock}${evolveBlock}

Use native tool calls when your model supports them; batch independent calls. Without native function calling, output exactly one JSON object:
{"tool": "tool_name", "args": {"param": "value"}}
Continue until the task is complete, then return a concise plain-text final answer.

If the turn produced files, call report_artifacts once (absolute path + one-line description each) just before the final answer.`;
    }

    return `You are an AI agent that can use tools to complete tasks.

Host OS: ${process.platform}. Working directory: ${cwd}.
Bash runs ${process.platform === 'win32' ? 'Windows cmd.exe (use cd/dir, && to chain; no pwd/ls/heredocs/semicolons; prefer the cwd argument over cd).' : '/bin/sh'}.
Use write/edit for code files, not shell echo. Report progress in assistant text before tool actions. Choose the smallest change that satisfies the request; avoid speculative features and repeated probes.
For multi-step work, first call todowrite with a short checklist and keep exactly one item in_progress; update it as items finish. Skip it for trivial requests.
A tool/program error can be the correct diagnostic result — report it honestly instead of forcing success.
Verification: back every factual claim with evidence you retrieved (tool result, file path, URL, DOI); label anything unverified. Never invent citations, URLs, DOIs, versions, figures, quotes or API signatures; prefer primary sources.

Available tools:
${toolDescriptions}
${skillBlock}${evolveBlock}

Use native tool calls when supported; batch independent calls (they run in parallel). Without native function calling, output exactly one JSON object:
{"tool": "tool_name", "args": {"param": "value"}}

Continue until the task is complete, then return a concise plain-text final answer with sources for factual claims and unverified items marked.

Deliverables: when the turn produced or modified files, call report_artifacts once (every deliverable, absolute path + one-line description) immediately before your final answer, so the UI can show the user a clickable list. Only list files that actually exist on disk; skip the call entirely when the turn produced nothing.`;
  }

  private contextBreakdown(cwd: string, conversationTokens: number, window: number) {
    const toolList = this.tools.listTools()
    const toolDescriptions = toolList.map(t => `- ${t.name}: ${t.description}\n  schema: ${JSON.stringify(t.parameters)}`).join('\n')
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
    if (context.options.permission_mode !== 'full_access' && !this.autoApproved(toolCall.name) && !this.readOnlyComputerUse(toolCall.name, args) && !ALWAYS_SAFE_TOOLS.has(toolCall.name)) {
      try { await this.approvals.request(context.taskId, context.sessionId, toolCall.name, args, context.cwd, context.signal); }
      catch (error: any) { context.signal.throwIfAborted(); return { success:false, data:null, error:error.message }; }
    }
    return serializeFileMutation(toolCall.name, () => this.recorder.run('tool', toolCall.name, context.taskId, context.sessionId, () => this.tools.call(toolCall.name, args, {
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
      runSubAgent: depth >= 2 || context.options.no_subagents === '1'
        ? undefined
        : async (subPrompt, subType) => {
            const subTaskId = `${context.taskId}:sub:${randomUUID()}`;
            return this.recorder.run('subagent', subPrompt, context.taskId, context.sessionId,
              () => this.executeTaskInternal(subTaskId, subPrompt, subType || agentType, depth + 1, context.sessionId, context.options),
              subTaskId);
          },
    }), undefined, serializeToolArgs(args)));
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

  async runDirect(tool: string, args: string): Promise<{ success: boolean; result: string; error: string }> {
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
    if(tool==='question_answer'){const ok=typeof parsed.answer==='string'&&this.questions.answer(String(parsed.id),parsed.answer);return {success:ok,result:'',error:ok?'':'Question expired or invalid answer'}};
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
        const items = entries
          .filter(entry => entry.name !== '.git' && entry.name !== 'node_modules')
          .map(entry => ({ name: entry.name, path: path.join(directory, entry.name), dir: entry.isDirectory() }))
          .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
        return { success: true, error: '', result: JSON.stringify({ path: directory, parent: path.dirname(directory), roots, entries: items }) };
      } catch (error: any) { return { success: false, result: '', error: error.message }; }
    }
    if (tool === 'workspace_read') {
      try {
        const file = path.resolve(String(parsed.path || ''));
        if (!isPathAllowed(file)) throw new Error('path not allowed: outside workspace roots');
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
        const breakdown = this.contextBreakdown(cwd, Number(parsed.conversation_tokens) || 0, Number(parsed.window) || 0)
        const sessionId = String(parsed.session_id || '')
        const lastPrompt = sessionId ? (sessionPromptTokens.get(sessionId) || 0) : 0
        return { success: true, result: JSON.stringify({ ...breakdown, last_prompt_tokens: lastPrompt }), error: '' }
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
          taskId: sessionIdOrEmpty(),
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
        const directId = sessionIdOrEmpty();
        try { await this.approvals.request(directId, 'direct', tool, parsed, cwd); }
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

    const directId=sessionIdOrEmpty();
    const mailMcp = tool === 'mcp' && String(parsed?.action || '') === 'call' && String(parsed?.server || '') === 'mail';
    if (!this.autoApproved(tool) && tool !== 'computeruse' && tool !== 'browser' && !mailMcp && !ALWAYS_SAFE_TOOLS.has(tool)) {
      try {await this.approvals.request(directId,'direct',tool,parsed,process.cwd())}
      catch(error:any) {return {success:false,result:'',error:error.message}}
    }
    const res = await this.tools.call(tool, parsed, {
      cwd: process.cwd(),
      taskId: sessionIdOrEmpty(),
      agentType: this.settings.default_agent_type,
      todo: [],
      mcp: this.mcp,
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
