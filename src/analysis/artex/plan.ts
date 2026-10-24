// ARTEX's "planner shared todolist": a chain that survives the planner's amnesia.
//
// Every planner wake-up is a fresh conversation — it does not remember the last
// one. Real exploitation is order-dependent (find the injection point → get
// credentials → move laterally → escalate), so a planner that re-decides the
// order every round produces a different order every round, and nothing finishes.
//
// The fix is a plan that lives outside the model: ordered steps, each naming what
// it depends on. Each round the planner only sees the steps whose prerequisites
// are already satisfied, and marks the ones that finished.

export type StepStatus = 'pending' | 'ready' | 'done' | 'blocked' | 'skipped'

export interface PlanStep {
  id: string
  text: string
  /** Step ids that must be done before this one is ready. */
  needs: string[]
  status: StepStatus
  note?: string
}

export interface PlanState {
  steps: PlanStep[]
  done: number
  total: number
  ready: PlanStep[]
  blocked: PlanStep[]
}

export class Plan {
  private steps = new Map<string, PlanStep>()
  private seq = 0

  add(text: string, needs: string[] = []): PlanStep {
    const trimmed = String(text || '').trim()
    if (!trimmed) throw new Error('step text is required')
    for (const dependency of needs) {
      if (!this.steps.has(dependency)) throw new Error(`step depends on unknown step: ${dependency}`)
    }
    this.seq += 1
    const step: PlanStep = {
      id: `s${this.seq}`,
      text: trimmed,
      needs: [...needs],
      status: needs.length ? 'pending' : 'ready',
    }
    this.steps.set(step.id, step)
    return step
  }

  /** Replace the whole plan, keeping the status of steps whose text is unchanged. */
  setAll(texts: Array<{ text: string; needs?: string[] }>): PlanStep[] {
    const previous = new Map([...this.steps.values()].map((step) => [step.text, step.status]))
    this.steps.clear()
    this.seq = 0
    const created: PlanStep[] = []
    for (const entry of texts) {
      const step = this.add(entry.text, entry.needs || [])
      const before = previous.get(step.text)
      if (before === 'done' || before === 'skipped') step.status = before
      created.push(step)
    }
    this.refresh()
    return created
  }

  complete(id: string, note?: string): PlanStep {
    const step = this.steps.get(id)
    if (!step) throw new Error(`unknown step: ${id}`)
    step.status = 'done'
    if (note) step.note = note
    this.refresh()
    return step
  }

  skip(id: string, note?: string): PlanStep {
    const step = this.steps.get(id)
    if (!step) throw new Error(`unknown step: ${id}`)
    step.status = 'skipped'
    if (note) step.note = note
    this.refresh()
    return step
  }

  /** Recompute ready/pending from the dependency graph. */
  private refresh(): void {
    for (const step of this.steps.values()) {
      if (step.status === 'done' || step.status === 'skipped') continue
      const satisfied = step.needs.every((dependency) => {
        const state = this.steps.get(dependency)?.status
        return state === 'done' || state === 'skipped'
      })
      step.status = satisfied ? 'ready' : 'pending'
    }
  }

  /** What the planner is allowed to work on this round. */
  ready(): PlanStep[] {
    this.refresh()
    return [...this.steps.values()].filter((step) => step.status === 'ready')
  }

  state(): PlanState {
    const steps = [...this.steps.values()]
    return {
      steps,
      done: steps.filter((step) => step.status === 'done' || step.status === 'skipped').length,
      total: steps.length,
      ready: steps.filter((step) => step.status === 'ready'),
      blocked: steps.filter((step) => step.status === 'pending'),
    }
  }

  /** A plan with ready work left is unfinished, not merely large. */
  isComplete(): boolean {
    return [...this.steps.values()].every((step) => step.status === 'done' || step.status === 'skipped')
  }
}
