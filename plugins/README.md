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
    "auto_approve": ["my_safe_tool"],
    "always_rules": ["A rule injected into every task in this workspace."],
    "intents": [{ "id": "p1", "description": "Closed only when this plugin is satisfied" }],
    "gate": { "enabled": true }
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
- **`always_rules`** — rules injected into every task, not only the turns whose
  words happen to match. Workspace policy belongs here; a learned correction
  belongs in `rules`.
- **`intents`** — rows the ledger starts a task with. The gate then requires
  them to be closed like any other intent, so a team standard ("the changelog
  has an entry") becomes something the agent has to account for.
- **`gate.enabled`** — ask for the completion gate to stay on. It can raise the
  mode but never lower it: a plugin may not withdraw a guarantee another plugin
  relies on.

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
| `hooks:gate` | `onIntentUpdate`, `onGateCheck`, `onTaskEnd` |
| `hooks:library` | `onLibraryInjection` |
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

    // --- the quality gate ---------------------------------------------------
    // A plugin can make the gate demand something the generic one does not.
    onIntentUpdate({ intents, completion }) {
      // Return rows to ADD to the ledger. They always land as pending: a plugin
      // cannot close work on the agent's behalf.
      return []
    },
    onGateCheck({ intents, completion, touched, trace, delivery }) {
      // Runs before the reviewer is paid for. Return { block: 'reason' } to
      // reject the claim (the agent sees it as source: "plugin"), or
      // { note: '...' } to hand the reviewer context.
    },
    onTaskEnd({ taskId, status, completion }) { /* success | rejected | ... */ },

    // --- the rule library ---------------------------------------------------
    onLibraryInjection({ message, kind, rules }) {
      // Return extra lines injected into this turn, on top of the matched rules.
      return []
    },
  }
}
```

## Rules the runtime enforces

- A hook that throws is logged and skipped. A broken plugin never fails a task.
- `onIntentUpdate` and `onGateCheck` can only add work, never remove it: no hook
  may mark an intent done, drop one, or report a task as passed. The completion
  score stays something the agent has to earn.
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

The three directories next to this file are working examples:
`careful-edits` is declarative only, `guard-secrets` ships a module with a tool
and a veto hook, and `delivery-policy` hooks the gate — it declares an intent,
injects a rule into every task, and refuses a done-claim that has no runnable
proof behind it.
