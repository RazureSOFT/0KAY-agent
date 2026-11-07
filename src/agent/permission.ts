// Who is allowed to write, and what counts as permission to write.
//
// Two kinds of write need a check before they land: a memory fact (the agent
// learning something it will reuse) and an experience update (the agent changing
// how future turns behave). Both outlive the task that produced them, which is
// exactly why "I feel confident" is not permission.
//
// A proposal is accepted when it carries evidence of one of these:
//   - `user`: the user said it in this session;
//   - `reviewer`: the reviewer confirmed it;
//   - `tool`: a successful tool call produced it;
//   - `path`: it is a file inside the workspace.
// Anything else is refused, and the refusal names what was missing so the model
// can supply it instead of retrying the same write.

import * as path from 'path';

export type WriteKind = 'memory' | 'experience';

export type ProofKind = 'user' | 'reviewer' | 'tool' | 'path';
export type Actor = 'agent' | 'user' | 'reviewer' | 'plugin';

export interface Proposal {
  kind: WriteKind;
  /** Where the write lands: a file, a session, a namespace. */
  scope: string;
  /** Evidence for the write, as a string the ledger classifies. */
  proof: string;
  actor: Actor;
}

export interface Refusal {
  ok: false;
  reason: string;
  /** What the caller has to supply to be accepted. */
  needs?: string;
}

export interface Permission {
  ok: true;
  proof: ProofKind;
}

export type Decision = Permission | Refusal;

const PROOF_PATTERNS: Array<{ kind: ProofKind; re: RegExp }> = [
  { kind: 'user', re: /^(user|user_said|user-message)\b/i },
  { kind: 'reviewer', re: /^(reviewer|review|gate)\b/i },
  { kind: 'tool', re: /^(tool|call|command|bash|shell|read|grep|glob|webfetch|websearch)\b/i },
  { kind: 'path', re: /^path\b/i },
];

export class PermissionLedger {
  private readonly workspace: string;
  private readonly allowAgentSelfWrite: boolean;

  constructor(workspace: string, options: { allowAgentSelfWrite?: boolean } = {}) {
    this.workspace = path.resolve(workspace);
    this.allowAgentSelfWrite = options.allowAgentSelfWrite ?? false;
  }

  /**
   * `scope` is where the write lands. A path outside this workspace is refused
   * for memory writes: a fact learned in one repo must not quietly steer another.
   */
  check(proposal: Proposal): Decision {
    if (proposal.actor === 'user' || proposal.actor === 'reviewer') {
      return { ok: true, proof: proposal.actor };
    }
    const raw = String(proposal.proof || '').trim();
    if (!raw) {
      return {
        ok: false,
        reason: `this ${proposal.kind} write has no permission proof`,
        needs: 'set proof to where the fact came from, e.g. "tool: bash exit 0", "path: src/main.ts", "user: the user said so", "reviewer: pass"',
      };
    }
    const matched = PROOF_PATTERNS.find((pattern) => pattern.re.test(raw));
    if (!matched) {
      return {
        ok: false,
        reason: `"${raw.slice(0, 80)}" is not a recognised proof for a ${proposal.kind} write`,
        needs: 'proof must start with user, reviewer, tool, or path',
      };
    }
    if (matched.kind === 'path') {
      const target = raw.replace(/^path\s*:?\s*/i, '').trim();
      if (!target) return { ok: false, reason: 'path proof needs a path', needs: 'proof: "path: <relative file>"' };
      const resolved = path.resolve(this.workspace, target);
      const rel = path.relative(this.workspace, resolved);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        return { ok: false, reason: `path proof points outside the workspace: ${target}`, needs: 'a path inside the workspace' };
      }
    }
    if (proposal.actor === 'agent' && proposal.kind === 'experience' && !this.allowAgentSelfWrite && matched.kind !== 'user' && matched.kind !== 'reviewer') {
      // Experience writes change future behaviour, so an agent may only make
      // one when a human or the reviewer asked for it.
      return {
        ok: false,
        reason: 'an agent may not rewrite its own experience without a user or reviewer instruction',
        needs: 'ask the user first, then write with proof "user: ..."',
      };
    }
    return { ok: true, proof: matched.kind };
  }
}
