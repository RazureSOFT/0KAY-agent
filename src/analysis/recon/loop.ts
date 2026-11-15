import type { Planner, Worker, Summarizer, IntentSpec, WorkerResult } from './engine.js'
import type { Plan } from './plan.js'
import { reviewPlan, type ReviewResult } from './review.js'
import type { Situation } from './engine.js'
import type { ReconGraph } from './graph.js'

// The model side of the RECON loop, shared by the synchronous deep_scan tool and
// the background assessment tasks: one goals phase, one planner factory, one
// worker factory — so a task and a scan behave identically except for who
// started them and where their output goes.
//
// The planner and the worker are model calls, but everything that decides when
// to stop — the evidence requirement for proving, the coverage gate, the
// settlement, the budget — is code. A model is allowed to be optimistic; the
// loop is not.

// ── Prompt bodies ───────────────────────────────────────────────────────────
// Three templates drive the loop: goals, planner and worker. They speak in
// terms of this repo's own tool surface (recon_graph actions and a JSON reply
// envelope) and contain no provider-specific sections. Keeping them in one
// place is what makes a synchronous scan and a background task behave the
// same way.

/** Pull the first JSON object out of a model reply, fences and prose included. */
export function extractJson(text: string): any | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const candidates: string[] = []
  if (fenced) candidates.push(fenced[1].trim())
  const start = text.indexOf('{')
  if (start >= 0) {
    let depth = 0
    for (let i = start; i < text.length; i++) {
      if (text[i] === '{') depth++
      else if (text[i] === '}' && --depth === 0) {
        candidates.push(text.slice(start, i + 1))
        break
      }
    }
  }
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate)
    } catch {
      // try the next shape
    }
  }
  return null
}

// Ported from RECON goalsDefaultTmpl (+ its scope tail's minimal-scope rule,
// which this repo enforces in code via setScope(targets)).
const GOALS_PROMPT = `你是渗透测试目标分解器。你的职责是从用户输入中识别出**最终要达成的结果**，而不是规划攻击步骤。

**第一步（拆分目标之前先做）：抽取操作约束**
从「任务目标 / 任务描述」里识别操作员对【可以做什么、不可以做什么操作】的明确规定，写进 constraints 数组逐条登记（如果描述、目标中不涉及操作约束可以不进行提取）：
- deny：禁止的操作（如「不扫端口」「不得对生产环境做写/删操作」「禁止爆破」「不碰某子域」）。
- allow：明确允许/限定的操作范围（如「只允许被动侦察」「仅针对某域名」）。
- 约束 ≠ 目标，也 ≠ 攻击步骤：它是对操作行为边界的规定。
- **约束必须【自包含、写死具体目标】**：把「当前目标/当前端口/当前IP/当前域名/本站」这类**指代词**替换成任务目标/描述里的**具体值**。约束会被单独注入到执行阶段的提示里，脱离上下文后指代词无法判断指谁。
  例：目标是 https://abc.example.net → 写「只允许测试 abc.example.net」而不是「只允许测试当前目标」；「仅测目标端口 443，不扫其他端口」而不是「只测当前端口」。若原文只说「当前目标」但目标地址已明确，就把地址填进去。
- **只登记目标/描述里【明确写出或强调】的约束，严禁臆造**；拿不准类型时用 deny（更保守）。
- 若目标/描述里确实没有任何操作约束，constraints 留空。
登记完约束（如有）后，再进行下面的目标拆分。

**目标 = 最终可交付/可核验的结果**

**不是目标的内容（禁止列为目标）**：
- 信息收集、侦察、端点扫描
- 漏洞分析与验证过程
- 攻击步骤、利用手段
- 结果验证步骤

**拆分原则**：
- 用户描述的最终目标只有一个 → 输出一个
- 存在多个**相互独立**的最终交付物 → 分别列出
- 严禁臆造用户未提及的目标

测试资产范围由系统按 targets 字段登记（最小范围原则：只登记用户明确点到的那一个目标，绝不擅自放大——看到 xxx.example.com 就登记整个 example.com 会把范围扩到用户目标之外）。
回复 JSON：{"constraints":["..."],"goals":[{"text":"...","assets":["..."]}]}。`

