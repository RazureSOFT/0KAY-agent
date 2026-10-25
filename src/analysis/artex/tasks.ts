import * as fs from 'node:fs'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import { ReconGraph } from './graph.js'
import type { ExplorationNode } from './graph.js'
import { Plan } from './plan.js'
import type { PlanStep } from './plan.js'
import { TraceStore } from './traces.js'
import type { TraceStep } from './traces.js'
import { ReconEngine } from './engine.js'
import { plantGoals, makePlanner, makeWorker, makeSummarizer } from './loop.js'
import type { LoopRuntime, LoopContext } from './loop.js'
import { renderAssessmentReport } from './report.js'
import { writeFileAtomic } from '../../tools/atomic_write.js'

// The task system: ARTEX's long-lived assessment tasks, adapted to this agent.
//
// A task is an objective plus targets that runs the ARTEX loop in the
// background — the same engine, planner and workers as deep_scan — on the
// session's recon graph. It outlives the tool call that created it, which is
// the whole point: the panel lists tasks, watches them move the graph, and
// steers them (pause / resume / cancel / a hint to the planner) while they run.
//
// Tasks keep ARTEX's shape: goals are proven by evidence or not at all, the
// coverage gate can hold a proof back, a budget ends the run with one
// settlement round, and a paused task resumes on the same graph, plan and
// traces — the frontier is the state, not the process.

export type AssessmentStatus = 'running' | 'paused' | 'done' | 'cancelled' | 'failed'

export interface AssessmentSpec {
  objective: string
  targets: string[]
  /** Refuse to prove goals until this percent of the scope is tested. */
  coverage?: number
  rounds?: number
  intents?: number
  concurrency?: number
  timeoutMs?: number
  /** Model override for this task's planner/worker calls; empty = the executor's active model. */
  model?: string
  /** Event-text language: 'zh' (default) or 'en'. */
  locale?: string
}

export interface AssessmentActivityEntry {
  at: string
  round: number
  kind: string
  text: string
}

/** One row of the task's conversation tree — planner rounds, worker intents, system events. */
export interface AssessmentSession {
  id: string
  kind: 'planner' | 'worker' | 'system'
  title: string
  /** Worker entries carry the intent node id; the live read joins the real status. */
  refId?: string
  round: number
  startedAt: string
}

/** Rough per-task model usage, estimated from prompt/reply sizes (no cache visibility). */
export interface AssessmentUsage {
  llmCalls: number
  inTokens: number
  outTokens: number
}

/** CJK glyphs count ~1 token each, the rest ~4 chars per token. */
function estimateTokens(text: string): number {
  if (!text) return 0
  let cjk = 0
  for (const ch of text) if (ch.codePointAt(0)! > 0x2e80) cjk += 1
  return cjk + Math.round((text.length - cjk) / 4)
}

export interface AssessmentState {
  id: string
  sessionId: string
  objective: string
  targets: string[]
  coverageArg?: number
  rounds: number
  intents: number
  concurrency: number
  timeoutMs: number
  model?: string
  locale?: string
  status: AssessmentStatus
  createdAt: string
  endedAt?: string
  goalIds: string[]
  goalTexts: Array<{ id: string; text: string }>
  constraints: string[]
  scope: string[]
  stopped?: string
  error?: string
  report?: {
    rounds: number
    intents: number
    facts: number
    findings: number
    digests: number
    traces: number
    proven: boolean
    pct: number | null
  }
  activity: AssessmentActivityEntry[]
  /** The conversation tree: planner rounds, worker intents, system events. */
  sessions: AssessmentSession[]
  usage: AssessmentUsage
  /** Plan and traces survive a pause and a process restart. */
  planSteps: PlanStep[]
  traceSteps: TraceStep[]
}

