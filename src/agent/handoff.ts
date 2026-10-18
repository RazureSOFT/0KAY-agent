/**
 * Structured task handoff — a 0kay adaptation of Tianshu-harness's /handoff.
 *
 * Where the existing agent handoff is a small JSON blob for in-run compaction,
 * this renders a durable, human-readable handoff document (goal / result /
 * artifacts / evidence / blockers / next) that can be archived and injected
 * into a later session. Pure and dependency-free.
 */

export interface HandoffArtifact {
  path: string;
  usage?: string;
}

export interface HandoffInput {
  taskId: string;
  prompt: string;
  result: string;
  status?: string;
  artifacts?: HandoffArtifact[];
  evidence?: string[];
  limitations?: string;
  next?: string[];
  createdAt?: number;
}

function clip(text: string, max: number): string {
  const value = String(text || '').trim();
  return value.length > max ? `${value.slice(0, max)}\n…(truncated)` : value;
}

/** Render a structured handoff document as markdown. */
export function buildHandoffDoc(input: HandoffInput): string {
  const when = new Date(input.createdAt ?? Date.now()).toISOString();
  const lines: string[] = [];
  lines.push(`# 任务交接 — ${input.taskId || 'unknown'}`);
  lines.push('');
  lines.push(`生成时间: ${when}`);
  lines.push(`状态: ${input.status || 'done'}`);
  lines.push('');
  lines.push('## 目标');
  lines.push(clip(input.prompt, 2000) || '(未记录)');
  lines.push('');
  lines.push('## 结果');
  lines.push(clip(input.result, 4000) || '(未记录)');
  lines.push('');

  lines.push('## 产物');
  const artifacts = (input.artifacts || []).filter((a) => a && a.path);
  if (artifacts.length) {
    for (const a of artifacts) lines.push(`- \`${a.path}\`${a.usage ? ` — ${a.usage}` : ''}`);
  } else {
    lines.push('- (无)');
  }
  lines.push('');

  lines.push('## 验证证据');
  const evidence = (input.evidence || []).filter(Boolean);
  if (evidence.length) {
    for (const e of evidence) lines.push(`- ${e}`);
  } else {
    lines.push('- (无验证命令)');
  }
  lines.push('');

  lines.push('## 未决 / 限制');
  lines.push(clip(input.limitations || '', 2000) || '(无)');
  lines.push('');

  lines.push('## 下一步');
  const next = (input.next || []).filter(Boolean);
  if (next.length) {
    for (const n of next) lines.push(`- ${n}`);
  } else {
    lines.push('- (未指定)');
  }
  lines.push('');

  return lines.join('\n');
}

/**
 * Convert the compact JSON handoff the agent already produces into a HandoffInput
 * (so both stay in sync). Unknown/missing fields degrade gracefully.
 */
export function fromHandoffJson(taskId: string, prompt: string, json: string): HandoffInput {
  let parsed: any = {};
  try {
    parsed = JSON.parse(json || '{}');
  } catch {
    parsed = {};
  }
  const artifacts: HandoffArtifact[] = Array.isArray(parsed.artifacts)
    ? parsed.artifacts
        .filter((a: any) => a && typeof a.path === 'string')
        .map((a: any) => ({ path: a.path, usage: typeof a.usage === 'string' ? a.usage : '' }))
    : [];
  return {
    taskId,
    prompt,
    result: typeof parsed.outcome === 'string' ? parsed.outcome : '',
    artifacts,
    limitations: typeof parsed.limitations === 'string' ? parsed.limitations : '',
  };
}
