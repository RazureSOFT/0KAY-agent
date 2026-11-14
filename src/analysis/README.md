# analysis/

Pure TypeScript analysis layers. Everything here runs without a model, without
a service, and without an external binary analysis suite. The tools in
`src/tools/` are thin adapters over these modules, which is what makes the
behaviour testable on its own.

## Modules

| Path | What it does |
|---|---|
| `recon/` | Two graphs: what a target *is* (assets) and what we *tried* (goals, intents, facts, findings). Coverage, provenance, scope, cold-region compaction, planner/worker loop, shared plan and traces, background assessments. |
| `poc/` | A finding's proof verdict: `reproduced`, `fixed`, `cannot_confirm`. A redirect is observed, not followed. |
| `ghidra/` | Adapter for a locally installed decompiler. Missing installs return an explicit hint, never an empty result. |
| `x86/` | Our own x86-64 analysis: container parsing, function tables, recursive traversal disassembly, basic blocks/CFG, pseudo-C. No external decompiler needed. |
| `arch/` | Workspace structure extraction and drift. |
| `codeindex/` | Lexical vector search, with an embeddings model when one is configured. |
| `runtime/` | Assessment runtime: traffic and evidence ledgers, interception rules, notices, model failover, side questions, enrichment and reports. |

## Rules we keep

1. **The program computes structure, the model reports observations.** Callers
   submit raw findings (`https://a.example/login`, `10.0.0.5:443`); `classify()`
   decides the kind, normalises the key and derives the parent chain. Models are
   unreliable bookkeepers and good observers.
2. **An intent is not coverage.** An asset counts as tested only when a fact or
   finding anchors to it. Otherwise every target looks covered the moment a plan
   exists.
3. **A finding needs evidence.** `runtime/report.ts` separates confirmed from
   unverified; the latter get a reason, not a silent promotion.
4. **No fabricated results.** A missing decompiler, a failed notification, an
   unusable model answer and an empty completion are all reported as such. A
   failure must never look like an empty success.
5. **Start disassembly at a real entry point.** A linear sweep over `.text`
   decodes build ids, jump tables and string constants as plausible garbage.
   `x86/` reads the container, uses the Go function table or the linker symbol
   table for entries, and follows control flow from there.

## Assessment runtime (`runtime/`)

`records.ts` keeps an append-only traffic ledger (secret headers redacted,
bodies bounded) and write-once evidence snapshots with a SHA-256 hash that
`verify()` recomputes. `proxy.ts` is a loopback recording proxy: plain HTTP is
forwarded and recorded in full, HTTPS arrives as a CONNECT tunnel that is
recorded as one entry saying its contents were not inspected. `policy.ts` holds
interception rules — blocks are checked before allows, an unmatched request
falls back to an approval, and an unusable model verdict never becomes an allow
— plus notices that record deduplication, rate limits and delivery failures.
`llm.ts` implements failover with a cooldown and a per-call record (payload
capture is opt-in and bounded), and side questions whose answers stay out of the
main context until explicitly read. `report.ts` enriches assets only from
observations (unknown fields are listed, not guessed) and assembles the report.

The rules are wired into the outbound path: `http_request` evaluates them before
sending, refuses on a block, applies a rewrite, and records every exchange in
the ledger. A rule that only answers a query would be a suggestion.

Each of these has a tool in `src/tools/packages/runtime.ts`, registered in the
default registry. Notices deliver through a webhook (via the egress proxy), a
file, or a local log; a failed or suppressed delivery is recorded on the notice
instead of being reported as sent.

## Exposing tools over MCP (`src/tools/mcp_server.ts`)

`mcp_serve` starts a loopback MCP server over the same registry: `initialize`,
`tools/list`, `tools/call`, `ping`. It binds 127.0.0.1, generates a bearer token
on start, and hides tools marked dangerous unless the caller opts in. An
unauthenticated tool endpoint would be a remote-execution surface with a
friendly name.

## Self-contained binary analysis (`x86/`)

| File | Role |
|---|---|
| `decode.ts` | Instruction decoder: prefixes, REX, ModRM/SIB, one- and two-byte opcodes, branch targets. |
| `image.ts` | ELF / PE / Mach-O headers, sections, virtual-address to file-offset mapping, symbol-table descriptors. PE long section names are resolved through the COFF string table. |
| `pclntab.ts` | Go function table (go116/go120 header) → function names and entries. |
| `symbols.ts` | ELF and COFF symbol tables → function entries, with the next symbol supplying the end. |
| `function.ts` | Recursive traversal from an entry: conditional branches fork, calls fall through, undecodable bytes stop that path. |
| `cfg.ts` | Basic blocks and edges. |
| `pseudoc.ts` | A reading aid in C-like syntax; untranslatable instructions remain as comments. |
| `frame.ts` | Calling convention, stack slots, saved argument registers. |
| `ir.ts` | Lifted IR: assignments, loads, conditions folded from flags, call arguments. |
| `structure.ts` | Post-dominator driven recovery of `if` / `while` / `do`; irreducible flow keeps a label and a `goto`. |
| `types.ts` | Small type lattice; ambiguity widens rather than truncates. |
| `decompile.ts` | The pipeline and the C printer. |
| `xref.ts` | Callers, callees and data references. |

`src/tools/binary_analysis.ts` exposes `summary`, `functions`, `disasm`, `cfg`,
`pseudoc`, `decompile` and `xref`. Every response names the entry-point source
it used; when no function table or symbol table is available, only the image
entry is walked and the response says so.

### What the decompiler does and does not do

It prints what the instructions do: named stack slots and saved arguments,
conditions folded from `cmp`/`test`/`bt`, `if`/`else`, `while`/`do`, call
arguments from the argument registers, and a C type per value. Go's stack-growth
prologue (a branch to a `morestack` thunk that jumps back to the entry) is folded
so it does not turn every function into `while (1)`.

It is not a source-level reconstruction. Registers stay registers (there is no
SSA renaming), the type lattice only distinguishes widths and pointers, and
anything undecodable stays as an `unknown` comment. Go's register ABI does not
save arguments to the stack, so a Go function often decompiles with no named
parameters — the body still reads the argument registers directly, and the
output says so instead of inventing a signature.

## Tests

Every layer has tests that need no model, no network and no installed suite:
the graphs are pure data, the validator runs against a local HTTP server, the
runtime state is in memory, and the binary layers run against a synthetic ELF
with a real symbol table as well as hand-built instruction bytes.