// Ported from RECON plannerDefaultTmpl. Adaptations: 判目标 is engine-side
// (findings auto-prove behind the coverage gate, so the planner only dispatches
// directions), the planner is a JSON call without tools (its optional light
// probing section does not apply), and add_intent's batching maps to the
// intents array. The hard floor, dedup rules, depth-over-coverage, route
// diversity and serial-chain discipline are the original text.
const PLANNER_PROMPT = `你是一个网络安全平台授权渗透测试系统的"规划者"，被频繁唤醒（图一变就唤醒）。职责：读态势 → 判目标 → **只在确有未被覆盖的新方向时**补充探索意图。你是规划者、不是执行者：本轮所有产物只能是【生成/说清意图】，绝不在 plan 里把活干了。

**本轮该产出几个意图（先想清楚这条）**：
- **硬底线（最高优先）**：只要【目标未达成】且【当前没有任何 open 或 running 意图】（openIntents 为空且 runningIntents 为 0），本轮就【必须】产出至少一个向目标推进的意图——没有在跑的 work 可等、也没有在排队的方向时，产出 0 意图=任务停摆；哪怕已知方向都只在最近完成里，也要据下面 done/blocked 的判断另开一条或续派一条。
- 硬底线之外，**产出 0 个意图是正常结果，但要有正当理由**（不是"少派更稳"的默认）：①**已覆盖**——你想到的方向都已被仍在 open/running 的意图处理（换措辞重复生成已存在的意图是严重错误）；②**等待依赖**——下一步依赖当前在跑 work 的产出、而它还没出来（此时硬派会让下游拿不到前置而空转，应等下次唤醒图更新后再派）。
- 反过来：确有【未覆盖、且不依赖在跑 work】的新方向，或目标未达成且范围内仍有未测面，就该派——别把 0 意图当偷懒的默认。

**每次唤醒的决策流程**：

1. **完整态势已附在本轮输入里**（无需再调它）：goals+状态、openIntents/runningIntents、blockedIntents、recent facts（带出处 ← 上游）、coverage、traces。
   - **血缘**：recent facts 带出处（← 哪个意图产出），据此理解"哪些事实来自哪个方向、能否综合出新方向"。
   - **否定/存疑观察**（"端口关闭/不可注入"等）是 worker 的观察、不是定论：证据扎实、且手段已穷尽的才视为该方向暂时封住；只是"看起来像/只探一次"的，按【尚未探明】处理，若在范围内且无其它意图覆盖，默认派一条复核意图去证实或推翻（**同一否定方向至多复核一次**；复核后仍为否定、且证据合理，就尊重该结论、不再派）。
2. **判目标**：目标由系统根据落图的发现自动证明（带覆盖度门禁，未达实测值会被拒绝）——你只负责为逼近目标派方向；若你判断某目标其实已被已有发现证明，派一条意图让 worker 把证据落成 finding 即可。
   - ⚠️ **量化验收核对（严禁提前盖章）**：目标含可量化条件（覆盖度达 X%、拿到某权限）时，未达实测值就继续派补差意图；不得以"大体达成/核心已拿下"为由暗示收官。
3. **决定补哪些新方向**：**这里的"克制"只指【不重复已存在的意图】，不是"能少派就少派"**——目标未达成时，默认追问是"为逼近目标，还有哪些更深、更狠、尚未覆盖的打法"，而不是"是否可以收尾"。意图是【开放的探索方向】（不是固定类型/菜单），结合已知事实、资产、目标自判方向，逐一与 open + running + 最近完成 比对：
   - 已有 open/running 覆盖 → 不再生成（正在处理）。
   - 最近完成里出现过 → **先分辨它怎么停的，再决定**：done（正常跑完）→ 已覆盖，不原样重派；是否死路看它产出的事实结论、而非状态本身；仅出现【材料性新机理】（新事实/资产/参数/明显不同的打法）才重派，且写清与上次的不同；换措辞、"再试一次说不定行"不算，禁止重试。blocked/exhausted（预算耗尽、探到一半被掐断 / 模型或网络失败，中途没善终、信息不全）→ traces 里已有它实际做到哪、卡在哪——接近突破被预算掐 → 派"接上次进度继续"；纯外部故障没跑成 → 直接重派同方向；每次卡同一处 → 换打法/方向。依据永远是 traces 里的真实进度，不是状态本身。
   - 完全无任何意图覆盖的全新方向 → 生成。
   - **深度优先于覆盖度**：coverage 是下限/验收项、不是探索目标本身；发现高价值入口（可能通向 RCE/提权/数据外泄）后，优先派意图把那条路【往深打穿】，而不是为拉平覆盖度去铺广、逐个资产浅测。
   - **保持路线多样、别过早收敛**：目标未达成时，若现有意图都挤在同一条路线/入口，而存在【本质不同】的未覆盖方向（另一入口面/另一类资产/另一条利用链），优先补那条分歧方向，而不是在同一线上加同义意图（看实质差异，不看措辞）。理想是 2–3 条机理不同的路线并存（如"从上传链打"与"从认证绕过打"），某条交出【目标逼近】的证据后才把资源集中过去。**但多样性永远服从约束**：被 constraints 排除的入口面/端口/主机/操作，即使本质不同也绝不生成意图。
   - **串行利用链：分步派，别拆成并行。** 强依赖串行链（①→②→③，后一步依赖前一步的实际产出）：不要一次性并行下发（下游拿不到还不存在的前置只会重复/空转）；用 plan 数组把整条链记成待办（每步一条、needs 标依赖），本轮只派"前置已满足"的那步（通常第一步），待它产出 fact 后下次唤醒再派下一步。**"同一件事"别拆两条**（"确认触发点"和"触发触发点"是同一步）；只有【平行、互不依赖】的维度（如枚举多个不相关端点）才用多意图并行。
   - **探本意图时瞥见本意图之外的线索**：不要自己动手——把它写成意图派下去，或让 worker 在 fact 里点一句交回规划者。

4. **提交**：intents 数组一次提交筛出的新方向（最多 4 个最高价值的，不要拆成多轮挤牙膏）：
   - **text**：一句话自然语言描述该方向（测试目标完整地址 + 做什么 + 为什么），不套固定分类；去重主要靠它与已有意图比对。
   - **assets**：本方向要测试/攻击的目标资产原始标识（URL/主机/host:port，来自态势）——只要方向围绕具体资产就务必传，跨多资产就都传；纯全局侦察无具体资产才留空。
   - **derivedFrom**：本方向由哪些上游节点综合得出（可选）——多个事实结合产生一个意图就都传。
   - **priority**：0-10，越高越先执行。

不重复、不硬凑；但目标未达成、又有未覆盖且更深的打法时，该派就派。简洁、聚焦、高效。`

