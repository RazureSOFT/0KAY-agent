// How done the task is, in the model's own words.
//
// The UI can say "running", but not "60% done, currently running the test
// suite". Only the model knows that, so this tool is a self-report: it takes an
// estimate, a one-line note about the current action, and an optional checklist.
//
// Two rules keep the self-report honest without being annoying:
//   - it can only move backwards a little (10 points). Models do revise their
//     estimate, but a jump from 80 back to 20 usually means the number was made
//     up rather than measured;
//   - the value is clamped to 0..100 and the tool reports what it accepted, so
//     the model sees the correction instead of believing its own number.

import { Tool, type ToolContext, type ToolResult } from './types.js';
import { success, clamp } from './helpers.js';
import { taskRecorder } from '../task/records.js';

export type ProgressPhase = 'thinking' | 'acting' | 'waiting' | 'done' | 'failed';

export interface ProgressItem {
  title: string;
  status: 'pending' | 'doing' | 'done' | 'blocked';
}

export interface ProgressState {
  percent: number;
  phase: ProgressPhase;
  note: string;
  items: ProgressItem[];
  updatedAt: number;
}

const PHASES: ProgressPhase[] = ['thinking', 'acting', 'waiting', 'done', 'failed'];
const STATUSES: ProgressItem['status'][] = ['pending', 'doing', 'done', 'blocked'];

/** How far a self-report may fall in one update. */
const MAX_REGRESSION = 10;

const states = new Map<string, ProgressState>();

export function progressFor(taskId: string): ProgressState | undefined {
  return states.get(taskId);
}

export function clearProgress(taskId: string): void {
  states.delete(taskId);
}

/**
 * Called by the loop when a task really finishes, so the bar does not sit at 80
 * forever because the model forgot one last update. A task that reached `finish`
 * is complete by definition — the delivery gate decides whether the result is
 * acceptable, not whether the work stopped.
 */
export async function completeProgress(taskId: string, sessionId: string, note = 'done'): Promise<void> {
  if (!taskId) return;
  const previous = states.get(taskId);
  states.set(taskId, {
    percent: 100,
    phase: 'done',
    note,
    items: previous?.items ?? [],
    updatedAt: Date.now(),
  });
  await taskRecorder
    .record({
      task_id: taskId,
      caller_id: 'agent',
      session_id: sessionId || '',
      kind: 'agent',
      state: 'running',
      progress: 100,
      phase: 'done',
      note,
    })
    .catch(() => undefined);
}

function normalizeItems(raw: unknown): ProgressItem[] {
  if (!Array.isArray(raw)) return [];
  const out: ProgressItem[] = [];
  for (const entry of raw.slice(0, 20)) {
    const item = entry as any;
    const title = String(item?.title || item?.content || '').trim();
    if (!title) continue;
    const status = STATUSES.includes(item?.status) ? (item.status as ProgressItem['status']) : 'pending';
    out.push({ title: title.slice(0, 120), status });
  }
  return out;
}

export class ProgressTool extends Tool {
  get name(): string {
    return 'progress';
  }

  get description(): string {
    return 'Report how complete the task is (0-100) and what you are doing right now. Call it once when you start, after each meaningful step, and once when you finish. The user sees this as a progress bar, so keep the note short and concrete ("running the test suite").';
  }

  get parameters(): Record<string, any> {
    return {
      type: 'object',
      properties: {
        percent: { type: 'number', description: 'How complete the whole task is, 0-100. Be honest: 100 means everything asked for is done and verified.' },
        note: { type: 'string', description: 'One short line describing the current action, in the user language. Shown next to the bar.' },
        phase: {
          type: 'string',
          enum: PHASES,
          description: 'thinking = planning or reading; acting = running tools; waiting = blocked on the user; done = finished; failed = cannot continue.',
        },
        items: {
          type: 'array',
          description: 'Optional checklist. Replaces the previous one.',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              status: { type: 'string', enum: STATUSES },
            },
            required: ['title'],
          },
        },
      },
      required: ['percent'],
    };
  }

  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    const key = context.taskId || 'default';
    const previous = states.get(key);
    const requested = clamp(args.percent, previous?.percent ?? 0, 0, 100);

    let accepted = requested;
    let corrected = '';
    if (previous && requested < previous.percent - MAX_REGRESSION) {
      accepted = Math.max(0, previous.percent - MAX_REGRESSION);
      corrected = `estimate dropped from ${previous.percent} to ${requested}; accepted ${accepted}. Lower the number gradually if the task really got bigger.`;
    }

    const phase: ProgressPhase = PHASES.includes(args.phase) ? args.phase : (previous?.phase ?? 'acting');
    const note = String(args.note || '').trim().slice(0, 200);
    const items = Array.isArray(args.items) ? normalizeItems(args.items) : (previous?.items ?? []);

    const state: ProgressState = { percent: accepted, phase, note, items, updatedAt: Date.now() };
    states.set(key, state);

    // The UI reads this off the task row, so it has to reach Core. A failure to
    // report is not a task failure — the work still happened.
    void taskRecorder
      .record({
        task_id: context.taskId,
        caller_id: 'agent',
        session_id: context.sessionId || '',
        kind: 'agent',
        state: 'running',
        progress: accepted,
        phase,
        note,
      })
      .catch(() => undefined);

    return success({
      percent: accepted,
      phase,
      note,
      items,
      ...(corrected ? { correction: corrected } : {}),
    });
  }
}
