import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { Tool } from '../types.js'
import type { ToolContext, ToolResult } from '../types.js'
import { success, failure } from '../helpers.js'
import { RetestTool } from './retest.js'
import {
  observeAll, checkAll, checkReportMarkdown, localUrlFor, summarizeObservation,
  type Observation, type CraftMode,
} from '../../analysis/craft/observe.js'
import { CraftProject } from '../../analysis/craft/project.js'

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
      'action=craft with operation=project|study|build|check|request|apply|ready|differences|artifacts|mode|threshold runs the four-stage Study → Build → Check → Ready loop on a craft task\'s own project (craft.json, capture/, app/, checks/, investigation.cany/, inbox/). study captures the original at 390/768/1280 once; check compares the rebuild there at every width, writes a "how alike" report with a mismatch list and difference images, and only reaches Ready when the score clears the threshold with no open change requests.',
      'action=observe / action=compare are the low-level measurement tools behind it: computed styles, real geometry, interaction states and a pixel-level screenshot diff with confidence and limitations.',
      'Caps: one running task per session, four overall. Prefer this over deep_scan when the work should be watchable and steerable.',
    ].join(' ')
  }
  get parameters(): Record<string, any> {
    return {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['create', 'list', 'get', 'control', 'hint', 'say', 'trace', 'report', 'findings', 'retests', 'retest', 'observe', 'compare', 'craft'] },
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
        url: { type: 'string', description: 'observe: the surface to read — a URL, or a local build path with the `local` flag.' },
        local: { type: 'boolean', description: 'observe/compare: treat `url` as a directory on disk instead of a URL.' },
        original_url: { type: 'string', description: 'compare: the original surface, when it is not `url`.' },
        rebuilt_url: { type: 'string', description: 'compare: the rebuild to measure against `original_url`.' },
        screenshot_dir: { type: 'string', description: 'observe: write a full-page screenshot per width here.' },
        all: { type: 'boolean', description: 'list: every session\'s tasks, not just this one. The tasks tab uses it so a task does not disappear when the conversation changes.' },
        operation: { type: 'string', enum: ['pause', 'resume', 'restart', 'cancel', 'delete', 'project', 'study', 'build', 'check', 'request', 'apply', 'ready', 'differences', 'artifacts', 'mode', 'threshold'], description: 'control: pause|resume|restart|cancel|delete. craft: project|study|build|check|request|apply|ready|differences|artifacts|mode|threshold — the four-stage Study → Build → Check → Ready loop on the task\'s own project directory.' },
        text: { type: 'string', description: 'hint: steering for the planner. craft(request): the change request text.' },
        craft_mode: { type: 'string', enum: ['clean_room', 'deep'], description: 'create: craft evidence mode (default clean_room = visible evidence only). craft(mode): change it on an existing project.' },
        craft_threshold: { type: 'number', minimum: 0, maximum: 100, description: 'create/craft(threshold): "how alike" required before Ready.' },
        mode: { type: 'string', enum: ['clean_room', 'deep'], description: 'craft(mode): clean_room or deep.' },
        threshold: { type: 'number', minimum: 0, maximum: 100, description: 'craft(threshold): new Ready threshold.' },
        note: { type: 'string', description: 'craft(build/ready): what changed, or why it was accepted.' },
        files: { type: 'array', items: { type: 'string' }, description: 'craft(build): files written in this round.' },
        applied_ids: { type: 'array', items: { type: 'string' }, description: 'craft(build/apply): inbox request ids handled in this round.' },
        tolerance: { type: 'number', minimum: 0, maximum: 255, description: 'craft(check): pixel tolerance for antialiasing.' },
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
            ...(args.craft_mode === 'deep' ? { craftMode: 'deep' as const } : {}),
            ...(args.craft_threshold != null ? { craftThreshold: Number(args.craft_threshold) } : {}),
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
        // Craft: read the surface, then measure the rebuild against it. The two
        // actions exist as a pair on purpose — a comparison without an
        // observation is a guess with a number attached. `craft` below is the
        // project-level loop; these two are the low-level measurement tools.
        case 'observe': {
          const target = String(args.url || '').trim()
          if (!target) return failure('url is required for observe')
          const url = args.local === true ? localUrlFor(target) : target
          const dir = args.screenshot_dir
            ? String(args.screenshot_dir)
            : await fs.mkdtemp(path.join(os.tmpdir(), '0kay-craft-observe-'))
          await fs.mkdir(dir, { recursive: true })
          const observations = await observeAll(url, {
            screenshotDir: dir,
            mode: args.mode === 'deep' ? 'deep' : 'clean_room',
          })
          const failed = observations.filter((row) => row.error)
          return success({
            url,
            captureDir: dir,
            widths: observations.map((row) => row.width),
            // Full observations carry hundreds of computed styles each; the
            // tool result only needs the evidence summary and the file paths.
            observations: observations.map(summarizeObservation),
            ...(failed.length ? { errors: failed.map((row) => ({ width: row.width, error: row.error })) } : {}),
            note: failed.length
              ? 'some widths could not be rendered — fix that before comparing, or the comparison will report a whole page as missing'
              : 'the surface was read at every comparison width',
          })
        }
        case 'compare': {
          const original = String(args.original_url || args.url || '').trim()
          const rebuilt = String(args.rebuilt_url || '').trim()
          if (!original || !rebuilt) return failure('original_url and rebuilt_url are both required for compare')
          const asLocal = args.local === true
          const root = await fs.mkdtemp(path.join(os.tmpdir(), '0kay-craft-compare-'))
          const beforeDir = path.join(root, 'original')
          const afterDir = path.join(root, 'rebuild')
          const checkDir = path.join(root, 'checks')
          for (const dir of [beforeDir, afterDir, checkDir]) await fs.mkdir(dir, { recursive: true })
          const observeOptions = { mode: (args.mode === 'deep' ? 'deep' : 'clean_room') as CraftMode }
          const before = await observeAll(asLocal ? localUrlFor(original) : original, { ...observeOptions, screenshotDir: beforeDir })
          const after = await observeAll(asLocal ? localUrlFor(rebuilt) : rebuilt, { ...observeOptions, screenshotDir: afterDir })
          const broken = [...before, ...after].filter((row) => row.error)
          if (broken.length) {
            return failure(`could not render ${broken.length} of the ${before.length + after.length} observations: ${broken[0].error}`)
          }
          const result = await checkAll(before, after, {
            checkDir,
            ...(args.tolerance != null ? { tolerance: Number(args.tolerance) } : {}),
          })
          const reportPath = path.join(checkDir, 'report.md')
          await fs.writeFile(reportPath, checkReportMarkdown(result))
          return success({
            original,
            rebuilt,
            captureDir: root,
            reportPath,
            // `similarity` stays the headline number callers already expect;
            // it is now the combined measurement rather than elements alone.
            similarity: result.overall,
            elementSimilarity: result.similarity,
            ...(result.pixelSimilarity !== undefined ? { pixelSimilarity: result.pixelSimilarity } : {}),
            comparisons: result.comparisons,
            checks: result.checks,
            confidence: result.confidence,
            limitations: result.limitations,
            // The count is what a person acts on; the score only sorts rounds.
            differenceCount: result.differenceCount,
          })
        }
        // The four-stage project loop. The root comes from the task ledger, not
        // from caller-supplied paths: a craft task owns exactly one project and
        // a resume finds the same study, checks and change requests.
        case 'craft': {
          const id = String(args.id || '').trim()
          if (!id) return failure('id is required for craft')
          const detail = await manager.get(id)
          const root = detail.state.craftRoot
          if (!root) return failure('this task has no craft project — create it with kind:"craft"')
          const project = await CraftProject.open(root)
          const op = String(args.operation || 'project')
          switch (op) {
            case 'project': {
              return success({
                ...(await project.summary()),
                differences: await project.differences(),
                artifacts: await project.artifacts(),
              })
            }
            case 'study': {
              const url = String(args.url || project.state.target || '').trim()
              if (!url) return failure('url is required for craft study')
              const study = await project.study(url, {
                ...(args.mode === 'deep' ? { mode: 'deep' as const } : {}),
                ...(args.timeoutMs != null ? { timeoutMs: Number(args.timeoutMs) } : {}),
              })
              return success({ id, operation: op, stage: project.state.stage, study })
            }
            case 'build': {
              const row = await project.build(
                String(args.note || ''),
                Array.isArray(args.files) ? args.files.map(String) : [],
                Array.isArray(args.applied_ids) ? args.applied_ids.map(String) : [],
              )
              return success({ id, operation: op, stage: project.state.stage, build: row })
            }
            case 'check': {
              const row = await project.check(args.rebuilt_url ? String(args.rebuilt_url) : undefined, {
                ...(args.tolerance != null ? { tolerance: Number(args.tolerance) } : {}),
                ...(args.timeoutMs != null ? { timeoutMs: Number(args.timeoutMs) } : {}),
              })
              return success({
                id, operation: op, stage: project.state.stage, check: row,
                differences: (await project.differences()).slice(0, 40),
              })
            }
            case 'request': {
              const text = String(args.text || '').trim()
              if (!text) return failure('text is required for craft request')
              const item = await project.request(text)
              return success({ id, operation: op, stage: project.state.stage, request: item })
            }
            case 'apply': {
              const ids = Array.isArray(args.applied_ids) ? args.applied_ids.map(String) : []
              if (!ids.length) return failure('applied_ids is required for craft apply')
              return success({ id, operation: op, applied: await project.apply(ids), pending: await project.pending() })
            }
            case 'ready': {
              await project.markReady(String(args.note || ''))
              return success({ id, operation: op, stage: project.state.stage, readyAt: project.state.readyAt })
            }
            case 'differences': {
              const differences = await project.differences()
              return success({ id, operation: op, differences, total: differences.length })
            }
            case 'artifacts':
              return success({ id, operation: op, artifacts: await project.artifacts() })
            case 'mode': {
              const mode: CraftMode = args.mode === 'deep' ? 'deep' : 'clean_room'
              await project.setMode(mode)
              return success({ id, operation: op, mode: project.state.mode })
            }
            case 'threshold': {
              if (args.threshold == null) return failure('threshold is required for craft threshold')
              await project.setThreshold(Number(args.threshold))
              return success({ id, operation: op, threshold: project.state.threshold })
            }
            default:
              return failure(`unknown craft operation: ${op}`)
          }
        }
        case 'report': {
          const result = await manager.report(String(args.id || ''), args.path ? String(args.path) : undefined, context.cwd || process.cwd(), args.preview === true)
          if (result.markdown != null) return success({ markdown: result.markdown, findings: result.findings, pct: result.pct })
          return success({ ...result, note: 'call report_artifacts with this path so the user gets a clickable link' })
        }
        default:
          throw new Error('action must be create, list, get, control, hint, say, report, observe, compare or craft')
      }
    } catch (error) {
      return failure(error)
    }
  }
}
