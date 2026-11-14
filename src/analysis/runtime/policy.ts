/**
 * Request interception rules and outbound notices.
 *
 * A rule is a decision that has already been made, so it is evaluated before
 * an approval prompt: asking someone to approve what a rule already decided
 * makes the rule optional. There is deliberately no built-in dangerous-command
 * table — a hidden policy nobody can read or change is wrong for somebody.
 */

export type InterceptAction = 'allow' | 'block' | 'rewrite';
export type Verdict = InterceptAction | 'prompt';

export interface RuleMatch {
  method?: string;
  host?: string;
  /** Matches the tail of the URL path, e.g. "/admin" or ".env". */
  pathEndsWith?: string;
  /** Substring of the flattened request (url + body + header names/values). */
  contains?: string;
}

export interface InterceptRule {
  id: string;
  action: InterceptAction;
  match: RuleMatch;
  /** For `rewrite`: replacements applied to the outgoing request. */
  setHeaders?: Record<string, string>;
  setBody?: string;
  note?: string;
  enabled?: boolean;
}

export interface InterceptRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface Decision {
  verdict: Verdict;
  ruleId: string | null;
  note: string;
  /** Present for `rewrite`; never mutates the caller's request. */
  request?: InterceptRequest;
}

/**
 * Flatten nested values, including a JSON array written as a string. A rule
 * against `rm -rf` must also match the array form `["rm","-rf","/"]`; matching
 * only the serialized text would let a command through its own rule.
 */
export function flattenText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if ((trimmed.startsWith('[') && trimmed.endsWith(']')) || (trimmed.startsWith('{') && trimmed.endsWith('}'))) {
      try { return flattenText(JSON.parse(trimmed)); } catch { return value; }
    }
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(flattenText).join(' ');
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, nested]) => `${key} ${flattenText(nested)}`).join(' ');
  }
  return '';
}

export function searchableText(request: InterceptRequest): string {
  return [request.method, request.url, flattenText(request.body), flattenText(request.headers)]
    .filter(Boolean).join(' ');
}

export function matchesRule(rule: InterceptRule, request: InterceptRequest): boolean {
  if (rule.enabled === false) return false;
  const m = rule.match || {};
  if (m.method && String(m.method).toUpperCase() !== String(request.method || '').toUpperCase()) return false;
  if (m.host && !request.url.toLowerCase().includes(String(m.host).toLowerCase())) return false;
  if (m.pathEndsWith) {
    let pathname = request.url;
    try { pathname = new URL(request.url).pathname; } catch { /* not a URL: use as-is */ }
    if (!pathname.endsWith(String(m.pathEndsWith))) return false;
  }
  if (m.contains && !searchableText(request).toLowerCase().includes(String(m.contains).toLowerCase())) return false;
  return true;
}

export class RuleSet {
  private rules: InterceptRule[] = [];
  private seq = 0;

  constructor(rules: InterceptRule[] = []) {
    for (const rule of rules) this.rules.push({ ...rule });
  }

  add(rule: Omit<InterceptRule, 'id'> & { id?: string }): InterceptRule {
    const added: InterceptRule = { ...rule, id: rule.id || `rule_${++this.seq}` };
    this.rules.push(added);
    return added;
  }

  remove(id: string): boolean {
    const before = this.rules.length;
    this.rules = this.rules.filter((rule) => rule.id !== id);
    return this.rules.length !== before;
  }

  list(): InterceptRule[] { return this.rules.map((rule) => ({ ...rule })); }

  /**
   * Blocks win over allows, and are checked first: someone who wrote both for
   * the same request meant to block it. An unmatched request goes to `prompt`
   * — silence here would turn "no rule" into a silent allow.
   */
  evaluate(request: InterceptRequest): Decision {
    const blocks = this.rules.filter((rule) => rule.action === 'block' && matchesRule(rule, request));
    if (blocks.length) {
      return { verdict: 'block', ruleId: blocks[0].id, note: blocks[0].note || 'matched a block rule' };
    }
    for (const rule of this.rules) {
      if (!matchesRule(rule, request)) continue;
      if (rule.action === 'rewrite') {
        const rewritten: InterceptRequest = {
          method: request.method,
          url: request.url,
          headers: { ...(request.headers || {}), ...(rule.setHeaders || {}) },
          body: rule.setBody !== undefined ? rule.setBody : request.body,
        };
        return { verdict: 'rewrite', ruleId: rule.id, note: rule.note || 'matched a rewrite rule', request: rewritten };
      }
      return { verdict: 'allow', ruleId: rule.id, note: rule.note || 'matched an allow rule' };
    }
    return { verdict: 'prompt', ruleId: null, note: 'no rule matched; approval required' };
  }

