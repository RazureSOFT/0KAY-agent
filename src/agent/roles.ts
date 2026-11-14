// Engineering roles: who does what in a task big enough to need more than one.
//
// A single agent doing a large change has one failure mode above all others:
// the same reasoning that produced the work also judges it. The work looks
// done from the inside, so it stops. Splitting a task into roles puts a
// different prompt, a different tool set and a different definition of "done"
// on each part of the job.
//
// This is deliberately NOT the same axis as `modes.ts`. A mode is how many
// instances of one role look at a problem (explore, council); a role is what
// each instance is for. `explore` with five fan-out is still one role that
// plans. A pipeline of planner -> worker -> tester is three roles that cannot
// see each other's reasoning and therefore cannot share a blind spot.
//
// The rules that matter are the tool sets and the completion criteria, because
// those are what actually stop a role from doing another role's job. A planner
// that can write files will write files. A tester that can edit the source will
// fix the bug it was sent to find, and then nobody has verified anything.

export type RoleId = 'planner' | 'worker' | 'tester' | 'reviewer';

export interface Role {
  id: RoleId;
  /** Shown in the UI and used when naming work items. */
  name: string;
  /** One line: what this role is for, and what it must not do instead. */
  summary: string;
  /**
   * Tools this role may call. Undefined means "no restriction beyond the sandbox".
   *
   * These are allow-lists, not hints. A planner with a write tool is a worker
   * that skipped the plan; a tester with an edit tool is a fixer, and a fix
   * without a re-test is how a bug ships twice.
   */
  tools?: string[];
  /** True when the role may not change the workspace at all. */
  readOnly: boolean;
  /** Appended to the task prompt so the role knows what finishing looks like. */
  brief: string;
}

/**
 * Read-only tools. Kept here rather than imported from agent.ts so a role can be
 * checked in a test without booting the agent.
 */
const READ_ONLY = [
  'read', 'glob', 'grep', 'webfetch', 'websearch', 'papersearch', 'apidocsearch',
  'todowrite', 'compress', 'decompress', 'search_context', 'acp_status',
  'report_artifacts', 'progress', 'intent', 'plan', 'recon_graph', 'fact',
  'question', 'finish', 'assessments', 'diagram', 'session', 'usage',
];

/** Verification tools: running the thing is how a tester learns anything. */
const RUN = ['bash', 'test', 'read', 'glob', 'grep', 'todowrite', 'progress', 'intent', 'finish', 'report_artifacts', 'question'];

export const ROLES: Record<RoleId, Role> = {
  planner: {
    id: 'planner',
    name: 'Planner',
    summary: 'Decide what to change and how to tell it worked. Does not change anything.',
    // A planner that writes is a worker that skipped the plan — and the plan is
    // the artefact the next two roles are handed, so it has to exist first.
    tools: [...READ_ONLY],
    readOnly: true,
    brief: [
      'You are the PLANNER. Your deliverable is a plan, not a change.',
      'Read the code before proposing anything; cite exact paths.',
      'Every step must name how it will be verified — a step with no check is a hope.',
      'State what you are NOT changing, so the worker does not wander.',
      'Submit the plan with the plan tool and stop. Do not edit files.',
    ].join('\n'),
  },

  worker: {
    id: 'worker',
    name: 'Worker',
    summary: 'Make the change the plan describes, and only that change.',
    // No restriction beyond the sandbox: a worker is the one role whose job is
    // to touch the tree, and narrowing it further would just fail to build.
    readOnly: false,
    brief: [
      'You are the WORKER. The plan is the contract; implement it.',
      'Prefer the smallest edit that satisfies the step over a rewrite.',
      'If a step turns out to be wrong, change the plan out loud at the end — do not silently do something else.',
      'Run the plan\'s verification for each step as you finish it.',
      'Report what you changed and what you could not, with file paths.',
    ].join('\n'),
  },

  tester: {
    id: 'tester',
    name: 'Tester',
    summary: 'Try to falsify the change. Reports; does not fix.',
    // The single most important rule in this file. A tester that fixes what it
    // finds has verified nothing: the fix is unverified, and the report says
    // "pass" because the tester made it pass.
    tools: [...RUN],
    readOnly: true,
    brief: [
      'You are the TESTER. Your job is to falsify the change, not to confirm it.',
      'Run the plan\'s verification steps yourself; do not trust a summary that says they passed.',
      'Then look for what the plan forgot: the empty input, the second call, the error path, the case the test does not cover.',
      'You may NOT edit source. If you find a defect, report it with a reproduction — do not fix it. A fix by the tester is an unverified fix.',
      'Report each finding with: what you ran, what you saw, what you expected. Say plainly when you could not falsify anything.',
    ].join('\n'),
  },

  reviewer: {
    id: 'reviewer',
    name: 'Reviewer',
    summary: 'Judge the delivered work against the request. Read-only.',
    tools: [...READ_ONLY],
    readOnly: true,
    brief: [
      'You are the REVIEWER. Judge the delivered work against the user\'s words.',
      'Read the files; do not reason from the transcript alone, which only shows what someone chose to report.',
      'Treat "done" claims as claims. A plan in prose is not implementation.',
      'Do not reject for style or naming unless the user asked for it.',
      'Name what is missing concretely: the feature, the file, the branch.',
    ].join('\n'),
  },
};