/** Live read of the graph for one task — the state file is the ledger, the graph is the truth. */
export interface AssessmentLive {
  coverage: ReturnType<ReconGraph['coverage']>
  goals: Array<{ id: string; text: string; status: string }>
  openIntents: Array<{ id: string; text: string; priority?: number }>
  runningIntents: number
  findings: Array<{ id: string; text: string; status: string }>
  digests: number
  /** The conversation tree, worker rows joined with their live intent status. */
  sessions: Array<AssessmentSession & { status: string }>
  usage: AssessmentUsage
}

/**
 * What the ARTEX tool surface (record_fact / add_intent / graph_overview / …)
 * operates on while a run is live in this session. The graph is the session's
 * shared instance; the trace store and the constraints array belong to the
 * active run.
 */
export interface ArtexRunContext {
  graph: ReconGraph
  traces: TraceStore
  constraints?: string[]
  objective?: string
}

interface RunHandles {
  controller: AbortController
  graph: ReconGraph
  plan: Plan
  traces: TraceStore
}

const MAX_RUNNING_PER_SESSION = 1
const MAX_RUNNING_TOTAL = 4
const MAX_ACTIVITY = 600
const MAX_SESSIONS = 400

export class AssessmentManager {
  private states = new Map<string, AssessmentState>()
  private runs = new Map<string, RunHandles>()
  /** The live run per session — what context.artex hands to the ARTEX tools. */
  private activeBySession = new Map<string, ArtexRunContext>()
  private pauseRequested = new Set<string>()
  private cancelRequested = new Set<string>()
  private loaded = false

