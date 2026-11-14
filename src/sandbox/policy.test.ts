import test from 'node:test'
import assert from 'node:assert/strict'
import * as path from 'node:path'
import { SandboxPolicy, parseSandboxMode, SANDBOX_MODES } from './policy.js'
import { ShellTool, WriteTool } from '../tools/tools.js'
import type { ToolContext } from '../tools/types.js'

const root = process.cwd()
const inside = path.join(root, 'tmp-file.txt')

// The policy is the part a reviewer should be able to read and argue with, so
// the tests state the promise rather than the implementation.

test('workspace-write allows the workspace and refuses outside it', () => {
  const policy = new SandboxPolicy('workspace-write', [root])
  assert.equal(policy.checkWrite(inside).allowed, true)
  const outside = path.resolve(root, '..', 'elsewhere.txt')
  const verdict = policy.checkWrite(outside)
  assert.equal(verdict.allowed, false)
  assert.match(verdict.reason || '', /outside/)
})

test('read-only refuses every write, even inside the workspace', () => {
  const policy = new SandboxPolicy('read-only', [root])
  const verdict = policy.checkWrite(inside)
  assert.equal(verdict.allowed, false)
  assert.match(verdict.reason || '', /read-only/)
})

test('read-only refuses the shell commands that write', () => {
  const policy = new SandboxPolicy('read-only', [root])
  for (const command of ['rm -rf build', 'echo hi > out.txt', 'git commit -m x', 'npm install', 'touch x', 'mv a b']) {
    assert.equal(policy.checkShell(command).allowed, false, command)
  }
  for (const command of ['ls -la', 'cat package.json', 'git status', 'grep -r foo src', 'npm ls']) {
    assert.equal(policy.checkShell(command).allowed, true, command)
  }
})

test('danger-full-access allows everything, which is the point of asking for it', () => {
  const policy = new SandboxPolicy('danger-full-access', [root])
  assert.equal(policy.checkWrite('/etc/passwd').allowed, true)
  assert.equal(policy.checkShell('rm -rf /tmp/x').allowed, true)
})

test('a recursive delete of a root path is refused even in workspace-write', () => {
  const policy = new SandboxPolicy('workspace-write', [root])
  assert.equal(policy.checkShell('rm -rf /').allowed, false)
  assert.equal(policy.checkShell('rm -rf C:\\').allowed, false)
  assert.equal(policy.checkShell('rm -rf ./build').allowed, true)
})

test('an unknown mode falls back to the safe one', () => {
  assert.equal(parseSandboxMode('yolo'), 'workspace-write')
  assert.equal(parseSandboxMode(undefined), 'workspace-write')
  for (const mode of SANDBOX_MODES) assert.equal(parseSandboxMode(mode), mode)
})

// The policy is only worth anything if the tools actually consult it.

const contextWith = (policy: SandboxPolicy): ToolContext => ({
  cwd: root, taskId: 't', sessionId: 's', agentType: 'general', sandbox: policy,
})

test('the write tool refuses what the policy refuses', async () => {
  const tool = new WriteTool()
  const blocked = await tool.execute(
    { filePath: inside, content: 'x' },
    contextWith(new SandboxPolicy('read-only', [root])),
  )
  assert.equal(blocked.success, false)
  assert.match(blocked.error || '', /read-only/)
})

test('the shell tool refuses before spawning anything', async () => {
  const tool = new ShellTool()
  const result = await tool.execute(
    { command: 'echo hello > out.txt' },
    contextWith(new SandboxPolicy('read-only', [root])),
  )
  assert.equal(result.success, false)
  assert.match(result.error || '', /read-only/)
})