  /**
   * Optional model fallback for requests no rule matched. An unparseable or
   * failing judge returns `prompt`, never `allow`: a model that cannot answer
   * is not an approval.
   */
  async judge(
    request: InterceptRequest,
    ask?: (question: string) => Promise<string | null>,
  ): Promise<Decision> {
    const decided = this.evaluate(request);
    if (decided.verdict !== 'prompt' || !ask) return decided;
    let answer: string | null = null;
    try {
      answer = await ask(`Should this request be allowed? Reply with exactly allow or deny.\n${searchableText(request)}`);
    } catch {
      answer = null;
    }
    const word = (answer || '').trim().toLowerCase();
    if (/^deny\b|^block\b/.test(word)) {
      return { verdict: 'block', ruleId: null, note: 'judge denied the request' };
    }
    if (/^allow\b/.test(word)) {
      return { verdict: 'allow', ruleId: null, note: 'judge allowed the request' };
    }
    return { verdict: 'prompt', ruleId: null, note: 'judge gave no usable answer; approval required' };
  }
}

export type NoticeLevel = 'info' | 'warn' | 'error';

export interface NoticeInput {
  level?: NoticeLevel;
  title: string;
  body?: string;
  channel?: string;
}

export interface Notice {
  id: string;
  at: number;
  level: NoticeLevel;
  title: string;
  body: string;
  channel: string;
  delivered: boolean;
  error?: string;
  duplicateOf?: string;
}

/**
 * Notices deduplicate within a window and are rate limited. A delivery failure
 * is recorded on the notice itself: a notification system that reports success
 * because it wrote a line to its own queue is lying about the outside world.
 */
export class Notifier {
  private rows: Notice[] = [];
  private seq = 0;
  private lastByKey = new Map<string, number>();
  constructor(
    private readonly options: {
      now?: () => number;
      max?: number;
      dedupeMs?: number;
      ratePerMinute?: number;
    } = {},
  ) {}

  async send(
    input: NoticeInput,
    deliver?: (notice: Notice) => void | Promise<void>,
  ): Promise<Notice> {
    const now = (this.options.now || Date.now)();
    const notice: Notice = {
      id: `nt_${++this.seq}`,
      at: now,
      level: input.level || 'info',
      title: String(input.title || ''),
      body: String(input.body || ''),
      channel: String(input.channel || 'log'),
      delivered: false,
    };
    const key = `${notice.channel}|${notice.level}|${notice.title}|${notice.body}`;
    const window = this.options.dedupeMs ?? 60_000;
    const last = this.lastByKey.get(key);
    if (last != null && now - last < window) {
      notice.duplicateOf = `nt_${this.seq - 1}`;
      notice.error = 'suppressed as a duplicate';
      this.push(notice);
      return notice;
    }
    const rate = this.options.ratePerMinute ?? 30;
    const recent = this.rows.filter((row) => now - row.at < 60_000 && row.delivered).length;
    if (recent >= rate) {
      notice.error = `rate limit reached (${rate}/min)`;
      this.push(notice);
      return notice;
    }
    if (!deliver) {
      notice.error = 'no delivery channel configured; recorded locally only';
      this.push(notice);
      return notice;
    }
    this.lastByKey.set(key, now);
    try {
      await deliver(notice);
      notice.delivered = true;
    } catch (error) {
      notice.error = error instanceof Error ? error.message : String(error);
    }
    this.push(notice);
    return notice;
  }

  private push(notice: Notice): void {
    this.rows.push(notice);
    const max = Math.max(1, this.options.max ?? 500);
    if (this.rows.length > max) this.rows.splice(0, this.rows.length - max);
  }

  list(level?: NoticeLevel): Notice[] {
    return this.rows.filter((row) => !level || row.level === level).slice().reverse();
  }

  stats(): { total: number; delivered: number; failed: number; suppressed: number } {
    return {
      total: this.rows.length,
      delivered: this.rows.filter((row) => row.delivered).length,
      failed: this.rows.filter((row) => !row.delivered && !row.duplicateOf).length,
      suppressed: this.rows.filter((row) => !!row.duplicateOf).length,
    };
  }
}
