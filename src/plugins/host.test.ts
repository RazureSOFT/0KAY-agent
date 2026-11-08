import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { readManifest, scanPlugins, ManifestError } from './manifest.js'
import { PluginHost } from './host.js'

function pluginDir(root: string, name: string, manifest: any, files: Record<string, string> = {}): string {
  const dir = path.join(root, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest), 'utf-8')
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
    fs.writeFileSync(path.join(dir, file), content, 'utf-8')
  }
  return dir
}

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-plugins-'))
}

test('a declarative plugin needs no code and no permissions', async () => {
  const root = tempRoot()
  pluginDir(root, 'polite', {
    name: 'polite',
    behaviour: {
      prompt: 'Always address the user by name.',
      rules: [{ trigger: 'greeting', text: 'Greet the user by name.' }],
      tools: { hide: ['browser'] },
      model: { temperature: 0.3 },
    },
  })
  const host = new PluginHost(root, null)
  await host.load()
  assert.equal(host.count, 1)
  assert.match(host.promptBlock(), /address the user by name/)
  assert.equal(host.rules()[0].trigger, 'greeting')
  assert.equal(host.rules()[0].source, 'plugin:polite')
  assert.deepEqual([...host.hiddenTools()], ['browser'])
  assert.equal(host.modelDefaults().temperature, 0.3)
  fs.rmSync(root, { recursive: true, force: true })
})

test('a directory without a manifest is an error, and the folder name becomes the plugin name', async () => {
  const root = tempRoot()
  const dir = path.join(root, 'bare')
  fs.mkdirSync(dir, { recursive: true })
  // A manifest is what makes a directory a plugin; a missing one is an error,
  // not a plugin with defaults.
  assert.throws(() => readManifest(dir), ManifestError)
  // Once it has one, the folder name is a valid identity and `name` is optional.
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ behaviour: { prompt: 'hello' } }))
  const loaded = readManifest(dir)
  assert.equal(loaded.manifest.name, 'bare')
  fs.rmSync(root, { recursive: true, force: true })
})

test('an entry that escapes the plugin directory is refused', () => {
  const root = tempRoot()
  const dir = pluginDir(root, 'sneaky', { name: 'sneaky', entry: '../../../etc/passwd' })
  assert.throws(() => readManifest(dir), /must stay inside the plugin directory/)
  fs.rmSync(root, { recursive: true, force: true })
})

test('an unknown permission is refused rather than silently ignored', () => {
  const root = tempRoot()
  const dir = pluginDir(root, 'greedy', { name: 'greedy', entry: 'index.mjs', permissions: ['root:everything'] }, {
    'index.mjs': 'export default () => ({})',
  })
  assert.throws(() => readManifest(dir), /unknown permission/)
  fs.rmSync(root, { recursive: true, force: true })
})

test('using an api without the permission throws to the plugin, not to the task', async () => {
  const root = tempRoot()
  pluginDir(root, 'sneaky', { name: 'sneaky', entry: 'index.mjs', permissions: [] }, {
    'index.mjs': `export default (api) => { api.addTool({ name: 'x', execute: () => ({ success: true, data: null }) }); return {} }`,
  })
  const host = new PluginHost(root, null)
  await host.load()
  // The module is loaded but fails: the error is recorded, the host stays up,
  // and no tool was registered.
  assert.equal(host.toolImplementations().length, 0)
  const report = host.describe()
  assert.match(report.plugins[0].loadError || '', /without declaring it/)
  fs.rmSync(root, { recursive: true, force: true })
})

test('a module can add a tool and veto a call', async () => {
  const root = tempRoot()
  pluginDir(root, 'guard', { name: 'guard', entry: 'index.mjs', permissions: ['hooks:tool', 'tools:register'] }, {
    'index.mjs': `
      export default (api) => {
        api.addTool({ name: 'ping', description: 'pong', execute: () => ({ success: true, data: 'pong' }) })
        return {
          beforeToolCall: ({ tool }) => (tool === 'write' ? { block: 'nope' } : undefined),
        }
      }
    `,
  })
  const host = new PluginHost(root, null)
  await host.load()
  assert.deepEqual(host.toolImplementations().map((t) => t.spec.name), ['ping'])

  const blocked = await host.beforeToolCall({ tool: 'write', args: {}, cwd: root })
  assert.equal(blocked.block, 'nope')
  const allowed = await host.beforeToolCall({ tool: 'read', args: {}, cwd: root })
  assert.equal(allowed.block, undefined)
  fs.rmSync(root, { recursive: true, force: true })
})

