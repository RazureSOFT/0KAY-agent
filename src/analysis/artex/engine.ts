import { ReconGraph } from './graph.js'
import type { ExplorationNode } from './graph.js'
import { Plan } from './plan.js'
import type { PlanStep } from './plan.js'
import { TraceStore } from './traces.js'
import type { TraceStep } from './traces.js'

// The ARTEX engine loop, rebuilt: planner reads the situation, dispatches intents,
// workers claim one each, results go back into the graph, repeat.
//
// The three details that make it terminate instead of spinning:
//
//   1. a round that dispatches zero intents ends the run. That is the normal way
//      to finish — most wake-ups have nothing new to try.
//   2. a round that changes nothing (no fact, no finding, no plan progress) ends
//      the run. Without this, a planner with a favourite idea runs forever.
//   3. a budget: rounds and intents. A scan is not allowed to be unbounded because
//      the model is feeling thorough.
//
// Everything here is pure orchestration; the planner and the worker are injected,
// which is why the loop can be tested without a model.

export interface Situation {
  round: number
  overview: ReturnType<ReconGraph['overview']>
  /** Plan steps whose prerequisites are satisfied. */
  ready: PlanStep[]
  plan: ReturnType<Plan['state']>
  /** Compact digest of what other workers already tried. */
  traces: Array<{ intentId: string; steps: number; workers: string[] }>
  budget: { roundsLeft: number; intentsLeft: number }
}

export interface IntentSpec {
  text: string
  assets?: string[]
  /** Plan step this intent advances; completing the intent completes the step. */
  stepId?: string
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

export interface EngineOptions {
  maxRounds?: number
  maxIntents?: number
  concurrency?: number
  /** Proved automatically once a finding anchors to it. */
  goalId?: string
  onEvent?: (event: { round: number; kind: 'intent' | 'fact' | 'finding' | 'stop'; text: string }) => void
}

export interface EngineReport {
  rounds: number
  intents: number
  facts: number
  findings: number
  proven: boolean
  stopped: 'goal-proven' | 'planner-idle' | 'no-progress' | 'budget' | 'plan-complete'
  coverage: { total: number; tested: number; untested: number }
  durationMs: number
}

export class ReconEngine {
  private readonly maxRounds: number
  private readonly maxIntents: number
  private readonly concurrency: number

  constructor(
    readonly graph: ReconGraph,
    readonly plan: Plan,
    readonly traces: TraceStore,
    private readonly options: EngineOptions = {},
  ) {
    this.maxRounds = Math.max(1, options.maxRounds ?? 6)
    this.maxIntents = Math.max(1, options.maxIntents ?? 12)
    this.concurrency = Math.max(1, Math.min(options.concurrency ?? 3, 8))
  }

  private situation(round: number, intentsUsed: number): Situation {
    return {
      round,
      overview: this.graph.overview(),
      ready: this.plan.ready(),
      plan: this.plan.state(),
      traces: this.traces.list().map(({ intentId, steps, workers }) => ({ intentId, steps, workers })),
      budget: { roundsLeft: this.maxRounds - round, intentsLeft: this.maxIntents - intentsUsed },
    }
  }

