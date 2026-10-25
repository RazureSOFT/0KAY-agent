import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { Tool } from '../types.js'
import type { ToolContext, ToolResult } from '../types.js'
import { success, failure } from '../helpers.js'
import { ReconGraph } from '../../analysis/artex/graph.js'
import { Plan } from '../../analysis/artex/plan.js'
import { TraceStore } from '../../analysis/artex/traces.js'
import { ReconEngine } from '../../analysis/artex/engine.js'
import { extractJson, plantGoals, makePlanner, makeWorker, makeSummarizer } from '../../analysis/artex/loop.js'

// The ARTEX loop as one tool: give it an objective and the targets, it decomposes
// the objective into provable goals, then runs planner → workers → graph until
// the goals are proven or a budget (with one final settlement round) ends it.
//
// The model side lives in analysis/artex/loop.ts, shared with the background
// assessment tasks — a scan and a task are the same loop, different plumbing.
//
// By default the loop runs on the SESSION's recon graph (the same one the
// recon_graph tool and the UI panel read), so a scan's assets, directions and
// findings stay visible after it ends. Pass isolate:true to run on a throwaway
// graph instead.

export { extractJson }

export class DeepScanTool extends Tool {
  get name(): string { return 'deep_scan'; }
  get description(): string {
    return [
      'Run a scoped assessment loop on the session recon graph: the objective is decomposed into provable goals, a planner dispatches intents, workers carry them out, results land in the graph, repeat until the goals are proven or a budget ends it with one settlement round.',
      'Stops on goals proven, no new intents, no progress, or budget; a coverage percentage can gate proving. Returns coverage (against the declared scope), findings and the reason it stopped.',
      'Needs an objective and at least one target; keep rounds and intents small for a first run. For a long, pausable run that outlives this call, use assessments instead. Pass isolate:true to run on a throwaway graph.',
    ].join(' ')
  }
  get parameters(): Record<string, any> {
    return {
      type: 'object',
      required: ['goal', 'targets'],
      properties: {
        goal: { type: 'string', description: 'The objective, in one sentence.' },
        targets: { type: 'array', items: { type: 'string' }, description: 'In-scope assets: URLs, hosts, host:port — also used as the coverage denominator.' },
        rounds: { type: 'integer', minimum: 1, maximum: 24 },
        intents: { type: 'integer', minimum: 1, maximum: 60 },
        concurrency: { type: 'integer', minimum: 1, maximum: 6 },
        coverage: { type: 'integer', minimum: 0, maximum: 100, description: 'Refuse to prove goals until this percent of the scope is tested.' },
        timeoutMs: { type: 'integer', minimum: 10000, maximum: 1800000 },
        isolate: { type: 'boolean', description: 'Run on a throwaway graph instead of the session graph the panel reads.' },
      },
    }
  }
  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    if (!context.llm) return failure('deep_scan needs a model: no llm caller in this context')
    const objective = String(args.goal || '').trim()
    const targets = Array.isArray(args.targets) ? args.targets.map(String).filter(Boolean) : []
    if (!objective) return failure('goal is required')
    if (!targets.length) return failure('targets must be a non-empty array')

    // Session graph by default — the panel is reading the same object. A graph
    // this run did not create may already carry scope, goals or an open frontier
    // from earlier work; that is continuation, not contamination.
    const graph = args.isolate === true || !context.recon ? new ReconGraph() : context.recon
    const plan = new Plan()
    const traces = new TraceStore()
    const priorScope = graph.scope().map((row) => row.value)
    const scopeValues = [...new Set([...priorScope, ...targets])]
    graph.setScope(scopeValues)

    const runtime = { llm: context.llm, subagent: context.runSubAgent }
    const loop = { objective, scopeLine: `Scope (never leave it): ${scopeValues.join(', ')}`, constraints: [] as string[], fallbackAssets: targets, graph }
    const { goalIds, constraints } = await plantGoals(runtime, graph, { objective, targets })
    loop.constraints = constraints

