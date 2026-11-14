// An independent reviewer for the planner's plan.
//
// The planner is one model in one frame of mind. When it writes a plan it has
// already decided what the plan is about, so it cannot see the dimensions it
// never considered: the operational one ("this works only if the target is
// reachable from here"), the evidence one ("nothing in the graph supports step
// 3"), the sequencing one ("step 4 needs credentials step 2 does not obtain").
//
// So a second call reads the same situation and the proposed plan and answers
// three questions: which dimensions does this plan hold up in, which does it
// collapse in, and what is the smallest change that fixes it. The verdict is
// `accept`, `revise` (the planner gets one more pass with the notes) or
// `reject` (the round produces no intents).
//
// Reviewing is deliberately cheap and bounded: one call, one revision attempt.

import type { LoopContext, LoopRuntime } from './loop.js'
import type { PlanStep } from './plan.js'

export type ReviewVerdict = 'accept' | 'revise' | 'reject'

/** One dimension the reviewer is asked to judge. */
export interface ReviewDimension {
  /** Stable id: `scope`, `evidence`, `sequencing`, `operability`, `effort`. */
  id: string
  /** What the dimension asks, in the reviewer's own words. */
  question: string
  /** `ok` means the plan holds up here. */
  verdict: 'ok' | 'weak' | 'fails'
  /** Why, in one sentence. Empty when ok. */
  note?: string
}

export interface ReviewResult {
  verdict: ReviewVerdict
  dimensions: ReviewDimension[]
  /** The single change that would most improve the plan. Empty on accept. */
  revision?: string
  /** Present when the reviewer could not run; the plan is then used as written. */
  error?: string
}

/**
 * The dimensions, stated once so both the prompt and the transcript agree.
 *
 * These are not generic "is this a good plan" checks: each one names a failure
 * this engine has actually seen — a plan that left the authorised scope, a plan
 * resting on facts nobody proved, a plan whose steps depend on an output that
 * no earlier step produces, a plan that assumes reachability it did not verify,
 * and a plan that spends rounds without moving the goal.
 */
export const REVIEW_DIMENSIONS: Array<{ id: string; question: string }> = [
  {
    id: 'scope',
    question: '计划里每一步是否都落在给定 scope 与 constraints 之内？（越界的步骤即使有效也必须判失败）',
  },
  {
    id: 'evidence',
    question: '计划依赖的事实是否已在图里被证明？依赖了未经证实的前提，或把"看起来像"当成前提，都是薄弱项。',
  },
  {
    id: 'sequencing',
    question: '步骤之间的依赖是否真实存在且被 needs 正确表达？有没有某一步需要前一步并未产出的东西？',
  },
  {
    id: 'operability',
    question: '这些步骤在当前条件下能否执行？（目标可达性、凭据、端口开放等运行前提有没有被假定）',
  },
  {
    id: 'effort',
    question: '这个计划的轮次投入是否与目标价值相称？有没有在低价值面上反复铺开而没往高价值路径深处走？',
  },
]

const REVIEWER_PROMPT = `你是授权评估系统的"计划评审者"。规划者刚写出一份计划，你独立审阅，不重复它的推理，只判断它在不同维度上是否站得住。

【评分维度】（逐条给出 ok / weak / fails，并附一句理由；ok 时理由留空）：
${REVIEW_DIMENSIONS.map((d) => `- ${d.id}：${d.question}`).join('\n')}

【判定】
- 全部 ok 或仅个别 weak（且 weak 不影响执行）→ "accept"
- 有 fails，或 weak 集中在会影响执行的维度 → "revise"，并给出【最小的那一个修改点】（不要重写整份计划）
- 计划的核心方向本身与目标或约束冲突（例如主要步骤越界、或整体答非所问）→ "reject"

【打回语的写法】
打回语要分层，先给大方向的对错，再收敛到具体小细节：
- 若大方向对、细节有问题：先确认方向（"整体思路成立"），再指出具体哪一步、缺什么、改成什么。
- 若大方向有问题：先说清是哪一维的偏离（结合维度 id），再说最小可行的纠正，不要罗列所有问题。
- 不要泛泛说"需要更详细"；每条意见都要能在计划里指出具体位置。

【输出格式】JSON only：
{"verdict":"accept|revise|reject","dimensions":[{"id":"scope","verdict":"ok|weak|fails","note":"..."}],"revision":"最小修改点，accept 时留空"}`

/**
 * Run the reviewer over a proposed plan.
 *
 * Never throws: a reviewer that fails (no model, unparseable reply) returns
 * `accept` with `error` set, because a plan nobody reviewed must still be able
 * to run — blocking the loop on the reviewer would turn a soft check into an
 * outage.
 */
export async function reviewPlan(
  runtime: LoopRuntime,
  loop: LoopContext,
  input: {
    plan: PlanStep[]
    intentTexts: string[]
    situation: Record<string, unknown>
  },
): Promise<ReviewResult> {
  const constraintLine = loop.constraints.length ? `\nConstraints: ${loop.constraints.join(' | ')}` : ''
  let reply: string | null = ''
  try {
    reply = await runtime.llm({
      systemPrompt: `${REVIEWER_PROMPT}\n\n${loop.scopeLine}${constraintLine}`,
      messages: [{
        role: 'user',
        content: JSON.stringify({
          // A stable marker: a fake runtime in tests routes by payload shape, and
          // without this the review call is indistinguishable from a planner call
          // (both carry the situation). Costs one field, removes a whole class of
          // test confusion.
          reviewer: true,
          objective: loop.objective,
          kind: loop.kind || 'recon',
          plan: input.plan.map((step) => ({ id: step.id, text: step.text, needs: step.needs, status: step.status })),
          intents: input.intentTexts,
          ...input.situation,
        }),
      }],
      temperature: 0,
      ...(loop.model ? { model: loop.model } : {}),
    })
  } catch (error: any) {
    return { verdict: 'accept', dimensions: [], error: error?.message || String(error) }
  }

  const parsed = extractJsonObject(reply || '')
  if (!parsed) {
    return { verdict: 'accept', dimensions: [], error: 'reviewer reply was not parseable JSON' }
  }

  const verdict = parsed.verdict === 'reject' ? 'reject' : parsed.verdict === 'revise' ? 'revise' : 'accept'
  const dimensions: ReviewDimension[] = []
  for (const raw of Array.isArray(parsed.dimensions) ? parsed.dimensions : []) {
    const id = String(raw?.id || '').trim()
    if (!id) continue
    const value = raw?.verdict === 'fails' ? 'fails' : raw?.verdict === 'weak' ? 'weak' : 'ok'
    dimensions.push({ id, question: REVIEW_DIMENSIONS.find((d) => d.id === id)?.question || '', verdict: value, ...(raw?.note ? { note: String(raw.note) } : {}) })
  }
  return {
    verdict,
    dimensions,
    ...(parsed.revision ? { revision: String(parsed.revision) } : {}),
  }
}

function extractJsonObject(text: string): Record<string, any> | null {
  if (!text) return null
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const value = JSON.parse(text.slice(start, end + 1))
    return value && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}