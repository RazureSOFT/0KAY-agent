export interface MultiAgentMode {
  id: string;
  name: string;
  summary: string;
  fanout: number;
  readOnly: boolean;
  digestLead: string;
}

export const MODES: Record<string, MultiAgentMode> = {
  explore: {
    id: 'explore',
    name: 'Explore',
    summary: 'Parallel exploration, then implement the best approach',
    fanout: 5,
    readOnly: false,
    digestLead:
      'Several independent sub-agents explored the problem from different angles. Review every candidate, pick the best approach (or merge the strongest parts) and implement it. ' +
      'Judge by correctness, simplicity and fit with the existing code; verify against the repository rather than copying blindly. State which candidate you chose and why.',
  },
  scout: {
    id: 'scout',
    name: 'Scout',
    summary: 'Read-only reconnaissance: look first, report, do not act',
    fanout: 3,
    readOnly: true,
    digestLead:
      'Several read-only scout sub-agents returned findings from their angles. Synthesize them into a reconnaissance report: ' +
      'structure of the target, entry points, risks and the recommended next step. This mode reports only — do not implement unless the user explicitly asks.',
  },
  team: {
    id: 'team',
    name: 'Team',
    summary: 'Wave-based construction, verify each wave',
    fanout: 5,
    readOnly: false,
    digestLead:
      'Several sub-agents proposed construction plans. Pick one primary plan and proceed in waves: each wave makes one group of independent changes, ' +
      'then verifies (compile/test) before the next wave; avoid concurrent writes to the same file.',
  },
  council: {
    id: 'council',
    name: 'Council',
    summary: 'Independent seats answer, then converge adversarially',
    fanout: 5,
    readOnly: false,
    digestLead:
      'Several sub-agents answered the same question independently (a council). Find the consensus, mark the disagreements, ' +
      'adjudicate them with evidence, then implement and verify accordingly.',
  },
};

export const DEFAULT_MODE_ID = 'explore';

export function resolveMode(id?: string): MultiAgentMode {
  const key = String(id || '').trim().toLowerCase();
  return MODES[key] || MODES[DEFAULT_MODE_ID];
}

export function listModes(): MultiAgentMode[] {
  return Object.values(MODES);
}
