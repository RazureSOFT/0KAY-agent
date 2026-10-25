import { Tool } from '../types.js'
import type { ToolContext, ToolResult } from '../types.js'
import { success, failure } from '../helpers.js'
import { findGhidra, analyzeBinary, decompileFunction, missingGhidraHint } from '../../analysis/ghidra/ghidra.js'
import { validatePoc, verdictLine } from '../../analysis/strix/validate.js'
import type { PocSpec } from '../../analysis/strix/validate.js'

// Three analysis tools, each rebuilt from a larger project rather than vendored:
//
//   recon_graph      the dual-graph model from ARTEX (assets vs. what we tried)
//   validate_finding the PoC verdict from strix (reproduced / fixed / cannot confirm)
//   ghidra_analyze   an adapter to a local Ghidra install, because rewriting a
//                    400MB Java suite is not a thing

export class ReconGraphTool extends Tool {
  get name(): string { return 'recon_graph'; }
  get description(): string {
    return [
      'Track what a target IS separately from what you have TESTED, so coverage is a question you can answer.',
      'action=add assets:["https://a.example/x","10.0.0.5:443","a.example"] — the kind and parent are inferred, you just submit what you saw.',
      'action=goal opens a deliverable a finding could prove; action=intent opens a direction against assets (priority 0-10); action=fact/finding records a result — facts and findings are what mark an asset tested, so record negative observations too.',
      'action=close moves an intent through its life (done | blocked | exhausted | stopped | paused); action=hint records steering for the planner.',
      'action=scope assets:["example.com","10.0.0.0/24"] declares the coverage denominator; action=coverage lists what is untested within it.',
      'action=history shows everything tried against one asset; action=overview is the one-call situation report.',
      'action=prove closes a goal — it refuses without a finding anchored to it, and refuses while scope coverage is below minCoverage percent when given.',
    ].join(' ')
  }
  get parameters(): Record<string, any> {
    return {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['add', 'goal', 'intent', 'fact', 'finding', 'hint', 'scope', 'close', 'coverage', 'history', 'overview', 'prove', 'export'] },
        assets: { type: 'array', items: { type: 'string' }, description: 'Raw observations: URL, host:port, IP, or hostname. scope: domains or CIDR ranges.' },
        text: { type: 'string', description: 'goal/intent/fact/finding/hint: what it is, in one sentence.' },
        asset: { type: 'string', description: 'history: the asset to look up.' },
        id: { type: 'string', description: 'close/prove: the node id. prove: optional evidence finding id.' },
        evidence: { type: 'string', description: 'prove: the finding node that proves the goal.' },
        status: { type: 'string', description: 'close: done | blocked | exhausted | stopped | paused.' },
        priority: { type: 'integer', minimum: 0, maximum: 10, description: 'intent: queue position, higher first.' },
        minCoverage: { type: 'integer', minimum: 0, maximum: 100, description: 'prove: refuse unless this percent of the scope is tested.' },
        derivedFrom: { type: 'array', items: { type: 'string' }, description: 'Node ids this came from (provenance).' },
      },
    }
  }
  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    const graph = context.recon
    if (!graph) return failure('recon graph unavailable in this context')
    try {
      switch (args.action) {
        case 'add': {
          const added = (Array.isArray(args.assets) ? args.assets : []).map((raw: string) => graph.addAsset(String(raw)))
          return success({ added: added.length, assets: added.map((asset) => ({ id: asset.id, kind: asset.kind, key: asset.key })) })
        }
        case 'goal': {
          const node = graph.addNode({ kind: 'goal', text: String(args.text || ''), assets: args.assets })
          return success({ id: node.id, kind: node.kind, status: node.status })
        }
        case 'intent': {
          const node = graph.addNode({
            kind: 'intent',
            text: String(args.text || ''),
            assets: args.assets,
            derivedFrom: args.derivedFrom,
            priority: args.priority != null ? Number(args.priority) : undefined,
          })
          return success({ id: node.id, kind: node.kind, assets: node.assetIds, priority: node.priority })
        }
        case 'fact':
        case 'finding': {
          const node = graph.addNode({ kind: args.action, text: String(args.text || ''), assets: args.assets, derivedFrom: args.derivedFrom })
          if (args.id) graph.complete(String(args.id), 'done')
          return success({ id: node.id, kind: node.kind, assets: node.assetIds, coverage: graph.coverage() })
        }
        case 'hint': {
          const node = graph.addHint(String(args.text || ''), args.assets)
          return success({ id: node.id, kind: node.kind })
        }
        case 'scope': {
          const rows = graph.setScope((Array.isArray(args.assets) ? args.assets : []).map(String))
          const coverage = graph.coverage()
          return success({
            scope: rows.map((row) => `${row.kind}:${row.value}`),
            denominator: coverage.scope.denominator,
            tested: coverage.tested,
            pct: coverage.scope.pct,
          })
        }
        case 'close': {
          const status = String(args.status || 'done')
          const node = graph.complete(String(args.id || ''), status)
          return success({ id: node.id, kind: node.kind, status: node.status })
        }
        case 'coverage': {
          const coverage = graph.coverage()
          return success({
            total: coverage.total,
            tested: coverage.tested,
            scope: coverage.scope,
            untested: coverage.untested.slice(0, 50).map((asset) => `${asset.kind}:${asset.key}`),
            ...(coverage.untested.length > 50 ? { more: coverage.untested.length - 50 } : {}),
          })
        }
        case 'history': {
          const asset = graph.addAsset(String(args.asset || ''))
          return success({
            asset: `${asset.kind}:${asset.key}`,
            nodes: graph.history(asset.id).map((node) => ({ id: node.id, kind: node.kind, status: node.status, text: node.text })),
          })
        }
        case 'overview':
          return success(graph.overview())
        case 'prove': {
          const goal = graph.prove(String(args.id || ''), args.evidence ? String(args.evidence) : undefined, args.minCoverage != null ? Number(args.minCoverage) : undefined)
          return success({ id: goal.id, status: goal.status, text: goal.text })
        }
        case 'export':
          return success(graph.toJSON())
        default:
          throw new Error('action must be add, goal, intent, fact, finding, hint, scope, close, coverage, history, overview, prove or export')
      }
    } catch (error) {
      return failure(error)
    }
  }
}

