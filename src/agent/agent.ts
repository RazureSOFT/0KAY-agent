/**
 * Agent main loop - Core can trigger via gRPC
 */

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
import { coreFetch, coreHeaders, listPluginTools } from '../connection.js';
import { browserController } from '../tools/browser.js';

/** Core HTTP base, used to pull uploaded attachments onto the agent host. */
const CORE_HTTP = process.env.CORE_HTTP_ADDR || process.env.CORE_HTTP || 'http://127.0.0.1:8080';

export interface AgentConfig {
  mocrAddress: string;
  maxIterations: number;
}

/**
 * Agent type that fans a problem out to several independent explorer sub-agents
 * before solving it, then synthesizes the best approach. See exploreSolutions.
 */
export const EXPLORE_AGENT_TYPE = 'code_explore';
export const EXPLORE_FANOUT = 5;
/** Explorers that miss this deadline are cancelled; the rest still feed the digest. */
export const EXPLORE_TIMEOUT_MS = 180_000;

/** Explorer sub-agents may only call these tools; everything else is rejected. */
const EXPLORE_READ_ONLY_TOOLS = new Set([
  'read', 'glob', 'grep', 'webfetch', 'websearch', 'papersearch', 'apidocsearch',
  'todowrite', 'compress', 'decompress', 'search_context', 'acp_status',
]);

/** Read a positive integer env override, clamped to [min, max]; out-of-range falls back. */
function envCount(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return Math.min(max, Math.floor(parsed));
}

/** Comma-separated tools that execute without approval prompts (bash intentionally excluded). */
export const DEFAULT_AUTO_APPROVE_TOOLS =
  'read,write,edit,apply_patch,glob,grep,webfetch,websearch,papersearch,apidocsearch,todowrite,skill,document,slides,compress,decompress,search_context,acp_status';

/**
 * Fixed handoff schema for in-run context compaction. Mirrors LIFE's
 * COMPACTION_HEADINGS so a compacted run and a compacted chat read the same.
 */
export const COMPACTION_SCHEMA_PROMPT =
  'Compress this execution transcript into a faithful, structured working summary so the run can continue after the raw history is dropped. Use EXACTLY these Markdown sections, in this order, and keep every section:\n' +
  '## Objective\n## Important Details\n## Work State\n## Next Move\n## Relevant Files\n' +
  'Objective: the current goal and what done means. Important Details: durable facts, decisions, constraints, file paths, IDs, tool results and errors, user answers, acceptance criteria, and questions already answered (never secrets). Work State: grouped as Completed / Active / Blocked, reporting only observed results and never inventing success. Next Move: the concrete immediate next step(s). Relevant Files: file_path:line references needed to continue. If a section has nothing, write 无. Carry prior facts forward. Start directly with ## Objective; no preamble or restated instructions. Be terse and factual, no process narration. Do not execute tools. Keep under 4000 words.';

/** Ledger-friendly tool arguments: drop bulky text payloads (line stats come from results). */
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

/** Runtime settings pulled from Core's /api/settings/agent section. */
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
  /** Browser automation via the Chrome DevTools Protocol. */
  enable_browser_tool?: boolean;
  /** Word/Markdown document generation. */
  enable_document_tool?: boolean;
  /** PowerPoint presentation generation. */
  enable_slides_tool?: boolean;
  /** Allow the WebUI terminal to run shell commands on this host. */
  enable_terminal?: boolean;
  vision_model?: string;
  /** Manual context window in tokens (0 = auto from the provider). */
  context_window?: number;
  enable_mcp_tool?: boolean;
  /** Allow tools contributed by plugins (via Core's tool catalog). */
  enable_plugin_tools?: boolean;
  enable_task_tool?: boolean;
  mcp_servers_json?: string;
  enable_skills?: boolean;
  skills_dir?: string;
  always_allow_tools?: string;
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
  /** Model-driven context compression ledger (billion-context style). */
  ledger?: ContextLedger;
}

export class Agent {
  private mocr: MocrProvider;
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
  /** Names of plugin-contributed tools currently registered (for refresh). */
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
      vision_model: '',
      context_window: 0,
      enable_mcp_tool: true,
      enable_plugin_tools: true,
      enable_task_tool: true,
      mcp_servers_json: '[]',
      enable_skills: true,
      skills_dir: '',
      always_allow_tools: DEFAULT_AUTO_APPROVE_TOOLS,
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