  constructor(
    private readonly graphFor: (sessionId: string) => Promise<ReconGraph>,
    private readonly dir?: string,
  ) {
    // Without the directory, every persist silently no-ops and tasks die with
    // the process — the ledger is the whole point of dir.
    if (this.dir) {
      try {
        fs.mkdirSync(this.dir, { recursive: true })
      } catch { /* persistence degrades to memory */ }
    }
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    if (!this.dir) return
    let files: string[]
    try {
      files = await fs.promises.readdir(this.dir)
    } catch {
      return
    }
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      try {
        const raw = await fs.promises.readFile(path.join(this.dir!, file), 'utf8')
        const state = JSON.parse(raw) as AssessmentState
        if (!state?.id || !state.objective) continue
        // A task found 'running' at boot is a task whose process died mid-run.
        // Its graph and plan are on disk; the user can resume it.
        if (state.status === 'running') state.status = 'paused'
        this.states.set(state.id, state)
      } catch {
        // A corrupted task file is skipped, not fatal.
      }
    }
  }

  private async persist(state: AssessmentState): Promise<void> {
    if (!this.dir) return
    try {
      await writeFileAtomic(path.join(this.dir, `${state.id}.json`), JSON.stringify(state))
    } catch {
      // Persistence is best-effort; the run continues in memory.
    }
  }

  async create(spec: AssessmentSpec, sessionId: string, runtime: LoopRuntime): Promise<AssessmentState> {
    await this.ensureLoaded()
    const objective = String(spec.objective || '').trim()
    const targets = (Array.isArray(spec.targets) ? spec.targets : []).map(String).filter(Boolean)
    if (!objective) throw new Error('objective is required')
    if (!targets.length) throw new Error('targets must be a non-empty array')
    const runningHere = [...this.states.values()].filter((entry) => entry.sessionId === sessionId && entry.status === 'running').length
    if (runningHere >= MAX_RUNNING_PER_SESSION) {
      throw new Error(`this session already has a running assessment — the session graph is one shared canvas, pause or finish it first`)
    }
    if ([...this.states.values()].filter((entry) => entry.status === 'running').length >= MAX_RUNNING_TOTAL) {
      throw new Error(`too many running assessments (${MAX_RUNNING_TOTAL} across all sessions)`)
    }

    const graph = await this.graphFor(sessionId)
    const priorScope = graph.scope().map((row) => row.value)
    const scopeValues = [...new Set([...priorScope, ...targets])]
    graph.setScope(scopeValues)

    const loop: LoopContext = {
      objective,
      scopeLine: `Scope (never leave it): ${scopeValues.join(', ')}`,
      constraints: [],
      fallbackAssets: targets,
      graph,
      ...(spec.model ? { model: String(spec.model).trim() } : {}),
    }
    // One choke point for every model call the loop makes — this is where the
    // task's token counters live. Estimates only: the underlying caller does
    // not expose provider usage or cache hits.
    const usage: AssessmentUsage = { llmCalls: 0, inTokens: 0, outTokens: 0 }
    const counting: LoopRuntime = {
      llm: async (request) => {
        usage.llmCalls += 1
        usage.inTokens += estimateTokens(`${request.systemPrompt || ''}\n${JSON.stringify(request.messages || [])}`)
        const reply = await runtime.llm(request)
        usage.outTokens += estimateTokens(reply || '')
        return reply
      },
      ...(runtime.subagent ? { subagent: runtime.subagent } : {}),
    }
    const { goalIds, constraints } = await plantGoals(counting, graph, { objective, targets, ...(spec.model ? { model: String(spec.model).trim() } : {}) })
    loop.constraints = constraints

    const state: AssessmentState = {
      id: `as_${Date.now().toString(36)}_${randomUUID().slice(0, 6)}`,
      sessionId,
      objective,
      targets,
      coverageArg: spec.coverage != null ? Number(spec.coverage) : undefined,
      rounds: Math.max(1, Number(spec.rounds) || 12),
      intents: Math.max(1, Number(spec.intents) || 24),
      concurrency: Math.max(1, Math.min(Number(spec.concurrency) || 3, 6)),
      timeoutMs: Math.max(10_000, Number(spec.timeoutMs) || 900_000),
      ...(spec.model ? { model: String(spec.model).trim() } : {}),
      ...(spec.locale ? { locale: String(spec.locale) } : {}),
      status: 'running',
      createdAt: new Date().toISOString(),
      goalIds,
      goalTexts: goalIds.map((gid) => {
        const node = graph.node(gid)
        return { id: gid, text: node?.text || '' }
      }),
      constraints,
      scope: scopeValues,
      activity: [],
      sessions: [],
      usage: { llmCalls: 0, inTokens: 0, outTokens: 0 },
      planSteps: [],
      traceSteps: [],
    }
    this.states.set(state.id, state)
    await this.persist(state)
    this.startActivity(state, graph, runtime, loop)
    return state
  }

  /** Fire the engine loop for a task. Resolves nothing on purpose: the run ends in finalize(). */
  private startActivity(state: AssessmentState, graph: ReconGraph, runtime: LoopRuntime, loop: LoopContext): void {
    // v1 ledgers predate the conversation tree and the usage counters.
    state.sessions ??= []
    state.usage ??= { llmCalls: 0, inTokens: 0, outTokens: 0 }
    const usage = state.usage
    // Every model call the engine makes flows through here, so the task's
    // token counters stay honest. Estimates only: the underlying caller does
    // not expose provider usage or cache hits, and sub-agent workers run their
    // own sessions whose usage is theirs.
    const counting: LoopRuntime = {
      llm: async (request) => {
        usage.llmCalls += 1
        usage.inTokens += estimateTokens(`${request.systemPrompt || ''}\n${JSON.stringify(request.messages || [])}`)
        const reply = await runtime.llm(request)
        usage.outTokens += estimateTokens(reply || '')
        return reply
      },
      ...(runtime.subagent ? { subagent: runtime.subagent } : {}),
    }
    const plan = Plan.fromJSON(state.planSteps)
    const traces = TraceStore.fromJSON(state.traceSteps)
    const controller = new AbortController()
    this.runs.set(state.id, { controller, graph, plan, traces })
    // The ARTEX tool surface works through this holder for as long as the run
    // is live; one running assessment per session makes the key unambiguous.
    this.activeBySession.set(state.sessionId, {
      graph,
      traces,
      constraints: loop.constraints,
      objective: state.objective,
    })
    this.pauseRequested.delete(state.id)
    this.cancelRequested.delete(state.id)
    state.status = 'running'
    state.endedAt = undefined
    state.error = undefined

    const engine = new ReconEngine(graph, plan, traces, {
      goalId: state.goalIds.length === 1 ? state.goalIds[0] : undefined,
      minCoveragePct: state.coverageArg,
      maxRounds: state.rounds,
      maxIntents: state.intents,
      concurrency: state.concurrency,
      timeoutMs: state.timeoutMs,
      signal: controller.signal,
      adoptOpenIntents: true,
      locale: state.locale,
      compaction: { summarizer: makeSummarizer(counting) },
      onEvent: (event) => {
        const at = new Date().toISOString()
        state.activity.push({ at, round: event.round, kind: event.kind, text: event.text })
        if (state.activity.length > MAX_ACTIVITY) state.activity.splice(0, state.activity.length - MAX_ACTIVITY)
        if (event.kind === 'planner' || event.kind === 'system') {
          state.sessions.push({
            id: `ses_${(state.sessions.length + 1).toString(36)}_${Date.now().toString(36)}`,
            kind: event.kind,
            title: event.text,
            round: event.round,
            startedAt: at,
          })
          if (state.sessions.length > MAX_SESSIONS) state.sessions.splice(0, state.sessions.length - MAX_SESSIONS)
        } else if (event.kind === 'intent' && event.refId) {
          state.sessions.push({
            id: `ses_${(state.sessions.length + 1).toString(36)}_${Date.now().toString(36)}`,
            kind: 'worker',
            title: event.text,
            refId: event.refId,
            round: event.round,
            startedAt: at,
          })
          if (state.sessions.length > MAX_SESSIONS) state.sessions.splice(0, state.sessions.length - MAX_SESSIONS)
        }
        state.planSteps = plan.toJSON()
        state.traceSteps = traces.toJSON()
        void this.persist(state)
      },
    })

    engine
      .run(makePlanner(counting, plan, loop), makeWorker(counting, loop))
      .then(async (report) => {
        state.stopped = report.stopped
        state.report = {
          rounds: report.rounds,
          intents: report.intents,
          facts: report.facts,
          findings: report.findings,
          digests: report.digests,
          traces: traces.size,
          proven: report.proven,
          pct: report.coverage.pct,
        }
        // The caller's intent outranks the engine's own reason: a pause request
        // during a drain still ends the run, but as a pause, not a verdict.
        state.status = this.cancelRequested.has(state.id)
          ? 'cancelled'
          : this.pauseRequested.has(state.id)
            ? 'paused'
            : 'done'
        state.endedAt = new Date().toISOString()
        state.planSteps = plan.toJSON()
        state.traceSteps = traces.toJSON()
        await this.persist(state)
      })
      .catch(async (error: any) => {
        state.status = 'failed'
        state.error = error?.message || String(error)
        state.endedAt = new Date().toISOString()
        await this.persist(state)
      })
      .finally(() => {
        this.runs.delete(state.id)
        // The tool surface loses its run context on purpose: with no live run
        // there is nothing for record_fact & co. to operate on.
        if (this.activeBySession.get(state.sessionId)?.traces === traces) {
          this.activeBySession.delete(state.sessionId)
        }
        this.pauseRequested.delete(state.id)
        this.cancelRequested.delete(state.id)
      })
  }

  /** pause / resume / cancel / delete. Anything else is refused. */
  async control(id: string, action: string): Promise<AssessmentState> {
    await this.ensureLoaded()
    const state = this.states.get(id)
    if (!state) throw new Error(`unknown assessment: ${id}`)
    if (action === 'pause') {
      const run = this.runs.get(id)
      if (!run) throw new Error('assessment is not running')
      this.pauseRequested.add(id)
      run.controller.abort()
    } else if (action === 'resume') {
      if (state.status !== 'paused') throw new Error(`cannot resume a ${state.status} assessment`)
      const graph = await this.graphFor(state.sessionId)
      const loop: LoopContext = {
        objective: state.objective,
        scopeLine: `Scope (never leave it): ${state.scope.join(', ')}`,
        constraints: state.constraints,
        fallbackAssets: state.targets,
        graph,
        ...(state.model ? { model: state.model } : {}),
      }
      this.startActivity(state, graph, this.runtimeFor(state), loop)
      await this.persist(state)
    } else if (action === 'cancel') {
      const run = this.runs.get(id)
      if (run) {
        this.cancelRequested.add(id)
        run.controller.abort()
      } else if (state.status === 'paused' || state.status === 'running') {
        state.status = 'cancelled'
        state.endedAt = new Date().toISOString()
        await this.persist(state)
      } else {
        throw new Error(`cannot cancel a ${state.status} assessment`)
      }
    } else if (action === 'delete') {
      if (this.runs.has(id)) throw new Error('stop the assessment before deleting it')
      this.states.delete(id)
      if (this.dir) await fs.promises.rm(path.join(this.dir, `${id}.json`), { force: true }).catch(() => {})
    } else {
      throw new Error(`unknown control action: ${action}`)
    }
    return state
  }

  /** The live run context for a session, if an assessment (or a registered deep_scan) is running. */
  activeFor(sessionId: string): ArtexRunContext | undefined {
    return this.activeBySession.get(sessionId)
  }

  /** deep_scan registers its own run so its workers get the same tool surface. */
  registerRun(sessionId: string, holder: ArtexRunContext): void {
    this.activeBySession.set(sessionId, holder)
  }

  releaseRun(sessionId: string): void {
    this.activeBySession.delete(sessionId)
  }

  /** A resumed run needs the same model plumbing the creating call had. */
  private runtimeFor(state: AssessmentState): LoopRuntime {
    const runtime = this.sessionRuntimes.get(state.sessionId)
    if (!runtime) throw new Error('no model runtime available for resuming — open the panel or ask the agent, then resume again')
    return runtime
  }

  /** Last model plumbing seen for a session; refreshed by every tool call. */
  private sessionRuntimes = new Map<string, LoopRuntime>()

  /** Steering: a hint lands on the session graph where the planner will read it. */
  async hint(id: string, text: string): Promise<void> {
    await this.ensureLoaded()
    const state = this.states.get(id)
    if (!state) throw new Error(`unknown assessment: ${id}`)
    const trimmed = String(text || '').trim()
    if (!trimmed) throw new Error('hint text is required')
    const graph = await this.graphFor(state.sessionId)
    graph.addHint(trimmed, state.targets)
    state.activity.push({ at: new Date().toISOString(), round: -1, kind: 'hint', text: trimmed })
    if (state.activity.length > MAX_ACTIVITY) state.activity.splice(0, state.activity.length - MAX_ACTIVITY)
    await this.persist(state)
  }

  /**
   * Remember the model plumbing of the most recent call from a session, so a
   * paused task can resume even after a process restart — the panel polls the
   * list, which refreshes this, before the user can press resume.
   */
  rememberRuntime(sessionId: string, runtime: LoopRuntime): void {
    this.sessionRuntimes.set(sessionId, runtime)
    if (this.sessionRuntimes.size > 32) {
      const oldest = this.sessionRuntimes.keys().next().value
      if (oldest && oldest !== sessionId) this.sessionRuntimes.delete(oldest)
    }
  }

  /** Omit<AssessmentState, …> plus a couple of live counts the list shows. */
  async list(sessionId?: string): Promise<Array<Omit<AssessmentState, 'activity' | 'planSteps' | 'traceSteps'> & { goalProgress?: { met: number; total: number }; findingsCount?: number }>> {
    await this.ensureLoaded()
    const rows = [...this.states.values()]
      .filter((state) => !sessionId || state.sessionId === sessionId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    return Promise.all(rows.map(async ({ activity, planSteps, traceSteps, ...rest }) => {
      try {
        const graph = await this.graphFor(rest.sessionId)
        const nodes = graph.toJSON().nodes
        const goals = rest.goalIds.map((gid) => graph.node(gid)).filter(Boolean) as ExplorationNode[]
        const met = goals.filter((goal) => goal.status === 'met').length
        const findingsCount = nodes.filter((node) => node.kind === 'finding').length
        return {
          ...rest,
          ...(goals.length ? { goalProgress: { met, total: goals.length } } : {}),
          findingsCount,
        }
      } catch {
        return rest
      }
    }))
  }

  /** A worker session's execution trace (ARTEX 执行过程 rows). */
  trace(id: string, intentId: string): TraceStep[] {
    const state = this.states.get(id)
    if (!state) throw new Error(`unknown assessment: ${id}`)
    const intent = String(intentId || '').trim()
    if (!intent) throw new Error('intent_id is required')
    return (state.traceSteps || []).filter((step) => step.intentId === intent)
  }

  async get(id: string): Promise<{ state: AssessmentState; live?: AssessmentLive }> {
    await this.ensureLoaded()
    const state = this.states.get(id)
    if (!state) throw new Error(`unknown assessment: ${id}`)
    let live: AssessmentLive | undefined
    try {
      const graph = await this.graphFor(state.sessionId)
      const nodes = graph.toJSON().nodes
      live = {
        coverage: graph.coverage(),
        goals: state.goalIds
          .map((gid) => graph.node(gid))
          .filter(Boolean)
          .map((node) => ({ id: node!.id, text: node!.text, status: String(node!.status) })),
        openIntents: graph.frontier().slice(0, 20).map((node) => ({ id: node.id, text: node.text, ...(node.priority != null ? { priority: node.priority } : {}) })),
        runningIntents: nodes.filter((node) => node.kind === 'intent' && node.status === 'running').length,
        findings: nodes.filter((node) => node.kind === 'finding').map((node) => ({ id: node.id, text: node.text, status: String(node.status) })),
        digests: graph.digests().length,
        sessions: (state.sessions || []).map((entry) => {
          if (entry.kind !== 'worker' || !entry.refId) return { ...entry, status: 'done' }
          const node = graph.node(entry.refId)
          const status = !node ? 'done'
            : node.status === 'open' ? 'queued'
            : String(node.status)
          return { ...entry, status }
        }),
        usage: state.usage || { llmCalls: 0, inTokens: 0, outTokens: 0 },
      }
    } catch {
      // A graph that cannot be read right now does not hide the task's ledger.
    }
    return { state, live }
  }

  /**
   * Render a task's graph into a Markdown deliverable — the report module, fed
   * by the same graph the panel draws. No step is described that the graph does
   * not show. With `preview` the markdown comes back without touching disk.
   */
  async report(id: string, outPath: string | undefined, cwd: string, preview = false): Promise<{ path?: string; markdown?: string; findings: number; pct: number | null }> {
    await this.ensureLoaded()
    const state = this.states.get(id)
    if (!state) throw new Error(`unknown assessment: ${id}`)
    const graph = await this.graphFor(state.sessionId)
    const markdown = renderAssessmentReport(state, graph)
    const findings = graph.toJSON().nodes.filter((node) => node.kind === 'finding').length
    const pct = graph.coverage().scope.pct
    if (preview) return { markdown, findings, pct }
    const resolved = path.resolve(cwd || process.cwd(), outPath && String(outPath).trim() ? String(outPath).trim() : `assessment-${id}.md`)
    await writeFileAtomic(resolved, markdown)
    return { path: resolved, findings, pct }
  }
}
