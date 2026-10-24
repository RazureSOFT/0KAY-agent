# tools/packages/

Tool implementations live here, one file per domain. `tools.ts` keeps the
registry and the tools that still share module-level helpers; everything that
can stand on its own moves out.

## What is here

| Package | Tools | Notes |
|---|---|---|
| `subagent.ts` | `subagent` | spawn / parallel / list / cancel child agents |
| `web-search.ts` | `papersearch`, `apidocsearch` | both go through Core's search gateway |
| `context.ts` | `compresscontext`, `decompresscontext`, `searchcontext`, `acpstatus` | window management |

## Why split at all

A single 1200-line `tools.ts` means every tool shares a namespace, a test file
and a review surface with forty others. Splitting by domain gives each group:

- its own imports (a web tool should not be able to reach the shell helper);
- its own test file next to it;
- a reviewable diff — moving `papersearch` no longer touches the shell tool.

## The shape a package has

```ts
import { Tool } from '../types.js'
import type { ToolContext, ToolResult } from '../types.js'
import { success, failure } from '../helpers.js'

export class SomethingTool extends Tool {
  get name() { return 'something' }
  get description() { return '...' }
  get parameters() { return { type: 'object', properties: {} } }
  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    try { return success(await doTheThing(args, context)) } catch (error) { return failure(error) }
  }
}
```

Rules that keep this from turning into spaghetti:

1. **No cross-package imports.** A package may import from `../types.js`,
   `../helpers.js`, `../../connection.js`, `../../sandbox/*`, `../../workspace/*`.
   If two packages need the same helper, it goes in `helpers.ts`, not sideways.
2. **No module-level mutable state.** Anything stateful comes in through
   `ToolContext` (`sandbox`, `subagents`, `mcp`, `llm`, `signal`).
3. **`tools.ts` re-exports what moved**, so `import { PaperSearchTool } from
   './tools.js'` keeps working. Removing the re-export is a separate decision.

## What still lives in tools.ts, and why

`read` / `write` / `edit` / `apply_patch` / `glob` / `grep` / `bash` share
`resolvePath`, `isPathAllowed` and the shell runner; `document` / `slides`
share the docx and pptx writers; the `evolve_*` family shares the worktree
plumbing. Those move once the shared part is extracted into `helpers.ts`, which
is the next step — not a rewrite of the classes.
