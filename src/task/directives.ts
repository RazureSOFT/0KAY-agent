import { randomUUID } from 'node:crypto';

// Agent→UI side effects have one road out of the agent process, and it is the
// same road approvals and questions travel: the agent queues a directive, core
// collects it on its next inbox poll, and the UI reacts. Titles and toasts are
// cosmetics — they queue, they never block, and a queue that outgrows this cap
// drops its oldest entries rather than growing without bound.

export type SessionDirectiveKind = 'title' | 'toast';

export interface SessionDirective {
  id: string;
  session_id: string;
  kind: SessionDirectiveKind;
  /** kind=title: the new session title. */
  title?: string;
  /** kind=toast: what the UI should say. */
  text?: string;
  /** kind=toast: info | success | warning | error. */
  level?: string;
  created_at: string;
}

const MAX_PENDING = 50;

export class SessionDirectives {
  private pending = new Map<string, SessionDirective>();

  add(directive: Omit<SessionDirective, 'id' | 'created_at'> & { id?: string }): SessionDirective {
    while (this.pending.size >= MAX_PENDING) {
      const oldest = this.pending.keys().next().value;
      if (!oldest) break;
      this.pending.delete(oldest);
    }
    const entry: SessionDirective = {
      id: directive.id || randomUUID(),
      session_id: directive.session_id || '',
      kind: directive.kind,
      ...(directive.title ? { title: directive.title } : {}),
      ...(directive.text ? { text: directive.text } : {}),
      ...(directive.level ? { level: directive.level } : {}),
      created_at: new Date().toISOString(),
    };
    this.pending.set(entry.id, entry);
    return entry;
  }

  list(sessionId = ''): SessionDirective[] {
    return [...this.pending.values()].filter((entry) => !sessionId || entry.session_id === sessionId);
  }

  /** Remove collected directives; returns how many were actually dropped. */
  ack(ids: string[]): number {
    let removed = 0;
    for (const id of ids || []) {
      if (this.pending.delete(id)) removed += 1;
    }
    return removed;
  }

  get size(): number {
    return this.pending.size;
  }
}
