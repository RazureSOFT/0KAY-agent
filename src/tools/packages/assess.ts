import { Tool } from '../types.js'
import type { ToolContext, ToolResult } from '../types.js'
import { success, failure } from '../helpers.js'

// ARTEX's task system as one tool: background assessment tasks that run the
// ARTEX loop on the session graph, outliving the call that started them. The
// panel drives this same tool over /api/run, which is why it is in the
// always-safe set — the user pressing "start" in the panel is the approval.

export class AssessmentsTool extends Tool {
  get name(): string { return 'assessments'; }
  get description(): string {
    return [
      'Long-running assessment tasks: create starts the ARTEX loop (goals phase, planner, workers) in the background on the session recon graph — it keeps running after this call returns.',
      'action=list shows every task with status and coverage; action=get returns one task plus the live graph read (goals, open intents, findings, recent activity).',
      'action=control with operation=pause|resume|cancel|delete manages a task; a paused task resumes where the frontier left off. action=hint sends steering text the planner reads next round.',
      'action=report renders the task graph into a Markdown deliverable (goals, coverage, findings with evidence chains, open directions) written to the working directory — call report_artifacts with the returned path.',
      'Caps: one running task per session, four overall. Prefer this over deep_scan when the work should be watchable and steerable.',
    ].join(' ')
  }
  get parameters(): Record<string, any> {
    return {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['create', 'list', 'get', 'control', 'hint', 'trace', 'report'] },
        intent_id: { type: 'string', description: 'trace: the worker intent node id.' },
        objective: { type: 'string', description: 'create: the objective, in one sentence.' },
        targets: { type: 'array', items: { type: 'string' }, description: 'create: in-scope assets — also the coverage denominator.' },
        coverage: { type: 'integer', minimum: 0, maximum: 100, description: 'create: refuse to prove goals below this percent of scope tested.' },
        rounds: { type: 'integer', minimum: 1, maximum: 48 },
        intents: { type: 'integer', minimum: 1, maximum: 120 },
        concurrency: { type: 'integer', minimum: 1, maximum: 6 },
        timeoutMs: { type: 'integer', minimum: 10000, maximum: 3600000 },
        id: { type: 'string', description: 'get/control/hint/report: the task id.' },
        operation: { type: 'string', enum: ['pause', 'resume', 'cancel', 'delete'], description: 'control: what to do.' },
        text: { type: 'string', description: 'hint: steering for the planner.' },
        path: { type: 'string', description: 'report: output file, default assessment-<id>.md in the working directory.' },
        model: { type: 'string', description: 'create: model override for this task planner/worker calls.' },
        language: { type: 'string', description: 'create: event-text language (zh/en).' },
        preview: { type: 'boolean', description: 'report: return the markdown instead of writing a file.' },
      },
    }
  }
  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    const manager = context.assessments
    if (!manager) return failure('assessment tasks unavailable in this context')
    const sessionId = context.sessionId || context.taskId
    // Every call refreshes the model plumbing bound to this session, which is
    // what lets a paused task resume later — even after a restart.
    const runtime = {
      llm: context.backgroundLlm || context.llm!,
      ...(context.runSubAgent ? { subagent: context.runSubAgent } : {}),
    }
    manager.rememberRuntime(sessionId, runtime)
    try {
      switch (args.action) {
        case 'create': {
          const state = await manager.create({
            objective: String(args.objective || ''),
            targets: Array.isArray(args.targets) ? args.targets.map(String).filter(Boolean) : [],
            ...(args.coverage != null ? { coverage: Number(args.coverage) } : {}),
            ...(args.rounds != null ? { rounds: Number(args.rounds) } : {}),
            ...(args.intents != null ? { intents: Number(args.intents) } : {}),
            ...(args.concurrency != null ? { concurrency: Number(args.concurrency) } : {}),
            ...(args.timeoutMs != null ? { timeoutMs: Number(args.timeoutMs) } : {}),
            ...(args.model ? { model: String(args.model) } : {}),
            ...(args.language ? { locale: String(args.language) } : {}),
          }, sessionId, runtime)
          return success({
            id: state.id, status: state.status, objective: state.objective,
            goals: state.goalTexts, scope: state.scope, constraints: state.constraints,
            note: 'the task is running in the background — assessments(action:"get", id) to follow it',
          })
        }
        case 'list':
          return success({ tasks: await manager.list(sessionId) })
        case 'get':
          return success(await manager.get(String(args.id || '')))
        case 'control': {
          const state = await manager.control(String(args.id || ''), String(args.operation || ''))
          return success({ id: state.id, status: state.status, stopped: state.stopped, error: state.error })
        }
        case 'hint': {
          await manager.hint(String(args.id || ''), String(args.text || ''))
          return success({ delivered: true })
        }
        case 'trace': {
          const steps = manager.trace(String(args.id || ''), String(args.intent_id || ''))
          return success({ steps })
        }
        case 'report': {
          const result = await manager.report(String(args.id || ''), args.path ? String(args.path) : undefined, context.cwd || process.cwd(), args.preview === true)
          if (result.markdown != null) return success({ markdown: result.markdown, findings: result.findings, pct: result.pct })
          return success({ ...result, note: 'call report_artifacts with this path so the user gets a clickable link' })
        }
        default:
          throw new Error('action must be create, list, get, control, hint or report')
      }
    } catch (error) {
      return failure(error)
    }
  }
}
