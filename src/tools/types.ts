import type { SubAgentRunner } from '../agent/subagents.js'
import type { SandboxPolicy } from '../sandbox/policy.js'
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
