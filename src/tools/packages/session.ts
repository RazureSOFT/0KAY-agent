import { Tool } from '../types.js';
import type { ToolContext, ToolResult } from '../types.js';
import { success, failure } from '../helpers.js';

// The session-UI tools: name the session the way the work actually went, and
// surface one-line notices without waiting for the final answer. Both are
// cosmetics — they queue a directive that core collects on its next inbox poll
// (the same road approvals travel), so they never block and always land within
// a couple of seconds.

const LEVELS = ['info', 'success', 'warning', 'error'];

export class SessionTool extends Tool {
  get name(): string { return 'session'; }

  get description(): string {
    return [
      'Session cosmetics, applied in the UI within seconds.',
      'action=set_title titles the session after the work ("Fix login redirect loop"), not after the first message ("help"); call it once, early, when the task is clear.',
      'action=notify raises a one-line toast for the user (level info|success|warning|error) — use it for milestones of long-running work (assessment finished, build green), not for narration.',
    ].join(' ');
  }

  get parameters(): Record<string, any> {
    return {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['set_title', 'notify'] },
        title: { type: 'string', description: 'set_title: the session title, under 80 characters.' },
        text: { type: 'string', description: 'notify: one line, under 200 characters.' },
        level: { type: 'string', enum: LEVELS, description: 'notify: how it looks in the UI.' },
      },
    };
  }

  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    const directives = context.sessionDirectives;
    if (!directives) return failure('session directives unavailable in this context');
    const sessionId = context.sessionId || context.taskId || '';
    try {
      switch (args.action) {
        case 'set_title': {
          const title = String(args.title || '').trim().slice(0, 120);
          if (!title) return failure('title is required');
          directives.add({ session_id: sessionId, kind: 'title', title });
          return success({ session_title: title, applied: 'queued — the UI applies it within seconds' });
        }
        case 'notify': {
          const text = String(args.text || '').trim().slice(0, 200);
          if (!text) return failure('text is required');
          const level = LEVELS.includes(String(args.level)) ? String(args.level) : 'info';
          directives.add({ session_id: sessionId, kind: 'toast', text, level });
          return success({ notified: true, level });
        }
        default:
          throw new Error('action must be set_title or notify');
      }
    } catch (error) {
      return failure(error);
    }
  }
}
