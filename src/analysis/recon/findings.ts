// Findings as persistent rows, and retests against them.
//
// A finding used to be a graph node that the run left behind: no id anyone could
// hold, no history, no state machine. That is enough to draw a report and not
// enough to answer the question a person actually asks a week later — "is this
// still there?" A retest needs something stable to point at, so findings get an
// id that outlives the run, and each retest is a record of one attempt to
// reproduce it.

import { randomUUID } from 'node:crypto'

export type RetestStatus = 'pending' | 'running' | 'completed' | 'failed' | 'stopped'

/** What the retest concluded. `inconclusive` is a real answer, not a failure. */
export type RetestVerdict = 'reproduced' | 'fixed' | 'inconclusive'

export interface FindingRecord {
  id: string
  /** The assessment that produced it; the finding outlives that task. */
  taskId: string
  sessionId: string
  /** Graph node this came from, when it came from one. */
  nodeId?: string
  text: string
  /** Vulnerability class, when the worker named one. */
  vulnclass?: string
  /** Assets this holds against, so a retest knows what to point at. */
  assets: string[]
  createdAt: string
}

export interface RetestRecord {
  id: string
  findingId: string
  status: RetestStatus
  /** Absent until the retest reaches a conclusion. */
  verdict?: RetestVerdict
  /** What the retest agent did and saw, in prose. */
  summary?: string
  /** Commands / requests that show it, when the agent recorded them. */
  evidence?: string
  notes?: string
  error?: string
  createdAt: string
  startedAt?: string
  finishedAt?: string
}

/** Only one retest may run against a finding at a time. */
export function isActive(retest: RetestRecord): boolean {
  return retest.status === 'pending' || retest.status === 'running'
}

export class FindingStore {
  private findings = new Map<string, FindingRecord>()
  private retests = new Map<string, RetestRecord>()
  /** Tie-breaker for records created within the same millisecond. */
  private seq = 0
  private order = new Map<string, number>()

  add(input: Omit<FindingRecord, 'id' | 'createdAt'> & { id?: string; createdAt?: string }): FindingRecord {
    const text = String(input.text || '').trim()
    if (!text) throw new Error('finding text is required')
    const record: FindingRecord = {
      id: input.id || `fi_${Date.now().toString(36)}_${randomUUID().slice(0, 6)}`,
      taskId: String(input.taskId || ''),
      sessionId: String(input.sessionId || ''),
      ...(input.nodeId ? { nodeId: String(input.nodeId) } : {}),
      text,
      ...(input.vulnclass ? { vulnclass: String(input.vulnclass) } : {}),
      assets: Array.isArray(input.assets) ? input.assets.map(String).filter(Boolean) : [],
      createdAt: input.createdAt || new Date().toISOString(),
    }
    this.findings.set(record.id, record)
    this.order.set(record.id, ++this.seq)
    return record
  }

  get(id: string): FindingRecord | undefined {
    return this.findings.get(id)
  }

  /** Findings of one task, newest first — what the task page lists. */
  forTask(taskId: string): FindingRecord[] {
    return [...this.findings.values()]
      .filter((finding) => finding.taskId === taskId)
      .sort((a, b) => this.rank(b.id) - this.rank(a.id))
  }

  all(): FindingRecord[] {
    return [...this.findings.values()]
  }

  /**
   * Start a retest.
   *
   * Refuses when one is already active for the same finding: two agents probing
   * the same target at once produce evidence neither of them can attribute, and
   * the second one's conclusion is worthless.
   */
  startRetest(findingId: string, notes = ''): RetestRecord {
    if (!this.findings.has(findingId)) throw new Error(`unknown finding: ${findingId}`)
    const active = [...this.retests.values()].find((retest) => retest.findingId === findingId && isActive(retest))
    if (active) {
      throw new Error(`a retest is already running for this finding (${active.id}); wait for it or stop it first`)
    }
    const record: RetestRecord = {
      id: `rt_${Date.now().toString(36)}_${randomUUID().slice(0, 6)}`,
      findingId,
      status: 'pending',
      ...(notes ? { notes: String(notes) } : {}),
      createdAt: new Date().toISOString(),
    }
    this.retests.set(record.id, record)
    this.order.set(record.id, ++this.seq)
    return record
  }

  markRunning(id: string): RetestRecord {
    return this.update(id, { status: 'running', startedAt: new Date().toISOString() })
  }

  /** A retest that reached a conclusion. The verdict is required — that is the point. */
  complete(id: string, input: { verdict: RetestVerdict; summary?: string; evidence?: string }): RetestRecord {
    return this.update(id, {
      status: 'completed',
      verdict: input.verdict,
      ...(input.summary ? { summary: String(input.summary) } : {}),
      ...(input.evidence ? { evidence: String(input.evidence) } : {}),
      finishedAt: new Date().toISOString(),
    })
  }

  fail(id: string, error: string): RetestRecord {
    return this.update(id, { status: 'failed', error: String(error || 'retest failed'), finishedAt: new Date().toISOString() })
  }

  stop(id: string): RetestRecord {
    return this.update(id, { status: 'stopped', finishedAt: new Date().toISOString() })
  }

  retest(id: string): RetestRecord | undefined {
    return this.retests.get(id)
  }

  forFinding(findingId: string): RetestRecord[] {
    return [...this.retests.values()]
      .filter((retest) => retest.findingId === findingId)
      .sort((a, b) => this.rank(b.id) - this.rank(a.id))
  }

  activeRetests(): RetestRecord[] {
    return [...this.retests.values()].filter(isActive)
  }

  private update(id: string, patch: Partial<RetestRecord>): RetestRecord {
    const record = this.retests.get(id)
    if (!record) throw new Error(`unknown retest: ${id}`)
    Object.assign(record, patch)
    return record
  }

  /** Survives a restart: findings and their retests are the durable part. */
  toJSON(): { findings: FindingRecord[]; retests: RetestRecord[] } {
    return { findings: this.all(), retests: [...this.retests.values()] }
  }

  restore(snapshot: { findings?: FindingRecord[]; retests?: RetestRecord[] } | null | undefined): void {
    this.findings.clear()
    this.retests.clear()
    for (const finding of snapshot?.findings || []) {
      if (finding?.id) this.findings.set(finding.id, finding)
    }
    for (const retest of snapshot?.retests || []) {
      if (retest?.id) this.retests.set(retest.id, retest)
    }
    // Ranks are runtime bookkeeping, not part of the snapshot: rebuild them in
    // the order the snapshot lists the records, which is creation order.
    this.seq = 0
    this.order.clear()
    for (const finding of snapshot?.findings || []) this.order.set(finding.id, ++this.seq)
    for (const retest of snapshot?.retests || []) this.order.set(retest.id, ++this.seq)
  }

  private rank(id: string): number {
    return this.order.get(id) || 0
  }
}