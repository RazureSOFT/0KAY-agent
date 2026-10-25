import { Tool } from '../types.js'
import type { ToolContext, ToolResult } from '../types.js'
import { success, failure } from '../helpers.js'
import type { ReconGraph } from '../../analysis/artex/graph.js'
import type { TraceStore } from '../../analysis/artex/traces.js'

// The ARTEX tool surface, 1:1: the same tool names, the same argument shapes
// and the same model-facing descriptions (ported from agent/tools.go, AGPL-3.0,
// see analysis/README.md for the licence record). They operate on the run
// context (context.artex) — the session's shared graph and the active run's
// trace store — instead of ARTEX's per-task DB stores.
//
// Known divergences, kept honest:
//   - report_finding returns only the exploration node id (ARTEX also keeps a
//     separate findings table bound to recorded traffic);
//   - steer_work queues a steering trace for the intent (ARTEX injects it into
//     the worker's live conversation);
//   - company scopes do not exist here (no company model).
// Tool names not ported: traffic_* (no MITM layer yet), list_companies /
// add_company_scope (no company model), mcp/skill wrappers (already exist as
// their own tools).

export interface ArtexRun {
  graph: ReconGraph
  traces: TraceStore
  /** The task's live constraints array — mutating it steers the planner. */
  constraints?: string[]
  objective?: string
}

function run(context: ToolContext): ArtexRun | null {
  return context.artex || null
}

/**
 * asset_ids in ARTEX are ids; here they may also be raw observations. Returns
 * RAW strings for addNode({assets}) — ids resolve to their asset's key, unknown
 * entries pass through as new observations.
 */
function rawAssets(graph: ReconGraph, ids: unknown): string[] {
  if (!Array.isArray(ids)) return []
  return (ids as unknown[])
    .map((entry) => String(entry ?? '').trim())
    .filter(Boolean)
    .map((entry) => graph.asset(entry)?.key ?? entry)
}

function composeFactText(summary: string, detail?: string, evidence?: string, confidence?: string): string {
  let text = summary
  if (detail) text += `\n${detail}`
  if (evidence) text += `\n证据: ${evidence}`
  if (confidence) text += ` [${confidence}]`
  return text.trim()
}

/** record_fact — ported verbatim from agent/tools.go recordFact(). */
export class RecordFactTool extends Tool {
  get name(): string { return 'record_fact'; }
  get description(): string {
    return '把探索【事实/结论】写入探索图，连到产生它的意图（intent_id）。用于记录探索结果——包括指纹/枚举等【正向结论】，和"端口关闭"/"参数不可注入"/"未发现登录入口"等【否定结论】。\n' +
      '⚠️一次探索的多个观察要【汇总成一条事实】，不要拆成多条：summary=对本次结论的总结性一句话，detail=相关细节（可含多个具体项）。一条意图通常只产出一条事实，拆太碎会让图谱无限膨胀。\n' +
      '★facts 数组用于一次写多条【彼此不同】的结论（每条可省略 intent_id，默认用顶层 intent_id）。\n' +
      '⚠️只写你在工具输出里【真实看到】的结论，不要脑补。evidence=支撑本结论的【一行】关键证据（命令+最能证明的那一两行输出），务必简洁。confidence=observed（输出里直接看到）| inferred（据现象推断）；否定结论务必如实标注。'
  }
  get parameters(): Record<string, any> {
    return {
      type: 'object',
      properties: {
        facts: { type: 'array', description: '【有多条不同结论时用】事实数组，元素字段同顶层字段；省略 intent_id 则用顶层 intent_id。', items: { type: 'object' } },
        summary: { type: 'string', description: '对本次探索结论的【总结性一句话】' },
        intent_id: { type: 'string', description: '产生本事实的意图 id（你领到的意图；批量时作为各条默认）' },
        detail: { type: 'string', description: '本事实的相关细节：把这次探索的多个观察都写进这里' },
        evidence: { type: 'string', description: '【一行】关键证据：命令 + 最能证明结论的那一两行输出。' },
        confidence: { type: 'string', enum: ['observed', 'inferred'], description: 'observed=直接看到 | inferred=据现象推断。' },
        asset_ids: { type: 'array', items: { type: 'string' }, description: '相关资产 id 或原始标识（可选）。' },
      },
    }
  }
  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    const artex = run(context)
    if (!artex) return failure('artex run context unavailable (recon_graph tool covers ad-hoc use)')
    const { graph } = artex
    const items: Array<Record<string, any>> = Array.isArray(args.facts) && args.facts.length ? args.facts : [args]
    const defaultIntent = String(args.intent_id || '')
    const ids: string[] = []
    const errors: Record<string, string> = {}
    items.forEach((item, index) => {
      try {
        const intentId = String(item.intent_id || defaultIntent || '')
        const text = composeFactText(String(item.summary || '').trim(), item.detail ? String(item.detail).trim() : undefined, item.evidence ? String(item.evidence).trim() : undefined, item.confidence ? String(item.confidence).trim() : undefined)
        if (!text) throw new Error('summary is required')
        const node = graph.addNode({
          kind: 'fact',
          text,
          assets: rawAssets(graph, item.asset_ids),
          ...(intentId ? { derivedFrom: [intentId] } : {}),
        })
        ids.push(node.id)
      } catch (error: any) {
        errors[String(index)] = error?.message || String(error)
      }
    })
    if (items.length === 1 && errors['0']) return failure(errors['0'])
    return ids.length ? success({ ids, ...(Object.keys(errors).length ? { errors } : {}) }) : failure('nothing recorded')
  }
}

