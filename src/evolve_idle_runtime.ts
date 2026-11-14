/**
 * The process-wide idle trigger, and the one place that turns a proposal into
 * something the user can see. `notify` only logs; `auto` also creates a paused
 * task, so the work still needs a click to start.
 */
import { IdleEvolve, type IdleAction } from './evolve_idle.js';
import { coreFetch, coreHeaders, coreHttpBase } from './connection.js';

let instance: IdleEvolve | null = null;

async function propose(action: IdleAction): Promise<void> {
  console.log(`[evolve] idle proposal (${action}); nothing runs until the user starts it`);
  if (action !== 'auto') return;
  try {
    await coreFetch(`${coreHttpBase()}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...coreHeaders() },
      body: JSON.stringify({
        kind: 'evolve',
        state: 'paused',
        title: 'Idle self-improvement',
        prompt: 'The agent has been idle. Review the most recent failures and propose one concrete, testable change. Do not modify the working tree until the user confirms.',
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (error) {
    console.error('[evolve] could not create the proposal task:', error instanceof Error ? error.message : error);
  }
}

export function configureIdleEvolve(options: { action: IdleAction; idleMinutes: number }): void {
  if (!instance) {
    instance = new IdleEvolve({ ...options, onIdle: (info) => propose(info.action) });
    instance.start();
    return;
  }
  instance.configure(options);
}

/** Called whenever a message or tool run happens: the idle clock restarts. */
export function touchAgentActivity(): void {
  instance?.touch();
}

export function idleEvolveStatus(): ReturnType<IdleEvolve['status']> | null {
  return instance?.status() ?? null;
}
