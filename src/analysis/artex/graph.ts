// The dual-graph model, second pass: this version follows the original's
// behaviour much more closely.
//
// Two graphs, on purpose:
//
//   asset graph       what the target IS   (shared, deduplicated, ground truth)
//   exploration graph what we have TRIED   (per session, with provenance)
//
// Keeping them apart is the whole idea. "We found 40 hosts" and "we have tested 3
// of them" are different questions, and a single graph answers neither cleanly.
// Anchors link the two, so a fact can be traced back to the asset it is about and
// an asset can show every direction already tried against it.
//
// What the second pass adds, matching the original's state machine:
//
//   - intents live a seven-state life (open/running/paused/done/blocked/
//     exhausted/stopped), so an interruption is a state, not a loss;
//   - goals close as `met` only through `prove()`, which now also honours a
//     coverage gate — you cannot declare victory on an untested target;
//   - edges are first-class (spawns / derived_from / yields / proves / covers),
//     which is what makes a layered drawing and cold-region compaction possible;
//   - parentless intents hang off a synthetic `origin` fact, so provenance
//     chains always reach a root;
//   - hint nodes carry steering that outlives one planner wake-up, and digest
//     nodes fold cold regions of the graph without deleting them;
//   - a scope list turns coverage into a fraction of something: tested assets
//     over in-scope assets, not over everything we happened to notice.
//
// The other rule, unchanged: agents submit raw strings ("https://a.b/c",
// "10.0.0.5:443"), and the *program* decides what kind of thing that is and who
// its parent is. Models are unreliable at bookkeeping and fine at observation.

import { writeFileAtomic } from '../../tools/atomic_write.js'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash } from 'node:crypto'

export type AssetKind = 'root_domain' | 'subdomain' | 'ip' | 'service' | 'app' | 'endpoint'

export interface Asset {
  id: string
  kind: AssetKind
  /** Normalised identity used for deduplication. */
  key: string
  /** What the caller submitted, kept for display. */
  raw: string
  parentId?: string
  createdAt: string
}

export type ExplorationKind = 'goal' | 'intent' | 'fact' | 'finding' | 'hint' | 'digest'
export type IntentStatus = 'open' | 'running' | 'paused' | 'done' | 'blocked' | 'exhausted' | 'stopped'
export type GoalStatus = 'open' | 'met' | 'abandoned'
export type FactStatus = 'confirmed' | 'dismissed' | 'origin'
export type FindingStatus = 'confirmed' | 'dismissed'
export type HintStatus = 'active' | 'consumed'
export type DigestStatus = 'active' | 'superseded'
export type NodeStatus = IntentStatus | GoalStatus | FactStatus | FindingStatus | HintStatus | DigestStatus

/** src is the upstream/parent end of every relation, dst the downstream child. */
export type EdgeRel = 'spawns' | 'derived_from' | 'yields' | 'proves' | 'covers'

export interface GraphEdge {
  src: string
  rel: EdgeRel
  dst: string
}

export interface ExplorationNode {
  id: string
  kind: ExplorationKind
  text: string
  status: NodeStatus
  /** Anchors: the assets this node is about. */
  assetIds: string[]
  /** Provenance: the upstream nodes this one came from. */
  derivedFrom: string[]
  /** Intent queue position, 0-10, higher first. */
  priority?: number
  createdAt: string
}

export type ScopeKind = 'domain' | 'ip' | 'cidr'

export interface ScopeEntry {
  kind: ScopeKind
  value: string
}

export interface ScopeCoverage {
  /** Number of scope rows; 0 means no scope was declared. */
  rows: number
  /** Assets inside the scope; equals total when no scope was declared. */
  denominator: number
  /** tested/denominator as a percentage, null when nothing is in scope. */
  pct: number | null
}

