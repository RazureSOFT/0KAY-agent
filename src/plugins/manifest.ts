import * as fs from 'fs'
import * as path from 'path'

/**
 * What an agent plugin is allowed to change.
 *
 * A plugin is a directory with a manifest.json. Everything declared here is data:
 * the runtime applies it without executing anything the plugin shipped, which is
 * what makes a plugin installable without granting it arbitrary code execution.
 *
 * The module escape hatch (`entry`) exists for plugins that genuinely need
 * behaviour — a new tool, a veto before a destructive call — but it is opt-in
 * per plugin, declared in the manifest, and bounded by the hook budget below.
 */
export interface PluginManifest {
  /** Directory name when absent. Stable identity; renaming is a different plugin. */
  name: string
  /** Shown in settings. Defaults to the name. */
  title?: string
  version?: string
  description?: string
  author?: string
  /** Plugin API version this was written against. */
  api?: string

  /** Declarative behaviour. No code runs for any of these. */
  behaviour?: {
    /**
     * Appended to the system prompt when the plugin is enabled.
     *
     * This is the main lever: a plugin that wants the agent to prefer pnpm, or
     * to never touch a particular directory, says so here instead of asking the
     * model to remember.
     */
    prompt?: string
    /** Extra rules for the rule library (the stage between message and model). */
    rules?: Array<{ trigger: string; text: string }>
    /** Tool groups this plugin hides, or adds its own tools to. */
    tools?: {
      /** Names hidden from the model while this plugin is enabled. */
      hide?: string[]
      /** Names moved into a group, so progressive disclosure lists them there. */
      group?: Record<string, string[]>
    }
    /** Defaults the plugin wants for the task. An operator setting still wins. */
    model?: { temperature?: number; max_tokens?: number }
    /** Extra tool names treated as safe (no approval prompt). */
    auto_approve?: string[]
    /**
     * Intents the plugin knows the task always needs, recorded on the ledger
     * before the first model turn. Declarative, so a plugin can make the gate
     * demand something specific ("the README is updated", "the changelog has an
     * entry") without shipping code.
     */
    intents?: Array<{ id?: string; description: string; method?: string }>
    /**
     * Rules that apply to every turn in this workspace, not just the turns whose
     * words happen to match. Declarative counterpart to a library rule.
     */
    always_rules?: string[]
    /** Turn the completion gate off or on for tasks this plugin applies to. */
    gate?: { enabled?: boolean }
  }

  /**
   * An ES module loaded by the runtime for behaviour that cannot be declared.
   *
   * Relative to the plugin directory. Its default (or `register`) export
   * receives an API object and may return hooks.
   */
  entry?: string
  /**
   * What the module may do. Declared, not inferred: the runtime enforces the
   * ones it can check (bash, network, filesystem outside the workspace) and
   * shows the list to the operator before the plugin is enabled.
   */
  permissions?: string[]
  /** Highest plugin API this was tested against; a higher major is refused. */
  engines?: { agent?: string }
}

export const PLUGIN_API_VERSION = '1'

/** Permissions the loader knows how to enforce. Anything else is a typo. */
export const KNOWN_PERMISSIONS = [
  'tools:register',
  'hooks:prompt',
  'hooks:tool',
  'hooks:gate',
  'hooks:library',
  'network',
  'filesystem:read',
  'filesystem:write',
  'shell',
] as const

export interface LoadedPlugin {
  manifest: PluginManifest
  dir: string
  /** Validation problems that do not stop the plugin from loading. */
  warnings: string[]
}

export class ManifestError extends Error {
  readonly file: string
  constructor(file: string, message: string) {
    super(message)
    this.name = 'ManifestError'
    this.file = file
  }
}

const RESERVED = new Set(['__proto__', 'constructor', 'prototype'])

function requireString(value: unknown, field: string, file: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ManifestError(file, `"${field}" must be a non-empty string`)
  }
  return value.trim()
}

/**
 * Read and validate one plugin directory.
 *
 * Throws ManifestError for anything that would make the plugin unsafe to load:
 * a bad name, a permission the runtime cannot enforce, or an entry path that
 * escapes the plugin directory. Warnings go in the returned list so a plugin
 * that is merely sloppy still works.
 */