test('a write to an absolute path outside the workspace is refused in workspace-write', () => {
  const policy = new SandboxPolicy('workspace-write', [root])
  const outside = process.platform === 'win32' ? 'C:\\Windows\\Temp\\x.txt' : '/etc/passwd'
  const verdict = policy.checkShell(`echo pwned > ${outside}`)
  assert.equal(verdict.allowed, false)
  assert.match(verdict.reason || '', /outside/)
  // A write inside the workspace still goes through.
  assert.equal(policy.checkShell(`echo fine > ${path.join(root, 'out.txt')}`).allowed, true)
})

test('a read of an absolute path is not treated as a write', () => {
  const policy = new SandboxPolicy('workspace-write', [root])
  const outside = process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/hosts'
  assert.equal(policy.checkShell(`cat ${outside}`).allowed, true)
})

// -- plan mode -------------------------------------------------------------
//
// A planning run reads the project to write a plan about it. The mode exists
// so "the plan is the only artefact" is enforced by the sandbox rather than
// asked of the model politely.

test('plan mode writes the plan and nothing else', () => {
  const policy = new SandboxPolicy('plan', [root])
  assert.equal(policy.checkWrite(path.join(root, '.0kay', 'plans', 'auth.plan.md')).allowed, true)
  const source = policy.checkWrite(path.join(root, 'src', 'app.ts'))
  assert.equal(source.allowed, false)
  assert.match(source.reason || '', /plan/)
})

test('plan mode still refuses to write outside the workspace', () => {
  const policy = new SandboxPolicy('plan', [root])
  const outside = path.resolve(root, '..', 'elsewhere.plan.md')
  assert.equal(policy.checkWrite(outside).allowed, false)
})

test('plan mode reads the project', () => {
  const policy = new SandboxPolicy('plan', [root])
  assert.equal(policy.checkRead(path.join(root, 'src', 'app.ts')).allowed, true)
})

test('plan mode runs read-only commands and refuses the rest', () => {
  const policy = new SandboxPolicy('plan', [root])
  assert.equal(policy.checkShell('git log --oneline -5').allowed, true)
  assert.equal(policy.checkShell('rg -n TODO src').allowed, true)
  for (const command of ['npm install', 'git commit -m x', 'rm -rf src', 'echo x > file.txt']) {
    const verdict = policy.checkShell(command)
    assert.equal(verdict.allowed, false, `${command} must be refused while planning`)
  }
})

test('plan is a recognised sandbox mode', () => {
  assert.ok(SANDBOX_MODES.includes('plan'))
  assert.equal(parseSandboxMode('plan'), 'plan')
})

test('the WriteTool refuses a source file while planning', async () => {
  const fs = await import('node:fs/promises')
  const plansDir = path.join(root, '.0kay', 'plans')
  await fs.mkdir(plansDir, { recursive: true })
  const tool = new WriteTool()
  const context: ToolContext = {
    cwd: root,
    taskId: 't-plan',
    agentType: 'general',
    sandbox: new SandboxPolicy('plan', [root]),
  }
  const plan = await tool.execute({ filePath: path.join(plansDir, 'x.plan.md'), content: '# Plan\n\nDo the thing.' }, context)
  assert.equal(plan.success, true, `the plan itself is writable: ${plan.error || ''}`)
  const source = await tool.execute({ filePath: path.join(root, 'src', 'nope.ts'), content: 'export {}' }, context)
  assert.equal(source.success, false, 'source is not writable while planning')
  await fs.rm(path.join(plansDir, 'x.plan.md'), { force: true })
})

test('a package manager may only read, in every restricted mode', () => {
  for (const mode of ['plan', 'read-only'] as const) {
    const policy = new SandboxPolicy(mode, [root])
    assert.equal(policy.checkShell('npm ls').allowed, true, `${mode}: npm ls reads`)
    assert.equal(policy.checkShell('go list ./...').allowed, true, `${mode}: go list reads`)
    for (const command of ['npm install', 'npm ci', 'go build ./...', 'pnpm add left-pad', 'npx some-package']) {
      assert.equal(policy.checkShell(command).allowed, false, `${mode}: ${command} must be refused`)
    }
  }
})
