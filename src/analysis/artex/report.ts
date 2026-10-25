import type { ReconGraph } from './graph.js'
import type { ExplorationNode } from './graph.js'
import type { AssessmentState } from './tasks.js'

// The report module: ARTEX renders a deliverable document from the graph when
// the work is done, and strix writes its findings to disk as it runs. This is
// the same idea — the graph is the single source of truth, the report is a
// deterministic walk over it: goals, scope and coverage, findings with their
// evidence chains, the observation log, and what is still open.
//
// Deliberately no LLM in here: a report that can hallucinate is not a
// deliverable. Every line is read off the graph.

const MAX_FACT_LINES = 40
const MAX_UNTESTED = 15

/** provenance chain, upstream first: "origin ← intent ← finding". */
function chain(graph: ReconGraph, node: ExplorationNode, depth = 3): string {
  const parts: string[] = [node.text]
  let current = node
  for (let i = 0; i < depth; i++) {
    const parent = current.derivedFrom.map((id) => graph.node(id)).find(Boolean)
    if (!parent) break
    parts.push(parent.text)
    current = parent
  }
  return parts.join(' ← ')
}

function anchoredAssets(graph: ReconGraph, node: ExplorationNode): string {
  const labels = node.assetIds
    .map((id) => graph.asset(id))
    .filter(Boolean)
    .map((asset) => `${asset!.kind}:${asset!.key}`)
  return labels.length ? labels.join(', ') : ''
}

export function renderAssessmentReport(state: AssessmentState, graph: ReconGraph): string {
  const coverage = graph.coverage()
  const nodes = graph.toJSON().nodes
  const findings = nodes.filter((node) => node.kind === 'finding')
  const facts = nodes.filter((node) => node.kind === 'fact' && node.status !== 'origin')
  const openIntents = graph.frontier()
  const runningIntents = nodes.filter((node) => node.kind === 'intent' && node.status === 'running')
  const pausedIntents = nodes.filter((node) => node.kind === 'intent' && node.status === 'paused')
  const goals = nodes.filter((node) => node.kind === 'goal')
  const metGoals = goals.filter((goal) => goal.status === 'met')
  const digests = graph.digests()

  const out: string[] = []
  out.push(`# Assessment report — ${state.objective}`)
  out.push('')
  out.push(`| | |`)
  out.push(`|---|---|`)
  out.push(`| Status | ${state.status}${state.stopped ? ` (${state.stopped})` : ''} |`)
  out.push(`| Session | \`${state.sessionId}\` |`)
  out.push(`| Started | ${state.createdAt} |`)
  if (state.endedAt) out.push(`| Ended | ${state.endedAt} |`)
  if (state.report) {
    out.push(`| Rounds / intents | ${state.report.rounds} / ${state.report.intents} |`)
    out.push(`| Worker steps recorded | ${state.report.traces} |`)
  }
  out.push('')

  out.push('## Goals')
  out.push('')
  if (!goals.length) {
    out.push('_No goals were declared._')
  } else {
    for (const goal of goals) {
      out.push(`- [${goal.status === 'met' ? 'x' : ' '}] ${goal.text}${goal.status !== 'open' ? ` _(${goal.status})_` : ''}`)
    }
  }
  out.push('')

  out.push('## Scope & coverage')
  out.push('')
  if (coverage.scope.rows) {
    out.push(`Scope: ${graph.scope().map((row) => `\`${row.kind}:${row.value}\``).join(', ')}`)
  } else {
    out.push('_No scope was declared — coverage is relative to every asset seen._')
  }
  out.push('')
  out.push(`**${coverage.tested} / ${coverage.scope.denominator || coverage.total}** assets tested${coverage.scope.pct != null ? ` (**${coverage.scope.pct}%**)` : ''}.`)
  const untested = coverage.untested.slice(0, MAX_UNTESTED).map((asset) => `\`${asset.kind}:${asset.key}\``)
  if (untested.length) {
    out.push('')
    out.push(`Untested: ${untested.join(', ')}${coverage.untested.length > MAX_UNTESTED ? ` — and ${coverage.untested.length - MAX_UNTESTED} more` : ''}.`)
  }
  out.push('')

  out.push('## Findings')
  out.push('')
  if (!findings.length) {
    out.push('_No confirmed findings. Absence of findings is not absence of risk — see coverage and open directions._')
  } else {
    findings.forEach((finding, index) => {
      const assets = anchoredAssets(graph, finding)
      out.push(`### F${index + 1}. ${finding.text}`)
      out.push('')
      out.push(`- Status: ${finding.status}`)
      if (assets) out.push(`- Assets: ${assets}`)
      out.push(`- Evidence chain: ${chain(graph, finding)}`)
      out.push('')
    })
  }

  out.push('## Observation log')
  out.push('')
  if (!facts.length) {
    out.push('_No facts were recorded._')
  } else {
    for (const fact of facts.slice(0, MAX_FACT_LINES)) {
      out.push(`- ${fact.text}${fact.status === 'dismissed' ? ' _(dismissed)_' : ''}`)
    }
    if (facts.length > MAX_FACT_LINES) out.push(`- … and ${facts.length - MAX_FACT_LINES} more`)
    if (digests.length) out.push(`\n${digests.length} cold region(s) folded into digests; see the exploration graph for their members.`)
  }
  out.push('')

  out.push('## Open directions')
  out.push('')
  const pending = [...runningIntents, ...openIntents, ...pausedIntents]
  if (!pending.length) {
    out.push('_None — the frontier is empty._')
  } else {
    for (const intent of pending.slice(0, 20)) {
      out.push(`- _(${intent.status})_ ${intent.text}`)
    }
  }
  out.push('')

  out.push('## Suggested next steps')
  out.push('')
  const suggestions: string[] = []
  if (metGoals.length < goals.length) suggestions.push('Pursue the unmet goals — the planner can resume this session graph at any time.')
  if (openIntents.length || pausedIntents.length) suggestions.push('Resume the open directions listed above; they were never finished, only queued.')
  if (coverage.untested.length) suggestions.push(`Test the ${coverage.untested.length} untested asset(s) in scope — coverage is ${coverage.scope.pct ?? 0}%.`)
  if (!findings.length) suggestions.push('Re-examine the observation log for inferred leads before calling the target clean.')
  if (!suggestions.length) suggestions.push('All goals met and the scope is covered — extend the scope to go deeper.')
  for (const suggestion of suggestions) out.push(`- ${suggestion}`)
  out.push('')

  out.push('---')
  out.push(`_Generated from the session exploration graph; no step is described that the graph does not show._`)
  out.push('')
  return out.join('\n')
}