export function readManifest(dir: string): LoadedPlugin {
  const file = path.join(dir, 'manifest.json')
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf-8'))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new ManifestError(file, `cannot read manifest: ${message}`)
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ManifestError(file, 'manifest must be a JSON object')
  }
  const source = raw as Record<string, any>
  const warnings: string[] = []

  const name = source.name === undefined ? path.basename(dir) : requireString(source.name, 'name', file)
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) {
    throw new ManifestError(file, `"name" must be a filename-safe identifier, got "${name}"`)
  }
  if (RESERVED.has(name.toLowerCase())) {
    throw new ManifestError(file, `"name" is reserved: "${name}"`)
  }

  const manifest: PluginManifest = {
    name,
    title: typeof source.title === 'string' && source.title.trim() ? source.title.trim() : undefined,
    version: typeof source.version === 'string' ? source.version.trim() : undefined,
    description: typeof source.description === 'string' ? source.description.trim() : undefined,
    author: typeof source.author === 'string' ? source.author.trim() : undefined,
    api: typeof source.api === 'string' ? source.api.trim() : undefined,
  }

  if (manifest.api && manifest.api.split('.')[0] !== PLUGIN_API_VERSION) {
    warnings.push(`declares API ${manifest.api}; this runtime implements ${PLUGIN_API_VERSION}.x`)
  }

  if (source.behaviour !== undefined) {
    if (!source.behaviour || typeof source.behaviour !== 'object' || Array.isArray(source.behaviour)) {
      throw new ManifestError(file, '"behaviour" must be an object')
    }
    const b = source.behaviour as Record<string, any>
    const behaviour: NonNullable<PluginManifest['behaviour']> = {}
    if (b.prompt !== undefined) {
      if (typeof b.prompt !== 'string') throw new ManifestError(file, '"behaviour.prompt" must be a string')
      behaviour.prompt = b.prompt
    }
    if (b.rules !== undefined) {
      if (!Array.isArray(b.rules)) throw new ManifestError(file, '"behaviour.rules" must be an array')
      behaviour.rules = b.rules.map((rule: any, index: number) => {
        if (!rule || typeof rule !== 'object') {
          throw new ManifestError(file, `"behaviour.rules[${index}]" must be an object`)
        }
        return {
          trigger: requireString(rule.trigger, `behaviour.rules[${index}].trigger`, file),
          text: requireString(rule.text, `behaviour.rules[${index}].text`, file),
        }
      })
    }
    if (b.tools !== undefined) {
      if (!b.tools || typeof b.tools !== 'object') throw new ManifestError(file, '"behaviour.tools" must be an object')
      const tools: NonNullable<NonNullable<PluginManifest['behaviour']>['tools']> = {}
      if (b.tools.hide !== undefined) {
        if (!Array.isArray(b.tools.hide)) throw new ManifestError(file, '"behaviour.tools.hide" must be an array')
        tools.hide = b.tools.hide.map((entry: any, index: number) => requireString(entry, `behaviour.tools.hide[${index}]`, file))
      }
      if (b.tools.group !== undefined) {
        if (!b.tools.group || typeof b.tools.group !== 'object') {
          throw new ManifestError(file, '"behaviour.tools.group" must be an object')
        }
        tools.group = {}
        for (const [group, names] of Object.entries(b.tools.group)) {
          if (!Array.isArray(names)) throw new ManifestError(file, `"behaviour.tools.group.${group}" must be an array`)
          tools.group[group] = names.map((entry: any, index: number) =>
            requireString(entry, `behaviour.tools.group.${group}[${index}]`, file))
        }
      }
      behaviour.tools = tools
    }
    if (b.model !== undefined) {
      if (!b.model || typeof b.model !== 'object') throw new ManifestError(file, '"behaviour.model" must be an object')
      const model: { temperature?: number; max_tokens?: number } = {}
      if (b.model.temperature !== undefined) {
        const t = Number(b.model.temperature)
        if (!Number.isFinite(t) || t < 0 || t > 2) throw new ManifestError(file, '"behaviour.model.temperature" must be 0..2')
        model.temperature = t
      }
      if (b.model.max_tokens !== undefined) {
        const m = Number(b.model.max_tokens)
        if (!Number.isInteger(m) || m <= 0) throw new ManifestError(file, '"behaviour.model.max_tokens" must be a positive integer')
        model.max_tokens = m
      }
      behaviour.model = model
    }
    if (b.auto_approve !== undefined) {
      if (!Array.isArray(b.auto_approve)) throw new ManifestError(file, '"behaviour.auto_approve" must be an array')
      behaviour.auto_approve = b.auto_approve.map((entry: any, index: number) => requireString(entry, `behaviour.auto_approve[${index}]`, file))
    }
    if (b.intents !== undefined) {
      if (!Array.isArray(b.intents)) throw new ManifestError(file, '"behaviour.intents" must be an array')
      behaviour.intents = b.intents.map((entry: any, index: number) => {
        if (!entry || typeof entry !== 'object') {
          throw new ManifestError(file, `"behaviour.intents[${index}]" must be an object`)
        }
        const out: { id?: string; description: string; method?: string } = {
          description: requireString(entry.description, `behaviour.intents[${index}].description`, file),
        }
        if (entry.id !== undefined) out.id = requireString(entry.id, `behaviour.intents[${index}].id`, file)
        if (entry.method !== undefined) out.method = requireString(entry.method, `behaviour.intents[${index}].method`, file)
        return out
      })
    }
    if (b.always_rules !== undefined) {
      if (!Array.isArray(b.always_rules)) throw new ManifestError(file, '"behaviour.always_rules" must be an array')
      behaviour.always_rules = b.always_rules.map((entry: any, index: number) =>
        requireString(entry, `behaviour.always_rules[${index}]`, file))
    }
    if (b.gate !== undefined) {
      if (!b.gate || typeof b.gate !== 'object') throw new ManifestError(file, '"behaviour.gate" must be an object')
      if (b.gate.enabled !== undefined && typeof b.gate.enabled !== 'boolean') {
        throw new ManifestError(file, '"behaviour.gate.enabled" must be a boolean')
      }
      behaviour.gate = { enabled: b.gate.enabled }
    }
    if (Object.keys(behaviour).length) manifest.behaviour = behaviour
  }

  if (source.entry !== undefined) {
    const entry = requireString(source.entry, 'entry', file)
    // A manifest that points outside its own directory is either a mistake or
    // an attempt to load something the operator did not review.
    const resolved = path.resolve(dir, entry)
    const relative = path.relative(path.resolve(dir), resolved)
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new ManifestError(file, `"entry" must stay inside the plugin directory, got "${entry}"`)
    }
    if (!fs.existsSync(resolved)) {
      throw new ManifestError(file, `"entry" does not exist: ${entry}`)
    }
    manifest.entry = entry
    const perms = source.permissions
    if (perms !== undefined) {
      if (!Array.isArray(perms)) throw new ManifestError(file, '"permissions" must be an array')
      const known = new Set<string>(KNOWN_PERMISSIONS)
      manifest.permissions = perms.map((entry: any, index: number) => {
        const value = requireString(entry, `permissions[${index}]`, file)
        if (!known.has(value)) {
          throw new ManifestError(file, `unknown permission "${value}"; known: ${[...known].join(', ')}`)
        }
        return value
      })
    } else {
      // A module with no declared permissions will be refused at load time
      // rather than silently given whatever it asks for.
      warnings.push('ships a module but declares no permissions; it will be loaded with none granted')
    }
  }

  if (source.engines?.agent !== undefined) {
    manifest.engines = { agent: String(source.engines.agent) }
  }

  return { manifest, dir: path.resolve(dir), warnings }
}

/** Read every plugin directory, collecting failures instead of aborting. */
export function scanPlugins(root: string): { plugins: LoadedPlugin[]; errors: Array<{ dir: string; error: string }> } {
  const plugins: LoadedPlugin[] = []
  const errors: Array<{ dir: string; error: string }> = []
  let entries: fs.Dirent[] = []
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return { plugins, errors }
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('.')) continue
    if (entry.name === 'node_modules') continue
    const dir = path.join(root, entry.name)
    try {
      plugins.push(readManifest(dir))
    } catch (error) {
      errors.push({ dir, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return { plugins, errors }
}
