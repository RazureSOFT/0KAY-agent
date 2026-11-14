import test from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_ROLE_KEY, ROLES, ROLE_IDS, applyRoleBrief, childOptions, isRoleId, pipelineFor, resolveRole, roleAllowsTool, roleForAgentType } from './roles.js';

test('no role means no restriction — an ordinary task is not narrowed', () => {
  // This is the property that matters most: a plain task must not start losing
  // tools because roles exist.
  assert.equal(roleAllowsTool(undefined, 'bash'), true);
  assert.equal(roleAllowsTool(undefined, 'write'), true);
  assert.equal(roleAllowsTool(undefined, 'anything_at_all'), true);
});

test('a planner may not write', () => {
  // A planner that writes is a worker that skipped the plan, and the plan is
  // the artefact the other roles are handed.
  assert.equal(roleAllowsTool(ROLES.planner, 'write'), false);
  assert.equal(roleAllowsTool(ROLES.planner, 'edit'), false);
  assert.equal(roleAllowsTool(ROLES.planner, 'apply_patch'), false);
  assert.equal(roleAllowsTool(ROLES.planner, 'bash'), false);
});

test('a planner may read and submit the plan', () => {
  assert.equal(roleAllowsTool(ROLES.planner, 'read'), true);
  assert.equal(roleAllowsTool(ROLES.planner, 'grep'), true);
  assert.equal(roleAllowsTool(ROLES.planner, 'plan'), true);
});

test('a tester may not edit source — a fix by the tester is unverified', () => {
  for (const tool of ['write', 'edit', 'apply_patch', 'patch']) {
    assert.equal(roleAllowsTool(ROLES.tester, tool), false, `${tool} must be refused`);
  }
});

test('a tester may run things, which is the whole point', () => {
  assert.equal(roleAllowsTool(ROLES.tester, 'bash'), true);
  assert.equal(roleAllowsTool(ROLES.tester, 'read'), true);
});

test('a reviewer is read-only', () => {
  for (const tool of ['write', 'edit', 'bash']) {
    assert.equal(roleAllowsTool(ROLES.reviewer, tool), false, `${tool} must be refused`);
  }
  assert.equal(roleAllowsTool(ROLES.reviewer, 'read'), true);
});

test('a worker is restricted only by the sandbox', () => {
  // Narrowing the worker further would just fail to build; it is the one role
  // whose job is to touch the tree.
  assert.equal(ROLES.worker.tools, undefined);
  assert.equal(roleAllowsTool(ROLES.worker, 'write'), true);
  assert.equal(roleAllowsTool(ROLES.worker, 'bash'), true);
});

test('readOnly agrees with the tool lists', () => {
  // The flag is used to gate the sandbox, so a mismatch here would let a role
  // that cannot call `write` still be handed a writable sandbox.
  for (const id of ROLE_IDS) {
    const role = ROLES[id];
    if (!role.readOnly) continue;
    for (const tool of ['write', 'edit', 'apply_patch', 'patch']) {
      assert.equal(roleAllowsTool(role, tool), false, `${id} is readOnly but allows ${tool}`);
    }
  }
});

test('only the worker is not read-only', () => {
  const writable = ROLE_IDS.filter((id) => !ROLES[id].readOnly);
  assert.deepEqual(writable, ['worker']);
});

test('isRoleId accepts the four roles and nothing else', () => {
  for (const id of ROLE_IDS) assert.equal(isRoleId(id), true);
  assert.equal(isRoleId('general'), false);
  assert.equal(isRoleId('code'), false);
  assert.equal(isRoleId(''), false);
  assert.equal(isRoleId(undefined), false);
  assert.equal(isRoleId(42), false);
});

test('resolveRole is undefined for a non-role, so ordinary tasks are unaffected', () => {
  assert.equal(resolveRole('code'), undefined);
  assert.equal(resolveRole(undefined), undefined);
  assert.equal(resolveRole('planner')?.id, 'planner');
});

test('every role has a brief that tells it what finishing means', () => {
  for (const id of ROLE_IDS) {
    assert.ok(ROLES[id].brief.length > 50, `${id} needs a real brief`);
    assert.ok(ROLES[id].name);
    assert.ok(ROLES[id].summary);
  }
});

test('the tester brief forbids fixing, not just discourages it', () => {
  const brief = ROLES.tester.brief;
  assert.match(brief, /may NOT edit source/);
  assert.match(brief, /do not fix/i);
});

