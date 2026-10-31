import { ReconGraph } from './graph.js'
import type { ExplorationNode } from './graph.js'
import { adjacency, hotSet, advanceColdStreaks, groupEligible, defaultColdParams } from './coldgraph.js'
import type { ColdParams } from './coldgraph.js'
import { Plan } from './plan.js'
import type { PlanStep, PlanState } from './plan.js'
import { TraceStore } from './traces.js'
import type { TraceStep } from './traces.js'

// The engine loop, second pass — the shape now follows the original's split:
// a worker pool that pulls from the intent frontier, and a planner that is
// woken by *events* rather than run on a fixed schedule.
//
//   - workers claim an open intent (open → running is the claim), execute it,
//     and close it with a terminal state that says how it ended: done, blocked
//     (it hit a wall), exhausted (it ran out of turns or time), stopped (killed).
//     A paused intent leaves the frontier and can rejoin it later.
//   - the planner is called when something happened: the work queue drained, a
//     finding landed, or a previous round produced nothing. Wake-ups that arrive
//     while the planner is thinking coalesce into its next round.
//   - the run ends when the goals are proven (evidence, not assertion), when the
//     planner has nothing left to dispatch and nothing is running, when the plan
//     is finished, or when a budget bites. A budget hit gets one *settlement*
//     round: a last chance to write back what was learned before the run is
//     called over, instead of discarding half-finished observations.
//   - every planner round also advances the cold-region bookkeeping: regions
//     that have been unreachable from live work for R consecutive rounds get
//     folded into digest nodes (members are kept; the digest is a view).
//
// The engine is embedded in a long-lived session graph, so its accounting only
// covers what happened during THIS run: the budget counts intents it dispatched
// or claimed itself, never directions that were already waiting on the frontier.
//
// Everything here is pure orchestration; the planner, the worker and the digest
// summarizer are injected, which is why the loop can be tested without a model.

export interface Situation {
  round: number
  overview: ReturnType<ReconGraph['overview']>
  /** Plan steps whose prerequisites are satisfied. */
  ready: PlanStep[]
  plan: PlanState
  /** Compact digest of what other workers already tried. */
  traces: Array<{ intentId: string; steps: number; workers: string[] }>
  budget: { roundsLeft: number; intentsLeft: number; msLeft: number }
  /** True on the final write-back round after a budget hit. */
  settlement?: boolean
}

export interface IntentSpec {
  text: string
  assets?: string[]
  /** Plan step this intent advances; completing the intent completes the step. */
  stepId?: string
  /** Queue position, 0-10, higher first. */
  priority?: number
  /** The graph node id, set by the engine when it hands the intent to a worker. */
  id?: string
  /** What this direction already produced (resume after interruption). */
  prior?: string[]
  /** Read-only situation snapshot for worker awareness (coverage removed). */
  overview?: string
}

export interface WorkerResult {
  facts?: Array<{ text: string; assets?: string[] }>
  findings?: Array<{ text: string; assets?: string[] }>
  /** What the worker actually did, for the other workers to search. */
  steps?: Array<Omit<TraceStep, 'intentId' | 'worker' | 'at'> & { at?: string }>
  note?: string
}

export type Planner = (situation: Situation) => Promise<IntentSpec[]>
export type Worker = (intent: IntentSpec, situation: Situation) => Promise<WorkerResult>
/** Turns a cold region's member texts into one digest summary. */
export type Summarizer = (texts: string[]) => Promise<string>

