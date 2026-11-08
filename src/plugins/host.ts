import * as fs from 'fs'
import * as path from 'path'
import { pathToFileURL } from 'url'
import { Tool, type ToolContext, type ToolResult } from '../tools/types.js'
import type { PluginManifest, LoadedPlugin } from './manifest.js'
import { scanPlugins } from './manifest.js'

/**
 * The surface a plugin module receives.
 *
 * Deliberately small. A plugin gets its own tools, a way to add prompt text,
 * and hooks that observe or veto a tool call. It does not get the agent, the
 * provider, the sandbox, or the Core connection: every capability it has is one
 * of these functions, and each is gated by a declared permission.
 */
export interface PluginApi {
  readonly name: string
  readonly dir: string
  /** Register a tool. Requires `tools:register`. */
  addTool(tool: PluginToolSpec): void
  /** Append text to the system prompt. Requires `hooks:prompt`. */
  addPrompt(text: string): void
  /** Log a line; shows in the plugin's row in settings. */
  log(message: string): void
  /** Read a file inside the plugin directory. Requires `filesystem:read`. */
  readFile(relative: string): string
  /** Write a file inside the plugin directory. Requires `filesystem:write`. */
  writeFile(relative: string, content: string): void
}

export interface PluginToolSpec {
  name: string
  description: string
  parameters?: Record<string, any>
  dangerous?: boolean
  execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> | ToolResult
}

export interface ToolCallVeto {
  /** When set, the call is refused and this text is returned to the model. */
  block?: string
  /** When set, the arguments are replaced before the tool runs. */
  args?: Record<string, any>
}

export interface PluginGateCheckInput {
  taskId: string
  intents: PluginIntentRow[]
  completion: number
  touched: string[]
  claim: string
  /** What the agent actually ran, in order. Lets a policy check for a real proof. */
  trace: Array<{ name: string; ok: boolean; evidence?: string }>
  delivery: { status: string; mutations: number; evidence: string[] }
}

export interface PluginIntentRow {
  id?: string
  description: string
  method?: string
  status?: 'pending' | 'in_progress' | 'done' | 'blocked'
  evidence?: string
}

export interface PluginHooks {
  /** Called once per task, after the system prompt is assembled. */
  onTaskStart?(input: { prompt: string; cwd: string; taskId: string; sessionId?: string }): void | Promise<void>
  /** Called before a tool runs; may block or rewrite it. Requires `hooks:tool`. */
  beforeToolCall?(input: { tool: string; args: Record<string, any>; cwd: string }): ToolCallVeto | void | Promise<ToolCallVeto | void>
  /** Called after a tool ran. Cannot change the result. */
  afterToolCall?(input: { tool: string; args: Record<string, any>; success: boolean; output: string }): void | Promise<void>
  /** Called before each model turn; may add text to that turn only. */
  beforeModelCall?(input: { iteration: number; model: string }): { prompt?: string } | void | Promise<{ prompt?: string } | void>
  /**
   * Called whenever the intent ledger changes. May append intents the plugin
   * knows the task needs. Requires `hooks:gate`.
   *
   * It cannot mark anything done or clear a row: the ledger is the agent's
   * account of the work, and a plugin that could close items would be able to
   * satisfy the gate on the agent's behalf.
   */
  onIntentUpdate?(input: { taskId: string; intents: PluginIntentRow[]; completion: number; approach: string }): PluginIntentRow[] | void | Promise<PluginIntentRow[] | void>
  /**
   * Called before the reviewer runs on a 100% claim. May add a reason to reject
   * (a `block` string) or a note that goes to the reviewer. Requires `hooks:gate`.
   *
   * A block is a policy refusal, not a verdict: it comes back to the agent as
   * `source: "plugin"` so it can be told apart from a reviewer rejection.
   */
  onGateCheck?(input: PluginGateCheckInput): { block?: string; note?: string } | void | Promise<{ block?: string; note?: string } | void>
  /** Called once when a task ends, whatever the outcome. Requires `hooks:gate`. */
  onTaskEnd?(input: { taskId: string; status: 'success' | 'rejected' | 'failed' | 'cancelled'; completion: number }): void | Promise<void>
  /**
   * Called for every turn after the library stage, so a plugin can add a rule to
   * this turn only. Requires `hooks:library`.
   */
  onLibraryInjection?(input: { message: string; kind: 'chat' | 'task'; rules: string[] }): string[] | void | Promise<string[] | void>
}