test('pipelineFor defaults to planner -> worker -> tester', () => {
  assert.deepEqual(pipelineFor(), ['planner', 'worker', 'tester']);
});

test('a plan that already exists is not re-planned', () => {
  // Re-planning an approved plan spends a call to disagree with the user.
  assert.deepEqual(pipelineFor({ needsPlan: false }), ['worker', 'tester']);
});

test('a read-only change does not need a tester', () => {
  assert.deepEqual(pipelineFor({ needsTest: false }), ['planner', 'worker']);
});

test('the reviewer is opt-in — it is the most expensive stage', () => {
  assert.deepEqual(pipelineFor({ needsReview: true }), ['planner', 'worker', 'tester', 'reviewer']);
  assert.ok(!pipelineFor().includes('reviewer'));
});

test('the stage order is fixed and cannot be reordered', () => {
  // A pipeline whose stages can be reordered is one nobody can reason about;
  // testing before building is meaningless.
  const pipeline = pipelineFor({ needsReview: true });
  assert.deepEqual(pipeline, ['planner', 'worker', 'tester', 'reviewer']);
  assert.ok(pipeline.indexOf('worker') < pipeline.indexOf('tester'));
  assert.ok(pipeline.indexOf('tester') < pipeline.indexOf('reviewer'));
});

test('every stage of every pipeline is a real role', () => {
  for (const stage of pipelineFor({ needsReview: true })) {
    assert.ok(isRoleId(stage), `${stage} is not a role`);
  }
});

test('a role brief is appended to the prompt', () => {
  const applied = applyRoleBrief('Fix the login bug', ROLES.tester);
  assert.match(applied, /Fix the login bug/);
  assert.match(applied, /You are the TESTER/);
});

test('applying a brief twice does not stack it', () => {
  // A retry re-enters the same code path; two copies of the brief would waste
  // context and read as two different instructions.
  const once = applyRoleBrief('task', ROLES.planner);
  const twice = applyRoleBrief(once, ROLES.planner);
  assert.equal(twice, once);
});

test('applying no role leaves the prompt alone', () => {
  assert.equal(applyRoleBrief('task', undefined), 'task');
});

test('a child task does not inherit the parent role', () => {
  // A planner's sub-agent is doing the planner's reading, but keeping
  // `agent_role=planner` would refuse it a write it may legitimately need, and
  // the refusal reads as a bug rather than as a contract.
  const child = childOptions({ agent_role: 'planner', thinking_intensity: 'high' });
  assert.equal(AGENT_ROLE_KEY in child, false);
  assert.equal(child.thinking_intensity, 'high');
  assert.equal(resolveRole(child[AGENT_ROLE_KEY]), undefined);
});

test('options with no role are passed through untouched', () => {
  const options = { thinking_intensity: 'high', model_id: 'x' };
  assert.equal(childOptions(options), options);
});

test('a child that asks for a role by name still gets one', () => {
  // Dropping the role is about inheritance, not about forbidding roles.
  assert.equal(roleAllowsTool(resolveRole('tester'), 'write'), false);
  assert.equal(roleAllowsTool(resolveRole('worker'), 'write'), true);
});

test('a pipeline stage expressed as an agent type names its role', () => {
  assert.equal(roleForAgentType('planner')?.id, 'planner');
  assert.equal(roleForAgentType('tester')?.id, 'tester');
  assert.equal(roleForAgentType('worker')?.id, 'worker');
});

test('a suffixed or scoped stage still resolves its role', () => {
  assert.equal(roleForAgentType('tester_v2')?.id, 'tester');
  assert.equal(roleForAgentType('worker:sub')?.id, 'worker');
  assert.equal(roleForAgentType('planner-fast')?.id, 'planner');
});

test('an unrelated agent type is not guessed into a role', () => {
  // `code` and `general` are ordinary tasks; reading a role into them would
  // narrow tools nobody asked to narrow.
  assert.equal(roleForAgentType('code'), undefined);
  assert.equal(roleForAgentType('general'), undefined);
  assert.equal(roleForAgentType('code_explore'), undefined);
  assert.equal(roleForAgentType(''), undefined);
  assert.equal(roleForAgentType(undefined), undefined);
});

test('role matching is case-insensitive', () => {
  assert.equal(roleForAgentType('PLANNER')?.id, 'planner');
  assert.equal(roleForAgentType('  Tester ')?.id, 'tester');
});
