// Which tools are worth carrying in every request, and which are worth
// mentioning once.
//
// Measured before this existed: 39 tool schemas, 28k characters, ~8.8k tokens of
// system prompt on every single call — most of it describing tools a given task
// will never touch (scrape alone is 2.2k).
//
// So the prompt carries the core set in full and names everything else in one
// line per group. A tool can still be called by name without loading anything:
// the call path loads its group on the way through. Loading early is an
// optimisation, not a permission.

export interface ToolGroup {
  /** Shown in the prompt index. */
  label: string
  /** One line telling the model when this group is worth loading. */
  hint: string
  tools: string[]
}

export const TOOL_GROUPS: Record<string, ToolGroup> = {
  core: {
    label: 'core',
    hint: 'always loaded',
    tools: ['read', 'write', 'edit', 'apply_patch', 'glob', 'grep', 'bash', 'todowrite', 'skill', 'question', 'tools'],
  },
  agent: {
    label: 'agent',
    hint: 'delegation, background work, artefacts, MCP',
    tools: ['task', 'subagent', 'background_task', 'report_artifacts', 'acp_status', 'mcp'],
  },
  web: {
    label: 'web',
    hint: 'fetching pages, search, papers, API docs, GitHub',
    tools: ['webfetch', 'websearch', 'papersearch', 'apidocsearch', 'github_search'],
  },
  docs: {
    label: 'docs',
    hint: 'writing .docx / .md / .pptx',
    tools: ['document', 'slides'],
  },
  analysis: {
    label: 'analysis',
    hint: 'static binary analysis (incl. Ghidra), web assessment, PoC validation, recon graphs, diagrams',
    tools: ['reverse_engineer', 'pentest', 'diagram', 'screenshot_to_code', 'recon_graph', 'validate_finding', 'ghidra_analyze', 'http_request', 'vuln_kb', 'osint', 'deep_scan', 'exploit_runtime'],
  },
  research: {
    label: 'research',
    hint: 'deep multi-step research, scraping, crawling',
    tools: ['research', 'scrape', 'crawl'],
  },
  context: {
    label: 'context',
    hint: 'compressing and searching this conversation',
    tools: ['compress', 'decompress', 'search_context'],
  },
  evolve: {
    label: 'evolve',
    hint: 'changing 0KAY itself in a worktree',
    tools: ['evolve_begin', 'evolve_commit', 'evolve_upstream', 'evolve_finish'],
  },
  desktop: {
    label: 'desktop',
    hint: 'driving the screen and a browser, installing toolchain dependencies',
    tools: ['computeruse', 'browser', 'setup_deps'],
  },
}

/** Groups that ride along on every request. */
export const ALWAYS_LOADED = ['core', 'agent']

const BY_TOOL = new Map<string, string>()
for (const [group, definition] of Object.entries(TOOL_GROUPS)) {
  for (const tool of definition.tools) BY_TOOL.set(tool, group)
}

export function groupOf(tool: string): string | undefined {
  return BY_TOOL.get(tool)
}

export function groupsFor(tools: string[]): string[] {
  const out = new Set<string>()
  for (const tool of tools) {
    const group = BY_TOOL.get(tool)
    if (group) out.add(group)
  }
  return [...out]
}

/** Every tool name the index knows about, in group order. */
export function knownTools(): string[] {
  return Object.values(TOOL_GROUPS).flatMap((group) => group.tools)
}

/**
 * Tools with no group are treated as always loaded rather than hidden — a tool
 * someone adds without touching this file should not silently disappear from
 * the prompt.
 */
export function isAlwaysLoaded(tool: string): boolean {
  const group = BY_TOOL.get(tool)
  return !group || ALWAYS_LOADED.includes(group)
}