export class ValidateFindingTool extends Tool {
  get name(): string { return 'validate_finding'; }
  get description(): string {
    return [
      'Run a proof-of-concept request and decide whether the finding is real.',
      'Returns reproduced / fixed / cannot_confirm — the third means the target never answered, which is not evidence of a fix.',
      'Give an expectation (statusIn, bodyContains, bodyAbsent); a PoC with no check proves nothing and is reported as cannot_confirm.',
      'redirect is manual, so a 302 is observed rather than followed.',
    ].join(' ')
  }
  get parameters(): Record<string, any> {
    return {
      type: 'object',
      required: ['target', 'url', 'expect'],
      properties: {
        target: { type: 'string', description: 'What the finding is about.' },
        url: { type: 'string' },
        method: { type: 'string' },
        headers: { type: 'object' },
        body: { type: 'string' },
        expect: {
          type: 'object',
          properties: {
            statusIn: { type: 'array', items: { type: 'integer' } },
            bodyContains: { type: 'array', items: { type: 'string' } },
            bodyAbsent: { type: 'array', items: { type: 'string' } },
          },
        },
        timeoutMs: { type: 'integer', minimum: 1000, maximum: 120000 },
      },
    }
  }
  async execute(args: Record<string, any>): Promise<ToolResult> {
    try {
      const spec: PocSpec = {
        target: String(args.target || ''),
        request: {
          url: String(args.url || ''),
          method: args.method ? String(args.method) : undefined,
          headers: args.headers && typeof args.headers === 'object' ? args.headers : undefined,
          body: args.body != null ? String(args.body) : undefined,
        },
        expect: args.expect && typeof args.expect === 'object' ? args.expect : {},
      }
      const verdict = await validatePoc(spec, { timeoutMs: args.timeoutMs })
      return success({ ...verdict, line: verdictLine(verdict, spec.target) })
    } catch (error) {
      return failure(error)
    }
  }
}

export class GhidraAnalyzeTool extends Tool {
  get name(): string { return 'ghidra_analyze'; }
  get description(): string {
    return [
      'Analyze a binary with a local Ghidra install (headless): action=facts lists functions and strings; action=decompile returns the C for one function (symbol or entry address, empty = entry point).',
      'Requires Ghidra with a JDK 17+; set GHIDRA_HOME if it is not in a standard location.',
      'Without Ghidra this reports what is missing instead of guessing — use reverse_engineer for headers, imports and entropy.',
    ].join(' ')
  }
  get parameters(): Record<string, any> {
    return {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string', description: 'Binary to analyze.' },
        action: { type: 'string', enum: ['facts', 'decompile'], description: 'facts (default) lists functions and strings; decompile returns C for one function.' },
        symbol: { type: 'string', description: 'decompile: function name or entry address; empty means the program entry point.' },
        maxFunctions: { type: 'integer', minimum: 1, maximum: 5000 },
        maxStrings: { type: 'integer', minimum: 0, maximum: 2000 },
        timeoutMs: { type: 'integer', minimum: 10000, maximum: 900000 },
      },
    }
  }
  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    try {
      const install = findGhidra()
      if (!install) return failure(missingGhidraHint())
      const target = String(args.path || '')
      if (!target) throw new Error('path is required')
      if (args.action === 'decompile') {
        const result = await decompileFunction(install, target, {
          symbol: typeof args.symbol === 'string' ? args.symbol : undefined,
          timeoutMs: args.timeoutMs,
          workDir: context.cwd,
        })
        return success({ ghidra: install.version, ...result })
      }
      const report = await analyzeBinary(install, target, {
        maxFunctions: args.maxFunctions,
        maxStrings: args.maxStrings,
        timeoutMs: args.timeoutMs,
      })
      return success({ ghidra: install.version, ...report })
    } catch (error) {
      return failure(error)
    }
  }
}
