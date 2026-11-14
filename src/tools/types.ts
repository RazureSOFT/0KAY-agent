import type { SubAgentRunner } from '../agent/subagents.js'
import type { SandboxPolicy } from '../sandbox/policy.js'
import type { ReconGraph } from '../analysis/recon/graph.js'
export interface ToolResult {
  success: boolean;
  data: any;
  error?: string;
}

export type JSONSchema = Record<string, any>;

export interface TodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  priority?: 'high' | 'medium' | 'low';
}

export interface McpToolInfo {
  server: string;
  name: string;
  description: string;
  inputSchema?: JSONSchema;
}

export interface McpClientLike {
  listTools(): McpToolInfo[];
  callTool(server: string, tool: string, args: Record<string, any>): Promise<any>;
}

export interface LlmMessagePart { type: string; text?: string; imageUrl?: string; mimeType?: string; }

export interface LlmRequest {
  messages: Array<{ role: string; content: string; parts?: LlmMessagePart[] }>;
  systemPrompt?: string;
  maxTokens?: number;
  model?: string;
  temperature?: number;
}

export type LlmCaller = (request: LlmRequest) => Promise<string | null>;

export interface ToolContext {
  cwd: string;
  taskId: string;
  sessionId?: string;
  agentType: string;
  todo?: TodoItem[];
  runSubAgent?: (prompt: string, agentType?: string) => Promise<string>;
  /** Spawn/list/cancel child agents. Absent at the deepest level, which is how recursion stops. */
  subagents?: SubAgentRunner;
  /** What this task may touch. Absent means "no policy", used only by tests. */
  sandbox?: SandboxPolicy;
  /** Asset + exploration graphs for this task (the recon_graph tool). */
  recon?: ReconGraph;
  /** Background assessment tasks (the assessments tool). */
  assessments?: import('../analysis/recon/tasks.js').AssessmentManager;
  /**
   * The RECON run context: the session's shared graph plus the active run's
   * trace store and live constraints. Present only while an assessment (or
   * deep_scan) is running in this session — the RECON tool surface operates
   * through it.
   */
  reconRun?: import('../analysis/recon/tasks.js').ReconRunContext;
  /** Session UI directives (the session tool): titles and toasts, applied by core on its next inbox poll. */
  sessionDirectives?: import('../task/directives.js').SessionDirectives;
  /** The intent ledger and 100% gate for this task (the intent tool). */
  gate?: import('../agent/gate.js').QualityGate;
  /** fact_1..fact_10, the task's durable memory (the fact tool). */
  facts?: import('../agent/facts.js').FactMemory;
  /** Checks that a memory or experience write is allowed before it lands. */
  permissions?: import('../agent/permission.js').PermissionLedger;
  /** The message -> library -> model stage, for tools that want the learned rules. */
  library?: import('../agent/library.js').RuleLibrary;
  /**
   * An LLM caller that survives the current tool call — no abort signal from
   * this context rides along. Background assessment tasks must use this, or
   * every model call dies the moment the task-creating call returns.
   */
  backgroundLlm?: LlmCaller;
  /** Which tool groups this task has loaded into its prompt. */
  toolGroups?: {
    list(): Array<{ group: string; hint: string; loaded: boolean; tools: string[] }>;
    load(group: string): boolean;
    unload(group: string): boolean;
  };
  mcp?: McpClientLike;
  signal?: AbortSignal;
  history?: any[];
  ledger?: any;
  llm?: LlmCaller;
  /**
   * Per-task options, the same map the agent uses for per-turn overrides.
   * Present so a tool (the plan tool) can read the user's own words and the
   * plan-quality threshold without a second channel. Absent in tests, which is
   * what "no review configured" looks like.
   */
  options?: Record<string, string>;
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

export function ok(data: any): ToolResult {
  return { success: true, data };
}

export function fail(error: string): ToolResult {
  return { success: false, data: null, error };
}
