import test from 'node:test'
import assert from 'node:assert/strict'
import { ReconGraphTool, ValidateFindingTool, GhidraAnalyzeTool } from './analysis.js'
import { ReconGraph } from '../../analysis/artex/graph.js'
import type { ToolContext } from '../types.js'

const context = (): ToolContext => ({
  cwd: process.cwd(),
  taskId: 't',
  agentType: 'general',
  recon: new ReconGraph(),
}) as ToolContext

test('recon_graph infers kinds and reports coverage', async () => {
  const tool = new ReconGraphTool()
  const ctx = context()

  const added = await tool.execute({ action: 'add', assets: ['https://api.example.com/login', '10.0.0.5:443'] }, ctx)
  assert.equal(added.success, true, added.error)
  assert.equal(added.data.added, 2)
  assert.deepEqual(added.data.assets.map((asset: any) => asset.kind).sort(), ['endpoint', 'service'])

  const empty = await tool.execute({ action: 'coverage' }, ctx)
  assert.equal(empty.data.tested, 0)
  assert.ok(empty.data.total >= 5, 'parents were created too')

  const fact = await tool.execute({ action: 'fact', text: 'login returns a JWT', assets: ['https://api.example.com/login'] }, ctx)
  assert.equal(fact.success, true, fact.error)

  const coverage = await tool.execute({ action: 'coverage' }, ctx)
  assert.equal(coverage.data.tested, 1)
})

test('recon_graph history answers what was tried against one asset', async () => {
  const tool = new ReconGraphTool()
  const ctx = context()
  await tool.execute({ action: 'intent', text: 'try default creds', assets: ['https://api.example.com/login'] }, ctx)
  await tool.execute({ action: 'finding', text: 'admin:admin works', assets: ['https://api.example.com/login'] }, ctx)

  const history = await tool.execute({ action: 'history', asset: 'https://api.example.com/login' }, ctx)
  assert.equal(history.success, true, history.error)
  assert.deepEqual(history.data.nodes.map((node: any) => node.kind), ['intent', 'finding'])
})

test('recon_graph refuses nonsense instead of storing it', async () => {
  const tool = new ReconGraphTool()
  const result = await tool.execute({ action: 'add', assets: ['definitely not an asset'] }, context())
  assert.equal(result.success, false)
  assert.match(result.error || '', /cannot classify/)
})

test('recon_graph without a graph says so', async () => {
  const tool = new ReconGraphTool()
  const result = await tool.execute({ action: 'coverage' }, { cwd: process.cwd(), taskId: 't', agentType: 'general' } as ToolContext)
  assert.equal(result.success, false)
  assert.match(result.error || '', /unavailable/)
})

test('validate_finding reports the three-state verdict and a line', async () => {
  const tool = new ValidateFindingTool()
  const result = await tool.execute({
    target: 'unreachable',
    url: 'http://127.0.0.1:1/x',
    expect: { statusIn: [200] },
    timeoutMs: 3000,
  })
  assert.equal(result.success, true, result.error)
  assert.equal(result.data.conclusion, 'cannot_confirm')
  assert.match(result.data.line, /CANNOT CONFIRM/)
})

test('ghidra_analyze without an install explains what is missing', async () => {
  const previous = process.env.GHIDRA_HOME
  delete process.env.GHIDRA_HOME
  try {
    const tool = new GhidraAnalyzeTool()
    const result = await tool.execute({ path: 'C:\\samples\\a.exe' }, context())
    // On a machine that does have Ghidra this test would actually run it, which
    // is why it asserts on the message rather than on success.
    if (!result.success) assert.match(result.error || '', /GHIDRA_HOME|Ghidra is not installed/)
    else assert.ok(result.data.functions)
  } finally {
    if (previous !== undefined) process.env.GHIDRA_HOME = previous
  }
})