// Code-owned tail appended after the ported planner body — the mechanical
// rules this repo's engine depends on (reply envelope, caps, steering),
// kept out of the ported text so the two evolve independently (RECON's
// 段 [A]/[B] split).
// Engineering mode rewrites what the planner is aiming at.
//
// The recon planner above is written for proving facts about a target: its
// "depth over coverage", "keep routes diverse" and "don't wrap up early" notes
// all assume an adversary-facing surface. An engineering task changes a code
// base or a deployed system, and the failure modes are different — a plan that
// tests instead of changes, a plan that changes too much at once, a plan with no
// way to tell whether the change worked.
const PLANNER_ENGINEERING = `你是"工程任务"的规划者，被频繁唤醒。职责：读现状 → 判目标 → **只在确有未覆盖的改动方向时**补充意图。你是规划者、不是执行者：本轮产物只能是意图，绝不在 plan 里把改动做了。

【这一类任务的目标是什么】
目标是**让系统达到某个状态**（修好某个缺陷、加上某个能力、改掉某处行为），不是证明关于它的事实。因此：
- **能靠读代码/读配置回答的问题，不要派成"探测"意图**——读就够了，写成事实。
- 每个意图都要指向一次**改动**：改哪个文件/哪段配置/哪处调用，改成什么，改完怎么验证。
- 目标未达成、且没有 open/running 意图时，**必须**至少派一条推进意图；否则任务停摆。

【每次唤醒的决策流程】
1. **先判定现状**：给出的 recent facts 是已确认的现状（读了哪些文件、看到什么行为）。别把"我猜它大概是这么实现的"当成事实——没读过就派一条"读并确认"的意图。
2. **判目标**：目标由系统按落图的发现自动证明。如果你认为已有发现足够证明某个目标，派一条意图让 worker 把证据落成 finding。
3. **决定补哪些改动方向**，逐一与 open + running + 最近完成比对：
   - 已有 open/running 覆盖 → 不重复。
   - 最近完成里出现过 → 看它怎么停的：正常完成看产出的事实是否已解决该方向；被预算掐断（blocked/exhausted）→ 派"接上次进度继续"；纯外部故障 → 直接重派。
   - 全新方向 → 生成。
   - **改动要小到能一次验证**：一个意图只改一处行为，不要把"重构认证 + 加日志 + 改配置"塞进一条。相关但独立的改动拆成多条，用 plan 的 needs 串起来。
   - **先建立可回退的基线**：动手改之前，确认"改之前是什么样"（读一遍、跑一遍、或看测试）——没有基线就无法判断改动是否生效，也就无法证明目标达成。
   - **每步都要有验证方式**：改完怎么知道成了？跑哪个测试、看哪个输出、检查哪条配置。写不出验证的意图，说明方向还没想清楚。
   - **不要扩大范围**：只改目标要求的。顺手发现的其他问题写成事实或新意图交回，不夹带修改。
4. **提交**：intents 数组一次提交（最多 4 条），每条写清：改哪里 + 改成什么 + 怎么验证。

【工程任务的判断基准】
- 宁可多读一次、少改一次：搞错现状的改动比没改更贵。
- 一处改动引发的新问题优先于新方向：发现回归就先修回归。
- 不重复、不硬凑；但方向未达成、又有未覆盖的改动时，该派就派。`

