// The dual-graph model from ARTEX, rebuilt small.
//
// Two graphs, on purpose:
//
//   asset graph      what the target IS        (shared, deduplicated, ground truth)
//   exploration graph what we have TRIED       (per task, with provenance)
//
// Keeping them apart is the whole idea. "We found 40 hosts" and "we have tested 3
// of them" are different questions, and a single graph answers neither cleanly.
// Anchors link the two, so a fact can be traced back to the asset it is about and
// an asset can show every direction already tried against it.
//
// The other rule worth stealing: agents submit raw strings ("https://a.b/c",
// "10.0.0.5:443"), and the *program* decides what kind of thing that is and who
// its parent is. Models are unreliable at bookkeeping and fine at observation.

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

export type ExplorationKind = 'goal' | 'intent' | 'fact' | 'finding'

export interface ExplorationNode {
  id: string
  kind: ExplorationKind
  text: string
  status: 'open' | 'done' | 'failed'
  /** Anchors: the assets this node is about. */
  assetIds: string[]
  /** Provenance: the nodes this one came from. */
  derivedFrom: string[]
  createdAt: string
}

export interface Coverage {
  total: number
  tested: number
  untested: Asset[]
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

export class ReconGraph {
  private assets = new Map<string, Asset>()
  private byKey = new Map<string, string>()
  private nodes = new Map<string, ExplorationNode>()
  private seq = 0

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
    return asset
  }

  /** Add exploration work: a goal, a candidate direction, a fact or a finding. */
  addNode(input: {
    kind: ExplorationKind
    text: string
    assets?: string[]
    derivedFrom?: string[]
    status?: ExplorationNode['status']
  }): ExplorationNode {
    const assetIds = (input.assets || []).map((raw) => this.addAsset(raw).id)
    const node: ExplorationNode = {
      id: this.nextId(input.kind === 'intent' ? 'i' : input.kind === 'finding' ? 'f' : 'n'),
      kind: input.kind,
      text: input.text.trim(),
      status: input.status || 'open',
      assetIds,
      derivedFrom: input.derivedFrom || [],
      createdAt: now(),
    }
    this.nodes.set(node.id, node)
    return node
  }

  /** Close an intent with an outcome. */
  complete(id: string, status: 'done' | 'failed' = 'done'): ExplorationNode {
    const node = this.nodes.get(id)
    if (!node) throw new Error(`unknown node: ${id}`)
    node.status = status
    return node
  }

  asset(id: string): Asset | undefined {
    return this.assets.get(id)
  }

  /**
   * What has actually been touched. An asset counts as tested once any fact or
   * finding anchors to it — an intent that was opened and abandoned does not.
   */
  coverage(): Coverage {
    const tested = new Set<string>()
    for (const node of this.nodes.values()) {
      if (node.kind !== 'fact' && node.kind !== 'finding') continue
      for (const assetId of node.assetIds) tested.add(assetId)
    }
    const all = [...this.assets.values()]
    return {
      total: all.length,
      tested: all.filter((asset) => tested.has(asset.id)).length,
      untested: all.filter((asset) => !tested.has(asset.id)),
    }
  }

  /** Everything ever tried against one asset, newest last. */
  history(assetId: string): ExplorationNode[] {
    return [...this.nodes.values()].filter((node) => node.assetIds.includes(assetId))
  }

  openIntents(): ExplorationNode[] {
    return [...this.nodes.values()].filter((node) => node.kind === 'intent' && node.status === 'open')
  }

  /**
   * The planner's situation report, in one call: how far along we are, what is
   * open, and what we learned most recently. ARTEX calls this the graph_overview
   * prefetch — the point is that reading the situation costs one tool call, not
   * five queries.
   */
  overview(limit = 10) {
    const coverage = this.coverage()
    const byKind: Record<string, number> = {}
    for (const asset of this.assets.values()) byKind[asset.kind] = (byKind[asset.kind] || 0) + 1
    const nodes = [...this.nodes.values()]
    const recent = nodes.filter((node) => node.kind === 'fact' || node.kind === 'finding').slice(-limit)
    return {
      coverage: { total: coverage.total, tested: coverage.tested, untested: coverage.untested.length },
      assetsByKind: byKind,
      goals: nodes.filter((node) => node.kind === 'goal').map((node) => ({ id: node.id, text: node.text, status: node.status })),
      openIntents: this.openIntents().slice(0, limit).map((node) => ({ id: node.id, text: node.text, assets: node.assetIds })),
      findings: nodes.filter((node) => node.kind === 'finding').length,
      recent: recent.map((node) => ({ id: node.id, kind: node.kind, text: node.text })),
    }
  }

  /**
   * A goal is proven by evidence, not by assertion. Without a finding anchored to
   * the same assets the call fails — that is the whole difference between a scan
   * that finished and a scan that got tired.
   */
  prove(goalId: string): ExplorationNode {
    const goal = this.nodes.get(goalId)
    if (!goal) throw new Error(`unknown node: ${goalId}`)
    if (goal.kind !== 'goal') throw new Error(`${goalId} is not a goal (kind: ${goal.kind})`)
    const targets = new Set(goal.assetIds)
    const evidence = [...this.nodes.values()].some(
      (node) => node.kind === 'finding' && node.assetIds.some((assetId) => targets.has(assetId)),
    )
    if (!evidence) throw new Error('no finding is anchored to this goal: record one before proving it')
    goal.status = 'done'
    return goal
  }

  toJSON() {
    return {
      assets: [...this.assets.values()],
      nodes: [...this.nodes.values()],
      coverage: this.coverage(),
    }
  }
}