/** report_finding — ported from agent/tools.go addFinding(); node id only (no separate findings table). */
export class ReportFindingTool extends Tool {
  get name(): string { return 'report_finding'; }
  get description(): string {
    return '记录确认的漏洞，用 evidence 提供命令输出、日志等可验证证据。任务上下文传当前 intent_id。返回 finding_node_id（探索节点 id）。只有真实触发并取得可复现证据才调用——严禁把版本/指纹匹配、外部库推断当已确认。'
  }
  get parameters(): Record<string, any> {
    return {
      type: 'object',
      required: ['summary'],
      properties: {
        intent_id: { type: 'string', description: '产生本发现的意图 id。' },
        name: { type: 'string', description: '漏洞名（如 SQLi in /login）。' },
        vulnclass: { type: 'string', description: '漏洞类别（如 sqli、authz）。' },
        severity: { type: 'string', enum: ['info', 'low', 'medium', 'high', 'critical'], description: '严重级别。' },
        summary: { type: 'string', description: '一句话结论。' },
        evidence: { type: 'string', description: '可复现证据：请求/响应或命令输出。' },
        asset_ids: { type: 'array', items: { type: 'string' }, description: '相关资产 id 或原始标识。' },
      },
    }
  }
  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    const artex = run(context)
    if (!artex) return failure('artex run context unavailable')
    const { graph } = artex
    const summary = String(args.summary || '').trim()
    if (!summary) return failure('summary is required')
    const name = String(args.name || '').trim()
    const severity = String(args.severity || '').trim()
    const vulnclass = String(args.vulnclass || '').trim()
    const evidence = String(args.evidence || '').trim()
    let text = name ? `${name}: ${summary}` : summary
    if (vulnclass) text += ` [${vulnclass}]`
    if (severity) text += ` [severity: ${severity}]`
    if (evidence) text += `\n证据: ${evidence}`
    const intentId = String(args.intent_id || '')
    const node = graph.addNode({
      kind: 'finding',
      text,
      assets: rawAssets(graph, args.asset_ids),
      ...(intentId ? { derivedFrom: [intentId] } : {}),
    })
    return success({ finding_node_id: node.id, note: '本实现没有独立 findings 表——finding_node_id 即唯一 id' })
  }
}

