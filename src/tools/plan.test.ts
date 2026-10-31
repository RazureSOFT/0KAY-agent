import test from 'node:test'
import assert from 'node:assert/strict'
import { PlanTool, planFor, clearPlan } from './plan.js'
import type { ToolContext } from './types.js'

// The plan tool is the handoff between "we agreed on a plan" and "now execute
// it". It has to refuse something that cannot be executed, and it must not
// pretend a plan is complete when the sections are missing.

const tool = new PlanTool()

function context(taskId: string): ToolContext {
  return { cwd: process.cwd(), taskId, sessionId: `s-${taskId}`, agentType: 'general' } as ToolContext
}

const FULL_PLAN = `# Add provider kinds

## Problem
core/internal/providers/store.go has no notion of what a provider serves.

## Approach
Add a kind field and reconcile entries on every write.

## Steps
1. Add Kind to ProviderConfig in core/internal/providers/store.go
2. Migrate on load and persist once
3. Filter /api/providers by kind

## Verification
Run go test ./internal/providers/ and confirm the migration test passes.

## Risks
Old providers.json files could lose model metadata; mitigated by merging entries.
`

test('a short plan is rejected', async () => {
  clearPlan('p1')
  const result = await tool.execute({ markdown: '# too short' }, context('p1'))
  assert.equal(result.success, false)
  assert.match(result.error || '', /too short/)
  assert.equal(planFor('p1'), undefined)
})

test('a complete plan is accepted with its step count', async () => {
  clearPlan('p2')
  const result = await tool.execute({ markdown: FULL_PLAN }, context('p2'))
  assert.equal(result.success, true)
  assert.equal(result.data.accepted, true)
  assert.equal(result.data.steps, 3)
  assert.equal(result.data.missing_sections, undefined)
  const stored = planFor('p2')
  assert.equal(stored?.title, 'Add provider kinds')
  assert.equal(stored?.markdown, FULL_PLAN.trim())
})

test('missing sections are reported but do not block', async () => {
  clearPlan('p3')
  const thin = '# Quick change\n\n## Steps\n1. edit the file and hope\n\nThis paragraph is long enough to pass the length check on its own, honestly.'
  const result = await tool.execute({ markdown: thin }, context('p3'))
  assert.equal(result.success, true)
  assert.ok(result.data.missing_sections.includes('problem'))
  assert.ok(result.data.missing_sections.includes('verification'))
})

test('an explicit title wins over the heading', async () => {
  clearPlan('p4')
  const result = await tool.execute({ markdown: FULL_PLAN, title: 'Provider kinds v2' }, context('p4'))
  assert.equal(result.data.title, 'Provider kinds v2')
})

test('a demo document is kept alongside the plan', async () => {
  clearPlan('p5')
  await tool.execute({ markdown: FULL_PLAN, demo_html: '<!doctype html><p>demo</p>' }, context('p5'))
  assert.equal(planFor('p5')?.demoHtml, '<!doctype html><p>demo</p>')
})
