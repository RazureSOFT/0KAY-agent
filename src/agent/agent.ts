/**
 * Agent main loop - Core can trigger via gRPC
 */

import { MocrProvider, Message, ToolCall } from '../provider/mocr.js';
import { ToolRegistry, createDefaultRegistry } from '../tools/tools.js';
import { SkillRegistry, getSkillRegistry } from '../skills/skills.js';
import { TaskManager, Task } from '../task/task.js';
import { McpManager, McpServerConfig } from '@0kay/mcp';
import { randomUUID } from 'crypto';
import * as path from 'path';
import { stat, readdir, mkdir } from 'fs/promises';
import { ApprovalManager } from '../task/approvals.js';
import { QuestionManager } from '../task/questions.js';
import * as os from 'os';
import { taskRecorder } from '../task/records.js';

export interface AgentConfig {
  mocrAddress: string;
  maxIterations: number;
}

/** Comma-separated tools that execute without approval prompts (bash intentionally excluded). */
export const DEFAULT_AUTO_APPROVE_TOOLS =
  'read,write,edit,apply_patch,glob,grep,webfetch,websearch,todowrite,skill';

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
  enable_mcp_tool?: boolean;
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
      enable_mcp_tool: true,
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
    if (typeof partial.enable_mcp_tool === 'boolean') this.settings.enable_mcp_tool = partial.enable_mcp_tool;
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
    if (!this.settings.enable_skills) this.tools.unregister('skill');
  }

  /**
   * Execute a task - main agent loop
   */
  async executeTask(taskId: string, prompt: string, agentType?: string, metadata: Record<string, string> = {}): Promise<string> {
    return this.executeTaskInternal(taskId, prompt, agentType, 0, metadata.session_id || '', metadata);
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
    }
    this.taskManager.createTask(taskId, prompt, type);
    return this.taskManager.executeTask(taskId, async () => {
      const cwd = options.workdir ? path.resolve(options.workdir) : process.cwd();
      if (!(await stat(cwd)).isDirectory()) throw new Error(`Workspace is not a directory: ${cwd}`);
      const context: AgentContext = {
        taskId,
        prompt,
        history: [{ role: 'user', content: prompt }],
        todo: [],
        signal: this.taskManager.signal(taskId),
        sessionId,
        cwd,
        options: forceSkill ? { ...options, force_skill: forceSkill } : options,
      };

      let result = '';
      let lastModel = this.settings.model_id;

      for (let i = 0; ; i++) {
        context.signal.throwIfAborted();
        // Unlimited iterations still need a bounded model context. Compact only
        // between completed tool batches so call/result pairs remain intact.
        if(context.history.reduce((size,message)=>size+message.content.length+JSON.stringify(message.toolCalls||[]).length,0)>80000 && lastModel){
          let summary='';
          for await(const chunk of this.mocr.generate({modelId:lastModel,messages:[{role:'user',content:JSON.stringify(context.history)}],systemPrompt:'Compress this execution transcript into a faithful working summary. Preserve file paths, changes, tool results/errors, user answers, acceptance criteria and pending work. Do not execute tools. Keep under 4000 words.',tools:[],toolChoice:'none',signal:context.signal,taskId,sessionId,maxTokens:5000}))summary+=chunk.chunk||'';
          if(!summary.trim())throw new Error('Context compaction returned no summary');
          context.history=[{role:'user',content:prompt},{role:'assistant',content:`Execution context summary:\n${summary}`}];
        }
        // Pinned model wins; otherwise intelligent selection (agent-only ChooseModels)
        // Parse thinking intensity from life-prefixed prompt: [thinking_intensity=max]
        const intMatch = /\[thinking_intensity=(\w+)\]/i.exec(context.prompt)
        const intensity = (options.thinking_intensity || intMatch?.[1] || 'medium').toLowerCase()
        const numericIntensity=Number(intensity)
        const difficultyHint = Number.isFinite(numericIntensity) ? Math.max(0,Math.min(100,numericIntensity))/100 : ({ off:0, low: 0.2, medium: 0.5, high: 0.75, max: 1.0 }[intensity] ?? 0.5)
        const requireThinking = intensity !== 'off' && difficultyHint > 0
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

        let fullResponse = '';
        let finalText = '';
        let fullReasoning = '';
        let receivedNativeCalls = false;
        for await (const chunk of this.mocr.generate({
          modelId,
          messages: context.history,
          systemPrompt: this.getSystemPrompt(context.prompt, context.cwd, context.options.force_skill || '') + `\nPreferred UI language: ${options.language==='en'?'English':'Chinese'}. Match the user language in progress, questions and replies.\nIteration ${i + 1}. Continue until complete or cancelled. Ask the user with question when blocked; do not repeat failing actions without new evidence.`,
          temperature: this.settings.temperature,
          thinking: requireThinking,
          difficultyHint,
          requireThinking,
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
Distinguish tool/program errors from expected diagnostic results: an unreachable host or nonzero probe exit code may be the correct test result. Report it honestly rather than rewriting working code to force success.

Available tools:
${toolDescriptions}
${skillBlock}

Use native tool calls when your model supports them. Independent tool calls in
the same turn are executed in parallel, so batch them when they do not depend
on each other. For providers without native
function calling, output exactly one fallback JSON object:
{"tool": "tool_name", "args": {"param": "value"}}

After tool results arrive, continue until the task is complete. Return a concise
plain-text final answer when no further tools are needed.`;
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
    if (context.options.permission_mode !== 'full_access' && !this.autoApproved(toolCall.name)) {
      try { await this.approvals.request(context.taskId, context.sessionId, toolCall.name, args, context.cwd, context.signal); }
      catch (error: any) { context.signal.throwIfAborted(); return { success:false, data:null, error:error.message }; }
    }
    return this.recorder.run('tool', toolCall.name, context.taskId, context.sessionId, () => this.tools.call(toolCall.name, args, {
      cwd: context.cwd,
      taskId: context.taskId,
      agentType,
      todo: context.todo,
      mcp: this.mcp,
      signal: context.signal,
      runSubAgent: depth >= 2
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
    if (tool === 'host_status') {
      const sample = () => os.cpus().reduce((sum, cpu) => ({ idle: sum.idle + cpu.times.idle, total: sum.total + Object.values(cpu.times).reduce((a,b) => a+b,0) }), {idle:0,total:0});
      const before = sample();
      await new Promise(resolve => setTimeout(resolve, 250));
      const after = sample();
      return { success: true, error: '', result: JSON.stringify({ cpu_percent: Math.max(0,Math.min(100,100*(1-(after.idle-before.idle)/Math.max(1,after.total-before.total)))), memory_percent:100*(1-os.freemem()/os.totalmem()), sampled_at:new Date().toISOString() }) };
    }

    if (tool === 'finish') {
      return { success: true, result: String(parsed.output ?? parsed.result ?? args ?? ''), error: '' }
    }

    const directId=sessionIdOrEmpty();
    if (!this.autoApproved(tool)) {
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

function sessionIdOrEmpty(): string {
  return `direct:${Date.now()}`;
}