    // deep_scan's workers get the same ARTEX tool surface as assessment tasks:
    // register this run under the session for its duration.
    const artexSession = context.sessionId || context.taskId
    context.assessments?.registerRun(artexSession, { graph, traces, constraints, objective })

    const engine = new ReconEngine(graph, plan, traces, {
      goalId: goalIds.length === 1 ? goalIds[0] : undefined,
      minCoveragePct: args.coverage != null ? Number(args.coverage) : undefined,
      maxRounds: Number(args.rounds) || 8,
      maxIntents: Number(args.intents) || 20,
      concurrency: Number(args.concurrency) || 3,
      timeoutMs: Number(args.timeoutMs) || 420_000,
      compaction: { summarizer: makeSummarizer(runtime) },
    })

    try {
      const report = await engine.run(makePlanner(runtime, plan, loop), makeWorker(runtime, loop))
      const snapshot = graph.toJSON()
      const goalStates = snapshot.nodes
        .filter((node) => node.kind === 'goal' && goalIds.includes(node.id))
        .map((node) => ({ id: node.id, text: node.text, status: node.status }))
      context.assessments?.releaseRun(artexSession)
      return success({
        ...report,
        goals: goalStates,
        findings: snapshot.nodes.filter((node) => node.kind === 'finding').map((node) => node.text),
        facts: snapshot.nodes.filter((node) => node.kind === 'fact').length,
        plan: plan.state().steps.map((step) => ({ id: step.id, text: step.text, status: step.status })),
        scope: graph.scope().map((row) => `${row.kind}:${row.value}`),
        graphIsolated: args.isolate === true || !context.recon,
        traces: traces.size,
      })
    } catch (error) {
      context.assessments?.releaseRun(artexSession)
      return failure(error)
    }
  }
}

/**
 * strix's "custom exploit runtime": write a snippet, run it, see what it printed.
 * The sandbox decides whether it is allowed to run at all.
 */
export class ExploitRuntimeTool extends Tool {
  get name(): string { return 'exploit_runtime'; }
  get description(): string {
    return [
      'Write a short script and run it: language python|node|sh, code inline or a path.',
      'Runs under the sandbox policy like any other command, with a timeout, in a temp directory.',
      'Use it to prove something programmatically (a payload, a parser, a loop over responses) rather than to run long jobs — use bash for those.',
    ].join(' ')
  }
  get parameters(): Record<string, any> {
    return {
      type: 'object',
      required: ['code'],
      properties: {
        code: { type: 'string' },
        language: { type: 'string', enum: ['python', 'node', 'sh'] },
        timeoutMs: { type: 'integer', minimum: 1000, maximum: 120000 },
      },
    }
  }
  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    const code = String(args.code || '')
    if (!code.trim()) return failure('code is required')
    const language = ['python', 'node', 'sh'].includes(String(args.language)) ? String(args.language) : 'python'
    const suffix = language === 'python' ? 'py' : language === 'node' ? 'mjs' : 'sh'
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), '0kay-poc-'))
    const file = path.join(dir, `poc.${suffix}`)
    try {
      await fs.writeFile(file, code, 'utf8')
      const shell = context.sandbox
      const command = language === 'python' ? `python "${file}"` : language === 'node' ? `node "${file}"` : `sh "${file}"`
      const verdict = shell?.checkShell(command)
      if (verdict && !verdict.allowed) return failure(verdict.reason || 'blocked by sandbox policy')

      const { execFile } = await import('node:child_process')
      const shellChoice = process.platform === 'win32' ? 'bash' : '/bin/sh'
      const output = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
        execFile(shellChoice, ['-c', command], { timeout: Number(args.timeoutMs) || 30_000, cwd: dir, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
          resolve({ code: error ? Number((error as any).code) || 1 : 0, stdout: String(stdout || ''), stderr: String(stderr || '') })
        })
      })
      return success({
        language,
        exitCode: output.code,
        stdout: output.stdout.slice(0, 20_000),
        stderr: output.stderr.slice(0, 8_000),
        ok: output.code === 0,
        script: file,
      })
    } catch (error) {
      return failure(error)
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }
}