export interface Coverage {
  /** Every asset ever submitted (kept for callers that predate scope). */
  total: number
  tested: number
  untested: Asset[]
  scope: ScopeCoverage
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

function now(): string {
  return new Date().toISOString()
}

/**
 * Work out what a raw observation is. Returns the kind, the normalised key, and
 * the key of its parent — the caller does not have to know the taxonomy.
 */
export function classify(raw: string): { kind: AssetKind; key: string; parentKey?: string; parentKind?: AssetKind } {
  const value = raw.trim()
  const url = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]+)(\/[^?#]*)?/i.exec(value)
  if (url) {
    const host = url[2].toLowerCase()
    const path = url[3] && url[3] !== '/' ? url[3] : ''
    if (!path) {
      // A bare origin is the service, not an endpoint.
      const service = classify(host.includes(':') ? host : `${host}:${url[1].toLowerCase() === 'https' ? '443' : '80'}`)
      return { kind: 'service', key: service.key, parentKey: service.parentKey, parentKind: service.parentKind }
    }
    const service = classify(host.includes(':') ? host : `${host}:${url[1].toLowerCase() === 'https' ? '443' : '80'}`)
    return { kind: 'endpoint', key: `${url[1].toLowerCase()}://${host}${path}`, parentKey: service.key, parentKind: 'service' }
  }

  if (IPV4.test(value)) {
    const parts = value.split('.').map(Number)
    if (parts.every((part) => part >= 0 && part <= 255)) return { kind: 'ip', key: value }
  }

  const hostPort = /^([^:\s]+):(\d{1,5})$/.exec(value)
  if (hostPort) {
    const host = hostPort[1].toLowerCase()
    const port = Number(hostPort[2])
    if (port < 1 || port > 65535) throw new Error(`port out of range: ${value}`)
    const parent = IPV4.test(host)
      ? { key: host, kind: 'ip' as AssetKind }
      : (() => { const host_ = classify(host); return { key: host_.key, kind: host_.kind } })()
    return { kind: 'service', key: `${host}:${port}`, parentKey: parent.key, parentKind: parent.kind }
  }

  const hostname = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.exec(value)
  if (hostname) {
    const host = value.toLowerCase().replace(/\.$/, '')
    const labels = host.split('.')
    if (labels.length <= 2) return { kind: 'root_domain', key: host }
    // Everything below the registrable domain is a subdomain; the parent is the
    // domain with one label removed, which is what makes a tree out of DNS.
    return { kind: 'subdomain', key: host, parentKey: labels.slice(1).join('.') }
  }

  throw new Error(`cannot classify asset: ${value}`)
}

/** The host an asset is reachable at — the part a domain scope can match. */
function assetHost(asset: Asset): string | undefined {
  if (asset.kind === 'root_domain' || asset.kind === 'subdomain') return asset.key
  if (asset.kind === 'ip') return asset.key
  if (asset.kind === 'service') return asset.key.replace(/:\d+$/, '')
  if (asset.kind === 'endpoint') return classify(asset.key).key.match(/^https?:\/\/([^/]+)/)?.[1]
  return undefined
}

function ipv4InCidr(ip: string, cidr: string): boolean {
  const [base, bitsRaw] = cidr.split('/')
  const bits = Number(bitsRaw)
  if (!IPV4.test(base) || !IPV4.test(ip) || !(bits >= 0 && bits <= 32)) return false
  const toInt = (value: string) => value.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  return ((toInt(ip) ^ toInt(base)) & mask) === 0
}

/** Intents and facts can fold into a digest; goals, findings, hints and digests cannot. */
export function foldableKind(kind: ExplorationKind, status: NodeStatus): boolean {
  if (kind === 'intent') return ['done', 'blocked', 'exhausted', 'stopped'].includes(status)
  if (kind === 'fact') return status === 'confirmed' || status === 'dismissed'
  return false
}

const STATUS_BY_KIND: Record<ExplorationKind, NodeStatus[]> = {
  goal: ['open', 'met', 'abandoned'],
  intent: ['open', 'running', 'paused', 'done', 'blocked', 'exhausted', 'stopped'],
  fact: ['confirmed', 'dismissed', 'origin'],
  finding: ['confirmed', 'dismissed'],
  hint: ['active', 'consumed'],
  digest: ['active', 'superseded'],
}

const OPEN_STATES: ReadonlySet<string> = new Set(['open', 'running', 'paused'])

export interface SerializedGraph {
  version?: number
  assets: Asset[]
  nodes: ExplorationNode[]
  edges?: GraphEdge[]
  scope?: ScopeEntry[]
}

export class ReconGraph {
  private assets = new Map<string, Asset>()
  private byKey = new Map<string, string>()
  private nodes = new Map<string, ExplorationNode>()
  private edges = new Map<string, GraphEdge>()
  private scopeRows: ScopeEntry[] = []
  private seq = 0
  private listeners: Array<() => void> = []

  constructor() {}

  /**
   * Persistence hook: fired after every mutation so a store can write the graph
   * through. Returns an unsubscribe function.
   */
  onChange(listener: () => void): () => void {
    this.listeners.push(listener)
    return () => {
      this.listeners = this.listeners.filter((entry) => entry !== listener)
    }
  }

  private changed(): void {
    for (const listener of this.listeners) {
      try { listener() } catch { /* a broken listener must not break the graph */ }
    }
  }

  private nextId(prefix: string): string {
    this.seq += 1
    return `${prefix}_${this.seq.toString(36)}`
  }

  /** Add an asset, deduplicated by kind+key, with its parents inferred. */
  addAsset(raw: string): Asset {
    const classified = classify(raw)
    const existing = this.byKey.get(`${classified.kind}:${classified.key}`)
    if (existing) return this.assets.get(existing)!

    let parentId: string | undefined
    if (classified.parentKey) {
      parentId = this.byKey.get(`${classified.parentKind}:${classified.parentKey}`)
      // The parent may not have been seen yet; add it so the tree is never broken.
      if (!parentId) parentId = this.addAsset(classified.parentKey).id
    }

    const asset: Asset = {
      id: this.nextId('a'),
      kind: classified.kind,
      key: classified.key,
      raw: raw.trim(),
      parentId,
      createdAt: now(),
    }
    this.assets.set(asset.id, asset)
    this.byKey.set(`${asset.kind}:${asset.key}`, asset.id)
    this.changed()
    return asset
  }

  /**
   * Declare what is in scope. Coverage becomes a fraction of this list instead
   * of a fraction of everything the scan happened to notice. URLs and host:port
   * reduce to their host; CIDR ranges pass through as-is.
   */
  setScope(patterns: string[]): ScopeEntry[] {
    this.scopeRows = this.buildScope(patterns)
    this.changed()
    return [...this.scopeRows]
  }

  /** ARTEX add_task_scope: merge scope rows without dropping existing ones. */
  addScope(patterns: string[]): ScopeEntry[] {
    const added = this.buildScope(patterns)
    const known = new Set(this.scopeRows.map((row) => `${row.kind}:${row.value}`))
    for (const row of added) {
      const key = `${row.kind}:${row.value}`
      if (!known.has(key)) {
        this.scopeRows.push(row)
        known.add(key)
      }
    }
    this.changed()
    return [...this.scopeRows]
  }

  private buildScope(patterns: string[]): ScopeEntry[] {
    const entries: ScopeEntry[] = []
    for (const pattern of patterns) {
      const value = String(pattern || '').trim()
      if (!value) continue
      const slash = value.includes('/') ? value.split('/') : null
      if (slash && IPV4.test(slash[0]) && /^\d{1,2}$/.test(slash[1] || '')) {
        entries.push({ kind: 'cidr', value })
        continue
      }
      let host = value
      try {
        const classified = classify(value)
        host = assetHost({ ...classified, id: '', raw: value, createdAt: '' } as Asset) || classified.key
      } catch {
        host = value.toLowerCase().replace(/^https?:\/\//, '').split('/')[0].replace(/:\d+$/, '')
      }
      if (!host) continue
      entries.push({ kind: IPV4.test(host) ? 'ip' : 'domain', value: host })
    }
    return entries
  }

  scope(): ScopeEntry[] {
    return [...this.scopeRows]
  }

  /** The relation an upstream→downstream pair gets, from the kinds involved. */
  private relFor(upstream: ExplorationKind, downstream: ExplorationKind): EdgeRel {
    if (upstream === 'digest') return 'covers'
    if (downstream === 'goal') return 'proves'
    if (upstream === 'intent' && downstream === 'intent') return 'spawns'
    if (upstream === 'intent') return 'yields'
    return 'derived_from'
  }

  private link(src: string, rel: EdgeRel, dst: string): void {
    if (src === dst) return
    this.edges.set(`${src}|${rel}|${dst}`, { src, rel, dst })
  }

  /** Add exploration work: a goal, a candidate direction, a fact, finding or hint. */
  addNode(input: {
    kind: ExplorationKind
    text: string
    assets?: string[]
    derivedFrom?: string[]
    status?: NodeStatus
    priority?: number
  }): ExplorationNode {
    const kind = input.kind
    if (!STATUS_BY_KIND[kind]) throw new Error(`unknown node kind: ${kind}`)
    let status = input.status || (kind === 'fact' ? 'confirmed' : kind === 'finding' ? 'confirmed' : kind === 'hint' ? 'active' : kind === 'digest' ? 'active' : 'open')
    if (kind === 'fact' && status === 'open') status = 'confirmed'
    if (kind === 'finding' && status === 'open') status = 'confirmed'
    if (!STATUS_BY_KIND[kind].includes(status)) throw new Error(`invalid status ${status} for kind ${kind}`)

    const assetIds = (input.assets || []).map((raw) => this.addAsset(raw).id)
    let derivedFrom = [...(input.derivedFrom || [])]
    // A direction nobody discovered is rooted at the synthetic origin fact, so
    // every provenance chain reaches a root and the drawing never dangles.
    if (kind === 'intent' && !derivedFrom.length) derivedFrom = [this.originNode().id]

    const node: ExplorationNode = {
      id: this.nextId(kind === 'intent' ? 'i' : kind === 'finding' ? 'f' : 'n'),
      kind,
      text: input.text.trim(),
      status,
      assetIds,
      derivedFrom,
      createdAt: now(),
    }
    if (kind === 'intent' && input.priority != null) {
      node.priority = Math.max(0, Math.min(10, Math.round(Number(input.priority) || 0)))
    }
    this.nodes.set(node.id, node)
    for (const upstream of derivedFrom) {
      if (!this.nodes.has(upstream)) continue
      this.link(upstream, this.relFor(this.nodes.get(upstream)!.kind, kind), node.id)
    }
    this.changed()
    return node
  }

  /** The synthetic root every parentless intent hangs from. */
  private originNode(): ExplorationNode {
    for (const node of this.nodes.values()) {
      if (node.kind === 'fact' && node.status === 'origin') return node
    }
    const origin: ExplorationNode = {
      id: this.nextId('n'),
      kind: 'fact',
      text: 'origin',
      status: 'origin',
      assetIds: [],
      derivedFrom: [],
      createdAt: now(),
    }
    this.nodes.set(origin.id, origin)
    return origin
  }

  /** Move a node to any legal state for its kind. Supersedes digests covering it. */
  setStatus(id: string, status: NodeStatus): ExplorationNode {
    const node = this.nodes.get(id)
    if (!node) throw new Error(`unknown node: ${id}`)
    if (!STATUS_BY_KIND[node.kind].includes(status)) {
      throw new Error(`invalid status ${status} for kind ${node.kind}`)
    }
    if (node.status === status) return node
    node.status = status
    if (node.kind === 'intent' || node.kind === 'fact') this.supersedeDigestsCovering(id)
    this.changed()
    return node
  }

  /**
   * Close a node. Accepted as the legacy two-word vocabulary as well as the
   * per-kind states: 'failed' means the direction hit a wall ('blocked'), a
   * finished goal is 'met', a finished observation is 'confirmed'.
   */
  complete(id: string, outcome: string = 'done'): ExplorationNode {
    const node = this.nodes.get(id)
    if (!node) throw new Error(`unknown node: ${id}`)
    const alias: Record<string, NodeStatus> = {
      done: node.kind === 'goal' ? 'met' : node.kind === 'fact' || node.kind === 'finding' ? 'confirmed' : 'done',
      failed: node.kind === 'fact' || node.kind === 'finding' ? 'dismissed' : 'blocked',
    }
    const status = alias[outcome] ?? (outcome as NodeStatus)
    return this.setStatus(id, status)
  }

  node(id: string): ExplorationNode | undefined {
    return this.nodes.get(id)
  }

  asset(id: string): Asset | undefined {
    return this.assets.get(id)
  }

  edgesOut(): GraphEdge[] {
    return [...this.edges.values()]
  }

  /** Open intents in queue order: priority first, then oldest. */
  frontier(): ExplorationNode[] {
    return [...this.nodes.values()]
      .filter((node) => node.kind === 'intent' && node.status === 'open')
      .sort((a, b) => (b.priority ?? 5) - (a.priority ?? 5) || a.createdAt.localeCompare(b.createdAt))
  }

  openIntents(): ExplorationNode[] {
    return this.frontier()
  }

  addHint(text: string, assets?: string[]): ExplorationNode {
    return this.addNode({ kind: 'hint', text, assets })
  }

  consumeHint(id: string): ExplorationNode {
    return this.setStatus(id, 'consumed')
  }

  hints(status: HintStatus = 'active'): ExplorationNode[] {
    return [...this.nodes.values()].filter((node) => node.kind === 'hint' && node.status === status)
  }

  /**
   * Fold a cold region into one digest node. Members stay in the graph; the
   * covers edges are what lets a drawing collapse them. When any member later
   * changes state the digest is superseded automatically.
   */
  digest(text: string, memberIds: string[]): ExplorationNode {
    const members = memberIds.filter((id) => {
      const node = this.nodes.get(id)
      return node && foldableKind(node.kind, node.status)
    })
    if (members.length < 2) throw new Error('a digest needs at least two foldable members')
    const node = this.addNode({ kind: 'digest', text })
    for (const member of members) this.link(node.id, 'covers', member)
    this.changed()
    return node
  }

  digests(status: DigestStatus = 'active'): Array<ExplorationNode & { memberIds: string[] }> {
    return [...this.nodes.values()]
      .filter((node) => node.kind === 'digest' && node.status === status)
      .map((node) => ({
        ...node,
        memberIds: [...this.edges.values()].filter((edge) => edge.src === node.id && edge.rel === 'covers').map((edge) => edge.dst),
      }))
  }

  private supersedeDigestsCovering(nodeId: string): void {
    for (const edge of this.edges.values()) {
      if (edge.rel !== 'covers' || edge.dst !== nodeId) continue
      const digest = this.nodes.get(edge.src)
      if (digest && digest.kind === 'digest' && digest.status === 'active') digest.status = 'superseded'
    }
  }

  /** Everything ever tried against one asset, newest last. */
  history(assetId: string): ExplorationNode[] {
    return [...this.nodes.values()].filter((node) => node.assetIds.includes(assetId))
  }

  private testedAssets(): Set<string> {
    const tested = new Set<string>()
    for (const node of this.nodes.values()) {
      if (node.kind !== 'fact' && node.kind !== 'finding') continue
      for (const assetId of node.assetIds) tested.add(assetId)
    }
    return tested
  }

  /** Whether an asset falls inside the declared scope; no scope means everything does. */
  inScope(asset: Asset): boolean {
    if (!this.scopeRows.length) return true
    const host = assetHost(asset)
    return this.scopeRows.some((row) => {
      if (row.kind === 'ip') return host === row.value
      if (row.kind === 'cidr') return host ? ipv4InCidr(host, row.value) : false
      if (!host) return false
      return host === row.value || host.endsWith(`.${row.value}`)
    })
  }

  /**
   * What has actually been touched, as a fraction of what is in scope. An asset
   * counts as tested once any fact or finding anchors to it — an intent that was
   * opened and abandoned does not. With no scope declared the denominator is
   * every asset, which keeps the number honest only in the trivial case.
   */
  coverage(): Coverage {
    const tested = this.testedAssets()
    const all = [...this.assets.values()]
    const inScope = all.filter((asset) => this.inScope(asset))
    const denominator = inScope.length
    const testedInScope = inScope.filter((asset) => tested.has(asset.id)).length
    return {
      total: all.length,
      tested: testedInScope,
      untested: inScope.filter((asset) => !tested.has(asset.id)),
      scope: {
        rows: this.scopeRows.length,
        denominator,
        pct: denominator ? Math.round((testedInScope / denominator) * 1000) / 10 : null,
      },
    }
  }

  /**
   * The planner's situation report, in one call: how far along we are, what is
   * open, and what we learned most recently. Reading the situation costs one
   * tool call, not five queries.
   */
  overview(limit = 10) {
    const coverage = this.coverage()
    const byKind: Record<string, number> = {}
    for (const asset of this.assets.values()) byKind[asset.kind] = (byKind[asset.kind] || 0) + 1
    const nodes = [...this.nodes.values()]
    const recent = nodes.filter((node) => (node.kind === 'fact' || node.kind === 'finding') && node.status !== 'origin').slice(-limit)
    const intents = nodes.filter((node) => node.kind === 'intent')
    return {
      coverage: {
        total: coverage.total,
        tested: coverage.tested,
        untested: coverage.untested.length,
        scope: coverage.scope,
      },
      assetsByKind: byKind,
      goals: nodes.filter((node) => node.kind === 'goal').map((node) => ({ id: node.id, text: node.text, status: node.status })),
      runningIntents: intents.filter((node) => node.status === 'running').length,
      openIntents: this.frontier().slice(0, limit).map((node) => ({ id: node.id, text: node.text, assets: node.assetIds, priority: node.priority })),
      blockedIntents: intents.filter((node) => node.status === 'blocked' || node.status === 'exhausted').length,
      findings: nodes.filter((node) => node.kind === 'finding').length,
      hints: this.hints().map((node) => ({ id: node.id, text: node.text })),
      digests: this.digests().length,
      recent: recent.map((node) => ({ id: node.id, kind: node.kind, text: node.text })),
    }
  }

  /**
   * A goal is proven by evidence, not by assertion, and not while the coverage
   * gate says the target is barely tested. Without a finding anchored to the
   * same assets the call fails — that is the whole difference between a scan
   * that finished and a scan that got tired.
   */
  prove(goalId: string, evidenceId?: string, minCoveragePct?: number): ExplorationNode {
    const goal = this.nodes.get(goalId)
    if (!goal) throw new Error(`unknown node: ${goalId}`)
    if (goal.kind !== 'goal') throw new Error(`${goalId} is not a goal (kind: ${goal.kind})`)
    if (goal.status === 'met') return goal

    if (minCoveragePct != null && minCoveragePct > 0) {
      const { scope } = this.coverage()
      if (scope.pct == null) throw new Error(`coverage gate: declare a scope before requiring ${minCoveragePct}% coverage`)
      if (scope.pct < minCoveragePct) {
        throw new Error(`coverage gate: ${scope.pct}% of the scope is tested, ${minCoveragePct}% is required before a goal can be proven`)
      }
    }

    let evidence: ExplorationNode | undefined
    if (evidenceId) {
      evidence = this.nodes.get(evidenceId)
      if (!evidence || evidence.kind !== 'finding') throw new Error(`evidence must be a finding node: ${evidenceId}`)
    } else {
      const targets = new Set(goal.assetIds)
      evidence = [...this.nodes.values()].find(
        (node) => node.kind === 'finding' && node.assetIds.some((assetId) => targets.has(assetId)),
      )
    }
    if (!evidence) throw new Error('no finding is anchored to this goal: record one before proving it')

    evidence.status = 'confirmed'
    goal.status = 'met'
    this.link(evidence.id, 'proves', goal.id)
    this.changed()
    return goal
  }

  toJSON(): SerializedGraph & { coverage: Coverage } {
    return {
      version: 2,
      assets: [...this.assets.values()],
      nodes: [...this.nodes.values()],
      edges: [...this.edges.values()],
      scope: [...this.scopeRows],
      coverage: this.coverage(),
    }
  }

  /**
   * Rebuild a graph from its serialized form — used by the persistence layer so
   * a restarted process continues the session's graph instead of losing it.
   * Old (v1) exports carry neither edges nor scope; both are reconstructed, and
   * statuses are translated to the current vocabulary rather than rejected.
   */
  static fromJSON(data: SerializedGraph): ReconGraph {
    const graph = new ReconGraph()
    if (!data || !Array.isArray(data.assets) || !Array.isArray(data.nodes)) {
      throw new Error('not a serialized recon graph')
    }
    const statusFix: Record<string, NodeStatus> = {
      open: 'open', running: 'running', paused: 'paused', done: 'done', blocked: 'blocked',
      exhausted: 'exhausted', stopped: 'stopped', failed: 'blocked', met: 'met', abandoned: 'abandoned',
      confirmed: 'confirmed', dismissed: 'dismissed', origin: 'origin', active: 'active', consumed: 'consumed', superseded: 'superseded',
    }
    let maxSeq = 0
    for (const asset of data.assets) {
      if (!asset?.id || !asset.kind || !asset.key) continue
      graph.assets.set(asset.id, { ...asset, createdAt: asset.createdAt || now() })
      graph.byKey.set(`${asset.kind}:${asset.key}`, asset.id)
    }
    for (const node of data.nodes) {
      if (!node?.id || !node.kind || !STATUS_BY_KIND[node.kind as ExplorationKind]) continue
      let status: string = statusFix[node.status] || STATUS_BY_KIND[node.kind as ExplorationKind][0]
      if (node.kind === 'goal' && status === 'done') status = 'met'
      if (node.kind === 'intent' && status === 'failed') status = 'blocked'
      if ((node.kind === 'fact' || node.kind === 'finding') && (status === 'done' || status === 'open')) status = 'confirmed'
      graph.nodes.set(node.id, {
        ...node,
        status: status as NodeStatus,
        assetIds: Array.isArray(node.assetIds) ? node.assetIds.filter((id) => graph.assets.has(id)) : [],
        derivedFrom: Array.isArray(node.derivedFrom) ? node.derivedFrom : [],
        createdAt: node.createdAt || now(),
      })
      const seq = Number.parseInt(node.id.split('_')[1] || '0', 36)
      if (Number.isFinite(seq) && seq > maxSeq) maxSeq = seq
    }
    graph.seq = maxSeq
    if (Array.isArray(data.edges) && data.edges.length) {
      for (const edge of data.edges) {
        if (edge?.src && edge?.dst && graph.nodes.has(edge.src) && graph.nodes.has(edge.dst)) {
          graph.edges.set(`${edge.src}|${edge.rel}|${edge.dst}`, { src: edge.src, rel: edge.rel, dst: edge.dst })
        }
      }
    } else {
      for (const node of graph.nodes.values()) {
        for (const upstream of node.derivedFrom) {
          const parent = graph.nodes.get(upstream)
          if (parent) graph.link(upstream, graph.relFor(parent.kind, node.kind), node.id)
        }
      }
    }
    if (Array.isArray(data.scope)) graph.scopeRows = data.scope.filter((row) => row?.kind && row?.value)
    return graph
  }
}

export type StoredGraph = SerializedGraph

/**
 * File-backed persistence: one JSON document per session key, written atomically
 * after each mutation. A corrupted or half-written document is treated as absent
 * — the graph rebuilds from scratch rather than crashing the session.
 */
export class FileGraphStore {
  constructor(private readonly dir: string) {
    try {
      fs.mkdirSync(dir, { recursive: true })
    } catch {
      // A directory that cannot be created disables persistence; the caller
      // detects this from load() returning null and the graph stays in memory.
    }
  }

  private fileFor(key: string): string {
    const safe = key.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80)
    const hash = createHash('sha256').update(key).digest('hex').slice(0, 8)
    return path.join(this.dir, `${safe}-${hash}.json`)
  }

  async load(key: string): Promise<SerializedGraph | null> {
    try {
      const raw = await fs.promises.readFile(this.fileFor(key), 'utf8')
      const data = JSON.parse(raw)
      if (!data || !Array.isArray(data.assets) || !Array.isArray(data.nodes)) return null
      return data as SerializedGraph
    } catch {
      return null
    }
  }

  async save(key: string, data: StoredGraph): Promise<void> {
    await writeFileAtomic(this.fileFor(key), JSON.stringify(data))
  }
}
