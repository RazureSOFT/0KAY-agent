// An audit trail of what the agent tried to do, and rules that decide in advance.
//
// Two things were missing, and they are two halves of one question.
//
// The first is the record. Approvals already ask before a dangerous call, but an
// approval that is granted leaves no trace: "who let the agent run that command,
// and when" has no answer an hour later. Every gated call is now written down —
// allowed or refused, with the reason — so the question has an answer.
//
// The second is the rule. Approval is per-call and needs a human; a rule is
// decided once and applied forever. An operator who has decided that `rm -rf` is
// never acceptable should not have to answer the prompt every time, and an
// operator who knows a path is off limits wants that enforced without them
// watching. Rules are checked before approval, because a rule is a decision
// already made.
//
// Deliberately NOT hard-coded: no list of "dangerous commands" ships in this
// file. A built-in list is a policy nobody can see, disagree with, or update, and
// it is always wrong for somebody. Rules come from settings; the defaults are
// empty.
//
// The audit log is bounded and in memory. It answers "what happened this
// session", which is the question that gets asked; a durable, unbounded log is a
// different feature with different costs, and pretending the two are the same is
// how a log file grows without limit.

export type GuardVerdict = 'allow' | 'block';

export interface AuditEntry {
  /** Milliseconds since epoch. */
  at: number;
  tool: string;
  /** What the rule decided, when a rule was involved. */
  verdict: GuardVerdict;
  /** Why, in the operator's own terms, or empty when a rule allowed it by default. */
  reason: string;
  /** The rule that spoke, so a surprise can be traced to its source. */
  rule?: string;
  /** A short, redacted description of the call. Never the full argument text. */
  summary: string;
}

export interface GuardRule {
  /** Label shown in the audit entry. */
  name: string;
  /** Tool name this rule applies to; matched case-insensitively. `*` for any. */
  tool: string;
  /**
   * Match against the call's searchable text (the tool plus its argument values).
   * A substring match, because that is what an operator writes down: a pattern
   * language would be more precise and would be used by nobody.
   */
  contains?: string;
  /** When set, the rule only applies to calls whose path ends with this. */
  pathEndsWith?: string;
  verdict: GuardVerdict;
  reason: string;
}

export interface GuardDecision {
  verdict: GuardVerdict;
  reason: string;
  rule?: string;
}

/** How much of the argument text a summary may quote. */
const SUMMARY_CHARS = 160;

/**
 * Keys whose value is a container of credentials.
 *
 * Checking only the key's own name is not enough, and this was a real leak: a
 * call with `headers: { Authorization: "Bearer sk-live-…" }` produced an audit
 * entry quoting the whole header object, because `headers` contains none of the
 * words in the credential list. The container has to be named too.
 */
const CONTAINER_KEYS = /^(headers?|cookies?|auth|credentials?|env|environment|secrets?)$/i;
const SECRET_KEYS = /token|secret|password|passwd|api[_-]?key|apikey|authorization|cookie|bearer|session|private[_-]?key|credential/i;

/**
 * A one-line, redacted description of a call.
 *
 * Redaction is not decoration: the arguments of an `http_request` may carry an
 * Authorization header, and an audit log that leaks a token is worse than no
 * audit log. A container of credentials is replaced wholesale — inspecting its
 * members would mean guessing which of them are secret, and a miss writes the
 * secret down.
 */
export function summarizeCall(tool: string, args: Record<string, any> | undefined): string {
  if (!args) return tool;
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;
    if (SECRET_KEYS.test(key) || CONTAINER_KEYS.test(key)) {
      parts.push(`${key}=<redacted>`);
      continue;
    }
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    if (typeof text !== 'string') continue;
    parts.push(`${key}=${text}`);
  }
  const joined = parts.join(' ');
  // With nothing quotable left, the tool name is still more useful than an empty
  // line, which reads as "the log lost this entry".
  if (!joined) return tool;
  return joined.length > SUMMARY_CHARS ? `${joined.slice(0, SUMMARY_CHARS)}…` : joined;
}

/**
 * The text a rule matches against.
 *
 * Lower-cased and joined so one `contains` can catch a command in any argument,
 * whichever field the caller happened to use.
 *
 * Array elements are joined with a space rather than JSON-serialised, because a
 * command passed as `["rm", "-rf", "/"]` has to match a rule written as
 * `rm -rf` — and `JSON.stringify` gives `["rm","-rf","/"]`, in which that
 * substring does not appear. This was a real miss: the rule engine reported no
 * match for the exact command it was written to catch.
 */
export function searchableText(tool: string, args: Record<string, any> | undefined): string {
  const values: string[] = [];
  const flatten = (value: unknown, depth: number): void => {
    if (depth > 6 || value === undefined || value === null) return;
    if (typeof value === 'string') {
      values.push(value);
      return;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      values.push(String(value));
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) flatten(item, depth + 1);
      return;
    }
    if (typeof value === 'object') {
      for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        // The keys carry meaning too — a rule like "no writes to .env" may name a
        // field rather than a value.
        values.push(key);
        flatten(nested, depth + 1);
      }
    }
  };
  flatten(args, 0);
  return [tool, ...values].join(' ').toLowerCase();
}