const PLANNER_TAIL = `

【输出格式】回复 JSON only：
{"plan":[{"text":"...","needs":[]}],"intents":[{"text":"...","assets":["..."],"derivedFrom":["..."],"priority":5}]}
- "plan" 是整个目标的有序步骤链，每轮原样重申（正常工作就不要改）；"needs" 列前置 step id。
- "intents" 是本轮要试的方向（最多 4 条），priority 0-10，越高越先执行。
- 尊重 hints：它们是循环外的操舵。
- 绝不越过给定 scope。`

// Craft mode: study something observable, rebuild it, compare, refine.
//
// The loop is the same planner/worker machinery; what changes is what a goal
// means. A recon planner asks "what is true about this target". A craft planner
// asks "what does the original do, and how far is my rebuild from it" — and the
// evidence is a comparison, not a fact about the original.
const PLANNER_CRAFT = `你是"复刻任务"的规划者，被频繁唤醒。职责：读现状 → 判目标 → **只在确有未覆盖的复刻方向时**补充意图。你是规划者、不是执行者：本轮产物只能是意图。

【这类任务的循环是四步，不要跳过任何一步】
1. **观察（study）**：从**可观察的表面**记录原样——页面在各宽度下的样子、可见文字、量到的布局/配色/字体/间距、菜单展开后的状态、交互后的反应。不读源码、不读文件、不反编译（除非任务明确允许"深看"模式）。
2. **构建（build）**：用任务指定的语言/框架产出新项目。没有指定就选一个合理的默认，并在意图里写明选了什么、为什么。
3. **比对（check）**：把结果和原样逐项对照，**产出明确的差异清单**——不是"看起来差不多"，是"这一处配色不同、这一处间距差 4px、这一处交互没有反应"。网站按多个宽度检查。
4. **就绪（ready）**：差异清零或只剩可接受的项，给出打开/预览的方式。

【判断基准】
- **观察不足时不要构建**：没量到的布局只能靠猜，猜出来的复刻无法比对。宁可先派一条"量这一块"的意图。
- **一次只改一处可比对的差异**：一条意图修一个差异项，改完就能重新比对。把"配色 + 布局 + 字体"塞进一条，比对时分不清是谁生效。
- **比对结果决定下一步**：上一轮比对出的差异清单是下一轮意图的唯一来源，优先于"我觉得还应该加点什么"。
- **不要复制你无权复制的东西**：标志、照片、成段文字，没有确认授权就不要照搬；用占位符代替并在事实里写明。
- **深看模式（deep）**：只有任务明确开启时才允许读源码/文件/反编译产物。默认是干净室——只看表面。

【输出格式】回复 JSON only：
{"plan":[{"text":"...","needs":[]}],"intents":[{"text":"...","assets":["..."],"derivedFrom":["..."],"priority":5}]}
- "plan" 是 study → build → check → ready 的有序步骤链，每轮原样重申；"needs" 列前置 step id。
- "intents" 是本轮要做的方向（最多 4 条），每条写清：做哪一步（观察/构建/比对/就绪）、具体到哪一处、做完怎么验证。
- 尊重 hints：它们是循环外的操舵。
- 绝不越过给定 scope。`

// Ported in spirit from RECON's settleWrapUpPrompt (worker-facing there; here
// the settlement round is planner-dispatched).
const PLANNER_SETTLE_TAIL = `

【收尾轮（settlement=true）】你即将因预算耗尽收官：不要再开新方向，只派至多一条"把已识别但还没写回的内容逐条写回"的意图（让 worker 把已识别未落图的观察补记为 fact/finding），然后结束。`

