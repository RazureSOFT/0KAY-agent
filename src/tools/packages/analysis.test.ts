import test from 'node:test'
import assert from 'node:assert/strict'
import { ReconGraphTool, ValidateFindingTool } from './analysis.js'
import { ReconGraph } from '../../analysis/recon/graph.js'
import { BinaryAnalysisTool } from '../binary_analysis.js'
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

test('binary decompilation is a built-in tool, not an adapter', async () => {
  // The answer to "decompile this" must not depend on what is installed. That was
  // the whole shape of the old ghidra_analyze tool: installed Ghidra meant a real
  // answer, absent Ghidra meant an explanation. binary_analyze always answers.
  const tool = new BinaryAnalysisTool()
  assert.equal(tool.name, 'binary_analyze')
  assert.doesNotMatch(tool.description, /Ghidra|GHIDRA_HOME/, 'no install to depend on')
  const missing = await tool.execute({ action: 'decompile', path: 'C:\samples\does-not-exist.exe' }, context())
  assert.equal(missing.success, false)
})