/** A path-ish argument, for `pathEndsWith`. */
function candidatePath(args: Record<string, any> | undefined): string {
  if (!args) return '';
  for (const key of ['filePath', 'path', 'file', 'target', 'out']) {
    const value = args[key];
    if (typeof value === 'string' && value) return value.replace(/\\/g, '/');
  }
  return '';
}

/**
 * Does a rule apply to this call?
 *
 * An empty rule — no `contains` and no `pathEndsWith` — matches every call with
 * that tool, which is how an operator writes "never let this tool run".
 */
export function ruleMatches(rule: GuardRule, tool: string, args: Record<string, any> | undefined): boolean {
  if (rule.tool && rule.tool !== '*' && rule.tool.toLowerCase() !== tool.toLowerCase()) return false;
  if (rule.contains) {
    if (!searchableText(tool, args).includes(rule.contains.toLowerCase())) return false;
  }
  if (rule.pathEndsWith) {
    const path = candidatePath(args);
    if (!path || !path.toLowerCase().endsWith(rule.pathEndsWith.replace(/\\/g, '/').toLowerCase())) return false;
  }
  return true;
}

/**
 * The first blocking rule that matches, or a default allow.
 *
 * Blocking rules are checked before allowing ones so that a broad allow cannot
 * silently override a specific block — an operator who writes both meant the
 * block, and the other order would quietly do the opposite.
 *
 * Among blocking rules the FIRST that matches wins, which is why the reason
 * names it: a decision nobody can trace back to a rule is a decision that
 * cannot be fixed.
 */
export function evaluateRules(
  rules: GuardRule[],
  tool: string,
  args: Record<string, any> | undefined,
): GuardDecision {
  for (const rule of rules) {
    if (rule.verdict !== 'block') continue;
    if (ruleMatches(rule, tool, args)) {
      return { verdict: 'block', reason: rule.reason || `blocked by rule "${rule.name}"`, rule: rule.name };
    }
  }
  for (const rule of rules) {
    if (rule.verdict !== 'allow') continue;
    if (ruleMatches(rule, tool, args)) {
      return { verdict: 'allow', reason: rule.reason || `allowed by rule "${rule.name}"`, rule: rule.name };
    }
  }
  return { verdict: 'allow', reason: '' };
}

/** Parse the rules an operator saved as JSON, dropping anything malformed. */
export function parseRules(raw: string): GuardRule[] {
  const text = String(raw || '').trim();
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const rules: GuardRule[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue;
    const value = entry as Record<string, unknown>;
    const verdict = value.verdict === 'block' ? 'block' : value.verdict === 'allow' ? 'allow' : undefined;
    // A rule with no tool would apply to everything by accident; a rule with no
    // verdict does not say anything.
    if (!verdict) continue;
    const tool = typeof value.tool === 'string' && value.tool.trim() ? value.tool.trim() : '';
    if (!tool) continue;
    rules.push({
      name: typeof value.name === 'string' && value.name.trim() ? value.name.trim() : `${tool}:${verdict}`,
      tool,
      ...(typeof value.contains === 'string' && value.contains ? { contains: value.contains } : {}),
      ...(typeof value.pathEndsWith === 'string' && value.pathEndsWith ? { pathEndsWith: value.pathEndsWith } : {}),
      verdict,
      reason: typeof value.reason === 'string' ? value.reason : '',
    });
  }
  return rules;
}

/**
 * The audit log for one agent process.
 *
 * Bounded: the oldest entries are dropped, because a log that grows without
 * limit is a memory leak with a nice name. `dropped` is reported so a reader
 * knows the log is not the whole story instead of assuming it is.
 */
export class AuditLog {
  private entries: AuditEntry[] = [];
  private dropped = 0;

  constructor(private readonly limit = 2000) {}

  record(entry: AuditEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.limit) {
      this.dropped += this.entries.length - this.limit;
      this.entries = this.entries.slice(-this.limit);
    }
  }

  /** Entries, newest last, optionally filtered. */
  list(filter: { tool?: string; verdict?: GuardVerdict; since?: number; limit?: number } = {}): { entries: AuditEntry[]; dropped: number; total: number } {
    let out = this.entries;
    if (filter.tool) out = out.filter((entry) => entry.tool.toLowerCase() === filter.tool!.toLowerCase());
    if (filter.verdict) out = out.filter((entry) => entry.verdict === filter.verdict);
    if (filter.since) out = out.filter((entry) => entry.at >= filter.since!);
    const limited = filter.limit && filter.limit > 0 ? out.slice(-filter.limit) : out;
    return { entries: [...limited], dropped: this.dropped, total: this.entries.length };
  }

  /** Counts by verdict, for a caller that wants the shape rather than the list. */
  summary(): { allowed: number; blocked: number; dropped: number } {
    let allowed = 0;
    let blocked = 0;
    for (const entry of this.entries) {
      if (entry.verdict === 'block') blocked += 1;
      else allowed += 1;
    }
    return { allowed, blocked, dropped: this.dropped };
  }

  clear(): void {
    this.entries = [];
    this.dropped = 0;
  }
}
