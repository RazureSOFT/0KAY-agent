/**
 * Shared tool types for the 0kay Agent tool suite.
 */

export interface ToolResult {
  success: boolean;
  data: any;
  error?: string;
}

/** JSON Schema object describing a tool's arguments. */
export type JSONSchema = Record<string, any>;

export interface ToolContext {
  /** Working directory for the task. */
  cwd: string;
  /** Current task id. */
  taskId: string;
  /** Agent type (general / code / research / ...). */
  agentType: string;
  /** Optional sub-agent runner (for the `task` tool). */
  runSubAgent?: (prompt: string, agentType?: string) => Promise<string>;
  /** Optional MCP client (for the `mcp` tool). */
  mcp?: McpClientLike;
  /** Mutable per-session todo list. */
  todo?: TodoItem[];
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

export interface TodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  priority?: 'high' | 'medium' | 'low';
}

export abstract class Tool {
  abstract get name(): string;
  abstract get description(): string;
  /** JSON Schema for arguments; defaults to open object. */
  get parameters(): JSONSchema {
    return { type: 'object', properties: {} };
  }
  /** Whether this tool requires host/agent permission. */
  get dangerous(): boolean {
    return false;
  }
  abstract execute(args: Record<string, any>, ctx: ToolContext): Promise<ToolResult>;
}

/** Shared helper for success/failure. */
export function ok(data: any): ToolResult {
  return { success: true, data };
}

export function fail(error: string): ToolResult {
  return { success: false, data: null, error };
}
