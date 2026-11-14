// A planning run ends with a plan, not with code.
//
// The plan used to arrive as ordinary assistant text, which meant the UI could
// not tell "here is a plan, ready to build" from "here is a paragraph about a
// plan", and the user had to copy it into a new task by hand. This tool is the
// handoff point: the model submits the finished plan once, the UI gets a card
// with a Build button, and the plan text is what the build task starts from.

import { Tool, type ToolContext, type ToolResult } from './types.js';
import { success, failure } from './helpers.js';
import { taskRecorder } from '../task/records.js';
import { PLAN_SUFFIX } from '../sandbox/policy.js';
import { planVerdict, reviewPlan, type PlanReview } from '../agent/plan_review.js';
import { reviewOptions } from '../agent/plan_review_options.js';

export interface PlanRecord {
  title: string;
  markdown: string;
  steps: number;
  /** Sections a thorough plan usually has and this one does not. Advisory only. */
  missing: string[];
  demoHtml?: string;
  createdAt: number;
}

const plans = new Map<string, PlanRecord>();

export function planFor(taskId: string): PlanRecord | undefined {
  return plans.get(taskId);
}

export function clearPlan(taskId: string): void {
  plans.delete(taskId);
}

// Each entry is "what this section is for" plus the words that indicate it.
// Both languages because a plan may be written in either.
const SECTIONS: Array<{ id: string; test: RegExp }> = [
  { id: 'problem', test: /(^|\n)#{1,6}.*(problem|context|why|问题|背景|现状)/i },
  { id: 'approach', test: /(^|\n)#{1,6}.*(approach|design|plan|方案|思路|设计)/i },
  { id: 'steps', test: /(^|\n)#{1,6}.*(step|change|implementation|步骤|改动|实施)/i },
  { id: 'verification', test: /(^|\n)#{1,6}.*(verif|test|check|验证|测试)/i },
  { id: 'risks', test: /(^|\n)#{1,6}.*(risk|rollback|风险|回滚)/i },
];

function countSteps(markdown: string): number {
  // Numbered items anywhere in the document. Rough, but it is a display number,
  // not a contract.
  return (markdown.match(/^\s*\d+[.)]\s+\S/gm) || []).length;
}

function firstHeading(markdown: string): string {
  const match = /^\s*#\s+(.+)$/m.exec(markdown);
  return match ? match[1].trim().slice(0, 120) : '';
}

export class PlanTool extends Tool {
  get name(): string {
    return 'plan';
  }

  get description(): string {
    return 'Submit the finished implementation plan for this planning run. Call it once, at the end, instead of finish. The user gets a card with a Build button that starts an execution task from this plan, so write it for an executor with no context: exact file paths, exact commands, verification steps, risks and rollback. A plan reviewer may reject the plan for falling below the quality bar; when it does, the reply lists the objections — address them and call this again with the revised plan.';
  }

  get parameters(): Record<string, any> {
    return {
      type: 'object',
      properties: {
        markdown: { type: 'string', description: 'The whole plan as Markdown, starting with a level-1 heading.' },
        title: { type: 'string', description: 'Short imperative title. Defaults to the level-1 heading.' },
        demo_html: {
          type: 'string',
          description: 'Optional self-contained HTML demo of the intended result (layout, flow, UI). Rendered in a sandboxed preview next to the plan.',
        },
      },
      required: ['markdown'],
    };
  }

  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    const markdown = String(args.markdown || '').trim();
    if (markdown.length < 80) {
      return failure('the plan is too short to be actionable — write the problem, the steps with file paths, and how to verify');
    }
    const missing = SECTIONS.filter((section) => !section.test.test(markdown)).map((section) => section.id);
    const record: PlanRecord = {
      title: String(args.title || firstHeading(markdown) || 'Plan').slice(0, 160),
      markdown,
      steps: countSteps(markdown),
      missing,
      ...(args.demo_html ? { demoHtml: String(args.demo_html) } : {}),
      createdAt: Date.now(),
    };

    // The plan is checked before it is recorded as ready. A plan below the
    // threshold goes back to the planner with the reviewer's objections rather
    // than being published for a Build the user would regret.
    const outcome = await reviewPlanIfConfigured(record, context);
    if (outcome?.review && planVerdict(outcome.review, outcome.threshold) === 'revise') {
      const { review, threshold } = outcome;
      return failure(
        [
          `the plan did not reach the quality threshold (${review.score} < ${threshold}). Fix these and submit again:`,
          ...review.objections.map((item) => `- [${item.severity}] ${item.where}: ${item.problem}${item.suggestion ? ` → ${item.suggestion}` : ''}`),
          review.revise ? `\n${review.revise}` : '',
        ].filter(Boolean).join('\n'),
      );
    }

    plans.set(context.taskId, record);
    // The plan also lands on disk. A plan that exists only in memory is gone
    // when the process is, and the file is what makes it reviewable later,
    // diffable in git, and buildable from the file manager.
    const saved = await savePlan(context.cwd, record);

    void taskRecorder
      .record({
        task_id: context.taskId,
        caller_id: 'agent',
        session_id: context.sessionId || '',
        kind: 'agent',
        state: 'running',
        progress: 100,
        phase: 'done',
        note: `plan ready: ${record.title}`,
        plan: JSON.stringify({ title: record.title, markdown, steps: record.steps, demo_html: record.demoHtml || '' }),
      })
      .catch(() => undefined);

    return success({
      accepted: true,
      title: record.title,
      steps: record.steps,
      ...(saved ? { file: saved } : {}),
      ...(missing.length ? { missing_sections: missing, note: 'the plan can still be built; add these sections if they change the approach' } : {}),
    });
  }
}

/**
 * Review a plan when a threshold and a model are available.
 *
 * Returns null when there is nothing to do, which keeps the "no review
 * configured" path free — the plan proceeds exactly as it did before this
 * existed. A review that could not run comes back degraded and passes; see
 * plan_review.ts.
 */
async function reviewPlanIfConfigured(
  record: PlanRecord,
  context: ToolContext,
): Promise<{ review?: PlanReview; threshold: number } | null> {
  const { threshold, userIntent, constraints } = reviewOptions(context.options);
  if (threshold <= 0) return null;
  if (!context.llm) return null;
  const review = await reviewPlan(
    { userIntent: userIntent || record.title, plan: record.markdown, constraints },
    context.llm,
  );
  return { review, threshold };
}

/**
 * Write the plan beside the project as `<slug>.plan.md`.
 *
 * `.plan.md` is the extension the whole system looks for: the file manager
 * offers Build on these files, and a planning task's sandbox may write no
 * other kind of file. The name comes from the title so a directory of plans
 * reads like a list of what was decided.
 */
async function savePlan(cwd: string, record: PlanRecord): Promise<string> {
  try {
    const fs = await import('fs/promises');
    const path = await import('path');
    const dir = path.join(cwd || process.cwd(), '.0kay', 'plans');
    await fs.mkdir(dir, { recursive: true });
    const slug = record.title
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'plan';
    const file = path.join(dir, `${slug}${PLAN_SUFFIX}`);
    const header = `<!-- 0kay plan · ${new Date(record.createdAt).toISOString()} · ${record.steps} steps -->\n\n`;
    await fs.writeFile(file, header + record.markdown + '\n', 'utf8');
    return file;
  } catch {
    // A plan that could not be written is still a plan; the card and the
    // build button work off the record, so this is not worth failing over.
    return '';
  }
}