  /** Apply settings loaded from Core's Agent settings section. */
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
    this.applyToolToggles();
    void this.refreshPluginTools();
    void this.refreshMcpServers();
    void this.refreshPluginSkills();
  }

  getSettings(): Readonly<Required<AgentSettings>> {
    return { ...this.settings };
  }

  /** True when the tool is listed in always_allow_tools → skip approval prompts. */
  private autoApproved(tool: string): boolean {
    if (!tool) return false;
    return this.settings.always_allow_tools
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .includes(tool);
  }

  /** computeruse screenshot/listwindows are read-only and may run without a prompt. */
  private readOnlyComputerUse(tool: string, args: Record<string, any>): boolean {
    return tool === 'computeruse' && ['screenshot', 'listwindows'].includes(String(args?.action || ''));
  }

  private applyToolToggles(): void {
    // Rebuild registry so disabled tools are absent from listTools / call().
    this.tools = createDefaultRegistry(this.skills);
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

  /**
   * Pull tools contributed by plugins from Core's tool catalog and register
   * each as a dynamic tool that routes execution back through Core.
   */
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

  /**
   * Load the shared MCP server list from Core (Settings → MCP) plus any
   * plugin-contributed servers and configure the MCP manager. A user-configured
   * server wins over a plugin one with the same id.
   */
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
    } catch { /* keep whatever we have */ }
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
    } catch { /* keep whatever we have */ }
    if (servers.length) {
      this.mcp.configure(servers);
      void this.mcp.refresh().catch((error) => console.warn('[Agent] MCP refresh failed:', error.message));
    }
  }

  /** Load skill directories contributed by installed plugins. */
  private async refreshPluginSkills(): Promise<void> {
    if (!this.settings.enable_skills) return;
    try {
      const res = await coreFetch(`${CORE_HTTP}/api/plugins/capabilities`, { headers: coreHeaders(), signal: AbortSignal.timeout(8000) });
      if (!res.ok) return;
      const caps: any = await res.json();
      for (const skill of caps?.skills || []) {
        if (!skill?.path) continue;
        try { this.skills.loadDir(skill.path); } catch { /* ignore a bad skill dir */ }
      }
    } catch { /* ignore */ }
  }

  /**
   * Execute a task - main agent loop
   */
  async executeTask(taskId: string, prompt: string, agentType?: string, metadata: Record<string, string> = {}): Promise<string> {
    return this.executeTaskInternal(taskId, prompt, agentType, 0, metadata.session_id || '', metadata);
  }

  /** True for filenames/mimes whose bytes are safe to inline as UTF-8 text. */
  private isTextAttachment(name: string, mime: string): boolean {
    if (mime.startsWith('text/')) return true;
    if (['application/json', 'application/xml', 'application/javascript', 'application/x-yaml', 'application/yaml', 'application/toml'].includes(mime)) return true;
    return /\.(txt|md|markdown|json|ya?ml|toml|csv|tsv|log|py|js|mjs|cjs|ts|tsx|jsx|vue|go|rs|java|kt|c|h|cc|cpp|hpp|cs|rb|php|sh|ps1|bat|cmd|html?|css|scss|xml|ini|cfg|conf|sql|env)$/i.test(name);
  }

  private isImageAttachment(name: string, mime: string): boolean {
    return mime.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp)$/i.test(name);
  }

  /**
   * Fetch uploaded attachments referenced by the Core metadata (`attachments` is
   * a JSON array of {name,url,mime,size}) into memory and turn them into prompt
   * content: text files are inlined, images become multimodal parts sent
   * straight to the model. Nothing is written to disk.
   */
  private async collectAttachments(raw: string, signal: AbortSignal): Promise<{ text: string; images: MessagePart[] }> {
    let refs: Array<{ name?: string; url?: string; mime?: string }> = [];
    try { refs = JSON.parse(raw); } catch { return { text: '', images: [] }; }
    if (!Array.isArray(refs) || refs.length === 0) return { text: '', images: [] };
    const lines: string[] = [];
    const images: MessagePart[] = [];
    for (const ref of refs) {
      const url = String(ref?.url || '');
      if (!url) continue;
      const name = String(ref?.name || path.basename(url.split('?')[0]));
      const mime = String(ref?.mime || '');
      const absolute = /^https?:\/\//.test(url) ? url : `${CORE_HTTP}${url}`;
      try {
        const response = await coreFetch(absolute, { headers: coreHeaders(), signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (this.isImageAttachment(name, mime)) {
          const type = mime || 'image/png';
          images.push({ type: 'image', imageUrl: `data:${type};base64,${bytes.toString('base64')}`, mimeType: type });
          lines.push(`- ${name} (image attached to this turn)`);
        } else if (this.isTextAttachment(name, mime) && bytes.length <= 1_000_000) {
          const text = bytes.toString('utf8');
          const clipped = text.length > 12000 ? `${text.slice(0, 12000)}\n…(truncated)` : text;
          lines.push(`- ${name} (${mime || 'text'}, ${bytes.length} bytes):\n\`\`\`\n${clipped}\n\`\`\``);
        } else {
          lines.push(`- ${name} (${mime || 'application/octet-stream'}, ${bytes.length} bytes)`);
        }
      } catch (error: any) {
        if (signal.aborted) throw error;
        lines.push(`- ${url} (download failed: ${error?.message || error})`);
      }
    }
    return { text: lines.join('\n'), images };
  }

  /** True when any message in the history carries an image part. */
  private historyHasImages(messages: Message[]): boolean {
    return messages.some((message) => (message.parts || []).some((part) => part.type === 'image'));
  }

  /**
   * Run a model request, retrying once on the configured vision model when the
   * primary model rejects the attached images. The structured handoff schema is
   * never involved here.
   */
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

  /** Prompt-level thinking budget, applied to every model regardless of provider. */
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

  /** Rough token estimate: ~4 chars per token plus a flat cost per image part. */
  private estimateTokens(messages: Message[]): number {
    let chars = 0;
    let images = 0;
    for (const message of messages) {
      chars += message.content.length + JSON.stringify(message.toolCalls || []).length;
      for (const part of message.parts || []) {
        if (part.type === 'image') images += 1;
        else chars += (part.text || '').length;
      }
    }
    return Math.ceil(chars / 4) + images * 850;
  }

  private looksContextOverflow(error: any): boolean {
    return /context length|context_length|maximum context|max context|too long|token limit|too many tokens|reduce the length|exceeds? the maximum|上下文|超出/i.test(String(error?.message || error));
  }

  /** Replace the run history with the structured compaction handoff summary. */
  private async compactHistory(context: AgentContext, modelId: string, sessionId: string): Promise<void> {
    let summary = '';
    const transcript = JSON.stringify(context.history.map(({ parts, ...rest }) => parts?.length ? { ...rest, content: `${rest.content}\n[${parts.filter(p => p.type === 'image').length} image attachment(s) omitted]` } : rest));
    for await (const chunk of this.mocr.generate({ modelId, messages: [{ role: 'user', content: transcript }], systemPrompt: COMPACTION_SCHEMA_PROMPT, tools: [], toolChoice: 'none', signal: context.signal, taskId: context.taskId, sessionId, maxTokens: 5000 })) summary += chunk.chunk || '';
    if (!summary.trim()) throw new Error('Context compaction returned no summary');
    context.history = [{ role: 'user', content: context.prompt }, { role: 'assistant', content: `Structured context summary:\n${summary}` }];
  }

  private async executeTaskInternal(taskId: string, prompt: string, agentType: string | undefined, depth: number, sessionId: string, options: Record<string, string> = {}): Promise<string> {
    const type = (agentType && agentType !== 'default' ? agentType : this.settings.default_agent_type) || 'general';
    // /{skill_name} [request] → force-apply that skill and use the rest as the task.
    let forceSkill = '';
    if (this.settings.enable_skills) {
      const slash = /^\s*\/([A-Za-z0-9_-]{1,64})(?:\s+([\s\S]*))?$/.exec(prompt);
      if (slash && this.skills.get(slash[1])) {
        forceSkill = slash[1];
        const rest = (slash[2] || '').trim();
        prompt = rest || `Follow the "${forceSkill}" skill to produce the standard output for this request.`;
      }
      // A mode named after a skill activates it (e.g. agent_type "science").
      if (!forceSkill && type && type !== 'general' && this.skills.get(type)) forceSkill = type;
    }
    this.taskManager.createTask(taskId, prompt, type);
    return this.taskManager.executeTask(taskId, async () => {
      const cwd = options.workdir ? path.resolve(options.workdir) : process.cwd();
      if (!(await stat(cwd)).isDirectory()) throw new Error(`Workspace is not a directory: ${cwd}`);
      const signal = this.taskManager.signal(taskId);
      let initialParts: MessagePart[] | undefined;
      if (options.attachments) {
        const { text, images } = await this.collectAttachments(options.attachments, signal);
        if (text) prompt += `\n\nAttachments: the user uploaded these files.\n${text}`;
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
      // Model-driven context compression: the model folds ranges via the
      // compress/decompress/search_context/acp_status tools as context grows.
      context.ledger = new ContextLedger(() => context.history);

      let result = '';
      let lastModel = this.settings.model_id;
      let lastPromptTokens = 0;

      // Workspace snapshot (git state) so the model knows the repo it is in.
      try {
        const note = await this.workspaceContext(cwd);
        if (note) context.options.workspace_note = note;
      } catch { /* not a repo or git unavailable */ }

      // Explore mode: fan the problem out to independent explorer sub-agents,
      // then hand their proposals to the main loop to choose the best.
      if (type === EXPLORE_AGENT_TYPE && depth === 0 && options.skip_explore !== '1') {
        const baseType = options.base_agent_type || 'code';
        const proposals = await this.exploreSolutions(context, taskId, context.prompt, baseType);
        context.history.push({ role: 'user', content: this.explorationDigest(proposals) });
      }

      for (let i = 0; ; i++) {
        context.signal.throwIfAborted();
        // Pinned model wins; otherwise intelligent selection (agent-only ChooseModels)
        // Parse thinking intensity from life-prefixed prompt: [thinking_intensity=max]
        const intMatch = /\[thinking_intensity=(\w+)\]/i.exec(context.prompt)
        const intensity = (options.thinking_intensity || intMatch?.[1] || 'medium').toLowerCase()
        const numericIntensity=Number(intensity)
        const difficultyHint = Number.isFinite(numericIntensity) ? Math.max(0,Math.min(100,numericIntensity))/100 : ({ off:0, low: 0.2, medium: 0.5, high: 0.75, max: 1.0 }[intensity] ?? 0.5)
        const requireThinking = intensity !== 'off' && difficultyHint > 0
        // Thinking budget scales with intensity: reasoning tokens count toward
        // max_tokens for most reasoning models, so a flat default made every
        // level look identical.
        const maxTokens = Math.max(4096, Math.round(difficultyHint * 32768))
        let modelId = options.model_id === 'MOCR' ? '' : options.model_id || this.settings.model_id;
        if (!modelId) {
          modelId = await this.mocr.chooseModels(
            context.history.map(m => `${m.role}: ${m.content}`).join('\n'),
            requireThinking,
            difficultyHint,
            context.signal,
          );
        }
        lastModel = modelId;

        // Automatic context compaction: only when the context is nearly full.
        // The window is read from the provider's /models endpoint (context_length)
        // and cached; a configured context_window overrides it. When neither is
        // known, a provider overflow error below compacts reactively.
        let contextLimit = this.settings.context_window || 0;
        if (!contextLimit && typeof (this.mocr as any).modelContextLength === 'function') {
          contextLimit = await this.mocr.modelContextLength(modelId, context.signal).catch(() => 0);
        }
        if (contextLimit > 0 && (lastPromptTokens || this.estimateTokens(context.history)) > contextLimit * 0.85) {
          await this.compactHistory(context, modelId, context.sessionId);
          lastPromptTokens = 0;
        }

        let fullResponse = '';
        let finalText = '';
        let fullReasoning = '';
        let receivedNativeCalls = false;
        try {
        for await (const chunk of this.generateWithVisionFallback({
          modelId,
          messages: context.history,
          systemPrompt: this.getSystemPrompt(context.prompt, context.cwd, context.options.force_skill || '') + `\nPreferred UI language: ${options.language==='en'?'English':'Chinese'}. Match the user language in progress, questions and replies.\nIteration ${i + 1}. Continue until complete or cancelled. Ask the user with question when blocked; do not repeat failing actions without new evidence. ${this.thinkingDirective(intensity, difficultyHint)}` + (context.options.workspace_note ? `\n\nWorkspace context:\n${context.options.workspace_note}` : ''),
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
              for (let idx = 0; idx < nativeCalls.length; idx++) {
                const toolCall = nativeCalls[idx];
                const item = settled[idx];
                if (item.status === 'rejected') throw item.reason;
                const toolResult = item.value;
                if (toolCall.name === 'finish' && toolResult.success) {
                  result = toolResult.data?.output || 'Task completed';
                  break;
                }
                context.history.push({
                  role: 'tool',
                  toolCallId: toolCall.id,
                  content: JSON.stringify(toolResult),
                });
              }
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
          context.history.push({ role: 'assistant', content: finalText || fullResponse, toolCalls: [{ id: `fallback_${i}`, name: toolCall.name, arguments: JSON.stringify(toolCall.args) }], reasoningContent: fullReasoning || undefined });
          context.history.push({ role: 'tool', toolCallId: `fallback_${i}`, content: JSON.stringify(toolResult) });

          if (toolResult.success && toolCall.name === 'finish') {
            result = toolResult.data?.output || 'Task completed';
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
        }catch{this.handoffs.set(taskId,JSON.stringify({artifacts:[],outcome:'任务已结束，产物信息提取失败，请查看 Agent 会话。'}))}
      }
      return result;
    }, depth > 0);
  }

  /**
   * Fan a problem out to several independent explorer sub-agents (default
   * EXPLORE_FANOUT, override with OKAY_EXPLORE_FANOUT), each with a different
   * objective, and collect their proposals concurrently. Explorers run
   * read-only: editing, execution and further sub-agents are disabled for them.
   */
  private async exploreSolutions(context: AgentContext, taskId: string, prompt: string, baseType: string): Promise<Array<{ angle: string; result: string }>> {
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
    const fanout = envCount('OKAY_EXPLORE_FANOUT', EXPLORE_FANOUT, 1, angles.length);
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

  /** Turn the explorer proposals into the instruction that seeds the main loop. */
  private explorationDigest(proposals: Array<{ angle: string; result: string }>): string {
    const blocks = proposals.map((proposal, index) => {
      const text = (proposal.result || '').trim();
      const clipped = text.length > 4000 ? `${text.slice(0, 4000)}\n…(truncated)` : text;
      return `### Candidate ${index + 1} — ${proposal.angle}\n${clipped || '(no output)'}`;
    }).join('\n\n');
    return `${proposals.length} independent sub-agents explored the problem above from different angles. Review every candidate, then choose the best approach (or merge the strongest parts) and implement it. Judge by correctness, simplicity and fit to the existing code — verify against the repository rather than copying blindly. State which candidate you chose and why.\n\n${blocks}`;
  }

  /**
   * Compact git state for the workspace, injected into the system prompt so the
   * model knows the branch, pending changes and recent history (ZCode-style).
   */
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

  private getSystemPrompt(taskPrompt?: string, cwd = process.cwd(), forceSkill = ''): string {
    const tools = this.tools.listTools();
    const toolDescriptions = tools
      .map(t => `- ${t.name}: ${t.description}\n  schema: ${JSON.stringify(t.parameters)}`)
      .join('\n');

    const skillBlock = this.settings.enable_skills
      ? `\n\n${this.skills.contextBlock(taskPrompt || '', forceSkill)}`
      : '';

    return `You are an AI agent that can use tools to complete tasks.

Host OS: ${process.platform}. Working directory: ${cwd}.
The bash tool actually runs ${process.platform === 'win32' ? 'Windows cmd.exe: use cd to print the directory, dir to list files, && for chaining. Do not use pwd, ls, Unix heredocs, or semicolon chaining. Use the cwd argument instead of changing directories.' : '/bin/sh'}.
Use write/edit for code files rather than shell echo or fragile command quoting.
Report progress to the user in assistant text before tool actions. Preserve explanations and final results.
Choose the smallest implementation satisfying the request. Avoid unnecessary features or repeated probes.
For multi-step or long-running tasks (coding, research, analysis, anything needing several tool rounds), FIRST call the todowrite tool to lay out a short checklist plan and keep exactly one item in_progress. As soon as an item is finished, update the list with todowrite (mark it completed, or drop it) before starting the next, so the checklist reflects live progress. Skip the checklist for trivial single-step requests.
Distinguish tool/program errors from expected diagnostic results: an unreachable host or nonzero probe exit code may be the correct test result. Report it honestly rather than rewriting working code to force success.

Verification (required before every final answer): check each factual claim against evidence you actually retrieved (tool results, files, websearch/papersearch/apidocsearch hits). Attach its source — URL, DOI, or file path — for anything stated as fact. If a claim is not backed by evidence, either search to confirm it or label it explicitly as unverified/uncertain; never present a guess as fact. Never invent citations, URLs, DOIs, version numbers, figures, quotes or API signatures. Prefer primary sources (official docs, papers) over blogs for technical claims, and note when sources disagree.

Available tools:
${toolDescriptions}
${skillBlock}

Use native tool calls when your model supports them. Independent tool calls in
the same turn are executed in parallel, so batch them when they do not depend
on each other. For providers without native
function calling, output exactly one fallback JSON object:
{"tool": "tool_name", "args": {"param": "value"}}

After tool results arrive, continue until the task is complete. Return a concise
plain-text final answer when no further tools are needed, with sources for any
factual claim and unverified items clearly marked.`;
  }

  /** Approximate context composition (tokens) for the usage indicator. */
  private contextBreakdown(cwd: string, conversationTokens: number, window: number) {
    const tools = this.tools.listTools()
    const toolDescriptions = tools.map(t => `- ${t.name}: ${t.description}\n  schema: ${JSON.stringify(t.parameters)}`).join('\n')
    const skillBlock = this.settings.enable_skills ? `\n\n${this.skills.contextBlock('', undefined)}` : ''
    let mcpChars = 0
    try { mcpChars = this.mcp ? JSON.stringify(this.mcp.listTools()).length : 0 } catch { mcpChars = 0 }
    const full = this.getSystemPrompt('', cwd, '')
    const baseChars = Math.max(0, full.length - toolDescriptions.length - skillBlock.length)
    const toTokens = (chars: number) => Math.round(chars / 4)
    const system = toTokens(baseChars)
    const toolTokens = toTokens(toolDescriptions.length)
    const skillTokens = toTokens(skillBlock.length)
    const mcpTokens = toTokens(mcpChars)
    const conversation = Math.max(0, Math.round(conversationTokens))
    return { window, system, tools: toolTokens, skills: skillTokens, mcp: mcpTokens, conversation, used: system + toolTokens + skillTokens + mcpTokens + conversation }
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
    if (context.options.permission_mode !== 'full_access' && !this.autoApproved(toolCall.name) && !this.readOnlyComputerUse(toolCall.name, args)) {
      try { await this.approvals.request(context.taskId, context.sessionId, toolCall.name, args, context.cwd, context.signal); }
      catch (error: any) { context.signal.throwIfAborted(); return { success:false, data:null, error:error.message }; }
    }
    return this.recorder.run('tool', toolCall.name, context.taskId, context.sessionId, () => this.tools.call(toolCall.name, args, {
      cwd: context.cwd,
      taskId: context.taskId,
      sessionId: context.sessionId,
      agentType,
      todo: context.todo,
      mcp: this.mcp,
      history: context.history,
      ledger: context.ledger,
      signal: context.signal,
      runSubAgent: depth >= 2 || context.options.no_subagents === '1'
        ? undefined
        : async (subPrompt, subType) => {
            const subTaskId = `${context.taskId}:sub:${randomUUID()}`;
            return this.recorder.run('subagent', subPrompt, context.taskId, context.sessionId,
              () => this.executeTaskInternal(subTaskId, subPrompt, subType || agentType, depth + 1, context.sessionId, context.options),
              subTaskId);
          },
    }), undefined, serializeToolArgs(args));
  }

  private parseToolCall(response: string): { name: string; args: Record<string, any> } | null {
    try {
      // Try to extract JSON from response
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed.tool) {
          return { name: parsed.tool, args: parsed.args || {} };
        }
      }
    } catch {
      // Not a valid JSON tool call
    }
    return null;
  }

  getTaskManager(): TaskManager {
    return this.taskManager;
  }

  async close(): Promise<void> {
    for (const task of this.taskManager.getActiveTasks()) this.taskManager.cancelTask(task.id);
    await this.mcp.close();
  }

  async flushTaskRecords(): Promise<void> {
    await this.recorder.record();
  }

  /** Expose tool registry for direct (no-LLM) tool dispatch. */
  getTools(): ToolRegistry {
    return this.tools;
  }

  /**
   * Run a single tool immediately without an LLM loop (Core.RunDirect).
   */
  async runDirect(tool: string, args: string): Promise<{ success: boolean; result: string; error: string }> {
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
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, parsed.content, 'utf8');
        return { success: true, error: '', result: JSON.stringify({ path: file, bytes: Buffer.byteLength(parsed.content) }) };
      } catch (error: any) { return { success: false, result: '', error: error?.message || 'workspace_write failed' }; }
    }
    if (tool === 'workspace_read_binary') {
      try {
        if (!parsed.path) throw new Error('path is required');
        const file = path.resolve(String(parsed.path));
        const s = await stat(file);
        if (s.isDirectory()) return { success: false, result: '', error: 'is a directory' };
        if (s.size > 30 * 1024 * 1024) return { success: false, result: '', error: `file too large (${s.size} bytes)` };
        const buffer = await readFile(file);
        return { success: true, error: '', result: JSON.stringify({ path: file, size: buffer.length, base64: buffer.toString('base64') }) };
      } catch (error: any) { return { success: false, result: '', error: error?.message || 'workspace_read_binary failed' }; }
    }
    // Convert a document to another format (legacy .doc/.ppt → pdf) using
    // LibreOffice when it is installed on this host.
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
          // A private user profile per call avoids the "another instance is
          // already running" failure when conversions overlap.
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
    // Best-effort plain-text extraction for legacy Office formats.
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
      const ok=this.approvals.decide(String(parsed.id || ''),parsed.allow);
      return {success:ok,result:JSON.stringify({ok}),error:ok?'':'Approval expired or not found'};
    }
    if (tool === 'context_usage') {
      try {
        const cwd = typeof parsed.cwd === 'string' && parsed.cwd ? parsed.cwd : process.cwd()
        const breakdown = this.contextBreakdown(cwd, Number(parsed.conversation_tokens) || 0, Number(parsed.window) || 0)
        return { success: true, result: JSON.stringify(breakdown), error: '' }
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

    // Terminal console: the WebUI operator runs a shell command on this host
    // directly. The call is user-initiated, so it bypasses the approval gate.
    // Output is captured as raw bytes and re-decoded, because Windows cmd built-
    // ins emit the OEM code page even when the console code page is UTF-8.
    if (tool === 'terminal_exec') {
      try {
        if (!this.settings.enable_terminal) throw new Error('terminal-disabled: enable it in the agent plugin settings');
        const command = String(parsed.command || '');
        if (!command.trim()) throw new Error('command is required');
        const cwd = path.resolve(parsed.cwd ? String(parsed.cwd) : process.cwd());
        const timeoutMs = Math.max(1000, Math.min(Number(parsed.timeout) || 120000, 300000));
        const label = await getOemLabel();
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
    // Direct computeruse calls are already gated by Core's `computer_use`
    // permission (RunDirect) and the enable_computer_use setting, so LIFE's
    // autonomous loop can drive the mouse/keyboard without a second prompt.
    // Interactive agent tasks still prompt for non-read-only actions below.
    if (!this.autoApproved(tool) && tool !== 'computeruse' && tool !== 'browser') {
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

// --- legacy Office helpers ----------------------------------------------------
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
      } catch { /* not on PATH */ }
      return '';
    })();
  }
  // A failed lookup is not cached: installing LibreOffice takes effect on the
  // next conversion attempt without an agent restart.
  return sofficePromise.then((found) => { if (!found) sofficePromise = null; return found; });
}

// LibreOffice cannot run two instances against the same profile; serialize
// conversions so overlapping previews don't fail.
let sofficeChain: Promise<unknown> = Promise.resolve();
function runSofficeSerialized<T>(task: () => Promise<T>): Promise<T> {
  const run = sofficeChain.then(task, task);
  sofficeChain = run.catch(() => {});
  return run;
}

/** Pull text out of a legacy .ppt/.pot/.pps OLE stream (best effort, no layout). */
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

// --- terminal command runner (UTF-8 aware) ------------------------------------
// Windows cmd built-ins (`dir`, error messages, …) write the OEM code page to a
// pipe even after `chcp 65001`, so captured bytes are decoded as UTF-8 and, when
// that yields replacement characters, re-decoded with the system OEM code page.
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
          // Escalate in case the child ignores SIGTERM.
          setTimeout(() => { try { child?.kill('SIGKILL'); } catch { /* already dead */ } }, 5000);
        }
      } catch { /* ignore */ }
    }, timeoutMs);
  });
}