/** insert_assets — ported from agent/tools_insert.go insertAssets(); mixed raw assets, anchored to the intent. */
export class InsertAssetsTool extends Tool {
  get name(): string { return 'insert_assets'; }
  get description(): string {
    return '把发现的新资产写入资产图（子域/service/endpoint/IP/主机，原始标识即可，类型与父子关系由程序判定），并锚到当前意图。只登记资产本身；探索结论用 record_fact。'
  }
  get parameters(): Record<string, any> {
    return {
      type: 'object',
      required: ['assets'],
      properties: {
        assets: { type: 'array', items: { type: 'string' }, description: '资产原始标识数组：URL、主机名、host:port、IP。' },
        intent_id: { type: 'string', description: '发现这些资产的意图 id（锚点）。' },
      },
    }
  }
  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    const artex = run(context)
    if (!artex) return failure('artex run context unavailable')
    const { graph } = artex
    const raws = Array.isArray(args.assets) ? args.assets.map(String).filter(Boolean) : []
    if (!raws.length) return failure('assets must be a non-empty array')
    const created = raws.map((raw) => graph.addAsset(raw))
    const intentId = String(args.intent_id || '')
    if (intentId) {
      const intent = graph.node(intentId)
      if (intent && intent.kind === 'intent') {
        const known = new Set(intent.assetIds)
        for (const asset of created) if (!known.has(asset.id)) intent.assetIds.push(asset.id)
      }
    }
    return success({ ids: created.map((asset) => asset.id), assets: created.map((asset) => ({ id: asset.id, kind: asset.kind, key: asset.key })) })
  }
}

/** add_intent — ported from agent/tools.go addIntent(); batch, anchored to existing facts/findings. */
export class AddIntentTool extends Tool {
  get name(): string { return 'add_intent'; }
  get description(): string {
    return '生成【探索方向】写入 frontier，并连入探索链路。意图是开放的探索方向，不是固定类型——用 summary 一句话自由描述要探索/验证/利用什么。\n' +
      '★优先批量：一轮筛出的多个新方向放进 intents 数组一次提交。parent_ids 只能填已存在的 fact/finding 节点 id——意图必须锚在已确认知识上，发现驱动而非凭空规划；顶层全新方向留空（自动挂 origin）。'
  }
  get parameters(): Record<string, any> {
    return {
      type: 'object',
      properties: {
        intents: { type: 'array', description: '【优先用这个】要新增的探索方向数组，按顺序处理。', items: { type: 'object' } },
        summary: { type: 'string', description: '[单条] 一句话描述这个探索方向：做什么+为什么。' },
        assets: { type: 'array', items: { type: 'string' }, description: '本方向要测试/攻击的目标资产（原始标识或 id，尽量传）。' },
        parent_ids: { type: 'array', items: { type: 'string' }, description: '上游锚点：已确认的 fact/finding 节点 id（不能填意图/目标/提示）。' },
        priority: { type: 'integer', minimum: 0, maximum: 10, description: '优先级 0-10，默认 5。' },
      },
    }
  }
  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    const artex = run(context)
    if (!artex) return failure('artex run context unavailable')
    const { graph } = artex
    const items: Array<Record<string, any>> = Array.isArray(args.intents) && args.intents.length ? args.intents : [args]
    const ids: string[] = []
    const errors: Record<string, string> = {}
    items.forEach((item, index) => {
      try {
        const text = String(item.summary || item.text || '').trim()
        if (!text) throw new Error('summary is required')
        const parents = Array.isArray(item.parent_ids) ? item.parent_ids.map(String).filter((id: string) => graph.node(id)) : []
        const node = graph.addNode({
          kind: 'intent',
          text,
          assets: rawAssets(graph, item.assets),
          ...(parents.length ? { derivedFrom: parents } : {}),
          ...(item.priority != null ? { priority: Number(item.priority) } : {}),
        })
        ids.push(node.id)
      } catch (error: any) {
        errors[String(index)] = error?.message || String(error)
      }
    })
    if (items.length === 1 && errors['0']) return failure(errors['0'])
    return ids.length ? success({ ids, ...(Object.keys(errors).length ? { errors } : {}) }) : failure('nothing created')
  }
}

/** prove_goal — ported from agent/tools.go proveGoal(); all-met ends the task. */
export class ProveGoalTool extends Tool {
  get name(): string { return 'prove_goal'; }
  get description(): string { return '当你判断某个发现/事实证明了某个目标达成时调用：把证据节点连到目标节点，并标记目标 met。⚠️量化验收（覆盖度 X%）未达实测值时会被拒绝——改派补差意图，不要硬来。' }
  get parameters(): Record<string, any> {
    return {
      type: 'object',
      required: ['goal_id', 'evidence_id'],
      properties: {
        goal_id: { type: 'string', description: '目标节点 id。' },
        evidence_id: { type: 'string', description: '证明它的发现/事实节点 id。' },
        reason: { type: 'string', description: '为什么这个证据满足该目标。' },
      },
    }
  }
  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    const artex = run(context)
    if (!artex) return failure('artex run context unavailable')
    const goalId = String(args.goal_id || '')
    const evidenceId = String(args.evidence_id || '')
    if (!goalId || !evidenceId) return failure('goal_id 和 evidence_id 必填')
    const goal = artex.graph.prove(goalId, evidenceId)
    const goals = artex.graph.toJSON().nodes.filter((node) => node.kind === 'goal')
    const allMet = goals.length > 0 && goals.every((node) => node.status === 'met' || node.status === 'abandoned')
    return success({
      goal: goalId, status: goal.status,
      ...(allMet ? { note: `本任务所有 ${goals.length} 个目标均已达成，任务自动判定完成` } : {}),
      ...(args.reason ? { reason: String(args.reason) } : {}),
    })
  }
}

