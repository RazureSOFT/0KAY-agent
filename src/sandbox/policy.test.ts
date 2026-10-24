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