const WORKER_PROMPT = `你是网络安全平台授权渗透测试系统的"执行者"(work agent)。你领到【一条意图】(一句话探索方向)，唯一职责：**完成这一条意图、把发现作为事实/发现报告、然后停止返回。**（本路径没有图写入工具，观察通过 JSON 交回。）

**边界（红线）**：
1. **只做你领到的这一条意图**。**探本意图时若瞥见本意图之外值得深挖的线索**（报错泄露的路径、可能与其它资产联动的点、疑似另一条利用链的入口），**在 fact 的文本里点一句交给规划者**。
2. 初次受阻（payload 被过滤 / 404 / 注入无回显）不代表已探透——把本意图的所有绕过手段走完再输出结论；
3. 只在授权范围内操作。若附有【操作约束】，那是最高优先级红线：每条命令/探测执行前先自检，违反即不做。

**只写真实看到的**：不要编造结果；工具失败就在 steps 里如实说。**否定结论也要记**（端口关闭/不可注入）——规划者据此决定是否复核。

回复 JSON only：
{"facts":[{"text":"..."}],"findings":[{"text":"..."}],"steps":[{"action":"...","detail":"...","ok":true}],"note":"..."}

- fact = 探索结论/观察（"login accepts POST /auth with JSON"），多个观察汇总成【一条】，带上证据（命令+关键输出行）。
- finding = **只有真实触发过、拿到可复现证据（请求/响应或命令输出）的缺陷**才写。严禁把"版本/指纹匹配到 CVE""参数看起来可注入""外部漏洞库推断"当已确认；触发不了但有嫌疑 → 写成 fact（嫌疑点+为何未触发）。`

// Ported from RECON workerDefaultTmpl: the single mandate, the three red lines
// and the write-back discipline (consolidate, increments only, real evidence,
// negative results recorded, findings only with reproducible triggers) — with
// the write-back tools mapped to recon_graph actions and the final summary
// envelope kept as this repo's fallback contract.
const WORKER_SUBAGENT_PROMPT = `你是一个网络安全平台授权渗透测试系统的"执行者"(work agent)。你领到【一条意图】(一句话探索方向)，唯一职责：**完成这一条意图、把发现写回知识图谱、然后停止返回。** 你有真实工具（bash、http_request、osint 等），探测必须真实执行——"我会测 X"不是结果，要跑出来。

**边界（红线）**：
1. **只做你领到的这一条意图**。**探本意图时若瞥见本意图之外值得深挖的线索**（报错泄露的路径、可能与其它资产联动的点、疑似另一条利用链的入口），**在 fact 的文本里点一句交给规划者**。
2. 初次受阻（payload 被过滤 / 404 / 注入无回显）不代表已探透——把本意图的所有绕过手段走完再输出结论；
3. 只在授权范围内操作。若附有【操作约束】，那是最高优先级红线：每条命令/探测执行前先自检，违反即不做（哪怕它落在你领到的意图里）。

**边发现边写回**（写进图才算数，脑子/文字里的不算；每得一个结果立刻写，别攒到最后被步数耗尽丢掉）。三种写回，别串：
- **新资产/资源 → insert_assets（资产图）**：子域 / service / endpoint / 指纹 / 凭据 等一切资产【本身】。**这里只登记资产；探索结论/判断不写这里，用 record_fact。**
- **探索结论/事实 → record_fact（探索图，传 intent_id）**：都用它。**多个观察汇总成【一条】事实**（summary=一句总结，detail=相关细节），不要一个属性一条、一意图通常只一条，拆碎会让图谱无限膨胀——**默认就写一条，能并进去的都并进去**；仅当确有【彼此完全独立、无法归并】的结论时才分条，这是极少数例外，不是常规。**只写增量**：只记这次【新得到】的，别把已有事实换措辞重记（只印证已有、无新增就不必记）。**只写真实看到的**：evidence（命令+最能证明的一两行输出，简洁）、confidence（observed=直接看到 / inferred=据现象推断）。**否定结论**（端口关闭/不可注入）也要记——规划者据此决定是否复核。
- **确认漏洞 → report_finding（探索图，传 intent_id）**：**只有你本次真实触发过、拿到可复现证据（请求/响应或命令输出）才用**。严禁把"版本/指纹匹配到 CVE""参数看起来可注入""外部漏洞库/更新日志/代码 diff 推断"当已确认，也不要用查 CVE 库或对比补丁版本替代实际触发。触发不了但有嫌疑 → 用 record_fact 记一条（嫌疑点+为何未触发）交规划者，别硬记成 finding。

完成本意图后，最后单独输出一段 JSON 总结（这是系统读取的契约）：
{"steps":[{"tool":"bash","action":"...","detail":"...","ok":true}],"note":"一句话：做了什么、得到哪些关键结论","facts":[],"findings":[]}
"steps" 列你实际执行过的**工具调用**与结果，一条调用一条记录：
- "tool" 写你实际用的工具名（bash / httpx / read / grep / webfetch / recon_graph …），不是工具就用 "step"。
- "action" 写动作（命令行、请求行、要读的文件），"detail" 写看到的关键输出（截断到一行）。
- 不要把推理过程写进 steps：没有发生工具调用的思考不是 step。
facts/findings 留空——已写回图；只有确实无法用 record_fact/report_finding 写回的观察才作兜底写在这里。`

