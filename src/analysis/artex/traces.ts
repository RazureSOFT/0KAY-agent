// ARTEX's cross-worker knowledge sharing, without the database.
//
// Workers run in parallel and cannot see each other's conversations, so the same
// endpoint gets probed five times. ARTEX solves it by letting a worker search the
// others' *execution traces* — not their conclusions, their steps. That is a
// different granularity: "someone already tried `sqlmap -u .../id=1` and got a 500"
// is more useful than a formalised fact, and it costs nothing to record.

export interface TraceStep {
  intentId: string
  worker: string
  action: string
  detail: string
  ok: boolean
  at: string
}

export interface TraceHit {
  intentId: string
  stepIds: number[]
  score: number
  excerpt: string
}

const MAX_STEPS = 2000

export class TraceStore {
  private steps: TraceStep[] = []

  record(step: Omit<TraceStep, 'at'> & { at?: string }): number {
    this.steps.push({ ...step, at: step.at || new Date().toISOString() })
    if (this.steps.length > MAX_STEPS) this.steps.splice(0, this.steps.length - MAX_STEPS)
    return this.steps.length - 1
  }

  /** Keyword search across every worker's steps, grouped by the intent they served. */
  search(query: string, options: { excludeIntent?: string; limit?: number } = {}): TraceHit[] {
    const needles = String(query || '')
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
    if (!needles.length) return []

    const byIntent = new Map<string, { ids: number[]; score: number; excerpts: string[] }>()
    this.steps.forEach((step, index) => {
      if (options.excludeIntent && step.intentId === options.excludeIntent) return
      const haystack = `${step.action} ${step.detail}`.toLowerCase()
      const score = needles.reduce((total, needle) => total + (haystack.includes(needle) ? 1 : 0), 0)
      if (!score) return
      const entry = byIntent.get(step.intentId) || { ids: [], score: 0, excerpts: [] }
      entry.ids.push(index)
      entry.score += score
      if (entry.excerpts.length < 3) entry.excerpts.push(`${step.action}: ${step.detail}`.slice(0, 160))
      byIntent.set(step.intentId, entry)
    })

    return [...byIntent.entries()]
      .map(([intentId, entry]) => ({
        intentId,
        stepIds: entry.ids,
        score: entry.score,
        excerpt: entry.excerpts.join(' | '),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, options.limit ?? 5)
  }

  /** Which intents have a trace at all, and how much work each one did. */
  list(): Array<{ intentId: string; steps: number; workers: string[]; lastAt: string }> {
    const byIntent = new Map<string, { steps: number; workers: Set<string>; lastAt: string }>()
    for (const step of this.steps) {
      const entry = byIntent.get(step.intentId) || { steps: 0, workers: new Set<string>(), lastAt: step.at }
      entry.steps += 1
      entry.workers.add(step.worker)
      entry.lastAt = step.at
      byIntent.set(step.intentId, entry)
    }
    return [...byIntent.entries()].map(([intentId, entry]) => ({
      intentId,
      steps: entry.steps,
      workers: [...entry.workers],
      lastAt: entry.lastAt,
    }))
  }

  /** The full text of specific steps, for when the excerpt is not enough. */
  get(intentId: string, stepIds?: number[]): TraceStep[] {
    if (!stepIds?.length) return this.steps.filter((step) => step.intentId === intentId)
    return stepIds.map((index) => this.steps[index]).filter(Boolean)
  }

  get size(): number {
    return this.steps.length
  }
}