/** goal_met — ported from agent/tools.go goalMet(); global finish that bypasses per-goal proof. */
export class GoalMetTool extends Tool {
  get name(): string { return 'goal_met'; }
  get description(): string {
    return '【立即结束整个任务】——仅当你确认任务的【全部目标都已真正达成、整体收官】时才调。仅仅达成了其中一个目标不算——那种情况用 prove_goal。它不是用来"结束本轮规划"的：本轮没有新意图要派、或在等 worker 产出，直接结束本轮即可，不要调本工具。'
  }
  get parameters(): Record<string, any> {
    return {
      type: 'object',
      required: ['reason'],
      properties: { reason: { type: 'string', description: '达成理由（必须是目标真正达成的证据，不能是"本轮无新方向"）。' } },
    }
  }
  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    const artex = run(context)
    if (!artex) return failure('artex run context unavailable')
    const reason = String(args.reason || '').trim()
    if (!reason) return failure('reason is required')
    const goals = artex.graph.toJSON().nodes.filter((node: any) => node.kind === 'goal' && node.status === 'open')
    for (const goal of goals) artex.graph.setStatus(goal.id, 'met')
    return success({ closed: goals.length, reason, note: '全部目标已标记 met，任务按目标完成收官' })
  }
}

/** kill_work — ported from agent/tools.go killWork(). */
export class KillWorkTool extends Tool {
  get name(): string { return 'kill_work'; }
  get description(): string { return '终止一条正在运行的意图(work)。用于叫停跑偏/无意义的探索；被终止的意图标记为 stopped，不再自动重领。' }
  get parameters(): Record<string, any> {
    return { type: 'object', required: ['intent_id'], properties: { intent_id: { type: 'string', description: '要终止的意图节点 id。' } } }
  }
  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    const artex = run(context)
    if (!artex) return failure('artex run context unavailable')
    artex.graph.setStatus(String(args.intent_id || ''), 'stopped')
    return success({ killed: String(args.intent_id || '') })
  }
}

/** steer_work — ported from agent/tools.go steerWork(); queued as a steering trace (divergence: no live injection). */
export class SteerWorkTool extends Tool {
  get name(): string { return 'steer_work'; }
  get description(): string {
    return '给一条正在运行的意图(work)注入纠偏指令。用于"别再走 X、聚焦 Y"这类【意图内】纠偏；若方向整个错了应改用 kill_work 再下新意图。注意：本实现把纠偏记入该意图的执行轨迹（续派时 worker 会读到），不是实时打断。'
  }
  get parameters(): Record<string, any> {
    return {
      type: 'object',
      required: ['intent_id', 'message'],
      properties: { intent_id: { type: 'string', description: '意图节点 id。' }, message: { type: 'string', description: '纠偏指令。' } },
    }
  }
  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    const artex = run(context)
    if (!artex) return failure('artex run context unavailable')
    const intentId = String(args.intent_id || '')
    const message = String(args.message || '').trim()
    if (!intentId || !message) return failure('intent_id and message are required')
    artex.traces.record({ intentId, worker: 'steer', action: 'steer', detail: message, ok: true })
    const node = artex.graph.node(intentId)
    if (node) {
      node.text += `\n[steer] ${message}`
    }
    return success({ steered: intentId, note: '已记入执行轨迹；续派该意图的 worker 会读到' })
  }
}