// Ported from RECON renderWorkerGraphOverview: the read-only situation frame —
// awareness without mandate creep, coverage deliberately removed.
function workerOverviewFrame(overviewJson: string): string {
  return `\n\n【全局探索态势（只读，帮你把自己这条意图放进大局看）】：
下面是整个任务当前的探索概况。用途有两个：一是知道别人已发现什么，别重复；二是让你探自己这条意图时，能联想到它和全局的关系。
**发散是好事**：探本意图时尽管深想、多联想。唯一的界线是——别真的动手去执行别的意图（那是别的 worker 的事，由规划者调度）。但凡你联想到有价值的线索（跨资产的联动、疑似另一条利用链的入口、全局层面的可疑点），**务必写进 fact 交规划者**——这是你重要的产出，不是可有可无。
${overviewJson}`
}

const DIGEST_PROMPT = `Summarize what these finished exploration steps established, in one sentence a planner can act on: what was tried, what it showed. Reply with the sentence only.`

/**
 * What the loop needs from its host. `llm` is a bare completion; `subagent`,
 * when given, runs a real agent loop with tools — workers prefer it and fall
 * back to `llm` when it is absent.
 */
export interface LoopRequest {
  systemPrompt: string
  messages: Array<{ role: 'user'; content: string }>
  temperature?: number
  model?: string
}

export interface LoopRuntime {
  llm: (request: LoopRequest) => Promise<string | null>
  subagent?: (prompt: string, agentType?: string) => Promise<string>
  /** The same runner with options overlaid; a task passes its permission mode here. */
  subagentWith?: (prompt: string, agentType: string | undefined, options: Record<string, string>) => Promise<string>
}

export interface LoopContext {
  objective: string
  /**
   * Engineering tasks aim at changing something (a code base, a deployed
   * service) rather than at proving facts about it. The machinery is identical;
   * the prompt framing is not.
   */
  kind?: 'recon' | 'engineering' | 'craft'
  /** Rendered "never leave it" scope line shared by every prompt. */
  scopeLine: string
  constraints: string[]
  fallbackAssets: string[]
  /** The graph, when the host wants workers to write back during execution. */
  graph?: ReconGraph
  /** Model override for this task's model calls; empty = the executor's active model. */
  model?: string
  /**
   * What this task's workers may do without asking.
   *
   * Absent means the caller's setting, which is what every task created before
   * this field did. Present means the task decided, and a resume keeps deciding
   * the same way.
   */
  permissionMode?: 'normal' | 'full_access'
  /**
   * Called once per planner round with the verdict on that round's plan.
   *
   * The host writes these into the task transcript, which is what lets the UI
   * show every plan alongside its score and whether it was sent back.
   */
  onReview?: (round: ReviewOutcome) => void
}

/** One planner round as the UI needs to see it: the plan, the verdict, the note. */
export interface ReviewOutcome {
  round: number
  plan: Array<{ id: string; text: string; needs: string[] }>
  intents: string[]
  result: ReviewResult
  /** True when the planner was asked again because the reviewer said revise. */
  revised: boolean
}

/** One call before the loop: the objective becomes provable goals on the graph. */
export async function plantGoals(
  runtime: LoopRuntime,
  graph: ReconGraph,
  context: { objective: string; targets: string[]; model?: string },
): Promise<{ goalIds: string[]; constraints: string[] }> {
  for (const target of context.targets) graph.addAsset(target)
  let constraints: string[] = []
  let goals: Array<{ text: string; assets: string[] }> = []
  try {
    const reply = await runtime.llm({
      systemPrompt: GOALS_PROMPT,
      messages: [{ role: 'user', content: JSON.stringify({ objective: context.objective, targets: context.targets }) }],
      temperature: 0.2,
      ...(context.model ? { model: context.model } : {}),
    })
    const parsed = extractJson(reply || '')
    if (parsed) {
      constraints = (Array.isArray(parsed.constraints) ? parsed.constraints : [])
        .map((entry: any) => String(entry || '').trim()).filter(Boolean).slice(0, 4)
      goals = (Array.isArray(parsed.goals) ? parsed.goals : [])
        .map((entry: any) => ({ text: String(entry?.text || '').trim(), assets: Array.isArray(entry?.assets) ? entry.assets.map(String) : context.targets }))
        .filter((entry: any) => entry.text).slice(0, 4)
    }
  } catch { /* fall through to the single-goal fallback */ }
  if (!goals.length) goals = [{ text: context.objective, assets: context.targets }]
  const goalIds = goals.map((goal) => graph.addNode({ kind: 'goal', text: goal.text, assets: goal.assets }).id)
  return { goalIds, constraints }
}

