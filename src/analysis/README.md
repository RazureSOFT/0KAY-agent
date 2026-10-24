# analysis/

Three capabilities that were rebuilt here rather than vendored, because each of
the originals is either enormous, differently licensed, or both. What travelled
is the idea; the code is ours.

| Module | Origin | Licence there | What we took |
|---|---|---|---|
| `artex/` | [jaykwok/ARTEX](https://github.com/jaykwok/ARTEX) | AGPL-3.0 | the dual-graph model: assets vs. exploration, provenance, coverage |
| `strix/` | [usestrix/strix](https://github.com/usestrix/strix) | Apache-2.0 | the PoC verdict — reproduced / fixed / cannot confirm |
| `ghidra/` | [NationalSecurityAgency/ghidra](https://github.com/NationalSecurityAgency/ghidra) | Apache-2.0 | nothing; we drive a local install through `analyzeHeadless` |

**On the licences.** ARTEX is AGPL-3.0, so no code was copied — not a line, not a
schema, not a prompt. The module here implements the *architecture* it describes
in its README (two graphs, anchors, program-computed parentage), which is an idea,
and ideas are not copyrightable. If this ever needs to be more than that, the
licence question has to be reopened deliberately, not discovered later.

## artex/ — assets vs. exploration

The distinction that makes coverage answerable:

- **asset graph** — what the target *is*: `root_domain → subdomain → ip → service → app → endpoint`
- **exploration graph** — what we *tried*: `goal → intent → fact → finding`, with `derivedFrom` provenance
- **anchors** — every exploration node names the assets it is about, which is what links the two

Two rules worth keeping from the original:

1. **The program computes parentage, the model does not.** Callers submit raw
   observations (`https://a.example.com/login`); `classify()` decides the kind,
   normalises the key, and derives the parent chain. Models are unreliable
   bookkeepers and fine observers.
2. **An intent is not coverage.** An asset counts as tested when a fact or finding
   anchors to it, not when someone opened a direction against it. Otherwise every
   target looks covered the moment a plan exists.

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

`engine.ts` is the part that makes it ARTEX rather than a bag of tools: planner
reads the situation → dispatches intents → workers claim one each → results go
back into the graph → repeat. Three things make it terminate instead of spinning:

1. **a round that dispatches zero intents ends the run** — that is the normal way
   to finish, not an error;
2. **a round that changes nothing ends the run** — otherwise a planner with a
   favourite idea runs until the budget;
3. **a budget** on rounds and intents, because "the model felt thorough" is not a
   stopping condition.

A worker that throws is a *failed intent*, not a dead run: the failure is recorded,
the intent is closed as failed, and the planner gets one more chance to try
something else.

`plan.ts` is the shared todolist — every planner wake-up is a fresh conversation,
so the chain has to live outside the model. Steps name their prerequisites; each
round only the ready ones are offered.

`traces.ts` is the cross-worker sharing: workers search each other's *steps*, not
just their conclusions. "Someone already tried `sqlmap -u .../id=1` and got a 500"
is more useful than a formalised fact.

## The tools they became

| Tool | From | Group |
|---|---|---|
| `recon_graph` | ARTEX (assets vs. exploration, `overview` = its graph_overview prefetch, `prove` = prove_goal) | analysis |
| `validate_finding` | strix (PoC verdict) | analysis |
| `http_request` | strix (interception proxy, reduced to control over one request) | analysis |
| `vuln_kb` | strix (CVSS 3.1 base score computed from the vector; OWASP Top 10 mapping) | analysis |
| `osint` | strix (recon: DNS + edge fingerprint) | analysis |
| `ghidra_analyze` | Ghidra (`facts` and `decompile`) | analysis |
| `deep_scan` | ARTEX's engine, driven by the agent's own model (planner + workers + budget) | analysis |
| `exploit_runtime` | strix's Python PoC runtime, run under the sandbox policy | analysis |

CVSS is computed, not looked up: a table is wrong the moment the vector is
unusual, and the arithmetic is published. `vuln_kb` also refuses to guess a
category when no keyword matches.

## Tests

All three are testable without the originals: the graph is pure data, the
validator runs against a local HTTP server that can flip its behaviour, and the
Ghidra adapter takes an injected runner so the parsing and the failure modes are
covered without a 400MB download.
