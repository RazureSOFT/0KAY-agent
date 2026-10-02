# 0KAY-agent

> Part of **[0KAY](https://github.com/RazureSOFT/0KAY)** — a self-hosted AI
> companion that remembers you, with a real agent underneath.

This repository is the **Agent**: the task-execution plugin of the 0KAY platform.
When you ask the companion to actually *do* something — inspect a repository,
edit files, run commands, browse the web, or drive the desktop — this process
runs the task and its tools, and reports back to Core.

It connects to 0KAY Core over gRPC, registers as the `agent` plugin, and executes
dispatched tasks with a tool registry, an approval gate, task records, and
MCP/LLM integration.

## What it does

- **Executes multi-step tasks** with filesystem, shell, web and desktop tools,
  updating a live todo checklist as it goes.
- **Routes every model call through mocr** (`ChooseModels` + streaming), so model
  choice and credentials stay in one place.
- **Waits for approval** in `normal` mode: privileged tool calls (and the
  `question` tool) pause until you decide. `full_access` runs without prompting.
- **Returns diffs**, not just text, for `edit`/`apply_patch`, so the WebUI can
  show exactly what changed.
- **Extends via skills and MCP**: built-in `code` / `research` / `general`
  skills plus `skills/*.md`, and any MCP server Core exposes.

## Who it's for

This is a component of 0KAY, not a standalone app — you normally get it by
installing the platform (or via `0kay-pm`), not by running it on its own. Read
the [main README](https://github.com/RazureSOFT/0KAY) first to understand the
big picture.

## Requirements

- Node.js 20+ (built and smoke-tested on Node 26)
- A running 0KAY Core (gRPC 50051) and MOCR (gRPC 50052)
- The 0KAY protobuf definitions and the `@0kay/mcp` client, arranged by the
  installer as sibling `mcp/` and `proto/` directories

## Install with 0kay-pm

```powershell
0kay-pm install @razuresoft/0kay-agent@0.1.1
```

The installer downloads this repository as a release source archive, fetches
`@razuresoft/0kay-mcp` from the `RazureSOFT/0KAY-mcp` repository (which also
provides `proto/`), arranges the `agent/`, `mcp/` and `proto/` layout, runs
`npm ci` and `npm run build`, then starts the agent automatically. Use
`0kay-pm update @razuresoft/0kay-agent@<version>` to update and
`0kay-pm start @razuresoft/0kay-agent` to start it again. No git is required.

Local development without 0kay-pm expects `../mcp` next to this repository.

## Run

```powershell
npm ci
npm run build
node dist/index.js
```

The process registers as plugin `agent` with Core and heartbeats every 10
seconds, re-registering after a disconnect. The reported plugin version is read
from `manifest.json`, which is the single source of truth for the release
version.

## Configuration

Environment variables (all optional; defaults shown):

| Variable | Default | Purpose |
|---|---|---|
| `CORE_ADDRESS` | `localhost:50051` | Core gRPC endpoint |
| `AGENT_GRPC_PORT` | `50054` | Agent gRPC listen port |
| `AGENT_ADDRESS` | `localhost:<AGENT_GRPC_PORT>` | Address reported to Core |
| `AGENT_BIND_HOST` | `127.0.0.1` | Agent gRPC bind host |
| `MOCR_ADDRESS` | `localhost:50052` | MOCR gRPC endpoint |
| `CORE_HTTP_ADDR` / `CORE_HTTP` | `http://127.0.0.1:8080` | Core HTTP API |
| `AGENT_DATA_DIR` | `./data/agent` | Task records, executor identity |
| `AGENT_EXECUTOR_ID` | read from data dir | Stable executor identity |
| `AGENT_SKILLS_DIR` | built-in `skills/` | Extra skill definitions |
| `PROTO_DIR` | `../../proto` | Protobuf definitions directory |
| `SEARXNG_URL` | `http://127.0.0.1:8888` | Optional web search backend |
| `CORE_PAIR_TOKEN` / `CORE_API_TOKEN` | — | Bearer token for paired/remote Core |
| `CORE_TLS_CA` / `CORE_TLS_NAME` | — | TLS CA and server name override |

`0kay-pm` writes these to `runtime-env.json` during installation (including
pairing results) and passes them to the process on start.

## Test

```powershell
npm test
```

## License

Provided as part of the 0KAY platform repositories.
