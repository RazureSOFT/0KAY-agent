/**
 * Context ledger — a compact, dependency-free adaptation of billion-context's
 * idea: the *model* decides when and what to fold into a high-fidelity summary
 * (via the compress/decompress/search_context/acp_status tools) instead of a
 * hard truncation limit.
 *
 * A compressed range is replaced in the live history by a single summary
 * message carrying a stable marker; the original messages are kept so
 * decompress can restore them and search_context can look inside them.
 */

export interface LedgerBlock {
  id: string
  summary: string
  /** Index (in the live history) where the summary message currently sits. */
  index: number
  messages: unknown[]
  tokens: number
  createdAt: number
}

function estimateTokens(value: unknown): number {
  let text = ''
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    text = String(value)
  }
  return Math.ceil((text || '').length / 4)
}

function messageText(message: any): string {
  if (!message || typeof message !== 'object') return ''
  const parts = Array.isArray(message.parts)
    ? message.parts.map((part: any) => (typeof part === 'string' ? part : part?.text || '')).join('')
    : ''
  return `${message.content || ''}${parts}`
}

export class ContextLedger {
  private blocks: LedgerBlock[] = []
  private counter = 0
  /** Last prompt token count reported by the model, when known. */
  lastPromptTokens = 0

  constructor(private readonly getHistory: () => any[]) {}

  private marker(id: string): string {
    return `[compressed ${id}]`
  }

  /** Fold history[from..to] into one summary message. Returns the new block. */
  compress(from: number, to: number, summary: string): LedgerBlock | null {
    const history = this.getHistory()
    if (!Array.isArray(history) || from < 0 || to < from || to >= history.length || !summary.trim()) return null
    const messages = history.slice(from, to + 1)
    this.counter += 1
    const id = `blk${this.counter}`
    const block: LedgerBlock = {
      id,
      summary: summary.trim(),
      index: from,
      messages,
      tokens: messages.reduce((sum, message) => sum + estimateTokens(messageText(message)), 0),
      createdAt: Date.now(),
    }
    history.splice(from, to - from + 1, { role: 'user', content: `${this.marker(id)} ${block.summary}` })
    this.blocks.push(block)
    return block
  }

  /** Restore a folded range in place. Accepts a block id or 1-based number. */
  decompress(blockRef: string): boolean {
    const block = this.findBlock(blockRef)
    if (!block) return false
    const history = this.getHistory()
    const index = history.findIndex((message: any) => typeof message?.content === 'string' && message.content.startsWith(this.marker(block.id)))
    if (index < 0) return false
    history.splice(index, 1, ...block.messages)
    this.blocks = this.blocks.filter((entry) => entry !== block)
    return true
  }

  private findBlock(blockRef: string): LedgerBlock | undefined {
    const ref = String(blockRef || '').trim()
    if (!ref) return undefined
    return (
      this.blocks.find((block) => block.id === ref) ||
      this.blocks[Number.parseInt(ref, 10) - 1]
    )
  }

  /** Keyword search across folded summaries and the visible messages. */
  search(query: string, limit = 10): Array<{ where: string; id?: string; text: string }> {
    const needle = String(query || '').toLowerCase().trim()
    if (!needle) return []
    const out: Array<{ where: string; id?: string; text: string }> = []
    for (const block of this.blocks) {
      if (block.summary.toLowerCase().includes(needle)) {
        out.push({ where: 'summary', id: block.id, text: block.summary })
      }
      for (const message of block.messages) {
        const text = messageText(message)
        if (text.toLowerCase().includes(needle)) out.push({ where: 'folded', id: block.id, text: text.slice(0, 400) })
        if (out.length >= limit) return out
      }
    }
    const history = this.getHistory()
    history.forEach((message: any, index: number) => {
      const text = messageText(message)
      if (text.toLowerCase().includes(needle)) out.push({ where: 'visible', text: `#${index} ${text.slice(0, 400)}` })
    })
    return out.slice(0, limit)
  }

  /** Context-usage overview for the acp_status tool. */
  status(): Record<string, unknown> {
    const history = this.getHistory()
    const visibleTokens = Array.isArray(history)
      ? history.reduce((sum, message) => sum + estimateTokens(messageText(message)), 0)
      : 0
    return {
      visible_messages: Array.isArray(history) ? history.length : 0,
      estimated_tokens: visibleTokens,
      last_prompt_tokens: this.lastPromptTokens,
      compressed_blocks: this.blocks.map((block) => ({ id: block.id, index: block.index, folded_messages: block.messages.length, tokens: block.tokens })),
      note: 'compress(from,to,summary) folds history[from..to] into a summary; decompress(block) restores it; search_context(query) looks inside folded ranges.',
    }
  }

  get blockCount(): number {
    return this.blocks.length
  }
}