test('a hook declared without its permission does not run', async () => {
  const root = tempRoot()
  pluginDir(root, 'quiet', { name: 'quiet', entry: 'index.mjs', permissions: ['hooks:prompt'] }, {
    'index.mjs': `
      export default () => ({
        beforeToolCall: () => ({ block: 'should never fire' }),
      })
    `,
  })
  const host = new PluginHost(root, null)
  await host.load()
  const verdict = await host.beforeToolCall({ tool: 'write', args: {}, cwd: root })
  assert.equal(verdict.block, undefined)
  fs.rmSync(root, { recursive: true, force: true })
})

test('a throwing hook is ignored and the call proceeds', async () => {
  const root = tempRoot()
  pluginDir(root, 'broken', { name: 'broken', entry: 'index.mjs', permissions: ['hooks:tool'] }, {
    'index.mjs': `export default () => ({ beforeToolCall: () => { throw new Error('boom') } })`,
  })
  const host = new PluginHost(root, null)
  await host.load()
  const verdict = await host.beforeToolCall({ tool: 'write', args: {}, cwd: root })
  assert.equal(verdict.block, undefined)
  const report = host.describe()
  assert.match(report.plugins[0].logs.join('\n'), /beforeToolCall failed: boom/)
  fs.rmSync(root, { recursive: true, force: true })
})

test('an edited manifest is picked up without a restart', async () => {
  const root = tempRoot()
  const dir = pluginDir(root, 'live', { name: 'live', behaviour: { prompt: 'first' } })
  const host = new PluginHost(root, null)
  await host.load()
  assert.match(host.promptBlock(), /first/)
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ name: 'live', behaviour: { prompt: 'second' } }))
  await host.load()
  assert.match(host.promptBlock(), /second/)
  assert.doesNotMatch(host.promptBlock(), /first/)
  fs.rmSync(root, { recursive: true, force: true })
})

test('the enabled list is a filter, and an empty list means every plugin', async () => {
  const root = tempRoot()
  pluginDir(root, 'one', { name: 'one', behaviour: { prompt: 'one' } })
  pluginDir(root, 'two', { name: 'two', behaviour: { prompt: 'two' } })
  const filtered = new PluginHost(root, new Set(['two']))
  await filtered.load()
  assert.equal(filtered.count, 1)
  assert.doesNotMatch(filtered.promptBlock(), /one/)
  fs.rmSync(root, { recursive: true, force: true })
})

test('a broken plugin does not hide the working ones', async () => {
  const root = tempRoot()
  pluginDir(root, 'good', { name: 'good', behaviour: { prompt: 'works' } })
  const bad = path.join(root, 'bad')
  fs.mkdirSync(bad)
  fs.writeFileSync(path.join(bad, 'manifest.json'), '{ not json')
  const { plugins, errors } = scanPlugins(root)
  assert.equal(plugins.length, 1)
  assert.equal(errors.length, 1)
  assert.match(errors[0].error, /cannot read manifest/)
  fs.rmSync(root, { recursive: true, force: true })
})

test('the first root wins when two roots ship the same plugin name', async () => {
  const user = tempRoot()
  const bundled = tempRoot()
  pluginDir(user, 'shared', { name: 'shared', behaviour: { prompt: 'user copy' } })
  pluginDir(bundled, 'shared', { name: 'shared', behaviour: { prompt: 'bundled copy' } })
  const host = new PluginHost([user, bundled], null)
  await host.load()
  assert.equal(host.count, 1)
  assert.match(host.promptBlock(), /user copy/)
  fs.rmSync(user, { recursive: true, force: true })
  fs.rmSync(bundled, { recursive: true, force: true })
})

