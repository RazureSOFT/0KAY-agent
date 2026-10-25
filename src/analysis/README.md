# analysis/

Three capabilities that were rebuilt here rather than vendored, because each of
the originals is either enormous, differently licensed, or both. What travelled
is the idea; the code is ours.

| Module | Origin | Licence there | What we took |
|---|---|---|---|
| `artex/` | [jaykwok/ARTEX](https://github.com/jaykwok/ARTEX) | AGPL-3.0 | the dual-graph model, the intent lifecycle, the event-driven loop, coverage, cold-region compaction |
| `strix/` | [usestrix/strix](https://github.com/usestrix/strix) | Apache-2.0 | the PoC verdict — reproduced / fixed / cannot confirm |
| `ghidra/` | [NationalSecurityAgency/ghidra](https://github.com/NationalSecurityAgency/ghidra) | Apache-2.0 | nothing; we drive a local install through `analyzeHeadless` |

**On the licences.** ARTEX is AGPL-3.0. The architecture here (two graphs,
anchors, program-computed parentage, the seven-state intent lifecycle,
prove-by-evidence, the cold-graph algorithms) is a clean-room reimplementation —
ideas are not copyrightable, and no ARTEX code has been copied. **The prompt
bodies are the deliberate exception**: on 2026-10-25 the project owner chose to
port ARTEX's prompts verbatim, so `loop.ts` carries goalsDefaultTmpl,
plannerDefaultTmpl and workerDefaultTmpl (plus the worker overview frame and the
settlement wording) from [jaykwok/ARTEX](https://github.com/jaykwok/ARTEX)
v0.3.15, commit e6ec569 — AGPL-3.0, © the ARTEX authors — adapted only where the
tool surface differs (recon_graph actions, JSON reply envelopes). Consequence,
accepted by that decision: if this project is ever distributed or offered as a
network service, the AGPL applies to the derived work. Any further copying from
ARTEX (or from norma) has to be recorded here the same way.

## artex/ — assets vs. exploration

The distinction that makes coverage answerable:

- **asset graph** — what the target *is*: `root_domain → subdomain → ip → service → app → endpoint`
- **exploration graph** — what we *tried*: `goal → intent → fact → finding`,
  plus `hint` (steering that outlives one planner wake-up) and `digest` (a fold
  over a cold region), with provenance that always reaches a root: a direction
  nobody discovered hangs off a synthetic `origin` fact
- **anchors** — every exploration node names the assets it is about, which is what links the two
- **edges** — first-class relations (`spawns`, `derived_from`, `yields`, `proves`,
  `covers`), which is what makes the layered drawing and cold-region compaction possible

Two rules worth keeping from the original:

1. **The program computes parentage, the model does not.** Callers submit raw
   observations (`https://a.example.com/login`); `classify()` decides the kind,
   normalises the key, and derives the parent chain. Models are unreliable
   bookkeepers and fine observers.
2. **An intent is not coverage.** An asset counts as tested when a fact or
   finding anchors to it, not when someone opened a direction against it. Otherwise every
   target looks covered the moment a plan exists.

### The second pass: what now matches the original's behaviour

- **Seven-state intents.** `open → running` is the claim; the closing state says
  how a direction ended — `done`, `blocked` (it hit a wall), `exhausted` (out of
  turns or time), `stopped` (killed), `paused` (out of the queue, re-joinable).
- **Goals close as `met`, and only through `prove()`** — a finding has to be
  anchored to the goal's assets, and a *coverage gate* can hold the proof back
  until a percentage of the declared scope has been tested.
- **Scope and a real denominator.** `setScope()` takes domains, IPs and CIDR
  ranges; coverage becomes tested-in-scope over in-scope, not tested over
  everything the scan happened to notice.
- **Persistence.** The graph writes through to `AGENT_DATA_DIR/recon/<session>.json`
  (atomic rename, one document per session key) and is rebuilt on first touch
  after a restart. Old exports without edges are translated, not rejected.
- **Cold-region compaction** (`coldgraph.ts`, pure algorithms, no model): a
  region unreachable from live work for R consecutive rounds folds into a digest
  node via an injected summarizer. Members are kept; any member that later moves
  supersedes the digest that covered it.
- **Serialization** with `toJSON()` / `fromJSON()`, which is also what the UI
  panel consumes (`edges` and `scope` included).

## strix/ — a finding needs a PoC

`validatePoc()` runs the request and returns one of three verdicts:

| Verdict | Meaning |
|---|---|
| `reproduced` | the expectation held |
| `fixed` | we reached the target, the expectation did not hold |
| `cannot_confirm` | we never got a usable answer (timeout, refused, blocked) |

The third is the one scanners get wrong: folding it into "fixed" is how a report
claims a clean bill of health for an app it could not reach. A PoC with no
expectation is also `cannot_confirm` — running a request is not evidence.

Redirects are observed rather than followed, so a 302 is a result, not a detour.

## ghidra/ — an adapter, and it says so

`findGhidra()` looks at `GHIDRA_HOME` then the usual install locations;
`analyzeBinary()` runs `analyzeHeadless` with `scripts/ExportFacts.java`, which
prints one JSON block between two markers. Everything else the analyzer writes to
stdout is ignored.

No install → `missingGhidraHint()`, which names the requirement (JDK 17+) and what
still works without it (`reverse_engineer`: headers, imports, strings, entropy).
No fabricated output, no silent empty result.

The Java script is the only file here that runs inside Ghidra; it uses the
standard script API (`FunctionManager`, `DataIterator`) and emits nothing but the
framed JSON.

## artex/ — the loop itself

`engine.ts` is the part that makes it ARTEX rather than a bag of tools, and its
shape now follows the original's split: a **worker pool** that claims from the
intent frontier (open → running is the claim, so two workers never take the same
direction), and a **planner woken by events** — the queue drained, a finding
landed, or a round that learned nothing. Wake-ups coalesce; the situation is
rebuilt fresh each round. Four things decide when a run is over:

1. **the goals are proven** — evidence recorded, not assertion; the engine tries
   to prove every open goal each time a finding lands, and the graph refuses
   when the evidence or the coverage gate says no;
2. **the planner goes idle** — nothing to dispatch, nothing running: the normal
   ending, and after two more barren rounds the run is called `no-progress`
   rather than grinding on;
3. **the plan is finished** — the shared todolist (below) ran out of steps;
4. **a budget bites** — rounds, intents, or wall clock. A budget hit gets one
   **settlement round**: a last chance to write back what was learned but never
   recorded, instead of discarding half-finished observations. Settlement
   intents do not spend the budget.

A worker that throws is a *blocked intent*, not a dead run: the failure is
recorded, the intent is closed as blocked, and the planner routes around it.

**Workers are real sub-agents, not result envelopes.** When the host provides a
sub-agent runner (the agent loop always does), the worker is a full agent with
tools — bash, http_request, osint, whatever the intent needs — under the same
sandbox and approvals as any other sub-agent. Its contract follows the
original's worker discipline:

- **write back as you go**: observations land in the graph through the
  `recon_graph` tool the moment they are obtained — the graph is the
  deliverable, the final JSON is only a summary and a fallback;
- **one mandate**: the intent is the whole job; leads outside it are recorded
  as facts for the planner, never acted on;
- **fact discipline**: many observations consolidate into one fact with
  detail; only new information; negative results too; findings only with
  reproducible evidence — a hunch is an inferred fact, not a finding;
- **continuation**: a re-queued intent (after a pause or a crash) reaches the
  next worker with what the direction already produced, so it continues
  instead of repeating.

The engine meets the workers halfway: **progress is read off the graph**
(observations plus plan steps), so a worker that records mid-flight keeps the
run alive even when its result envelope is thin, and every round opens with a
sweep that proves goals from whatever the graph now holds — evidence recorded
by a worker's own tools closes goals without ever passing through the engine.

The engine runs on a long-lived session graph, so its accounting covers only
what it dispatched or claimed itself — directions already waiting on the
frontier are continuation, not budget spend.

`plan.ts` is the shared todolist — every planner wake-up is a fresh conversation,
so the chain has to live outside the model. Steps name their prerequisites; each
round only the ready ones are offered.

`traces.ts` is the cross-worker sharing: workers search each other's *steps*, not
just their conclusions. "Someone already tried `sqlmap -u .../id=1` and got a 500"
is more useful than a formalised fact.

## What the tools do with it

- `recon_graph` — the graph itself: `goal`/`intent`/`fact`/`finding`/`hint` to
  write, `close` to move an intent through its life, `scope` to declare the
  coverage denominator, `prove` to close a goal through the gate, `overview`
  for the one-call situation report, `export` for the UI.
- `deep_scan` — the loop above, synchronous, on the **session graph by
  default**: the objective is decomposed into provable goals before round one,
  and everything the scan does stays visible in the panel afterwards.
  `isolate: true` runs it on a throwaway graph instead.
- `assessments` — the task system: the same loop as a background task the panel
  can watch and steer (see below).

## The task system (`tasks.ts`)

ARTEX's tasks, adapted: an assessment is an objective plus targets that runs
the ARTEX loop **in the background**, on the session's recon graph, outliving
the tool call that started it. The panel's Tasks tab lists them, opens one,
and steers:

- **create** — goals phase, then the engine loop, running detached;
- **pause** — the abort signal stops dispatching; running intents are handed
  back to the frontier, so a **resume** redoes exactly what was interrupted,
  on the same graph, plan and traces;
- **cancel / delete** — a cancelled task closes without starting a run;
- **hint** — steering text lands on the graph; the planner reads it next round.

The ledger (state, plan, traces, activity) persists per task under
`AGENT_DATA_DIR/assessments/`; a task found `running` at process boot is
parked as `paused`, not lost. Two hard caps keep the blast radius small:
**one running assessment per session** — the session graph is one shared
canvas, and two loops on it would prove each other's goals — and four across
all sessions.

Ownership is explicit in the engine: a run only claims intents it dispatched
(or adopted at start, which is what resume does). That is what makes several
runs coexist on one graph without stealing each other's work or deadlocking
on each other's wake buses.

The model plumbing for a task is captured from the call that created it — a
detached LLM caller (no abort signal from the creating context) and, when
available, real sub-agent workers. Every panel call refreshes this plumbing,
which is why a task can resume even after a restart.

## What deliberately did not travel

ARTEX is a complete product around this loop. Still missing, each a project of
its own: the MITM recording proxy and its per-request evidence snapshots, the
rule engine with an LLM fallback judge for approvals, side questions that bypass
the running loop, IM notifications, and the LLM failover pool. The graph, the
lifecycle, the loop, the coverage model and the task system are the parts this
module exists to carry.

## Tests

All three are testable without the originals: the graph is pure data, the
validator runs against a local HTTP server that can flip its behaviour, and the
Ghidra adapter takes an injected runner so the parsing and the failure modes are
covered without a 400MB download. The cold-graph algorithms take no model and no
storage, which is the point of keeping them pure.
