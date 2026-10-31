// Where the tokens go.
//
// A prompt is five things competing for one window: the system block, the tool
// schemas, the skill block, the conversation, and the tool results sitting in
// the conversation. Without a budget, whichever grows fastest wins — usually
// tool results, because a build log does not know it is 9,000 tokens.
//
// This module only does arithmetic. Trimming lives in compact.ts and the loop.

export interface BudgetShares {
  system: number;
  tools: number;
  skills: number;
  history: number;
  toolResults: number;
}

export interface Budget {
  /** Usable input window (window minus the output reserve). */
  usable: number;
  /** Tokens held back for the model's reply. */
  outputReserve: number;
  system: number;
  tools: number;
  skills: number;
  history: number;
  toolResults: number;
  /** True when the shares had to be renormalised for a small window. */
  scaled: boolean;
}

const DEFAULT_SHARES: BudgetShares = {
  system: 0.08,
  tools: 0.2,
  skills: 0.08,
  history: 0.46,
  toolResults: 0.18,
};

// Floors keep the prompt coherent on a small window: a 32k model still needs a
// readable system block even though 8% of it is 2.5k.
const FLOORS = { system: 1200, tools: 1500, skills: 0, history: 3000, toolResults: 800 };

export function allocateBudget(
  window: number,
  options: { outputReserve?: number; shares?: Partial<BudgetShares> } = {},
): Budget {
  const total = Math.max(1, Math.floor(window));
  // A quarter of the window for the reply is the usual trade: enough for a long
  // answer, not so much that the input gets starved.
  const outputReserve = Math.min(
    Math.max(1024, Math.floor(options.outputReserve ?? total * 0.25)),
    Math.floor(total * 0.5),
  );
  const usable = Math.max(1, total - outputReserve);
  const shares = { ...DEFAULT_SHARES, ...(options.shares || {}) };

  const budget: Budget = {
    usable,
    outputReserve,
    system: Math.floor(usable * shares.system),
    tools: Math.floor(usable * shares.tools),
    skills: Math.floor(usable * shares.skills),
    history: Math.floor(usable * shares.history),
    toolResults: Math.floor(usable * shares.toolResults),
    scaled: false,
  };

  // Apply floors, then take the difference out of the largest remaining block so
  // the total stays inside `usable`.
  const keys: Array<keyof typeof FLOORS> = ['system', 'tools', 'skills', 'history', 'toolResults'];
  const floorSum = keys.reduce((acc, key) => acc + FLOORS[key], 0);

  if (floorSum > usable) {
    // The floors alone do not fit: give every block its floor's share of what
    // there is, so a small window degrades evenly instead of starving history.
    for (const key of keys) {
      budget[key] = Math.max(1, Math.floor((usable * FLOORS[key]) / floorSum));
    }
    budget.scaled = true;
    return budget;
  }

  for (const key of keys) {
    const floor = FLOORS[key];
    if (budget[key] < floor) {
      budget[key] = floor;
      budget.scaled = true;
    }
  }
  let sum = keys.reduce((acc, key) => acc + budget[key], 0);
  // Take the overshoot out of the biggest block that still has headroom above
  // its floor. If nothing has headroom the floors already fit, so this ends.
  while (sum > usable) {
    const candidates = keys.filter((key) => budget[key] > FLOORS[key]);
    if (candidates.length === 0) break;
    const biggest = candidates.reduce((a, b) => (budget[a] >= budget[b] ? a : b));
    const excess = sum - usable;
    const give = Math.min(excess, budget[biggest] - FLOORS[biggest]);
    budget[biggest] -= give;
    sum -= give;
  }
  return budget;
}

/** Rough token estimate used across the agent. Four characters per token. */
export function estimateTextTokens(text: string): number {
  return Math.ceil((text || '').length / 4);
}

export interface UsageReport {
  system: number;
  tools: number;
  skills: number;
  history: number;
  toolResults: number;
  used: number;
}

/** Which blocks are over budget, in the order they should be trimmed. */
export function overBudget(budget: Budget, usage: UsageReport): Array<keyof BudgetShares> {
  const order: Array<keyof BudgetShares> = ['toolResults', 'history', 'skills', 'tools', 'system'];
  return order.filter((key) => usage[key] > budget[key]);
}
