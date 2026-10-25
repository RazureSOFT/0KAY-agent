// Cold-region detection, as pure graph algorithms with no model and no storage
// dependency — the same separation the original draws, so the judgement can be
// tested without an LLM anywhere near it.
//
// The idea: as a session runs, the graph fills with intents and facts that are
// finished and will never change again. Leaving them hot costs prompt space on
// every planner wake-up. A region is *cold* when nothing live can reach it —
// it cannot feed the current work anymore — and after it has stayed cold for R
// consecutive planner rounds it is eligible to fold into a digest node. Members
// are never deleted; the digest is a view, and any member that changes state
// supersedes the digest that covered it (the graph does that part).
//
// Two knobs, same defaults as the original:
//
//   R — debounce: rounds a node must stay structurally cold before it is
//       eligible (small enough to react, large enough not to chase churn);
//   K — minimum members before a block is worth a digest (one node is not a
//       region, it is a node).

export interface ColdNode {
  id: string
  kind: string
  status: string
}

export interface ColdEdge {
  src: string
  dst: string
  rel: string
}

export interface ColdParams {
  R: number
  K: number
}

export function defaultColdParams(): ColdParams {
  return { R: 6, K: 2 }
}

/** A live intent is one a worker could still pick up or is already working. */
function isLiveIntent(node: ColdNode): boolean {
  return node.kind === 'intent' && ['open', 'running', 'paused'].includes(node.status)
}

export interface Adjacency {
  parents: Map<string, string[]>
  children: Map<string, string[]>
}

/**
 * Upstream/downstream view over the causal edges. Covers edges are the derived
 * digest view, not causality — including them would let a summary look like a
 * reason, so they are filtered out here.
 */
export function adjacency(nodes: ColdNode[], edges: ColdEdge[]): Adjacency {
  const known = new Set(nodes.map((node) => node.id))
  const parents = new Map<string, string[]>()
  const children = new Map<string, string[]>()
  for (const edge of edges) {
    if (edge.rel === 'covers') continue
    if (!known.has(edge.src) || !known.has(edge.dst)) continue
    if (!children.has(edge.src)) children.set(edge.src, [])
    if (!parents.has(edge.dst)) parents.set(edge.dst, [])
    children.get(edge.src)!.push(edge.dst)
    parents.get(edge.dst)!.push(edge.src)
  }
  return { parents, children }
}

/**
 * The hot set: live intents, everything upstream that feeds them, and their
 * direct children (a finished intent's own outputs stay visible next to it).
 * Everything else is structurally cold.
 */
export function hotSet(nodes: ColdNode[], adj: Adjacency): Set<string> {
  const live = nodes.filter(isLiveIntent)
  const hot = new Set<string>()
  const upstream = (start: string) => {
    const queue = [start]
    while (queue.length) {
      const id = queue.pop()!
      if (hot.has(id)) continue
      hot.add(id)
      for (const parent of adj.parents.get(id) || []) queue.push(parent)
    }
  }
  for (const intent of live) {
    hot.add(intent.id)
    for (const parent of adj.parents.get(intent.id) || []) upstream(parent)
    for (const child of adj.children.get(intent.id) || []) hot.add(child)
  }
  return hot
}

/**
 * Advance the per-node cold streaks by one planner round. A node that is
 * structurally cold this round gets its streak incremented; a node that turned
 * hot again resets to zero. Returns the set that has been cold continuously
 * for at least R rounds and is foldable — those are eligible for digestion.
 */
export function advanceColdStreaks(
  nodes: ColdNode[],
  hot: Set<string>,
  streaks: Map<string, number>,
  params: ColdParams = defaultColdParams(),
): Set<string> {
  const eligible = new Set<string>()
  for (const node of nodes) {
    if (hot.has(node.id) || !foldable(node)) {
      streaks.delete(node.id)
      continue
    }
    const streak = (streaks.get(node.id) ?? 0) + 1
    streaks.set(node.id, streak)
    if (streak >= params.R) eligible.add(node.id)
  }
  return eligible
}

function foldable(node: ColdNode): boolean {
  if (node.kind === 'intent') return ['done', 'blocked', 'exhausted', 'stopped'].includes(node.status)
  if (node.kind === 'fact') return node.status === 'confirmed' || node.status === 'dismissed'
  return false
}

/**
 * Group eligible nodes into blocks: connected components under the causal
 * edges, restricted to the eligible set. Blocks smaller than K are left alone —
 * folding a singleton hides information for no space saved.
 */
export function groupEligible(eligible: Set<string>, adj: Adjacency, params: ColdParams = defaultColdParams()): string[][] {
  const parent = new Map<string, string>()
  const find = (id: string): string => {
    let root = id
    while (parent.get(root) !== root) root = parent.get(root)!
    return root
  }
  const union = (a: string, b: string) => {
    if (!parent.has(a)) parent.set(a, a)
    if (!parent.has(b)) parent.set(b, b)
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }
  for (const id of eligible) parent.set(id, id)
  for (const [dst, sources] of adj.parents) {
    for (const src of sources) {
      if (eligible.has(src) && eligible.has(dst)) union(src, dst)
    }
  }
  const blocks = new Map<string, string[]>()
  for (const id of eligible) {
    const root = find(id)
    if (!blocks.has(root)) blocks.set(root, [])
    blocks.get(root)!.push(id)
  }
  return [...blocks.values()].filter((block) => block.length >= params.K)
}
