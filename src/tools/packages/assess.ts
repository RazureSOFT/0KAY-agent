import { Tool } from '../types.js'
import type { ToolContext, ToolResult } from '../types.js'
import { success, failure } from '../helpers.js'
import { RetestTool } from './retest.js'

// RECON's task system as one tool: background assessment tasks that run the
// RECON loop on the session graph, outliving the call that started them. The
// panel drives this same tool over /api/run, which is why it is in the
// always-safe set — the user pressing "start" in the panel is the approval.

export class AssessmentsTool extends Tool {
  get name(): string { return 'assessments'; }
  get description(): string {
    return [
      'Long-running assessment tasks: create starts the RECON loop (goals phase, planner, workers) in the background on the session recon graph — it keeps running after this call returns.',
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
        action: { type: 'string', enum: ['create', 'list', 'get', 'control', 'hint', 'say', 'trace', 'report', 'findings', 'retests', 'retest'] },
        kind: { type: 'string', enum: ['recon', 'engineering', 'craft'], description: 'create: what kind of assessment. recon proves facts about targets (default); engineering changes a code base or a deployed system; craft studies something observable, rebuilds it, then compares and refines until they match.' },
        permission_mode: { type: 'string', enum: ['normal', 'full_access'], description: 'create: what this task\'s workers may do without asking. full_access skips approval for dangerous tools; the mode sticks to the task, so a resume does not inherit the caller\'s current setting.' },
        intent_id: { type: 'string', description: 'trace: the worker intent node id.' },
        objective: { type: 'string', description: 'create: the objective, in one sentence.' },
        targets: { type: 'array', items: { type: 'string' }, description: 'create: in-scope assets — also the coverage denominator.' },
        coverage: { type: 'integer', minimum: 0, maximum: 100, description: 'create: refuse to prove goals below this percent of scope tested.' },
        rounds: { type: 'integer', minimum: 1, maximum: 48 },
        intents: { type: 'integer', minimum: 1, maximum: 120 },
        concurrency: { type: 'integer', minimum: 1, maximum: 6 },
        timeoutMs: { type: 'integer', minimum: 10000, maximum: 3600000 },
        id: { type: 'string', description: 'get/control/hint/report/findings: the task id.' },
        finding_id: { type: 'string', description: 'retests/retest: the durable finding row id (from findings).' },
        all: { type: 'boolean', description: 'list: every session\'s tasks, not just this one. The tasks tab uses it so a task does not disappear when the conversation changes.' },
        operation: { type: 'string', enum: ['pause', 'resume', 'restart', 'cancel', 'delete'], description: 'control: what to do. restart starts a finished/cancelled/failed task again with the same objective and scope.' },
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
    // A task carries its own permission mode; the loop overlays it per worker call
    // through `subagentOverrides`. The runner itself stays the same object so a
    // resume does not need a new closure.
    const runtime = {
      llm: context.backgroundLlm || context.llm!,
      ...(context.runSubAgent
        ? {
            subagent: context.runSubAgent,
            ...(context.runSubAgentWith
              ? { subagentWith: (prompt: string, agentType: string | undefined, options: Record<string, string>) => context.runSubAgentWith!(prompt, agentType, options) }
              : {}),
          }
        : {}),
    }
    manager.rememberRuntime(sessionId, runtime)
    try {
      switch (args.action) {
        case 'create': {
          const state = await manager.create({
            ...(args.kind === 'engineering' ? { kind: 'engineering' as const } : {}),
            ...(args.kind === 'craft' ? { kind: 'craft' as const } : {}),
            ...(args.permission_mode === 'full_access' ? { permissionMode: 'full_access' as const } : {}),
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
          // `all` widens the read to every session. The tasks tab asks for it;
          // a caller that wants one session's tasks keeps the default.
          return success({ tasks: await manager.list(args.all === true ? undefined : sessionId) })
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
        case 'say': {
          // A direct message to the running agent, not a graph hint: it lands in
          // the constraints the next planning round already re-reads.
          const outcome = await manager.say(String(args.id || ''), String(args.text || ''))
          return success({
            ...outcome,
            note: outcome.delivered
              ? 'delivered to the live run — it takes effect on the next round'
              : 'no live run; the message is kept and folded in when the task resumes',
          })
        }
        case 'trace': {
          const steps = manager.trace(String(args.id || ''), String(args.intent_id || ''))
          return success({ steps })
        }
        // The task page reads findings as rows, not graph nodes: a row is what a
        // retest can point at, and it survives the run that produced it.
        case 'findings':
          return success({ findings: manager.findings.forTask(String(args.id || '')) })
        case 'retests': {
          const findingId = String(args.finding_id || '').trim()
          if (!findingId) return failure('finding_id is required for retests')
          return success({ retests: manager.findings.forFinding(findingId) })
        }
        case 'retest': {
          // One call that starts and finishes: the caller is the agent asking for
          // the retest, so there is no queued state to poll. Delegated to the
          // retester tool so the verdict rules live in one place.
          const findingId = String(args.finding_id || '').trim()
          if (!findingId) return failure('finding_id is required for retest')
          const retester = new RetestTool()
          return retester.execute({ action: 'start', finding_id: findingId, notes: args.notes }, context)
        }
        case 'report': {
          const result = await manager.report(String(args.id || ''), args.path ? String(args.path) : undefined, context.cwd || process.cwd(), args.preview === true)
          if (result.markdown != null) return success({ markdown: result.markdown, findings: result.findings, pct: result.pct })
          return success({ ...result, note: 'call report_artifacts with this path so the user gets a clickable link' })
        }
        default:
          throw new Error('action must be create, list, get, control, hint, say or report')
      }
    } catch (error) {
      return failure(error)
    }
  }
}