/** The planner: situation in, up to three intents out, plan refreshed in passing. */
/**
 * Which planner a kind runs.
 *
 * Kept as one function so a new kind cannot be added without deciding its prompt:
 * the previous arrangement (`kind ? A : B`) silently sent every unknown kind to
 * the recon planner, which is how engineering mode spent a release running a
 * penetration-test planner with a different label.
 */
function plannerPromptFor(kind: LoopContext['kind']): string {
  if (kind === 'engineering') return PLANNER_ENGINEERING
  if (kind === 'craft') return PLANNER_CRAFT
  return PLANNER_PROMPT
}

export function makePlanner(runtime: LoopRuntime, plan: Plan, loop: LoopContext): Planner {
  const constraintLine = loop.constraints.length ? `\nConstraints: ${loop.constraints.join(' | ')}` : ''

  /** One planner call. `notes` is the reviewer's revision, when there is one. */
  const ask = async (situation: Situation, notes?: string) => {
    const reply = await runtime.llm({
      systemPrompt: `${plannerPromptFor(loop.kind)}\n\n${loop.scopeLine}${constraintLine}`,
      messages: [{
        role: 'user',
        content: JSON.stringify({
          objective: loop.objective,
          kind: loop.kind || 'recon',
          goals: situation.overview.goals,
          round: situation.round,
          settlement: situation.settlement || false,
          coverage: situation.overview.coverage,
          openIntents: situation.overview.openIntents,
          blockedIntents: situation.overview.blockedIntents,
          hints: situation.overview.hints,
          recent: situation.overview.recent,
          plan: situation.plan.steps.map((step) => ({ id: step.id, text: step.text, status: step.status })),
          readySteps: situation.ready.map((step) => ({ id: step.id, text: step.text })),
          traces: situation.traces,
          budget: situation.budget,
          // The reviewer's single revision request, if the plan was sent back.
          ...(notes ? { revisionRequested: notes } : {}),
        }),
      }],
      temperature: 0.2,
      ...(loop.model ? { model: loop.model } : {}),
    })
    const parsed = extractJson(reply || '')
    if (!parsed) return null

    const intents = (Array.isArray(parsed.intents) ? parsed.intents : [])
      .map((entry: any) => ({
        text: String(entry?.text || '').trim(),
        assets: Array.isArray(entry?.assets) ? entry.assets.map(String) : undefined,
        stepId: typeof entry?.stepId === 'string' ? entry.stepId : undefined,
        priority: entry?.priority != null ? Number(entry.priority) : undefined,
      }))
      .filter((intent: IntentSpec) => intent.text)
      .slice(0, 4)

    // Applied here rather than at the call site so a revised plan replaces the
    // rejected one in the same place — the transcript shows the plan that
    // actually runs, and the verdict attached to it.
    if (Array.isArray(parsed.plan) && parsed.plan.length) {
      try {
        plan.setAll(parsed.plan.map((entry: any) => ({ text: String(entry.text || ''), needs: entry.needs })))
      } catch {
        // A malformed plan must not kill the round; the intents still run.
      }
    }
    return { intents, planSteps: parsed.plan }
  }

  return async (situation) => {
    const first = await ask(situation)
    if (!first) return []

    // Review what the planner proposed, with the same situation the planner saw.
    // A reviewer that cannot run hands back `accept`, so this never blocks a
    // round — it only sends a plan back.
    const review = await reviewPlan(runtime, loop, {
      plan: plan.toJSON(),
      intentTexts: first.intents.map((intent: IntentSpec) => intent.text),
      situation: {
        goals: situation.overview.goals,
        coverage: situation.overview.coverage,
        recent: situation.overview.recent,
        hints: situation.overview.hints,
        traces: situation.traces,
      },
    })

    let intents = first.intents
    let revised = false
    if (review.verdict === 'revise' && review.revision) {
      // Exactly one revision attempt: a reviewer that keeps saying "revise" would
      // otherwise cost a model call per round with no bound.
      const second = await ask(situation, review.revision)
      if (second) {
        intents = second.intents
        revised = true
      }
    }
    if (review.verdict === 'reject') {
      // The round produces nothing. The plan stays as the reviewer last saw it so
      // the next round's planner starts from the same context.
      intents = []
    }

    loop.onReview?.({
      round: situation.round,
      plan: plan.toJSON().map((step) => ({ id: step.id, text: step.text, needs: step.needs })),
      intents: intents.map((intent: IntentSpec) => intent.text),
      result: review,
      revised,
    })
    return intents
  }
}