/** add_hint — ported from agent/tools.go addHint(). */
export class AddHintTool extends Tool {
  get name(): string { return 'add_hint'; }
  get description(): string { return '把人类/主 agent 的战略提示挂到探索图，规划者下次生成意图时会读到它。' }
  get parameters(): Record<string, any> {
    return { type: 'object', required: ['text'], properties: { text: { type: 'string', description: '战略提示一句话。' } } }
  }
  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    const artex = run(context)
    if (!artex) return failure('artex run context unavailable')
    const text = String(args.text || '').trim()
    if (!text) return failure('text is required')
    const node = artex.graph.addHint(text)
    return success({ id: node.id })
  }
}

/** set_goals — ported from agent/tools.go setGoals(); replaces the open goal set. */
export class SetGoalsTool extends Tool {
  get name(): string { return 'set_goals'; }
  get description(): string {
    return '设定/替换本任务的目标清单（最终可交付结果，不是攻击步骤）。已 open 的旧目标标记 abandoned，新目标逐条登记。'
  }
  get parameters(): Record<string, any> {
    return {
      type: 'object',
      required: ['goals'],
      properties: { goals: { type: 'array', items: { type: 'string' }, description: '目标一句话数组。' } },
    }
  }
  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    const artex = run(context)
    if (!artex) return failure('artex run context unavailable')
    const list = Array.isArray(args.goals) ? args.goals.map(String).map((entry) => entry.trim()).filter(Boolean) : []
    if (!list.length) return failure('goals must be a non-empty array')
    const created: string[] = []
    for (const node of artex.graph.toJSON().nodes) {
      if (node.kind === 'goal' && node.status === 'open') artex.graph.setStatus(node.id, 'abandoned')
    }
    for (const text of list.slice(0, 8)) created.push(artex.graph.addNode({ kind: 'goal', text }).id)
    return success({ goals: created })
  }
}

/** set_constraints — mutates the task's live constraints array (planner reads it next round). */
export class SetConstraintsTool extends Tool {
  get name(): string { return 'set_constraints'; }
  get description(): string {
    return '登记操作约束（可以做什么/不可以做什么），注入执行阶段提示，最高优先级红线。约束必须自包含、写死具体目标（不要写"当前目标"）。'
  }
  get parameters(): Record<string, any> {
    return {
      type: 'object',
      required: ['constraints'],
      properties: { constraints: { type: 'array', items: { type: 'string' }, description: '约束数组，每条自包含。' } },
    }
  }
  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    const artex = run(context)
    if (!artex) return failure('artex run context unavailable')
    if (!artex.constraints) return failure('this run has no constraints channel')
    const list = Array.isArray(args.constraints) ? args.constraints.map(String).map((entry) => entry.trim()).filter(Boolean) : []
    if (!list.length) return failure('constraints must be a non-empty array')
    for (const entry of list) if (!artex.constraints.includes(entry)) artex.constraints.push(entry)
    return success({ constraints: [...artex.constraints] })
  }
}

/** add_task_scope — merges scope rows (ARTEX add_task_scope; minimal-scope principle). */
export class AddTaskScopeTool extends Tool {
  get name(): string { return 'add_task_scope'; }
  get description(): string {
    return '登记测试资产范围（覆盖度的分母、授权边界）。最小范围原则：只登记明确点到的那一个目标，绝不擅自放大——看到 xxx.example.com 就登记整个 example.com 会把范围扩到目标之外。'
  }
  get parameters(): Record<string, any> {
    return { type: 'object', required: ['patterns'], properties: { patterns: { type: 'array', items: { type: 'string' }, description: '域名/IP/CIDR（URL 会取主机名）。' } } }
  }
  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    const artex = run(context)
    if (!artex) return failure('artex run context unavailable')
    const rows = artex.graph.addScope(Array.isArray(args.patterns) ? args.patterns.map(String) : [])
    return success({ scope: rows.map((row: any) => `${row.kind}:${row.value}`), pct: artex.graph.coverage().scope.pct })
  }
}

// ---- read tools ----

/** graph_overview — ported from agent/tools.go graphOverviewData() semantics. */
export class GraphOverviewTool extends Tool {
  get name(): string { return 'graph_overview'; }
  get description(): string { return '一次性读取完整探索态势（goals、open/running 意图、facts、coverage、traces）——规划者的态势输入就是它，无需再调别的读工具。' }
  get parameters(): Record<string, any> { return { type: 'object', properties: {} } }
  async execute(_args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    const artex = run(context)
    if (!artex) return failure('artex run context unavailable')
    return success(artex.graph.overview())
  }
}