export const ROLE_IDS: RoleId[] = ['planner', 'worker', 'tester', 'reviewer'];

export function isRoleId(value: unknown): value is RoleId {
  return typeof value === 'string' && (ROLE_IDS as string[]).includes(value);
}

/** Resolve a role, or undefined for "no role" (an ordinary task). */
export function resolveRole(value: unknown): Role | undefined {
  return isRoleId(value) ? ROLES[value] : undefined;
}

/**
 * May this role call this tool?
 *
 * No role means no restriction: an ordinary task is not a pipeline member and
 * must not be silently narrowed. A role with no `tools` list allows everything
 * the sandbox allows.
 */
export function roleAllowsTool(role: Role | undefined, tool: string): boolean {
  if (!role) return true;
  if (!role.tools) return true;
  return role.tools.includes(tool);
}

/**
 * The pipeline for a task that asked for one.
 *
 * Testers only make sense after something was built, and a reviewer only makes
 * sense after the tests ran, so the order is fixed rather than configurable:
 * a pipeline whose stages can be reordered is a pipeline nobody can reason
 * about. Planning is omitted when the caller already has a plan (a Build from a
 * plan card), because re-planning an approved plan spends a call to disagree
 * with the user.
 */
export function pipelineFor(opts: { needsPlan?: boolean; needsTest?: boolean; needsReview?: boolean } = {}): RoleId[] {
  const pipeline: RoleId[] = [];
  if (opts.needsPlan !== false) pipeline.push('planner');
  pipeline.push('worker');
  if (opts.needsTest !== false) pipeline.push('tester');
  if (opts.needsReview === true) pipeline.push('reviewer');
  return pipeline;
}

/** Apply a role's brief to a prompt. Idempotent, so a retry does not stack it. */
export function applyRoleBrief(prompt: string, role: Role | undefined): string {
  if (!role) return prompt;
  if (prompt.includes(role.brief)) return prompt;
  return `${prompt}\n\n---\n${role.brief}`;
}

export const AGENT_ROLE_KEY = 'agent_role';

/**
 * The options a child task inherits.
 *
 * A child must NOT keep the parent's role. A planner's sub-agent is doing the
 * planner's reading, but if it keeps `agent_role=planner` it is refused the
 * write it may legitimately need, and the refusal reads as a bug. The role is
 * dropped rather than downgraded: the child gets a role only when the caller
 * asks for one by name.
 */
export function childOptions(parentOptions: Record<string, string>): Record<string, string> {
  if (!(AGENT_ROLE_KEY in parentOptions)) return parentOptions;
  const { [AGENT_ROLE_KEY]: _dropped, ...rest } = parentOptions;
  return rest;
}

/**
 * Infer a role from an agent type, for callers that only know the type.
 *
 * Core and the UI pass `agent_type`; a pipeline stage is naturally expressed as
 * one. This is a convenience, not the source of truth: an explicit
 * `agent_role` option always wins, because a caller that named a role meant it.
 */
export function roleForAgentType(agentType: string | undefined): Role | undefined {
  const value = String(agentType || '').trim().toLowerCase();
  if (!value) return undefined;
  // A pipeline stage arrives as `role` or `role_...`; `planner`, `tester_v2`
  // and `worker:sub` all name a role. An unrelated type (`code`, `general`)
  // names none, and must not be guessed into one.
  for (const id of ROLE_IDS) {
    if (value === id || value.startsWith(`${id}_`) || value.startsWith(`${id}:`) || value.startsWith(`${id}-`)) {
      return ROLES[id];
    }
  }
  return undefined;
}