/** The worker: a real tool-carrying sub-agent when the host provides one, a JSON completion otherwise. */
export function makeWorker(runtime: LoopRuntime, loop: LoopContext): Worker {
  const constraintLine = loop.constraints.length ? `\nConstraints: ${loop.constraints.join(' | ')}` : ''
  const parse = (text: string): WorkerResult => {
    const parsed = extractJson(text || '')
    if (!parsed) return { note: 'worker returned nothing parseable' }
    return {
      facts: Array.isArray(parsed.facts) ? parsed.facts.map((entry: any) => ({ text: String(entry?.text || '') })).filter((entry: any) => entry.text) : [],
      findings: Array.isArray(parsed.findings) ? parsed.findings.map((entry: any) => ({ text: String(entry?.text || '') })).filter((entry: any) => entry.text) : [],
      steps: Array.isArray(parsed.steps)
        ? parsed.steps.map((entry: any) => ({
            // A step without a tool name is a step, not a tool call: `step` is the
            // marker the UI uses to pick a different icon and no monospace body.
            tool: String(entry?.tool || 'step'),
            action: String(entry?.action || 'step'),
            detail: String(entry?.detail || ''),
            ok: entry?.ok !== false,
          }))
        : [],
      note: typeof parsed.note === 'string' ? parsed.note : undefined,
    }
  }
  return async (intent: IntentSpec): Promise<WorkerResult> => {
    // What this direction already produced (a re-queued intent after a pause or
    // a crash): the worker continues from there instead of repeating it.
    let priorLine = ''
    if (intent.id && loop.graph) {
      const prior = loop.graph
        .edgesOut()
        .filter((edge) => edge.src === intent.id && edge.rel === 'yields')
        .map((edge) => loop.graph!.node(edge.dst)?.text)
        .filter(Boolean) as string[]
      if (prior.length) priorLine = `\n\n【该方向已产出（不要重复，从没做完的部分继续）】：\n${prior.map((entry) => `- ${entry}`).join('\n')}`
    }
    const subagentBrief = [
      WORKER_SUBAGENT_PROMPT,
      '',
      loop.scopeLine,
      ...(loop.constraints.length ? [`Constraints: ${loop.constraints.join(' | ')}`] : []),
      `\n【你领到的意图（本次唯一任务：只做这一条、只产生资产/事实/finding、做完即停）】：\n${intent.text}`,
      `意图 id: ${intent.id || 'n/a'}（record_fact / report_finding / insert_assets 传 intent_id）`,
      `Assets: ${(intent.assets || loop.fallbackAssets).join(', ')}`,
      priorLine,
      ...(intent.overview ? [workerOverviewFrame(intent.overview)] : []),
    ].filter((line) => line !== undefined).join('\n')
    // The worker runs under the task's permission mode, not the caller's.
    // `subagentWith` is how that mode is applied without rebuilding the runner:
    // the task outlives the conversation, so the decision has to travel with it.
    const runner = runtime.subagentWith && loop.permissionMode
      ? (prompt: string, agentType?: string) =>
          runtime.subagentWith!(prompt, agentType, { permission_mode: loop.permissionMode! })
      : runtime.subagent
    if (runner) {
      try {
        return parse(await runner(subagentBrief))
      } catch (error: any) {
        return { note: `worker failed: ${error?.message || error}` }
      }
    }
    const reply = await runtime.llm({
      systemPrompt: `${WORKER_PROMPT}\n\n${loop.scopeLine}${constraintLine}`,
      messages: [{ role: 'user', content: JSON.stringify({ goal: loop.objective, intent: intent.text, assets: intent.assets || loop.fallbackAssets }) }],
      temperature: 0.2,
      ...(loop.model ? { model: loop.model } : {}),
    })
    return parse(reply || '')
  }
}

export function makeSummarizer(runtime: LoopRuntime): Summarizer {
  return async (texts) => {
    const reply = await runtime.llm({ systemPrompt: DIGEST_PROMPT, messages: [{ role: 'user', content: texts.join('\n') }], temperature: 0.1 })
    return String(reply || '').trim()
  }
}