export interface LoadedModulePlugin extends LoadedPlugin {
  hooks: PluginHooks
  tools: PluginToolSpec[]
  promptText: string
  logs: string[]
  /** Set when the module failed; the declarative half still applies. */
  loadError?: string
}

export interface PluginRecord {
  manifest: PluginManifest
  dir: string
  enabled: boolean
  warnings: string[]
  tools: string[]
  hasModule: boolean
  loadError?: string
  logs: string[]
}

/**
 * Hook budget, in calls per task.
 *
 * A hook that runs on every tool call in a long task is a loop waiting to
 * happen: a plugin that throws, or that is just slow, can turn a 40-step task
 * into a hang. Past this the hook is skipped and the skip is reported once.
 */
const HOOK_BUDGET_PER_TASK = 2000

interface HookState {
  calls: number
  skipped: boolean
}

export class PluginHost {
  private plugins: LoadedModulePlugin[] = []
  private errors: Array<{ dir: string; error: string }> = []
  private hooks = new Map<string, HookState>()
  private loadedAt = 0
  private readonly roots: string[]

  /**
   * @param roots Directories to read, in priority order. A name found in an
   *   earlier root wins, so a user's copy of a bundled plugin overrides it
   *   instead of loading twice.
   */
  constructor(roots: string | string[], private readonly enabled: Set<string> | null) {
    const list = Array.isArray(roots) ? roots : [roots]
    const seenDirs = new Set<string>()
    this.roots = []
    for (const root of list) {
      const resolved = path.resolve(root)
      if (seenDirs.has(resolved)) continue
      seenDirs.add(resolved)
      this.roots.push(resolved)
    }
  }

  async load(): Promise<void> {
    this.plugins = []
    this.errors = []
    const seen = new Set<string>()
    for (const root of this.roots) {
      const { plugins, errors } = scanPlugins(root)
      for (const error of errors) this.errors.push(error)
      for (const plugin of plugins) {
        if (seen.has(plugin.manifest.name)) continue
        seen.add(plugin.manifest.name)
        if (this.enabled && !this.enabled.has(plugin.manifest.name)) continue
        this.plugins.push(await this.materialise(plugin))
      }
    }
    this.loadedAt = Date.now()
  }