/** list_facts — ported from agent/tools.go listFacts(). */
export class ListFactsTool extends Tool {
  get name(): string { return 'list_facts'; }
  get description(): string { return '分页列出探索事实（最新在前，可 q 过滤）。' }
  get parameters(): Record<string, any> {
    return { type: 'object', properties: { q: { type: 'string', description: '子串过滤。' }, limit: { type: 'integer', minimum: 1, maximum: 100, description: '默认 20。' } } }
  }
  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    const artex = run(context)
    if (!artex) return failure('artex run context unavailable')
    const q = String(args.q || '').toLowerCase()
    const limit = Math.min(Number(args.limit) || 20, 100)
    const rows = artex.graph.toJSON().nodes
      .filter((node) => node.kind === 'fact' && node.status !== 'origin')
      .filter((node) => !q || node.text.toLowerCase().includes(q))
      .slice(-limit)
      .reverse()
      .map((node: any) => ({ id: node.id, text: node.text, status: node.status }))
    return success({ facts: rows, total: rows.length })
  }
}

/** list_findings — ported from agent/tools.go listFindings(). */
export class ListFindingsTool extends Tool {
  get name(): string { return 'list_findings'; }
  get description(): string { return '列出全部确认的漏洞发现。' }
  get parameters(): Record<string, any> { return { type: 'object', properties: {} } }
  async execute(_args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    const artex = run(context)
    if (!artex) return failure('artex run context unavailable')
    return success({
      findings: artex.graph.toJSON().nodes.filter((node) => node.kind === 'finding').map((node: any) => ({ id: node.id, text: node.text, status: node.status })),
    })
  }
}

/** list_goals — ported from agent/tools.go listGoals(). */
export class ListGoalsTool extends Tool {
  get name(): string { return 'list_goals'; }
  get description(): string { return '列出本任务的目标与状态。' }
  get parameters(): Record<string, any> { return { type: 'object', properties: {} } }
  async execute(_args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    const artex = run(context)
    if (!artex) return failure('artex run context unavailable')
    return success({ goals: artex.graph.toJSON().nodes.filter((node) => node.kind === 'goal').map((node: any) => ({ id: node.id, text: node.text, status: node.status })) })
  }
}

/** node_detail — ported from agent/tools.go nodeDetail(). */
export class NodeDetailTool extends Tool {
  get name(): string { return 'node_detail'; }
  get description(): string { return '读一个节点的完整内容与上下游血缘（列表/态势只给摘要时用它）。' }
  get parameters(): Record<string, any> {
    return { type: 'object', required: ['id'], properties: { id: { type: 'string', description: '节点 id。' } } }
  }
  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    const artex = run(context)
    if (!artex) return failure('artex run context unavailable')
    const node = artex.graph.node(String(args.id || ''))
    if (!node) return failure(`unknown node: ${args.id}`)
    const edges = artex.graph.edgesOut()
    return success({
      id: node.id, kind: node.kind, status: node.status, text: node.text, assetIds: node.assetIds,
      upstream: node.derivedFrom.map((id) => artex.graph.node(id)).filter(Boolean).map((parent) => ({ id: parent!.id, kind: parent!.kind, text: parent!.text })),
      downstream: edges.filter((edge) => edge.src === node.id).map((edge) => artex.graph.node(edge.dst)).filter(Boolean).map((child) => ({ id: child!.id, kind: child!.kind, text: child!.text })),
    })
  }
}

/** expand_digest — ported from agent/tools.go expandDigest(). */
export class ExpandDigestTool extends Tool {
  get name(): string { return 'expand_digest'; }
  get description(): string { return '展开一个 digest（折叠的冷区）的成员节点。' }
  get parameters(): Record<string, any> {
    return { type: 'object', required: ['id'], properties: { id: { type: 'string', description: 'digest 节点 id。' } } }
  }
  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    const artex = run(context)
    if (!artex) return failure('artex run context unavailable')
    const digest = artex.graph.digests().find((entry) => entry.id === String(args.id || ''))
    if (!digest) return failure(`unknown or inactive digest: ${args.id}`)
    return success({
      id: digest.id, text: digest.text,
      members: digest.memberIds.map((id) => artex.graph.node(id)).filter(Boolean).map((node) => ({ id: node!.id, kind: node!.kind, status: node!.status, text: node!.text })),
    })
  }
}

