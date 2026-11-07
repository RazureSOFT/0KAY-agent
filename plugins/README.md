# Agent extensions

A plugin changes how the agent behaves. It is a directory with a
`manifest.json`. Installing one is a file copy, and the toggle takes effect on
the next task — no rebuild, no restart.

These are separate from Core plugins: a Core plugin is a process that adds tools
to the platform. An extension changes the agent itself.

## Where they live

| What | Where |
|---|---|
| Installed plugins | `core/data/extensions/` (Core's data dir, `CORE_EXTENSIONS_DIR` overrides) |
| Examples shipped with the agent | `agent/plugins/` |

Both are read. A name found in the installed directory wins over the bundled
one, so a local copy overrides an example instead of loading twice.

## Install, list, toggle

```bash
0kay-pm ext                          # what is installed
0kay-pm ext add ./my-plugin          # install a directory
0kay-pm ext add ./my-plugin --replace
0kay-pm ext disable my-plugin
0kay-pm ext enable my-plugin
0kay-pm ext rm my-plugin
```

The settings page has the same list with switches, under Agent → plugins.

## The manifest

```json
{
  "name": "careful-edits",
  "title": "Careful edits",
  "version": "1.0.0",
  "description": "What this changes, in one line.",
  "api": "1",
  "behaviour": {
    "prompt": "Text appended to the system prompt.",
    "rules": [{ "trigger": "refactor", "text": "A rule the rule library adds." }],
    "tools": { "hide": ["browser"], "group": { "core": ["my_tool"] } },
    "model": { "temperature": 0.2 },
    "auto_approve": ["my_safe_tool"]
  },
  "entry": "index.mjs",
  "permissions": ["tools:register", "hooks:tool"]
}
```

Everything under `behaviour` is data. Nothing runs for it.

### What each key does

- **`prompt`** — appended to the system prompt while enabled. This is the main
  lever: a plugin that wants the agent to prefer pnpm says so here rather than
  hoping the model remembers.
- **`rules`** — added to the rule library, the stage between the user's message
  and the model. `trigger` is matched against the message.
- **`tools.hide`** — names hidden from the model. Use it to retire a tool this
  deployment must not use, or one your plugin replaces.
- **`tools.group`** — move a tool into a group, which affects when progressive
  disclosure mentions it.
- **`model`** — defaults the plugin wants. The operator's own setting still wins.
- **`auto_approve`** — extra tool names that run without an approval prompt.
  Think twice: this is the opposite of a safety feature.

### `entry` and `permissions`

`entry` is an ES module inside the plugin directory. It is loaded with a
dynamic import and receives a small API. Code is opt-in per plugin, and every
capability it uses must be declared in `permissions` first — using one that was
not declared throws to the plugin, and the plugin fails to load while the rest
of the agent keeps working.

| Permission | Unlocks |
|---|---|
| `tools:register` | `api.addTool()` |
| `hooks:prompt` | `api.addPrompt()`, `beforeModelCall` |
| `hooks:tool` | `beforeToolCall`, `afterToolCall` |
| `filesystem:read` | `api.readFile()` |
| `filesystem:write` | `api.writeFile()` |
| `network`, `shell` | documentation only; the runtime does not grant them |

```js
export default function register(api) {
  api.addTool({
    name: 'secret_scan',
    description: 'List files that look like credentials.',
    parameters: { type: 'object', properties: { path: { type: 'string' } } },
    async execute(args, context) {
      // context.cwd, context.taskId, context.sandbox are the same ones a
      // built-in tool gets.
      return { success: true, data: { matches: [] } }
    },
  })

  return {
    onTaskStart({ prompt, cwd }) { /* once per task */ },
    beforeToolCall({ tool, args }) {
      // Return { block: 'reason' } to refuse, { args: {...} } to rewrite.
      // Returning nothing lets the call through.
    },
    afterToolCall({ tool, success, output }) { /* observe only */ },
    beforeModelCall({ iteration, model }) {
      // Return { prompt: '...' } to add text to this turn only.
    },
  }
}
```

## Rules the runtime enforces

- A hook that throws is logged and skipped. A broken plugin never fails a task.
- `afterToolCall` cannot rewrite the result: the side effect already happened,
  and a plugin that could change the reported outcome could lie to the model.
- Hooks are budgeted at 2000 calls per task. Past that they are skipped and the
  skip is recorded in the plugin's row.
- `entry` and every file it reads stay inside the plugin directory. A manifest
  that points outside is refused.
- A plugin with an unresolvable name, an unknown permission, or a missing
  manifest is listed with the reason and does not load. It is not silently
  dropped, because a plugin that is installed and not running is the confusing
  case.

## Writing one from scratch

1. Make a directory, add `manifest.json` with at least a `name`.
2. Add `behaviour.prompt` — that alone is a working plugin.
3. If you need behaviour, add `entry`, list the permissions it uses, and return
   hooks from the module.
4. `0kay-pm ext add ./that-directory`.
5. Check `0kay-pm ext` shows it as loaded, then send the agent a message.

The two directories next to this file are working examples:
`careful-edits` is declarative only, `guard-secrets` ships a module with a tool
and a veto hook.