  private async materialise(plugin: LoadedPlugin): Promise<LoadedModulePlugin> {
    const record: LoadedModulePlugin = {
      ...plugin,
      hooks: {},
      tools: [],
      promptText: plugin.manifest.behaviour?.prompt || '',
      logs: [],
    }
    if (!plugin.manifest.entry) return record
    const granted = new Set(plugin.manifest.permissions || [])
    const dir = plugin.dir
    const api: PluginApi = {
      name: plugin.manifest.name,
      dir,
      addTool: (tool) => {
        this.require(granted, 'tools:register', plugin.manifest.name)
        if (!tool || typeof tool.name !== 'string' || !tool.name.trim()) {
          throw new Error('addTool needs a name')
        }
        if (typeof tool.execute !== 'function') {
          throw new Error(`tool ${tool.name} has no execute function`)
        }
        record.tools.push({
          name: tool.name.trim(),
          description: tool.description || `Tool from plugin ${plugin.manifest.name}.`,
          parameters: tool.parameters,
          dangerous: !!tool.dangerous,
          execute: tool.execute,
        })
      },
      addPrompt: (text) => {
        this.require(granted, 'hooks:prompt', plugin.manifest.name)
        const clean = String(text || '').trim()
        if (clean) record.promptText = record.promptText ? `${record.promptText}\n\n${clean}` : clean
      },
      log: (message) => {
        if (record.logs.length < 50) record.logs.push(String(message).slice(0, 400))
      },
      readFile: (relative) => {
        this.require(granted, 'filesystem:read', plugin.manifest.name)
        return fs.readFileSync(this.inside(dir, relative, plugin.manifest.name), 'utf-8')
      },
      writeFile: (relative, content) => {
        this.require(granted, 'filesystem:write', plugin.manifest.name)
        const target = this.inside(dir, relative, plugin.manifest.name)
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.writeFileSync(target, String(content), 'utf-8')
      },
    }
    try {
      // The cache-busting suffix is the load time, so a reload after editing
      // picks up the new module instead of the one already in the module graph.
      const url = pathToFileURL(path.join(dir, plugin.manifest.entry!)).href + `?t=${Date.now()}`
      const module = await import(url)
      const factory = module.default ?? module.register
      if (typeof factory !== 'function') {
        throw new Error('module must export a default function (or `register`)')
      }
      const returned = await factory(api)
      if (returned && typeof returned === 'object') {
        const hooks = returned as Record<string, unknown>
        // A plugin that hangs out a hook without the permission does not get to
        // use it; the declarative half of the plugin still loads.
        const allowed = (permission: string) => granted.has(permission)
        if (typeof hooks.onTaskStart === 'function') record.hooks.onTaskStart = hooks.onTaskStart as PluginHooks['onTaskStart']
        if (typeof hooks.beforeModelCall === 'function') {
          record.hooks.beforeModelCall = allowed('hooks:prompt') ? hooks.beforeModelCall as PluginHooks['beforeModelCall'] : undefined
        }
        if (typeof hooks.beforeToolCall === 'function') {
          record.hooks.beforeToolCall = allowed('hooks:tool') ? hooks.beforeToolCall as PluginHooks['beforeToolCall'] : undefined
        }
        if (typeof hooks.afterToolCall === 'function') {
          record.hooks.afterToolCall = allowed('hooks:tool') ? hooks.afterToolCall as PluginHooks['afterToolCall'] : undefined
        }
        if (typeof hooks.onIntentUpdate === 'function') {
          record.hooks.onIntentUpdate = allowed('hooks:gate') ? hooks.onIntentUpdate as PluginHooks['onIntentUpdate'] : undefined
        }
        if (typeof hooks.onGateCheck === 'function') {
          record.hooks.onGateCheck = allowed('hooks:gate') ? hooks.onGateCheck as PluginHooks['onGateCheck'] : undefined
        }
        if (typeof hooks.onTaskEnd === 'function') {
          record.hooks.onTaskEnd = allowed('hooks:gate') ? hooks.onTaskEnd as PluginHooks['onTaskEnd'] : undefined
        }
        if (typeof hooks.onLibraryInjection === 'function') {
          record.hooks.onLibraryInjection = allowed('hooks:library') ? hooks.onLibraryInjection as PluginHooks['onLibraryInjection'] : undefined
        }
      }
    } catch (error) {
      record.loadError = error instanceof Error ? error.message : String(error)
    }
    return record
  }

  private require(granted: Set<string>, permission: string, name: string): void {
    if (!granted.has(permission)) {
      throw new Error(`plugin "${name}" used ${permission} without declaring it`)
    }
  }