export interface EngineOptions {
  maxRounds?: number
  maxIntents?: number
  concurrency?: number
  /** Proved automatically once a finding anchors to it. */
  goalId?: string
  /** Refuse to prove goals while scope coverage is below this percentage. */
  minCoveragePct?: number
  /** Wall-clock cap for the whole run. */
  timeoutMs?: number
  /** Abort from outside: stop dispatching, drain what is running, end as 'aborted'. */
  signal?: AbortSignal
  /** Event-text language: 'zh' (default) or 'en'. */
  locale?: string
  /**
   * Adopt every open intent on the frontier at start (a resumed run picking up
   * where the last one was interrupted). Without it the run only ever claims
   * what it dispatched itself — on a graph shared with other live runs,
   * claiming anything else would steal their work and deadlock their drain.
   */
  adoptOpenIntents?: boolean
  /** One final write-back round when a budget bites (default true). */
  settleOnBudget?: boolean
  /** Cold-region folding: omit to keep it off; R/K default to 6/2. */
  compaction?: { R?: number; K?: number; summarizer: Summarizer }
  onEvent?: (event: { round: number; kind: 'intent' | 'fact' | 'finding' | 'digest' | 'planner' | 'system'; text: string; refId?: string }) => void
}

export interface EngineReport {
  rounds: number
  intents: number
  facts: number
  findings: number
  digests: number
  proven: boolean
  stopped: 'goal-proven' | 'planner-idle' | 'no-progress' | 'budget-settled' | 'budget' | 'plan-complete' | 'timeout' | 'aborted'
  coverage: { total: number; tested: number; untested: number; denominator: number; pct: number | null }
  durationMs: number
}

/** A tiny broadcast bus: waiters get the next emit, emitters never block. */
class Signal {
  private waiters: Array<() => void> = []
  wait(): Promise<void> {
    return new Promise((resolve) => { this.waiters.push(resolve) })
  }
  emit(): void {
    const waiters = this.waiters
    this.waiters = []
    for (const waiter of waiters) waiter()
  }
}

export class ReconEngine {
  private readonly maxRounds: number
  private readonly maxIntents: number
  private readonly concurrency: number
  private readonly timeoutMs: number
  private readonly settleOnBudget: boolean
  private readonly cold: ColdParams
  private readonly summarizer?: Summarizer
  private readonly coldStreaks = new Map<string, number>()
  private readonly stepByIntent = new Map<string, string>()
  /** Intents this run dispatched or claimed — the only ones the budget counts. */
  private readonly counted = new Set<string>()
  /** Intents this run may claim: its own dispatches, plus adopted ones at start. */
  private readonly owned = new Set<string>()
  private adopted = false
  private nudged = false
  private settlementCount = 0

  constructor(
    readonly graph: ReconGraph,
    readonly plan: Plan,
    readonly traces: TraceStore,
    private readonly options: EngineOptions = {},
  ) {
    this.maxRounds = Math.max(1, options.maxRounds ?? 10)
    this.maxIntents = Math.max(1, options.maxIntents ?? 16)
    this.concurrency = Math.max(1, Math.min(options.concurrency ?? 3, 8))
    this.timeoutMs = Math.max(5_000, options.timeoutMs ?? 420_000)
    this.settleOnBudget = options.settleOnBudget !== false
    this.cold = { R: options.compaction?.R ?? defaultColdParams().R, K: options.compaction?.K ?? defaultColdParams().K }
    this.summarizer = options.compaction?.summarizer
  }

  private situation(round: number, started: number, settlement = false): Situation {
    return {
      round,
      overview: this.graph.overview(),
      ready: this.plan.ready(),
      plan: this.plan.state(),
      traces: this.traces.list().map(({ intentId, steps, workers }) => ({ intentId, steps, workers })),
      budget: {
        roundsLeft: Math.max(0, this.maxRounds - round),
        intentsLeft: Math.max(0, this.maxIntents - this.counted.size),
        msLeft: Math.max(0, this.timeoutMs - (Date.now() - started)),
      },
      ...(settlement ? { settlement: true } : {}),
    }
  }

  private nodes(): ExplorationNode[] {
    return this.graph.toJSON().nodes
  }

  /** Claim the next open intent this run owns: open → running is the claim, so
   *  two workers can never take the same direction. Priority first, then oldest. */
  claimNext(): ExplorationNode | null {
    // Adoption happens once, lazily before the first claim, when no other live
    // run should be on this graph (the manager caps one running assessment per
    // session).
    if (this.options.adoptOpenIntents && !this.adopted) {
      this.adopted = true
      for (const node of this.graph.frontier()) this.owned.add(node.id)
    }
    for (const candidate of this.graph.frontier()) {
      if (!this.owned.has(candidate.id)) continue
      try {
        this.graph.setStatus(candidate.id, 'running')
        this.counted.add(candidate.id)
        return candidate
      } catch {
        // Another worker claimed it between the read and the write; try the next.
      }
    }
    return null
  }

