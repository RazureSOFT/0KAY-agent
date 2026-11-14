/**
 * Model failover, a per-call record, and questions that stay out of the main
 * context.
 *
 * The pool's job is not "try another model until something comes back"; it is
 * to stop sending traffic to a provider that has just failed several times,
 * and to be honest when nothing is available. A silent empty completion is
 * worse than an error because the caller will treat it as an answer.
 */

export type ProviderState = 'healthy' | 'cooldown' | 'down';

export interface ProviderEntry {
  id: string;
  label?: string;
  call: (prompt: string) => Promise<string | null>;
}

export interface CallRecord {
  id: string;
  at: number;
  providerId: string;
  ok: boolean;
  durationMs: number;
  promptChars: number;
  responseChars: number;
  error?: string;
}

export interface Completion {
  text: string;
  providerId: string;
  attempts: number;
}

interface ProviderRuntime {
  entry: ProviderEntry;
  failures: number;
  state: ProviderState;
  cooldownUntil: number;
  calls: number;
  successes: number;
}

export class LlmPool {
  private providers: ProviderRuntime[] = [];
  private log: CallRecord[] = [];
  private seq = 0;
  constructor(
    private readonly options: {
      now?: () => number;
      failureThreshold?: number;
      cooldownMs?: number;
      maxRecords?: number;
    } = {},
  ) {}

  register(entry: ProviderEntry): void {
    if (this.providers.some((p) => p.entry.id === entry.id)) {
      throw new Error(`provider ${entry.id} is already registered`);
    }
    this.providers.push({ entry, failures: 0, state: 'healthy', cooldownUntil: 0, calls: 0, successes: 0 });
  }

  private now(): number { return (this.options.now || Date.now)(); }

  /** Cooldown expiry is a half-open probe, not a full recovery. */
  private available(runtime: ProviderRuntime, now: number): boolean {
    if (runtime.state === 'healthy') return true;
    if (now >= runtime.cooldownUntil) {
      runtime.state = 'cooldown';
      return true;
    }
    return false;
  }

  async complete(prompt: string): Promise<Completion> {
    const now = this.now();
    const threshold = Math.max(1, this.options.failureThreshold ?? 3);
    const cooldown = Math.max(1, this.options.cooldownMs ?? 30_000);
    const tried: string[] = [];
    let lastError = 'no provider registered';
    for (const runtime of this.providers) {
      if (!this.available(runtime, now)) continue;
      tried.push(runtime.entry.id);
      const started = this.now();
      runtime.calls += 1;
      try {
        const text = await runtime.entry.call(prompt);
        if (text == null || !String(text).trim()) throw new Error('provider returned no completion');
        runtime.failures = 0;
        runtime.state = 'healthy';
        runtime.cooldownUntil = 0;
        runtime.successes += 1;
        this.record({
          providerId: runtime.entry.id, ok: true, durationMs: this.now() - started,
          promptChars: prompt.length, responseChars: String(text).length,
        });
        return { text: String(text), providerId: runtime.entry.id, attempts: tried.length };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        runtime.failures += 1;
        if (runtime.failures >= threshold) {
          runtime.state = 'down';
          runtime.cooldownUntil = this.now() + cooldown;
        }
        this.record({
          providerId: runtime.entry.id, ok: false, durationMs: this.now() - started,
          promptChars: prompt.length, responseChars: 0, error: lastError,
        });
      }
    }
    throw new Error(tried.length
      ? `all providers failed (${tried.join(', ')}): ${lastError}`
      : `no provider available: ${lastError}`);
  }

  private record(row: Omit<CallRecord, 'id' | 'at'>): void {
    this.log.push({ id: `call_${++this.seq}`, at: this.now(), ...row });
    const max = Math.max(1, this.options.maxRecords ?? 1000);
    if (this.log.length > max) this.log.splice(0, this.log.length - max);
  }

  status(): Array<{ id: string; label: string; state: ProviderState; failures: number; calls: number; successes: number; retryAfterMs: number }> {
    const now = this.now();
    return this.providers.map((p) => ({
      id: p.entry.id,
      label: p.entry.label || p.entry.id,
      state: p.state,
      failures: p.failures,
      calls: p.calls,
      successes: p.successes,
      retryAfterMs: Math.max(0, p.cooldownUntil - now),
    }));
  }

  records(limit = 100): CallRecord[] { return this.log.slice(-Math.max(1, Math.min(limit, 1000))).reverse(); }

  reset(id?: string): void {
    for (const p of this.providers) {
      if (id && p.entry.id !== id) continue;
      p.failures = 0; p.state = 'healthy'; p.cooldownUntil = 0;
    }
  }
}

export interface SideQuestion {
  id: string;
  at: number;
  question: string;
  context: string;
  status: 'pending' | 'answered' | 'failed';
  answer?: string;
  error?: string;
}

/**
 * A side question runs beside the main loop. Its answer lives here and nowhere
 * else until a caller explicitly reads it, which is what keeps a one-off
 * clarification out of every later planner round.
 */
export class SideQuestionBus {
  private rows: SideQuestion[] = [];
  private seq = 0;
  constructor(
    private readonly options: { now?: () => number; max?: number } = {},
  ) {}

  ask(question: string, context = ''): SideQuestion {
    const row: SideQuestion = {
      id: `sq_${++this.seq}`,
      at: (this.options.now || Date.now)(),
      question: String(question || ''),
      context: String(context || ''),
      status: 'pending',
    };
    this.rows.push(row);
    const max = Math.max(1, this.options.max ?? 200);
    if (this.rows.length > max) this.rows.splice(0, this.rows.length - max);
    return row;
  }

  /** Resolve with an injected caller; failures are stored, not thrown away. */
  async resolve(id: string, ask: (prompt: string) => Promise<string | null>): Promise<SideQuestion> {
    const row = this.rows.find((candidate) => candidate.id === id);
    if (!row) throw new Error(`side question ${id} not found`);
    const prompt = row.context ? `Context:\n${row.context}\n\nQuestion: ${row.question}` : row.question;
    try {
      const answer = await ask(prompt);
      if (answer == null || !String(answer).trim()) throw new Error('no answer returned');
      row.status = 'answered';
      row.answer = String(answer);
      row.error = undefined;
    } catch (error) {
      row.status = 'failed';
      row.error = error instanceof Error ? error.message : String(error);
    }
    return row;
  }

  get(id: string): SideQuestion | undefined { return this.rows.find((row) => row.id === id); }

  list(status?: SideQuestion['status']): SideQuestion[] {
    return this.rows.filter((row) => !status || row.status === status).slice().reverse();
  }

  /** Only answered questions are relevant to a later round. */
  answers(): Array<{ id: string; question: string; answer: string }> {
    return this.rows.filter((row) => row.status === 'answered' && row.answer)
      .map((row) => ({ id: row.id, question: row.question, answer: row.answer as string }));
  }
}
