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
import type { IntentSpec, Situation, WorkerResult } from '../../analysis/artex/engine.js'

// The ARTEX loop as one tool: give it a goal and the targets, it runs planner →
// workers → graph until the goal is proven or the budget runs out.
//
// The planner and the worker are model calls, but everything that decides when to
// stop — the budget, the zero-intent exit, the no-progress exit, the evidence
// requirement for proving — is code. A model is allowed to be optimistic; the
// loop is not.

/** Pull the first JSON object out of a model reply, fences and prose included. */
export function extractJson(text: string): any | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const candidates: string[] = []
  if (fenced) candidates.push(fenced[1].trim())
  const start = text.indexOf('{')
  if (start >= 0) {
    let depth = 0
    for (let i = start; i < text.length; i++) {
      if (text[i] === '{') depth++
      else if (text[i] === '}' && --depth === 0) {
        candidates.push(text.slice(start, i + 1))
        break
      }
    }
  }
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate)
    } catch {
      // try the next shape
    }
  }
  return null
}

const PLANNER_PROMPT = `You are the planner of a scoped security assessment. You do not execute anything.

Given the current situation, return the next exploration intents — concrete, single-purpose actions a worker can carry out against the listed assets.

Reply with JSON only:
{"plan":[{"text":"..."}],"intents":[{"text":"...","assets":["..."],"stepId":"s1"}]}

Rules:
- "plan" is the ordered chain of steps for the whole task; repeat it every round, unchanged once it is working.
- "intents" is what to try THIS round: 0 to 3 of them. Return {"intents":[]} when there is nothing new worth trying — that ends the assessment cleanly.
- Never repeat an intent that already appears in the situation. Each intent names the assets it targets.
- Stay strictly inside the given scope.`

const WORKER_PROMPT = `You are a worker executing exactly one intent. You may call tools.

Carry out the intent and report what you observed. Do not invent results: if a tool failed, say so in "steps" and return no facts.

Reply with JSON only:
{"facts":[{"text":"..."}],"findings":[{"text":"..."}],"steps":[{"action":"...","detail":"...","ok":true}],"note":"..."}

A fact is an observation ("login accepts POST /auth with JSON"). A finding is an exploitable defect with evidence ("auth bypass: empty password returns 200 and a JWT").`

export class DeepScanTool extends Tool {
  get name(): string { return 'deep_scan'; }
  get description(): string {
    return [
      'Run a scoped assessment loop: a planner proposes intents, workers carry them out, results go into the asset/exploration graph, repeat.',
      'Stops on goal proven, no new intents, no progress, or budget. Returns coverage, findings and the reason it stopped.',
      'Needs a goal and at least one target. Intents never leave the scope you give; keep rounds and intents small for a first run.',
    ].join(' ')
  }
  get parameters(): Record<string, any> {
    return {
      type: 'object',
      required: ['goal', 'targets'],
      properties: {
        goal: { type: 'string', description: 'What would count as done, in one sentence.' },
        targets: { type: 'array', items: { type: 'string' }, description: 'In-scope assets: URLs, hosts, host:port.' },
        rounds: { type: 'integer', minimum: 1, maximum: 12 },
        intents: { type: 'integer', minimum: 1, maximum: 40 },
        concurrency: { type: 'integer', minimum: 1, maximum: 6 },
      },
    }
  }
  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    if (!context.llm) return failure('deep_scan needs a model: no llm caller in this context')
    const goalText = String(args.goal || '').trim()
    const targets = Array.isArray(args.targets) ? args.targets.map(String).filter(Boolean) : []
    if (!goalText) return failure('goal is required')
    if (!targets.length) return failure('targets must be a non-empty array')

    const graph = new ReconGraph()
    const plan = new Plan()
    const traces = new TraceStore()
    for (const target of targets) graph.addAsset(target)
    const goal = graph.addNode({ kind: 'goal', text: goalText, assets: targets })

    const scopeLine = `Scope (never leave it): ${targets.join(', ')}`
    const planner = async (situation: Situation): Promise<IntentSpec[]> => {
      const reply = await context.llm!({
        systemPrompt: `${PLANNER_PROMPT}\n\n${scopeLine}`,
        messages: [{
          role: 'user',
          content: JSON.stringify({
            goal: goalText,
            round: situation.round,
            coverage: situation.overview.coverage,
            openIntents: situation.overview.openIntents,
            recent: situation.overview.recent,
            plan: situation.plan.steps.map((step) => ({ id: step.id, text: step.text, status: step.status })),
            readySteps: situation.ready.map((step) => ({ id: step.id, text: step.text })),
            budget: situation.budget,
          }),
        }],
        temperature: 0.2,
      })
      const parsed = extractJson(reply || '')
      if (!parsed) return []

      if (Array.isArray(parsed.plan) && parsed.plan.length) {
        try {
          plan.setAll(parsed.plan.map((entry: any) => ({ text: String(entry.text || ''), needs: entry.needs })))
        } catch {
          // A malformed plan must not kill the round; the intents still run.
        }
      }

      return (Array.isArray(parsed.intents) ? parsed.intents : [])
        .map((entry: any) => ({
          text: String(entry?.text || '').trim(),
          assets: Array.isArray(entry?.assets) ? entry.assets.map(String) : undefined,
          stepId: typeof entry?.stepId === 'string' ? entry.stepId : undefined,
        }))
        .filter((intent: IntentSpec) => intent.text)
        .slice(0, 3)
    }

    const worker = async (intent: IntentSpec): Promise<WorkerResult> => {
      const reply = await context.llm!({
        systemPrompt: `${WORKER_PROMPT}\n\n${scopeLine}`,
        messages: [{ role: 'user', content: JSON.stringify({ goal: goalText, intent: intent.text, assets: intent.assets || targets }) }],
        temperature: 0.2,
      })
      const parsed = extractJson(reply || '')
      if (!parsed) return { note: 'worker returned nothing parseable' }
      return {
        facts: Array.isArray(parsed.facts) ? parsed.facts.map((entry: any) => ({ text: String(entry?.text || '') })).filter((entry: any) => entry.text) : [],
        findings: Array.isArray(parsed.findings) ? parsed.findings.map((entry: any) => ({ text: String(entry?.text || '') })).filter((entry: any) => entry.text) : [],
        steps: Array.isArray(parsed.steps)
          ? parsed.steps.map((entry: any) => ({ action: String(entry?.action || 'step'), detail: String(entry?.detail || ''), ok: entry?.ok !== false }))
          : [],
        note: typeof parsed.note === 'string' ? parsed.note : undefined,
      }
    }

    const engine = new ReconEngine(graph, plan, traces, {
      goalId: goal.id,
      maxRounds: Number(args.rounds) || 4,
      maxIntents: Number(args.intents) || 10,
      concurrency: Number(args.concurrency) || 3,
    })

    try {
      const report = await engine.run(planner, worker)
      const snapshot = graph.toJSON()
      return success({
        ...report,
        goal: { id: goal.id, text: goalText, status: snapshot.nodes.find((node) => node.id === goal.id)?.status },
        findings: snapshot.nodes.filter((node) => node.kind === 'finding').map((node) => node.text),
        facts: snapshot.nodes.filter((node) => node.kind === 'fact').length,
        plan: plan.state().steps.map((step) => ({ id: step.id, text: step.text, status: step.status })),
        traces: traces.size,
      })
    } catch (error) {
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
