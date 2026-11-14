/**
 * Idle trigger for self-improvement.
 *
 * Off by default, and when it fires it only proposes: the actual work still
 * starts from the UI button, because "the agent decided to rewrite itself while
 * nobody was watching" is not a default anyone should get by accident. A
 * cooldown keeps a quiet machine from proposing every minute.
 */
export type IdleAction = 'off' | 'notify' | 'auto';

export interface IdleEvolveOptions {
  action: IdleAction;
  idleMinutes: number;
  checkIntervalMs?: number;
  cooldownMinutes?: number;
  now?: () => number;
  onIdle: (info: { idleMs: number; action: IdleAction }) => void | Promise<void>;
}

export interface IdleEvolveStatus {
  action: IdleAction;
  idleMinutes: number;
  running: boolean;
  idleMs: number;
  firedAt: number | null;
  cooldownRemainingMs: number;
}

export class IdleEvolve {
  private action: IdleAction;
  private idleMinutes: number;
  private lastActivity: number;
  private firedAt = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;
  private readonly checkIntervalMs: number;
  private readonly cooldownMinutes: number;
  private readonly onIdle: IdleEvolveOptions['onIdle'];

  constructor(options: IdleEvolveOptions) {
    this.action = options.action;
    this.idleMinutes = Math.max(1, options.idleMinutes);
    this.now = options.now || Date.now;
    this.checkIntervalMs = Math.max(1000, options.checkIntervalMs ?? 60_000);
    this.cooldownMinutes = Math.max(1, options.cooldownMinutes ?? 360);
    this.onIdle = options.onIdle;
    this.lastActivity = this.now();
  }

  /** Call on every user message or tool run: the clock restarts. */
  touch(): void {
    this.lastActivity = this.now();
  }

  configure(patch: { action?: IdleAction; idleMinutes?: number }): void {
    if (patch.action) this.action = patch.action;
    if (patch.idleMinutes != null) this.idleMinutes = Math.max(1, patch.idleMinutes);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.checkIntervalMs);
    // Do not keep the process alive just for this.
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Exposed so tests (and a manual poke) can advance the clock deterministically. */
  tick(): void {
    if (this.action === 'off') return;
    const now = this.now();
    const idleMs = now - this.lastActivity;
    if (idleMs < this.idleMinutes * 60_000) return;
    if (this.firedAt && now - this.firedAt < this.cooldownMinutes * 60_000) return;
    this.firedAt = now;
    try {
      void this.onIdle({ idleMs, action: this.action });
    } catch (error) {
      // A failed proposal must not take the timer down.
      console.error('[evolve] idle trigger failed:', error instanceof Error ? error.message : error);
    }
  }

  status(): IdleEvolveStatus {
    const now = this.now();
    return {
      action: this.action,
      idleMinutes: this.idleMinutes,
      running: this.timer !== null,
      idleMs: now - this.lastActivity,
      firedAt: this.firedAt || null,
      cooldownRemainingMs: this.firedAt
        ? Math.max(0, this.cooldownMinutes * 60_000 - (now - this.firedAt))
        : 0,
    };
  }
}

export function parseIdleAction(value: unknown): IdleAction {
  const text = String(value ?? '').trim().toLowerCase();
  if (text === 'notify' || text === 'auto') return text;
  return 'off';
}