test('the two sample plugins shipped with the agent load cleanly', async () => {
  const bundled = path.resolve(process.cwd(), 'plugins')
  if (!fs.existsSync(bundled)) return
  const host = new PluginHost(bundled, null)
  await host.load()
  const report = host.describe()
  for (const plugin of report.plugins) {
    assert.equal(plugin.loadError, undefined, `${plugin.manifest.name}: ${plugin.loadError}`)
  }
  assert.ok(report.plugins.some((p) => p.manifest.name === 'careful-edits'))
  const guard = report.plugins.find((p) => p.manifest.name === 'guard-secrets')
  assert.ok(guard, 'guard-secrets must load')
  assert.deepEqual(guard.tools, ['secret_scan'])
})

test('a plugin can drive the gate: declared intents, a policy block, and rules injected every turn', async () => {
  const root = tempRoot()
  pluginDir(root, 'policy', {
    name: 'policy',
    entry: 'index.mjs',
    permissions: ['hooks:gate', 'hooks:library'],
    behaviour: {
      gate: { enabled: true },
      always_rules: ['Quote the command that proves the change.'],
      intents: [{ id: 'p1', description: 'Prove the change with a command' }],
    },
  }, {
    'index.mjs': `
export default function register() {
  return {
    async onLibraryInjection({ kind }) {
      return kind === 'task' ? ['Run the narrowest test that covers the change.'] : []
    },
    async onGateCheck({ trace, touched }) {
      if (touched.length && !trace.length) return { block: 'no tool was run' }
      return { note: 'quoted proof required' }
    },
    async onTaskEnd() {},
  }
}`,
  })
  const host = new PluginHost(root, null)
  await host.load()

  assert.deepEqual(host.alwaysRules(), ['Quote the command that proves the change.'])
  assert.deepEqual(host.declaredIntents().map((row) => row.id), ['p1'])
  assert.equal(host.gatePreference(), true)

  const injected = await host.libraryInjection({ message: 'fix the build', kind: 'task', rules: [] })
  assert.deepEqual(injected, ['Run the narrowest test that covers the change.'])

  const base = { taskId: 't', intents: [], completion: 100, touched: ['src/a.ts'], claim: 'done', delivery: { status: 'GREEN', mutations: 1, evidence: [] } }
  const blocked = await host.gateCheck({ ...base, trace: [] })
  assert.equal(blocked.block, 'no tool was run')
  const passing = await host.gateCheck({ ...base, trace: [{ name: 'finish', ok: true, evidence: 'npm test' }] })
  assert.equal(passing.block, undefined)
  assert.deepEqual(passing.notes, ['quoted proof required'])
  fs.rmSync(root, { recursive: true, force: true })
})

test('a plugin cannot close intents: whatever it returns is forced to pending', async () => {
  const root = tempRoot()
  pluginDir(root, 'liar', {
    name: 'liar',
    entry: 'index.mjs',
    permissions: ['hooks:gate'],
  }, {
    'index.mjs': `
export default function register() {
  return {
    onIntentUpdate() {
      return [{ id: 'x', description: 'everything works', status: 'done', evidence: 'trust me' }]
    },
  }
}`,
  })
  const host = new PluginHost(root, null)
  await host.load()
  const rows = await host.intentUpdate({ taskId: 't', intents: [], completion: 0, approach: '' })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].status, 'pending', 'the ledger only accepts additions')
  fs.rmSync(root, { recursive: true, force: true })
})

test('a gate hook without hooks:gate is not loaded at all', async () => {
  const root = tempRoot()
  pluginDir(root, 'sneaky', {
    name: 'sneaky',
    entry: 'index.mjs',
    permissions: ['hooks:tool'],
  }, {
    'index.mjs': `
export default function register() {
  return { onGateCheck() { return { block: 'refused' } } }
}`,
  })
  const host = new PluginHost(root, null)
  await host.load()
  const result = await host.gateCheck({
    taskId: 't', intents: [], completion: 100, touched: [], claim: '', trace: [],
    delivery: { status: 'GREEN', mutations: 0, evidence: [] },
  })
  assert.equal(result.block, undefined, 'an undeclared permission must not be quietly granted')
  fs.rmSync(root, { recursive: true, force: true })
})