  /** Pull an intent out of the queue without losing it. */
  pause(id: string): void {
    this.graph.setStatus(id, 'paused')
  }

  /** Put a paused intent back into the frontier. */
  resume(id: string): void {
    this.graph.setStatus(id, 'open')
  }

  /** Kill an intent that has not started yet. */
  kill(id: string): void {
    this.graph.setStatus(id, 'stopped')
  }

  private t(zh: string, en: string): string {
    return this.options.locale === 'en' ? en : zh
  }

  async run(planner: Planner, worker: Worker): Promise<EngineReport> {
    const started = Date.now()
    const wake = new Signal()
    this.nudged = false
    // An abort has to wake a coordinator that may be mid-drain; otherwise the
    // run would sleep until the next event before noticing it was killed.
    const onAbort = () => wake.emit()
    this.options.signal?.addEventListener('abort', onAbort, { once: true })
    let stop: EngineReport['stopped'] | null = null
    let rounds = 0
    let facts = 0
    let findings = 0
    let idleRounds = 0
    let running = 0

    const isProven = (): boolean => {
      if (this.options.goalId) {
        const goal = this.graph.node(this.options.goalId)
        return !!goal && goal.kind === 'goal' && goal.status === 'met'
      }
      const goals = this.nodes().filter((node) => node.kind === 'goal')
      return goals.length > 0 && goals.every((goal) => goal.status === 'met' || goal.status === 'abandoned')
    }

    const runIntent = async (node: ExplorationNode, situation: Situation): Promise<void> => {
      // Exactly one decrement, whatever happens inside: the coordinator's
      // drain predicate counts on it.
      try {
        await runIntentBody(node, situation)
      } finally {
        running -= 1
        wake.emit()
      }
    }
    const runIntentBody = async (node: ExplorationNode, situation: Situation): Promise<void> => {
      // What this direction already produced (a re-queued intent after a pause
      // or a crash) rides with the spec: the worker continues instead of
      // repeating it.
      const prior = this.graph
        .edgesOut()
        .filter((edge) => edge.src === node.id && edge.rel === 'yields')
        .map((edge) => this.graph.node(edge.dst)?.text)
        .filter(Boolean) as string[]
      const spec: IntentSpec = {
        id: node.id,
        text: node.text,
        assets: node.assetIds.map((id) => this.graph.asset(id)?.key).filter(Boolean) as string[],
        ...(prior.length ? { prior } : {}),
        // Awareness without mandate creep: the full situation minus coverage —
        // the original strips coverage from the worker view for exactly this reason.
        overview: JSON.stringify({ ...situation.overview, coverage: undefined }),
        ...(this.stepByIntent.get(node.id) ? { stepId: this.stepByIntent.get(node.id) } : {}),
        ...(node.priority != null ? { priority: node.priority } : {}),
      }
        let result: WorkerResult
        try {
          result = await worker(spec, situation)
        } catch (error: any) {
          // A worker that fails is an intent that hit a wall, not a crashed run.
          // The failure is information: the planner sees a blocked intent and can
          // route around it, which is why this does not end the run.
          this.graph.setStatus(node.id, 'blocked')
          this.traces.record({
            intentId: node.id,
            worker: spec.text.slice(0, 24),
            action: 'worker-error',
            detail: error?.message || String(error),
            ok: false,
          })
          this.options.onEvent?.({ round: situation.round, kind: 'system', text: this.t(`worker 在 "${spec.text.slice(0, 40)}" 上受阻：${error?.message || error}`, `worker blocked on "${spec.text.slice(0, 40)}": ${error?.message || error}`) })
          return
        }

      for (const fact of result.facts || []) {
        this.graph.addNode({ kind: 'fact', text: fact.text, assets: fact.assets || spec.assets, derivedFrom: [node.id] })
        facts += 1
        this.options.onEvent?.({ round: situation.round, kind: 'fact', text: fact.text })
      }
      for (const found of result.findings || []) {
        const findingNode = this.graph.addNode({ kind: 'finding', text: found.text, assets: found.assets || spec.assets, derivedFrom: [node.id] })
        findings += 1
        this.options.onEvent?.({ round: situation.round, kind: 'finding', text: found.text })
        // Evidence is the trigger to try proving: the graph refuses when the
        // evidence is not there or the coverage gate is unmet, and the refusal
        // is the answer. Every open goal gets a chance — a finding can close
        // more than one of them.
        const goals = this.nodes().filter((node) => node.kind === 'goal' && node.status === 'open')
        for (const goal of goals) {
          if (this.options.goalId && goal.id !== this.options.goalId) continue
          try {
            this.graph.prove(goal.id, findingNode.id, this.options.minCoveragePct)
          } catch { /* not proven yet */ }
        }
      }
      for (const step of result.steps || []) {
        this.traces.record({ ...step, intentId: node.id, worker: spec.text.slice(0, 24) })
      }

      this.graph.setStatus(node.id, 'done')
      const stepId = this.stepByIntent.get(node.id)
      if (stepId) {
        try {
          this.plan.complete(stepId, result.note)
        } catch {
          // A stale step id is not a reason to lose the findings.
        }
      }
    }

    let currentSituation: Situation = this.situation(0, started)
    const nothingRunning = () => running <= 0 && this.graph.frontier().length === 0
    const aborted = () => !!this.options.signal?.aborted

    // A resumed run picks up the frontier the last run left behind — say so in
    // the task log, the same way the original's session tree shows a resumed
    // conversation.
    if (this.options.adoptOpenIntents && this.graph.frontier().length) {
      const pending = this.graph.frontier().length
      this.options.onEvent?.({ round: 0, kind: 'system', text: this.t(`收编 ${pending} 条未完成方向，继续执行`, `Adopted ${pending} unfinished intents, continuing`) })
    }

    // The worker pool: claim what is open, otherwise sleep until the planner
    // dispatches or the run ends. Workers overlap planner rounds — a direction
    // queued while another executes is picked up without waiting for the batch.
    const workerLoops = Array.from({ length: this.concurrency }, async () => {
      for (;;) {
        if (aborted()) return
        const node = this.claimNext()
        if (node) {
          running += 1
          void runIntent(node, { ...currentSituation }).catch(() => { /* the finally inside already counted it */ })
          continue
        }
        if (stop) return
        await wake.wait()
      }
    })

    // The coordinator: rebuild the situation, ask the planner, dispatch, wait
    // for something worth reacting to. All wake-ups funnel through one signal,
    // so bursts of worker completions collapse into the next planner round.
    const dispatch = (specs: IntentSpec[], settlement: boolean): void => {
      let room = settlement ? 2 : Math.max(0, this.maxIntents - this.counted.size)
      for (const spec of specs) {
        if (!spec?.text || room <= 0) continue
        room -= 1
        if (settlement) this.settlementCount += 1
        const node = this.graph.addNode({
          kind: 'intent',
          text: spec.text,
          assets: spec.assets,
          priority: spec.priority,
        })
        this.counted.add(node.id)
        this.owned.add(node.id)
        if (spec.stepId) this.stepByIntent.set(node.id, spec.stepId)
        this.options.onEvent?.({ round: currentSituation.round, kind: 'intent', text: spec.text, refId: node.id })
      }
      wake.emit()
    }

    // Progress is read off the GRAPH, not off the result envelopes: sub-agent
    // workers write facts mid-flight through their own tools, and a run that
    // only watched envelopes would call such a round barren and stop early.
    // Origin facts are bookkeeping, not observations. The result-envelope
    // counters (facts/findings below) remain for the report; they just no
    // longer decide whether the run is alive.
    const progress = (): number => {
      let observations = 0
      for (const node of this.nodes()) {
        if ((node.kind === 'fact' || node.kind === 'finding') && node.status !== 'origin') observations += 1
      }
      return observations + this.plan.state().done
    }

    try {
      while (!stop) {
        if (aborted()) { stop = 'aborted'; break }
        // Workers write findings straight into the graph mid-flight; a goal
        // whose evidence landed that way is proven here, not only when a
        // result envelope carries a finding.
        this.sweepProve()
        if (isProven()) { stop = 'goal-proven'; break }
        if (Date.now() - started > this.timeoutMs) { stop = 'timeout'; break }
        if (this.plan.isComplete() && nothingRunning() && this.plan.state().total > 0) { stop = 'plan-complete'; break }

        if (rounds >= this.maxRounds || this.counted.size >= this.maxIntents) {
          if (this.settleOnBudget && !aborted() && Date.now() - started <= this.timeoutMs) {
            // The settlement round: not new work — a last chance for the workers
            // to write back observations that would otherwise die with the run.
            this.options.onEvent?.({ round: rounds, kind: 'system', text: this.t('预算触发：进入收尾轮，写回未落图的观察', 'Budget reached: settlement round — write back unrecorded observations') })
            rounds += 1
            currentSituation = this.situation(rounds, started, true)
            const specs = await this.askPlanner(planner, currentSituation)
            dispatch(specs, true)
            await this.drain(wake, () => nothingRunning() || !!stop || aborted())
            stop = 'budget-settled'
          } else {
            stop = 'budget'
          }
          break
        }

        rounds += 1
        await this.compact()
        currentSituation = this.situation(rounds, started)
        this.options.onEvent?.({ round: rounds, kind: 'planner', text: this.t(`态势研判 #${rounds}`, `Planner round #${rounds}`) })
        const before = progress()
        let specs = await this.askPlanner(planner, currentSituation)
        // The original's hard floor: with unmet goals and an idle frontier, a
        // planner that dispatches nothing gets ONE strict re-ask before the
        // run accepts "nothing to do" — a silent JSON miss should not end a
        // task that never started.
        if (!specs.length && !this.nudged && this.counted.size === 0 && !currentSituation.settlement && !aborted()) {
          const openGoals = this.nodes().filter((node) => node.kind === 'goal' && node.status === 'open')
          if (openGoals.length) {
            this.nudged = true
            this.options.onEvent?.({ round: rounds, kind: 'system', text: this.t('planner 首轮未派意图，重申目标后重问一次', 'Planner dispatched nothing on round one — re-asking once') })
            specs = await this.askPlanner(planner, { ...currentSituation, budget: { ...currentSituation.budget, roundsLeft: Math.max(1, currentSituation.budget.roundsLeft) } })
          }
        }
        // Each drain measures progress from ITS OWN entry, not from before the
        // planner: dispatch itself moves the graph (origin facts, claims), and
        // a stale baseline would release the drain before any worker ran.
        const freshBaseline = (): (() => boolean) => {
          const baseline = progress()
          return () => progress() > baseline
        }

        if (!specs.length) {
          if (nothingRunning()) {
            // The normal ending: nothing queued, nothing running, nothing new.
            stop = idleRounds >= 1 ? 'no-progress' : 'planner-idle'
            break
          }
          // Something is still running; wait for it. If it produces nothing
          // either, this round counts as idle like any other.
          const moved = freshBaseline()
          await this.drain(wake, () => nothingRunning() || !!stop || aborted() || moved())
        } else {
          dispatch(specs, false)
          // Wait for the batch to act. A finding cuts in early — it may prove a
          // goal, and there is no point paying for more intents after that.
          const moved = freshBaseline()
          await this.drain(wake, () => nothingRunning() || !!stop || aborted() || moved())
        }

        if (progress() > before) idleRounds = 0
        else idleRounds += 1
        // A run that keeps dispatching but learns nothing is stuck: end it here
        // rather than letting it grind to the budget on repeat work.
        if (idleRounds >= 3) { stop = 'no-progress'; break }
      }
    } finally {
      this.options.signal?.removeEventListener('abort', onAbort)
      stop = stop || 'timeout'
      wake.emit()
      await Promise.allSettled(workerLoops)
      // Workers that were mid-flight when the run ended stay claimed forever
      // unless they are handed back: an interrupted direction returns to the
      // frontier so the next run redoes it instead of losing it. Only this
      // run's own claims are touched — the graph may be shared with other
      // live runs whose workers are nobody's business. (A worker that
      // finishes anyway still closes its intent; the late 'done' lands after
      // the revert.)
      for (const id of this.counted) {
        const node = this.graph.node(id)
        if (node && node.kind === 'intent' && node.status === 'running') {
          try { this.graph.setStatus(id, 'open') } catch { /* already closed by a late worker */ }
        }
      }
    }

    const coverage = this.graph.coverage()
    return {
      rounds,
      intents: this.counted.size - this.settlementCount,
      facts,
      findings,
      digests: this.graph.digests().length,
      proven: isProven(),
      stopped: stop ?? 'timeout',
      coverage: {
        total: coverage.total,
        tested: coverage.tested,
        untested: coverage.untested.length,
        denominator: coverage.scope.denominator,
        pct: coverage.scope.pct,
      },
      durationMs: Date.now() - started,
    }
  }

