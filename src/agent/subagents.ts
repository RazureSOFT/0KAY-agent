import { randomUUID } from 'node:crypto'

// Sub-agents: children the model can start, watch and kill.
//
// A sub-agent is not a second process. It is the same loop entered at depth+1
// with a fresh message history, so it costs one model call per step and nothing
// else. What makes it useful is that the parent does not see the child's
// intermediate steps — only the answer — so a wide search costs the parent one
// message instead of forty.
//
// Two rules keep this from turning into a fork bomb: a hard concurrency limit
// (queued, not rejected), and a depth limit enforced by the caller (a child at
// the deepest level simply has no sub-agent tool).

export type SubAgentStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'

export interface SubAgentSpec {
  prompt: string
  agentType?: string
  label?: string
  /** Tool names the child may use. Undefined means "same as the parent". */
  tools?: string[]
}

export interface SubAgentRecord {
  id: string
  label: string
  prompt: string
  agentType: string
  status: SubAgentStatus
  startedAt: string
  finishedAt?: string
  result?: string
  error?: string
}

export interface SubAgentRunner {
  spawn(spec: SubAgentSpec): Promise<SubAgentRecord>
  list(): SubAgentRecord[]
  cancel(id: string): boolean
}

const DEFAULT_CONCURRENCY = 4
const MAX_TRACKED = 64

export class SubAgentRegistry implements SubAgentRunner {
  private readonly records = new Map<string, SubAgentRecord>()
  private readonly aborts = new Map<string, AbortController>()
  private active = 0
  private readonly waiting: Array<() => void> = []

  constructor(private readonly concurrency = DEFAULT_CONCURRENCY) {}

  list(): SubAgentRecord[] {
    return [...this.records.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  }

  get(id: string): SubAgentRecord | undefined {
    return this.records.get(id)
  }

  stats(): { running: number; queued: number; total: number } {
    const all = this.list()
    return {
      running: all.filter((record) => record.status === 'running').length,
      queued: all.filter((record) => record.status === 'queued').length,
      total: all.length,
    }
  }

  /**
   * Run one child. `run` receives an AbortSignal that fires on cancel, and its
   * return value becomes the record's result.
   */
  async spawn(spec: SubAgentSpec, run?: (signal: AbortSignal) => Promise<string>): Promise<SubAgentRecord> {
    const prompt = String(spec.prompt || '').trim()
    if (!prompt) throw new Error('sub-agent prompt is required')
    if (!run) throw new Error('sub-agent execution is unavailable')

    const record: SubAgentRecord = {
      id: `sub_${randomUUID()}`,
      label: (spec.label || prompt).slice(0, 80),
      prompt,
      agentType: spec.agentType || 'general',
      status: 'queued',
      startedAt: new Date().toISOString(),
    }
    this.remember(record)

    await this.acquire()
    record.status = 'running'
    const controller = new AbortController()
    this.aborts.set(record.id, controller)
    try {
      const result = await run(controller.signal)
      if (controller.signal.aborted) {
        record.status = 'cancelled'
      } else {
        record.status = 'done'
        record.result = result
      }
    } catch (error: any) {
      // A cancel that lands mid-step surfaces as an abort error; that is a
      // cancellation, not a failure, and the parent should be able to tell.
      record.status = controller.signal.aborted ? 'cancelled' : 'failed'
      if (!controller.signal.aborted) record.error = error?.message || String(error)
    } finally {
      record.finishedAt = new Date().toISOString()
      this.aborts.delete(record.id)
      this.release()
    }
    return record
  }

  cancel(id: string): boolean {
    const controller = this.aborts.get(id)
    if (!controller) return false
    controller.abort()
    const record = this.records.get(id)
    if (record && record.status === 'running') record.status = 'cancelled'
    return true
  }

  cancelAll(): number {
    let count = 0
    for (const id of [...this.aborts.keys()]) if (this.cancel(id)) count++
    return count
  }

  private remember(record: SubAgentRecord): void {
    this.records.set(record.id, record)
    // Keep the map from growing for the life of the process: drop the oldest
    // finished entries, never a running one.
    if (this.records.size <= MAX_TRACKED) return
    for (const [id, entry] of this.records) {
      if (this.records.size <= MAX_TRACKED) break
      if (entry.status === 'done' || entry.status === 'failed' || entry.status === 'cancelled') this.records.delete(id)
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.concurrency) {
      this.active++
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      this.waiting.push(() => {
        this.active++
        resolve()
      })
    })
  }

  private release(): void {
    this.active--
    const next = this.waiting.shift()
    if (next) next()
  }
}

/** Run several children at once and keep every outcome, including the failures. */
export async function runTeam(
  registry: SubAgentRegistry,
  specs: SubAgentSpec[],
  run: (spec: SubAgentSpec, signal: AbortSignal) => Promise<string>,
): Promise<SubAgentRecord[]> {
  const settled = await Promise.allSettled(
    specs.map((spec) => registry.spawn(spec, (signal) => run(spec, signal))),
  )
  return settled.map((entry, index) => {
    if (entry.status === 'fulfilled') return entry.value
    const spec = specs[index]
    return {
      id: `sub_failed_${index}`,
      label: spec.label || spec.prompt.slice(0, 80),
      prompt: spec.prompt,
      agentType: spec.agentType || 'general',
      status: 'failed' as SubAgentStatus,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      error: entry.reason?.message || String(entry.reason),
    }
  })
}
