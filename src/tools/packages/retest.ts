// Retest a finding: actually try to reproduce it again.
//
// A finding is a claim. A week later the claim may be false — the bug was fixed,
// the host was rebuilt, the credentials stopped working. Answering "is it still
// there" cannot be a status field someone sets by hand; it has to be a fresh
// attempt, with the consequences recorded.
//
// This tool is the `retester`: a tool-carrying sub-agent that gets the finding,
// runs the same class of probe again, and must end by choosing one of three
// verdicts. `inconclusive` is a real answer — pretending either of the other two
// would be worse than admitting the evidence was not there.

import { Tool, type ToolContext, type ToolResult } from '../types.js';
import { failure, success } from '../helpers.js';

export type RetestVerdict = 'reproduced' | 'fixed' | 'inconclusive';

/** What the retest agent is asked to do, in the words it reads. */
function retestPrompt(input: { text: string; assets: string[]; vulnclass?: string; notes?: string }): string {
  return [
    '你是复测执行者。你的唯一任务：验证下面这条已报告的问题【现在是否仍然存在】。',
    '',
    `【问题】${input.text}`,
    input.vulnclass ? `【类型】${input.vulnclass}` : '',
    input.assets.length ? `【目标】${input.assets.join(', ')}` : '【目标】（未记录资产：从问题描述里判断该测哪里，判断不了就返回 inconclusive）',
    input.notes ? `【上次复测备注】${input.notes}` : '',
    '',
    '【要求】',
    '1. 用和当初同样的思路去验证，不是重新做一遍全量探测：把能证明或推翻这条问题的那个动作再做一次。',
    '2. 只在这条问题的目标范围内操作，不做其他探测。',
    '3. 记录你实际做了什么、看到什么（命令/请求 + 关键输出），这是 verdict 的依据。',
    '4. 结束后必须给出且只给出一个 verdict：',
    '   - reproduced：同样的手法再次成立，问题仍在',
    '   - fixed：同样的手法不再成立（被拒绝、被过滤、目标不存在）',
    '   - inconclusive：无法判断（目标不可达、凭据失效、动作做不完）',
    '   没有足够证据时选 inconclusive，不要为了给出结论而猜。',
    '',
    '【输出格式】JSON only：',
    '{"verdict":"reproduced|fixed|inconclusive","summary":"一句话结论","evidence":"实际执行了什么、看到什么"}',
  ]
    .filter(Boolean)
    .join('\n');
}

export class RetestTool extends Tool {
  get name(): string {
    return 'finding_retest';
  }

  get description(): string {
    return [
      'Retest a finding: run the same probe again to decide whether it still reproduces.',
      'Actions: start (begin a retest for a finding), list (retests of one finding), active (every retest currently running), stop (abandon one).',
      'A retest ends with a verdict — reproduced, fixed or inconclusive — and is recorded against the finding, so a person can see the history instead of a single mutable status.',
    ].join(' ');
  }

