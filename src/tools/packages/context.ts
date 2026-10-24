import { Tool } from '../types.js'
import type { ToolContext, ToolResult } from '../types.js'
import { success, failure, clamp } from '../helpers.js'

// Context management: the tools a long task uses to keep its own window
// honest. They talk to Core, never to the model.

export class CompressContextTool extends Tool {
  get name(): string { return 'compress'; }
  get description(): string {
    return 'Fold a range of earlier conversation messages into one high-fidelity summary to free context. Provide from/to (0-based indices into the visible history) and a summary that preserves decisions, file paths/commands, results and open threads. The originals are kept and can be restored with decompress; search_context can look inside them.';
  }
  get parameters(): Record<string, any> {
    return { type: 'object', required: ['from', 'to', 'summary'], properties: {
      from: { type: 'integer' }, to: { type: 'integer' }, summary: { type: 'string' },
    }};
  }
  async execute(args: Record<string, any>, context?: ToolContext): Promise<ToolResult> {
    if (!context?.ledger) return failure('context ledger unavailable');
    const block = context.ledger.compress(Number(args.from), Number(args.to), String(args.summary || ''));
    if (!block) return failure('invalid range or empty summary');
    return success({ block: block.id, folded_messages: block.messages.length, tokens_freed: block.tokens });
  }
}

export class DecompressContextTool extends Tool {
  get name(): string { return 'decompress'; }
  get description(): string { return 'Restore a previously compressed range when exact details are needed again. Pass the block id returned by compress (or its 1-based number).'; }
  get parameters(): Record<string, any> {
    return { type: 'object', required: ['block'], properties: { block: { type: 'string' } } };
  }
  async execute(args: Record<string, any>, context?: ToolContext): Promise<ToolResult> {
    if (!context?.ledger) return failure('context ledger unavailable');
    return context.ledger.decompress(String(args.block || '')) ? success({ restored: String(args.block) }) : failure('unknown block');
  }
}

export class SearchContextTool extends Tool {
  get name(): string { return 'search_context'; }
  get description(): string { return 'Keyword search over compressed summaries and visible messages, to find details that were folded away.'; }
  get parameters(): Record<string, any> {
    return { type: 'object', required: ['query'], properties: { query: { type: 'string' }, limit: { type: 'integer' } } };
  }
  async execute(args: Record<string, any>, context?: ToolContext): Promise<ToolResult> {
    if (!context?.ledger) return failure('context ledger unavailable');
    return success({ results: context.ledger.search(String(args.query || ''), clamp(args.limit, 10, 1, 50)) });
  }
}

export class AcpStatusTool extends Tool {
  get name(): string { return 'acp_status'; }
  get description(): string { return 'Context-usage overview: visible message count, estimated tokens, last prompt tokens and the compressed blocks.'; }
  async execute(_args: Record<string, any>, context?: ToolContext): Promise<ToolResult> {
    if (!context?.ledger) return failure('context ledger unavailable');
    return success(context.ledger.status());
  }
}