  /**
   * Try proving every open goal from whatever the graph now holds — a worker
   * that recorded a finding through its own tools mid-flight never passes
   * through a result envelope, so the sweep is what closes the gap. The graph
   * refuses when the evidence or the coverage gate says no; the refusal is
   * just this round's answer.
   */
  private sweepProve(): void {
    const goals = this.nodes().filter((node) => node.kind === 'goal' && node.status === 'open')
    if (!goals.length) return
    for (const goal of goals) {
      if (this.options.goalId && goal.id !== this.options.goalId) continue
      try {
        this.graph.prove(goal.id, undefined, this.options.minCoveragePct)
      } catch { /* not proven yet */ }
    }
  }

  /** Ask the planner once, retry a transient failure once, then give up quietly. */
  private async askPlanner(planner: Planner, situation: Situation): Promise<IntentSpec[]> {    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return (await planner(situation)) || []
      } catch {
        // A planner that throws twice in a row has nothing to say this round.
      }
    }
    return []
  }

  /** Sleep until the predicate holds or the run is told to stop. */
  private async drain(wake: Signal, done: () => boolean): Promise<void> {
    while (!done()) await wake.wait()
  }

  /**
   * Cold-region bookkeeping, once per planner round. Regions that have stayed
   * unreachable from live work for R consecutive rounds are folded into digest
   * nodes; members survive, the drawing collapses them, and any member that
   * later changes state supersedes the digest automatically.
   */
  async compact(): Promise<number> {
    if (!this.summarizer) return 0
    const nodes = this.nodes().map(({ id, kind, status }) => ({ id, kind, status }))
    const adj = adjacency(nodes, this.graph.edgesOut().map(({ src, rel, dst }) => ({ src, rel, dst })))
    const hot = hotSet(nodes, adj)
    const eligible = advanceColdStreaks(nodes, hot, this.coldStreaks, this.cold)
    const covered = new Set<string>()
    for (const digest of this.graph.digests()) for (const member of digest.memberIds) covered.add(member)
    const fresh = [...eligible].filter((id) => !covered.has(id))
    const blocks = groupEligible(new Set(fresh), adj, this.cold).slice(0, 2)
    let created = 0
    for (const block of blocks) {
      if (block.length > 50) continue
      const texts = block
        .map((id) => this.graph.node(id))
        .filter(Boolean)
        .map((node) => `${node!.kind} (${node!.status}): ${node!.text}`)
      try {
        const summary = await this.summarizer(texts)
        if (!summary?.trim()) continue
        this.graph.digest(summary.trim(), block)
        created += 1
        this.options.onEvent?.({ round: 0, kind: 'digest', text: summary.trim() })
      } catch {
        // A failed summary costs one round of compression, nothing else.
      }
    }
    return created
  }
}