  get parameters(): Record<string, any> {
    return {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['start', 'list', 'active', 'stop'] },
        finding_id: { type: 'string', description: 'start/list/stop: the finding to retest.' },
        retest_id: { type: 'string', description: 'stop: the retest to abandon, from list.' },
        notes: { type: 'string', description: 'start: anything the retest should know (last verdict, what changed).' },
      },
    };
  }

  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    const manager = context.assessments;
    if (!manager) return failure('assessment tasks unavailable in this context');
    const store = manager.findings;

    try {
      switch (String(args.action || '')) {
        case 'start': {
          const findingId = String(args.finding_id || '').trim();
          if (!findingId) return failure('finding_id is required for start');
          const finding = store.get(findingId);
          if (!finding) return failure(`unknown finding: ${findingId}`);
          // Started and finished here, in one call: the agent that asks for the
          // retest is the one that runs it, so there is no queued state to poll.
          //
          // A refused start (one already running) is an outcome to report, not a
          // tool failure: the caller's next move is to wait or stop the other
          // one, and an error string would send it looking for a different bug.
          let record;
          try {
            record = store.startRetest(findingId, String(args.notes || ''));
          } catch (refused: any) {
            return success({ error: refused?.message || String(refused) });
          }
          store.markRunning(record.id);
          try {
            const reply = await runRetestAgent(context, finding, String(args.notes || ''));
            const done = store.complete(record.id, reply);
            // Recorded as its own lane in the task's session list: a retest is a
            // separate conversation, and a person expects to open it and read what
            // the retester did, not just see a verdict appear under a finding.
            void manager.recordRetestSession(finding.taskId, {
              findingId: finding.id,
              retestId: done.id,
              title: finding.text,
              ...(done.verdict ? { verdict: done.verdict } : {}),
            }).catch(() => {});
            return success({
              retest: done,
              finding: { id: finding.id, text: finding.text },
            });
          } catch (error: any) {
            const failed = store.fail(record.id, error?.message || String(error));
            void manager.recordRetestSession(finding.taskId, {
              findingId: finding.id,
              retestId: failed.id,
              title: finding.text,
            }).catch(() => {});
            return success({ retest: failed, error: failed.error });
          }
        }
        case 'list': {
          const findingId = String(args.finding_id || '').trim();
          if (!findingId) return failure('finding_id is required for list');
          return success({ retests: store.forFinding(findingId) });
        }
        case 'active':
          return success({ retests: store.activeRetests() });
        case 'stop': {
          const retestId = String(args.retest_id || '').trim();
          if (!retestId) return failure('retest_id is required for stop');
          if (!store.retest(retestId)) return failure(`unknown retest: ${retestId}`);
          return success({ retest: store.stop(retestId) });
        }
        default:
          return failure(`unknown action "${args.action}"; expected start, list, active or stop`);
      }
    } catch (error) {
      return failure(error);
    }
  }
}

/**
 * Run the probe again and read back a verdict.
 *
 * A verbatim or unparseable reply is `inconclusive`, not `reproduced`: the cost
 * of a wrong "still vulnerable" is a person re-doing work on a fixed bug, and a
 * missing answer is exactly what "we could not tell" means.
 */
export async function runRetestAgent(
  context: ToolContext,
  finding: { text: string; assets: string[]; vulnclass?: string },
  notes: string,
): Promise<{ verdict: RetestVerdict; summary?: string; evidence?: string }> {
  const prompt = retestPrompt({ ...finding, ...(notes ? { notes } : {}) });

  // A real sub-agent when the host provides one: it can carry tools and actually
  // probe. Without one, the model call alone still produces a judgement, which is
  // better than refusing to record anything.
  // `runSubAgent` is the synchronous form: it carries tools and returns the
  // child's final text. A real probe needs tools — a bare model call can only
  // reason about a claim, not test it — so that path is preferred, and the plain
  // call is the fallback for contexts without a sub-agent runner (tests).
  const raw = context.runSubAgent
    ? await context.runSubAgent(prompt, 'code_explore')
    : await context.llm?.({ systemPrompt: prompt, messages: [{ role: 'user', content: '验证这条问题现在是否仍然存在。' }], temperature: 0 } as any);

  return parseVerdict(raw || '');
}

export function parseVerdict(raw: string): { verdict: RetestVerdict; summary?: string; evidence?: string } {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return { verdict: 'inconclusive', summary: '复测没有给出可解析的结论' };
  let parsed: any;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return { verdict: 'inconclusive', summary: '复测结论无法解析' };
  }
  const value = String(parsed?.verdict || '').trim();
  const verdict: RetestVerdict =
    value === 'reproduced' ? 'reproduced' : value === 'fixed' ? 'fixed' : 'inconclusive';
  return {
    verdict,
    ...(parsed?.summary ? { summary: String(parsed.summary) } : {}),
    ...(parsed?.evidence ? { evidence: String(parsed.evidence) } : {}),
  };
}