  async run(planner: Planner, worker: Worker): Promise<EngineReport> {
    const started = Date.now()
    let rounds = 0
    let intents = 0
    let facts = 0
    let findings = 0
    let stopped: EngineReport['stopped'] = 'budget'

    for (let round = 1; round <= this.maxRounds; round++) {
      rounds = round
      const situation = this.situation(round, intents)

      if (this.options.goalId && this.isProven(this.options.goalId)) {
        stopped = 'goal-proven'
        break
      }
      if (this.plan.isComplete() && this.graph.openIntents().length === 0 && this.plan.state().total > 0) {
        stopped = 'plan-complete'
        break
      }
      if (intents >= this.maxIntents) {
        stopped = 'budget'
        break
      }

      let dispatched: IntentSpec[] = []
      try {
        dispatched = (await planner(situation)) || []
      } catch {
        // A planner that throws is a planner with nothing to say.
        dispatched = []
      }

      if (!dispatched.length) {
        // The normal ending: nothing new to try.
        stopped = 'planner-idle'
        break
      }

      const room = Math.min(dispatched.length, this.maxIntents - intents)
      const batch = dispatched.slice(0, room)
      intents += batch.length

      const progress = await this.runBatch(batch, situation, worker)
      facts += progress.facts
      findings += progress.findings

      if (!progress.changed) {
        stopped = 'no-progress'
        break
      }
    }

    if (this.options.goalId && this.isProven(this.options.goalId)) stopped = 'goal-proven'
    const coverage = this.graph.coverage()
    return {
      rounds,
      intents,
      facts,
      findings,
      proven: Boolean(this.options.goalId && this.isProven(this.options.goalId)),
      stopped,
      coverage: { total: coverage.total, tested: coverage.tested, untested: coverage.untested.length },
      durationMs: Date.now() - started,
    }
  }

  /** Run one round's intents, at most `concurrency` at a time. */
  private async runBatch(batch: IntentSpec[], situation: Situation, worker: Worker): Promise<{ facts: number; findings: number; changed: boolean }> {
    let facts = 0
    let findings = 0
    let failed = 0
    let changed = false
    const queue = [...batch]

    const runOne = async (spec: IntentSpec) => {
      const intentNode = this.graph.addNode({ kind: 'intent', text: spec.text, assets: spec.assets })
      this.options.onEvent?.({ round: situation.round, kind: 'intent', text: spec.text })

      let result: WorkerResult
      try {
        result = await worker(spec, situation)
      } catch (error: any) {
        // A worker that fails is an intent that failed, not a crashed run.
        this.graph.complete(intentNode.id, 'failed')
        // A failure is information: the planner deserves one more chance to try
        // something else. Without this, one broken tool ends the scan.
        failed += 1
        changed = true
        this.traces.record({
          intentId: intentNode.id,
          worker: spec.text.slice(0, 24),
          action: 'worker-error',
          detail: error?.message || String(error),
          ok: false,
        })
        return
      }

      for (const fact of result.facts || []) {
        this.graph.addNode({ kind: 'fact', text: fact.text, assets: fact.assets || spec.assets, derivedFrom: [intentNode.id] })
        facts += 1
        changed = true
        this.options.onEvent?.({ round: situation.round, kind: 'fact', text: fact.text })
      }
      for (const finding of result.findings || []) {
        this.graph.addNode({ kind: 'finding', text: finding.text, assets: finding.assets || spec.assets, derivedFrom: [intentNode.id] })
        findings += 1
        changed = true
        this.options.onEvent?.({ round: situation.round, kind: 'finding', text: finding.text })
      }
      for (const step of result.steps || []) {
        this.traces.record({ ...step, intentId: intentNode.id, worker: spec.text.slice(0, 24) })
      }

      this.graph.complete(intentNode.id, 'done')
      if (spec.stepId) {
        try {
          this.plan.complete(spec.stepId, result.note)
          changed = true
        } catch {
          // A stale step id is not a reason to lose the findings.
        }
      }
    }

    const workers = Array.from({ length: Math.min(this.concurrency, queue.length) }, async () => {
      for (;;) {
        const next = queue.shift()
        if (!next) return
        await runOne(next)
      }
    })
    await Promise.all(workers)

    return { facts, findings, changed: changed || failed > 0 }
  }

  /**
   * Prove the goal when the evidence is there. `graph.prove` refuses without a
   * finding anchored to it, so the attempt is cheap and the refusal is the answer.
   */
  private isProven(goalId: string): boolean {
    const nodes = this.graph.toJSON().nodes as ExplorationNode[]
    const node = nodes.find((entry) => entry.id === goalId)
    if (!node || node.kind !== 'goal') return false
    if (node.status === 'done') return true
    try {
      this.graph.prove(goalId)
      return true
    } catch {
      return false
    }
  }
}
