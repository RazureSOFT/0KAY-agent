import { Tool, type ToolContext, type ToolResult } from './types.js';
import { success, failure } from './helpers.js';
import { INTENT_STATUSES } from '../agent/intent.js';

/**
 * The intent ledger, written by the model.
 *
 * Four variables per intent, as the spec requires: id, what the user gets, how
 * this build intends to deliver it, and how far it has got. The completion rate
 * is NOT a variable the model sets — it is derived, and the gate refuses a 100%
 * claim that disagrees with the entries. That asymmetry is the whole point:
 * a number the model can type is a number the model can fake.
 */
export class IntentTool extends Tool {
  get name(): string { return 'intent'; }

  get description(): string {
    return 'Record or update the list of things the user asked for (the intent ledger). Call it once you understand the request, and again whenever the list or a status changes. The completion rate is derived from these entries; a 100% claim is rejected while any entry is open.';
  }

  get parameters(): Record<string, any> {
    return {
      type: 'object',
      properties: {
        intents: {
          type: 'array',
          description: 'The full current list. Entries with the same id or the same description are updated in place.',
          items: {
            type: 'object',
            required: ['id', 'description', 'status'],
            properties: {
              id: { type: 'string', description: 'Short stable id, e.g. i1, i2.' },
              description: { type: 'string', description: 'What the user gets, in one line. Use the user\'s own words for the thing they asked for.' },
              method: { type: 'string', description: 'How you intend to deliver it: the file, the approach, the command.' },
              status: { type: 'string', enum: INTENT_STATUSES, description: 'pending = not started; in_progress = being worked on; done = delivered and verified; blocked = cannot proceed.' },
              evidence: { type: 'string', description: 'For done entries: the proof — command output, file:line, or the verified result. Required to claim done.' },
            },
          },
        },
        approach: { type: 'string', description: 'One or two lines: the plan you will follow to satisfy these intents. The user sees this next to the list.' },
      },
      required: ['intents'],
    };
  }

  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    try {
      if (!Array.isArray(args.intents)) throw new Error('intents must be an array');
      if (!context.gate) throw new Error('the intent ledger is not available in this context');
      const result = context.gate.updateIntents(args.intents, typeof args.approach === 'string' ? args.approach : '', 'agent', {
        taskId: context.taskId,
        sessionId: context.sessionId || '',
      });
      const state = context.gate.ledger.current;
      return success({
        derived_completion: `${result.derived}%`,
        intents: state.intents.map((intent) => ({ id: intent.id, status: intent.status, description: intent.description })),
        ...(result.ok ? {} : { gate_note: result.problems }),
      });
    } catch (error) {
      return failure(error);
    }
  }
}

/**
 * fact_1 .. fact_10: state the agent will need later and would otherwise lose to
 * compaction. Newest first; the tenth is dropped when an eleventh arrives.
 */
export class FactTool extends Tool {
  get name(): string { return 'fact'; }

  get description(): string {
    return 'Remember one durable fact about this work so it survives context compaction (up to 10, newest kept). Facts are statements of what is true — "the gateway listens on 8080", "the build needs --ignore-scripts" — not plans or todos. The write needs a proof of where the fact came from.';
  }

  get parameters(): Record<string, any> {
    return {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The fact, one sentence, specific enough to act on.' },
        proof: { type: 'string', description: 'Where it came from: "tool: <command or tool name and result>", "path: <file>", "user: <what the user said>", "reviewer: <verdict>".' },
        source: { type: 'string', description: 'Short human label for the origin, e.g. a file path or command.' },
        action: { type: 'string', enum: ['write', 'remove'], description: 'write (default) adds or refreshes a fact; remove drops one by slot.' },
        slot: { type: 'string', description: 'For action=remove: the slot to drop, e.g. fact_3.' },
      },
      required: ['text'],
    };
  }

  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    try {
      if (!context.facts) throw new Error('fact memory is not available in this context');
      if (args.action === 'remove') {
        const removed = context.facts.remove(String(args.slot || ''));
        return removed ? success({ removed: args.slot, facts: context.facts.list() }) : failure(`${args.slot} does not exist`);
      }
      const ledger = context.permissions;
      if (!ledger) throw new Error('no permission ledger for this task');
      const written = context.facts.write(
        { text: String(args.text || ''), proof: args.proof, source: args.source, slot: args.slot },
        context.taskId,
        ledger,
      );
      if ('ok' in written && written.ok === false) return failure(`${written.reason}${written.needs ? ` — ${written.needs}` : ''}`);
      return success({ fact: written, facts: context.facts.list().map((fact) => ({ slot: fact.slot, text: fact.text })) });
    } catch (error) {
      return failure(error);
    }
  }
}
