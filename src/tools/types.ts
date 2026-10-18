/**
 * Shared tool base types for the 0kay Agent tool suite.
 *
 * This module has no imports from `tools.ts` so concrete tool modules can
 * extend `Tool` without creating an import cycle (tools.ts imports the concrete
 * tools to build the registry).
 */

export interface ToolResult {
  success: boolean;
  data: any;
  error?: string;
}

/** JSON Schema object describing a tool's arguments. */
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

/** A text/multimodal request routed through the agent's model channel (MOCR). */
export interface LlmRequest {
  messages: Array<{ role: string; content: string; parts?: LlmMessagePart[] }>;
  systemPrompt?: string;
  maxTokens?: number;
  model?: string;
  temperature?: number;
}

/** Model caller injected by the agent so tools reuse the MOCR channel instead
 *  of calling a provider directly. Returns the full text, or null when no model
 *  channel is available. */
export type LlmCaller = (request: LlmRequest) => Promise<string | null>;

export interface ToolContext {
  cwd: string;
  taskId: string;
  sessionId?: string;
  agentType: string;
  todo?: TodoItem[];
  runSubAgent?: (prompt: string, agentType?: string) => Promise<string>;
  mcp?: McpClientLike;
  signal?: AbortSignal;
  /** Live conversation history + its context ledger (model-driven compression). */
  history?: any[];
  ledger?: any;
  /** Model channel (MOCR). Tools that need a model call this first. */
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

/** Shared helper for success/failure. */
export function ok(data: any): ToolResult {
  return { success: true, data };
}

export function fail(error: string): ToolResult {
  return { success: false, data: null, error };
}
