/**
 * Agent main loop - Core can trigger via gRPC
 */

import { MocrProvider, Message, ToolCall } from '../provider/mocr.js';
import { ToolRegistry, createDefaultRegistry } from '../tools/tools.js';
import { SkillRegistry, getSkillRegistry } from '../skills/skills.js';
import { TaskManager, Task } from '../task/task.js';
import { McpManager, McpServerConfig } from '@0kay/mcp';

export interface AgentConfig {
  mocrAddress: string;
  maxIterations: number;
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
  enable_mcp_tool?: boolean;
  enable_task_tool?: boolean;
  mcp_servers_json?: string;
  enable_skills?: boolean;
  skills_dir?: string;
}

export interface AgentContext {
  taskId: string;
  prompt: string;
  history: Message[];
  todo: Array<{ id: string; content: string; status: 'pending' | 'in_progress' | 'completed' | 'cancelled'; priority?: 'high' | 'medium' | 'low' }>;
}

export class Agent {
  private mocr: MocrProvider;
  private tools: ToolRegistry;
  private skills: SkillRegistry;
  private taskManager: TaskManager;
  private mcp: McpManager;
  private config: AgentConfig;
  private settings: Required<AgentSettings>;

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
      enable_mcp_tool: true,
      enable_task_tool: true,
      mcp_servers_json: '[]',
      enable_skills: true,
      skills_dir: '',
    };

    this.mocr = new MocrProvider({ grpcAddress: this.config.mocrAddress });
    this.tools = createDefaultRegistry();
    this.skills = getSkillRegistry();
    this.mcp = new McpManager();
    this.taskManager = new TaskManager({ maxConcurrentTasks: this.settings.max_concurrent_tasks });

    this.taskManager.setOnComplete((task) => {
      console.log(`Task ${task.id} completed: ${task.state}`);
      // In production, this would call Core.LifePlugin.OnTaskCompleted
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
    if (typeof partial.enable_mcp_tool === 'boolean') this.settings.enable_mcp_tool = partial.enable_mcp_tool;
    if (typeof partial.enable_task_tool === 'boolean') this.settings.enable_task_tool = partial.enable_task_tool;
    if (typeof partial.mcp_servers_json === 'string') {
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
    if (typeof partial.skills_dir === 'string') {
      this.settings.skills_dir = partial.skills_dir.trim();
      if (this.settings.skills_dir) {
        this.skills.loadDir(this.settings.skills_dir);
      }
    }
    this.applyToolToggles();
  }

  getSettings(): Readonly<Required<AgentSettings>> {
    return { ...this.settings };
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
    if (!this.settings.enable_web_tools) for (const name of ['webfetch', 'websearch']) this.tools.unregister(name);
    if (!this.settings.enable_computer_use) this.tools.unregister('computeruse');
    if (!this.settings.enable_mcp_tool) this.tools.unregister('mcp');
    if (!this.settings.enable_task_tool) this.tools.unregister('task');
  }

  /**
   * Execute a task - main agent loop
   */
  async executeTask(taskId: string, prompt: string, agentType?: string): Promise<string> {
    return this.executeTaskInternal(taskId, prompt, agentType, 0);
  }

  private async executeTaskInternal(taskId: string, prompt: string, agentType: string | undefined, depth: number): Promise<string> {
    const type = (agentType && agentType !== 'default' ? agentType : this.settings.default_agent_type) || 'general';
    const task = this.taskManager.createTask(taskId, prompt, type);
    task.state = 'RUNNING';
    task.updatedAt = new Date();

    try {
      const context: AgentContext = {
        taskId,
        prompt,
        history: [{ role: 'user', content: prompt }],
        todo: [],
      };

      let result = 'Max iterations reached';
      const maxIters = this.settings.max_iterations || this.config.maxIterations;

      for (let i = 0; i < maxIters; i++) {
        // Pinned model wins; otherwise intelligent selection (agent-only ChooseModels)
        // Parse thinking intensity from life-prefixed prompt: [thinking_intensity=max]
        const intMatch = /\[thinking_intensity=(\w+)\]/i.exec(context.prompt)
        const intensity = (intMatch?.[1] || '').toLowerCase()
        const difficultyHint = { low: 0.2, medium: 0.5, high: 0.75, max: 1.0 }[intensity] ?? 0.5
        const requireThinking = intensity === 'high' || intensity === 'max'
        let modelId = this.settings.model_id;
        if (!modelId) {
          modelId = await this.mocr.chooseModels(
            context.history.map(m => `${m.role}: ${m.content}`).join('\n'),
            requireThinking,
            difficultyHint,
          );
        }

        let fullResponse = '';
        let finalText = '';
        let receivedNativeCalls = false;
        for await (const chunk of this.mocr.generate({
          modelId,
          messages: context.history,
          systemPrompt: this.getSystemPrompt(context.prompt),
          temperature: intensity === 'max' ? Math.max(this.settings.temperature, 0.9) : this.settings.temperature,
          thinking: requireThinking,
          difficultyHint,
          requireThinking,
          tools: this.tools.listTools(),
          toolChoice: 'auto',
        })) {
          if (chunk.chunk) {
            fullResponse += chunk.chunk;
          }
          if (chunk.done) {
            if (chunk.text) finalText = chunk.text;
            const nativeCalls = chunk.toolCalls || [];
            if (nativeCalls.length) {
              receivedNativeCalls = true;
              context.history.push({
                role: 'assistant',
                content: finalText || fullResponse,
                toolCalls: nativeCalls,
              });
              for (const toolCall of nativeCalls) {
                const toolResult = await this.executeToolCall(toolCall, context, type, depth);
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
              if (result !== 'Max iterations reached') break;
            }
            break;
          }
        }

        if (result !== 'Max iterations reached') break;
        if (receivedNativeCalls) continue;
        const toolCall = this.parseToolCall(finalText || fullResponse);
        if (toolCall) {
          const toolResult = await this.executeToolCall({ id: `fallback_${i}`, name: toolCall.name, arguments: JSON.stringify(toolCall.args) }, context, type, depth);
          context.history.push({ role: 'assistant', content: finalText || fullResponse, toolCalls: [{ id: `fallback_${i}`, name: toolCall.name, arguments: JSON.stringify(toolCall.args) }] });
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

      task.state = 'DONE';
      task.result = result;
      task.updatedAt = new Date();
      this.taskManager.notifyComplete(task);
      return result;
    } catch (error: any) {
      task.state = 'FAILED';
      task.error = error.message;
      task.updatedAt = new Date();
      this.taskManager.notifyComplete(task);
      throw error;
    }
  }

  private getSystemPrompt(taskPrompt?: string): string {
    const tools = this.tools.listTools();
    const toolDescriptions = tools
      .map(t => `- ${t.name}: ${t.description}\n  schema: ${JSON.stringify(t.parameters)}`)
      .join('\n');

    const skillBlock = this.settings.enable_skills
      ? `\n\n${this.skills.contextBlock(taskPrompt || '')}`
      : '';

    return `You are an AI agent that can use tools to complete tasks.

Available tools:
${toolDescriptions}
${skillBlock}

Use native tool calls when your model supports them. For providers without native
function calling, output exactly one fallback JSON object:
{"tool": "tool_name", "args": {"param": "value"}}

After tool results arrive, continue until the task is complete. Return a concise
plain-text final answer when no further tools are needed.`;
  }

  private async executeToolCall(toolCall: ToolCall, context: AgentContext, agentType: string, depth: number) {
    let args: Record<string, any> = {};
    try {
      args = toolCall.arguments ? JSON.parse(toolCall.arguments) : {};
    } catch {
      return { success: false, data: null, error: `invalid JSON arguments for ${toolCall.name}` };
    }
    if (toolCall.name === 'finish') return { success: true, data: { output: String(args.output ?? args.result ?? '') } };
    return this.tools.call(toolCall.name, args, {
      cwd: process.cwd(),
      taskId: context.taskId,
      agentType,
      todo: context.todo,
      mcp: this.mcp,
      runSubAgent: depth >= 2
        ? undefined
        : async (subPrompt, subType) => this.executeTaskInternal(`${context.taskId}:sub:${Date.now()}`, subPrompt, subType || agentType, depth + 1),
    });
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

    if (tool === 'finish') {
      return { success: true, result: String(parsed.output ?? parsed.result ?? args ?? ''), error: '' }
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

function sessionIdOrEmpty(): string {
  return `direct:${Date.now()}`;
}