  private inside(dir: string, relative: string, name: string): string {
    const target = path.resolve(dir, String(relative || ''))
    const rel = path.relative(path.resolve(dir), target)
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`plugin "${name}" tried to reach outside its directory: ${relative}`)
    }
    return target
  }

  /** Reset the per-task hook counters. Called when a task starts. */
  startTask(): void {
    this.hooks.clear()
  }

  /** Whether a hook may run again in this task. */
  private spend(name: string, hook: string): boolean {
    const key = `${name}:${hook}`
    let state = this.hooks.get(key)
    if (!state) {
      state = { calls: 0, skipped: false }
      this.hooks.set(key, state)
    }
    if (state.calls >= HOOK_BUDGET_PER_TASK) {
      if (!state.skipped) {
        state.skipped = true
        const plugin = this.plugins.find((p) => p.manifest.name === name)
        if (plugin && plugin.logs.length < 50) {
          plugin.logs.push(`${hook} exceeded ${HOOK_BUDGET_PER_TASK} calls in one task; skipped from here on`)
        }
      }
      return false
    }
    state.calls++
    return true
  }

  /** Prompt text from every enabled plugin, in load order. */
  promptBlock(): string {
    const parts: string[] = []
    for (const plugin of this.plugins) {
      const text = plugin.promptText.trim()
      if (!text) continue
      parts.push(`### Plugin: ${plugin.manifest.title || plugin.manifest.name}\n${text}`)
    }
    return parts.join('\n\n')
  }

  /** Rules contributed by plugins, in the shape the rule library expects. */
  rules(): Array<{ trigger: string; text: string; source: string }> {
    const out: Array<{ trigger: string; text: string; source: string }> = []
    for (const plugin of this.plugins) {
      for (const rule of plugin.manifest.behaviour?.rules || []) {
        out.push({ trigger: rule.trigger, text: rule.text, source: `plugin:${plugin.manifest.name}` })
      }
    }
    return out
  }

  /** Tool names hidden by any enabled plugin. */
  hiddenTools(): Set<string> {
    const hidden = new Set<string>()
    for (const plugin of this.plugins) {
      for (const name of plugin.manifest.behaviour?.tools?.hide || []) hidden.add(name)
    }
    return hidden
  }

  /** Tools registered by plugin modules, ready for the registry. */
  toolImplementations(): Array<{ plugin: string; spec: PluginToolSpec }> {
    const out: Array<{ plugin: string; spec: PluginToolSpec }> = []
    for (const plugin of this.plugins) {
      for (const spec of plugin.tools) out.push({ plugin: plugin.manifest.name, spec })
    }
    return out
  }

  modelDefaults(): { temperature?: number; max_tokens?: number } {
    const out: { temperature?: number; max_tokens?: number } = {}
    // First plugin to declare wins: a later plugin must not silently loosen a
    // limit an earlier one set, and load order is stable because it is sorted.
    for (const plugin of this.plugins) {
      const model = plugin.manifest.behaviour?.model
      if (!model) continue
      if (out.temperature === undefined && model.temperature !== undefined) out.temperature = model.temperature
      if (out.max_tokens === undefined && model.max_tokens !== undefined) out.max_tokens = model.max_tokens
    }
    return out
  }

  autoApprove(): string[] {
    const out = new Set<string>()
    for (const plugin of this.plugins) {
      for (const name of plugin.manifest.behaviour?.auto_approve || []) out.add(name)
    }
    return [...out]
  }

  async taskStart(input: { prompt: string; cwd: string; taskId: string; sessionId?: string }): Promise<void> {
    for (const plugin of this.plugins) {
      const hook = plugin.hooks.onTaskStart
      if (!hook || !this.spend(plugin.manifest.name, 'onTaskStart')) continue
      try {
        await hook(input)
      } catch (error) {
        this.note(plugin, `onTaskStart failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  async beforeModelCall(input: { iteration: number; model: string }): Promise<string> {
    const parts: string[] = []
    for (const plugin of this.plugins) {
      const hook = plugin.hooks.beforeModelCall
      if (!hook || !this.spend(plugin.manifest.name, 'beforeModelCall')) continue
      try {
        const result = await hook(input)
        const text = result && typeof result.prompt === 'string' ? result.prompt.trim() : ''
        if (text) parts.push(text)
      } catch (error) {
        this.note(plugin, `beforeModelCall failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return parts.join('\n\n')
  }

  /**
   * Run the veto hooks in order.
   *
   * A block from any plugin stops the chain: later plugins do not get to argue
   * with a refusal, and the first refusal is what the model sees.
   */
  async beforeToolCall(input: { tool: string; args: Record<string, any>; cwd: string }): Promise<ToolCallVeto> {
    let current = input.args
    for (const plugin of this.plugins) {
      const hook = plugin.hooks.beforeToolCall
      if (!hook || !this.spend(plugin.manifest.name, 'beforeToolCall')) continue
      try {
        const verdict = await hook({ ...input, args: current })
        if (!verdict) continue
        if (typeof verdict.block === 'string' && verdict.block.trim()) {
          return { block: verdict.block.trim() }
        }
        if (verdict.args && typeof verdict.args === 'object') current = verdict.args
      } catch (error) {
        // A failing plugin must not fail the task, and must not be able to
        // approve anything either: the call continues with its original args.
        this.note(plugin, `beforeToolCall failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return current === input.args ? {} : { args: current }
  }

  async afterToolCall(input: { tool: string; args: Record<string, any>; success: boolean; output: string }): Promise<void> {
    for (const plugin of this.plugins) {
      const hook = plugin.hooks.afterToolCall
      if (!hook || !this.spend(plugin.manifest.name, 'afterToolCall')) continue
      try {
        await hook(input)
      } catch (error) {
        this.note(plugin, `afterToolCall failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  /**
   * Ask plugins whether the ledger is missing anything they know about.
   *
   * Only additions are honoured, and only with a description. A plugin cannot
   * mark a row done or remove one, which keeps the completion score something
   * the agent has to earn.
   */
  async intentUpdate(input: { taskId: string; intents: PluginIntentRow[]; completion: number; approach: string }): Promise<PluginIntentRow[]> {
    const added: PluginIntentRow[] = []
    for (const plugin of this.plugins) {
      const hook = plugin.hooks.onIntentUpdate
      if (!hook || !this.spend(plugin.manifest.name, 'onIntentUpdate')) continue
      try {
        const rows = await hook(input)
        if (!Array.isArray(rows)) continue
        for (const row of rows) {
          const description = String(row?.description ?? '').replace(/\s+/g, ' ').trim()
          if (!description) continue
          added.push({
            description: description.slice(0, 400),
            method: row.method ? String(row.method).slice(0, 600) : undefined,
            ...(row.id ? { id: String(row.id).slice(0, 64) } : {}),
            // Forced: whatever the plugin said, it can only add pending work.
            status: 'pending',
          })
        }
      } catch (error) {
        this.note(plugin, `onIntentUpdate failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return added
  }

  /**
   * Policy check before the reviewer is paid for.
   *
   * The first block wins, for the same reason the first tool veto wins: a
   * refusal that later plugins may argue with is not a refusal.
   */
  async gateCheck(input: PluginGateCheckInput): Promise<{ block?: string; notes: string[] }> {
    const notes: string[] = []
    for (const plugin of this.plugins) {
      const hook = plugin.hooks.onGateCheck
      if (!hook || !this.spend(plugin.manifest.name, 'onGateCheck')) continue
      try {
        const verdict = await hook(input)
        if (!verdict) continue
        if (typeof verdict.block === 'string' && verdict.block.trim()) {
          return { block: verdict.block.trim(), notes }
        }
        if (typeof verdict.note === 'string' && verdict.note.trim()) notes.push(verdict.note.trim())
      } catch (error) {
        this.note(plugin, `onGateCheck failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return { notes }
  }

  async taskEnd(input: { taskId: string; status: 'success' | 'rejected' | 'failed' | 'cancelled'; completion: number }): Promise<void> {
    for (const plugin of this.plugins) {
      const hook = plugin.hooks.onTaskEnd
      if (!hook || !this.spend(plugin.manifest.name, 'onTaskEnd')) continue
      try {
        await hook(input)
      } catch (error) {
        this.note(plugin, `onTaskEnd failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  /** Rules a plugin wants injected into this turn, on top of the matched ones. */
  async libraryInjection(input: { message: string; kind: 'chat' | 'task'; rules: string[] }): Promise<string[]> {
    const out: string[] = []
    for (const plugin of this.plugins) {
      const hook = plugin.hooks.onLibraryInjection
      if (!hook || !this.spend(plugin.manifest.name, 'onLibraryInjection')) continue
      try {
        const rows = await hook(input)
        if (!Array.isArray(rows)) continue
        for (const row of rows) {
          const text = String(row ?? '').replace(/\s+/g, ' ').trim()
          if (text) out.push(text.slice(0, 400))
        }
      } catch (error) {
        this.note(plugin, `onLibraryInjection failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return out
  }

  /** Every rule the declarative half declares, matched or not. */
  alwaysRules(): string[] {
    const out: string[] = []
    for (const plugin of this.plugins) {
      for (const text of plugin.manifest.behaviour?.always_rules || []) out.push(text)
    }
    return out
  }

  /** Intents a plugin declares the task always needs. */
  declaredIntents(): PluginIntentRow[] {
    const out: PluginIntentRow[] = []
    for (const plugin of this.plugins) {
      for (const row of plugin.manifest.behaviour?.intents || []) out.push({ ...row })
    }
    return out
  }

  /**
   * Whether the enabled plugins want the gate off, or on.
   *
   * `undefined` means nobody expressed an opinion and the operator's setting
   * stands. A disagreement resolves to "on": a plugin that wants the gate
   * cannot switch off a gate another plugin relies on.
   */
  gatePreference(): boolean | undefined {
    let sawOff = false
    let sawOn = false
    for (const plugin of this.plugins) {
      const enabled = plugin.manifest.behaviour?.gate?.enabled
      if (enabled === true) sawOn = true
      if (enabled === false) sawOff = true
    }
    if (sawOn) return true
    if (sawOff) return false
    return undefined
  }

  private note(plugin: LoadedModulePlugin, message: string): void {
    if (plugin.logs.length < 50) plugin.logs.push(message.slice(0, 400))
  }

  /** What the settings page shows. */
  describe(): { plugins: PluginRecord[]; errors: Array<{ dir: string; error: string }>; loaded_at: number } {
    return {
      plugins: this.plugins.map((plugin) => ({
        manifest: plugin.manifest,
        dir: plugin.dir,
        enabled: true,
        warnings: plugin.warnings,
        tools: plugin.tools.map((tool) => tool.name),
        hasModule: !!plugin.manifest.entry,
        loadError: plugin.loadError,
        logs: plugin.logs.slice(-10),
      })),
      errors: this.errors,
      loaded_at: this.loadedAt,
    }
  }

  get count(): number {
    return this.plugins.length
  }
}

/**
 * Wrap a plugin tool so the registry can hold it next to the built-ins.
 *
 * A plugin that throws is reported as a failed tool call rather than escaping
 * into the loop: the model can then react to the failure, which is the same
 * contract a built-in tool has.
 */
class PluginRegistryTool extends Tool {
  constructor(private readonly plugin: string, private readonly spec: PluginToolSpec) {
    super()
  }
  get name(): string { return this.spec.name }
  get description(): string { return this.spec.description || `Tool from plugin ${this.plugin}.` }
  get parameters(): Record<string, any> { return this.spec.parameters || { type: 'object', properties: {} } }
  get dangerous(): boolean { return !!this.spec.dangerous }
  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    try {
      return await this.spec.execute(args || {}, context)
    } catch (error) {
      return { success: false, data: null, error: error instanceof Error ? error.message : String(error) }
    }
  }
}

export function toRegistryTool(plugin: string, spec: PluginToolSpec): Tool {
  return new PluginRegistryTool(plugin, spec)
}