/** list_assets — ported from agent/tools.go listAssets(). */
export class ListAssetsTool extends Tool {
  get name(): string { return 'list_assets'; }
  get description(): string { return '列出资产图（可按类型/关键字过滤）。' }
  get parameters(): Record<string, any> {
    return { type: 'object', properties: { type: { type: 'string', description: '按类型过滤（root_domain/subdomain/ip/service/app/endpoint）。' }, q: { type: 'string', description: '子串过滤。' }, limit: { type: 'integer', minimum: 1, maximum: 500, description: '默认 100。' } } }
  }
  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    const artex = run(context)
    if (!artex) return failure('artex run context unavailable')
    const type = String(args.type || '')
    const q = String(args.q || '').toLowerCase()
    const limit = Math.min(Number(args.limit) || 100, 500)
    return success({
      assets: artex.graph.toJSON().assets
        .filter((asset) => (!type || asset.kind === type) && (!q || asset.key.toLowerCase().includes(q)))
        .slice(0, limit)
        .map((asset) => ({ id: asset.id, kind: asset.kind, key: asset.key })),
    })
  }
}

/** list_untested_assets — ported from agent/tools.go listUntestedAssets(). */
export class ListUntestedAssetsTool extends Tool {
  get name(): string { return 'list_untested_assets'; }
  get description(): string { return '列出范围内尚未测试的资产（补差意图的目标池）。' }
  get parameters(): Record<string, any> {
    return { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 200, description: '默认 20。' } } }
  }
  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    const artex = run(context)
    if (!artex) return failure('artex run context unavailable')
    const limit = Math.min(Number(args.limit) || 20, 200)
    const coverage = artex.graph.coverage()
    return success({
      untested: coverage.untested.slice(0, limit).map((asset) => ({ id: asset.id, kind: asset.kind, key: asset.key })),
      total: coverage.untested.length,
      pct: coverage.scope.pct,
    })
  }
}

/** search_all_worker_traces — ported from agent/tools.go searchAllWorkerTraces(). */
export class SearchAllWorkerTracesTool extends Tool {
  get name(): string { return 'search_all_worker_traces'; }
  get description(): string { return '全文检索所有 worker 的执行过程（不是结论，是步骤）——"有人试过 X 吗"用它回答，别重复探测。' }
  get parameters(): Record<string, any> {
    return { type: 'object', required: ['q'], properties: { q: { type: 'string', description: '关键字（如 sqlmap、/admin、500）。' }, exclude_intent: { type: 'string', description: '排除自己的意图 id。' } } }
  }
  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    const artex = run(context)
    if (!artex) return failure('artex run context unavailable')
    return success({
      hits: artex.traces.search(String(args.q || ''), { excludeIntent: args.exclude_intent ? String(args.exclude_intent) : undefined }),
    })
  }
}

/** get_worker_trace — ported from agent/tools.go getWorkerTrace(). */
export class GetWorkerTraceTool extends Tool {
  get name(): string { return 'get_worker_trace'; }
  get description(): string { return '读某条意图的完整执行过程（它实际做到哪、卡在哪）。' }
  get parameters(): Record<string, any> {
    return { type: 'object', required: ['intent_id'], properties: { intent_id: { type: 'string', description: '意图节点 id。' } } }
  }
  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    const artex = run(context)
    if (!artex) return failure('artex run context unavailable')
    return success({ steps: artex.traces.get(String(args.intent_id || '')) })
  }
}

export const ARTEX_TOOLS = [
  new GraphOverviewTool(), new ListGoalsTool(), new ListFactsTool(), new ListFindingsTool(), new NodeDetailTool(), new ExpandDigestTool(),
  new ListAssetsTool(), new ListUntestedAssetsTool(), new AddTaskScopeTool(),
  new AddIntentTool(), new ProveGoalTool(), new GoalMetTool(), new KillWorkTool(), new SteerWorkTool(),
  new RecordFactTool(), new ReportFindingTool(), new InsertAssetsTool(), new AddHintTool(), new SetGoalsTool(), new SetConstraintsTool(),
  new SearchAllWorkerTracesTool(), new GetWorkerTraceTool(),
]
