import type { SubAgentRunner } from '../agent/subagents.js'
import type { SandboxPolicy } from '../sandbox/policy.js'
import type { ReconGraph } from '../analysis/artex/graph.js'
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
  assessments?: import('../analysis/artex/tasks.js').AssessmentManager;
  /**
   * The ARTEX run context: the session's shared graph plus the active run's
   * trace store and live constraints. Present only while an assessment (or
   * deep_scan) is running in this session — the ARTEX tool surface operates
   * through it.
   */
  artex?: import('../analysis/artex/tasks.js').ArtexRunContext;
  /** Session UI directives (the session tool): titles and toasts, applied by core on its next inbox poll. */
  sessionDirectives?: import('../task/directives.js').SessionDirectives;
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
