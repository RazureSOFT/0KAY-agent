// USER MESSAGE -> LIBRARY -> MODEL.
//
// Every prompt passes through here before it reaches a model. Three things
// happen, in this order, and nothing else:
//
//   1. classify. Greetings and other social turns are recognised so the loop can
//      skip the task lifecycle. A gate on "hello" teaches the model to lie about
//      being busy, and a task record for "thanks" is noise in the history.
//   2. learn. A correction ("no, I said X") becomes a rule that outlives the
//      turn, so the next session does not repeat the mistake. Rules are stored
//      per workspace because they are about a codebase, not a user.
//   3. inject. The rules that matched, plus the standing no-lying red line,
//      become a block the loop prepends to the turn.
//
// Keep this file free of model calls: it runs on every turn, and a classifier
// that costs a request would be paid for by every message.

import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';

export type TurnKind = 'chat' | 'task';

export interface LibraryRule {
  id: string;
  /** What the rule forbids or requires, one sentence. */
  text: string;
  /** Where it came from, so a bad rule can be traced and removed. */
  source: 'correction' | 'manual';
  /** The user sentence that produced it, kept for context. */
  origin: string;
  createdAt: number;
  hits: number;
}

export interface LibraryVerdict {
  kind: TurnKind;
  /** Short machine reason, useful in logs and in the UI's trace. */
  reason: string;
  /** Rules whose trigger matched this message. */
  rules: LibraryRule[];
  /** The block to prepend to the turn. Always non-empty. */
  injection: string;
  /** A correction this message contained, if any, already persisted. */
  learned?: LibraryRule;
}

const SOCIAL = [
  /^\s*(hi|hello|hey|yo|hiya|good\s+(morning|afternoon|evening)|gm)\b/i,
  /^\s*(thanks|thank\s+you|thx|ty|cheers|nice|great|awesome|perfect|ok(ay)?|k|cool|got\s+it|sure)\b[\s!.,)]*$/i,
  /^\s*(bye|goodbye|good\s+night|see\s+you|later|晚安|再见)\b/i,
  /^\s*(你好|您好|嗨|哈喽|在吗|早|早上好|中午好|晚上好|谢谢|多谢|感谢|好的|行|可以|收到|明白了|嗯|哦|哈哈)/,
];

/** A verb, a path, a command, or an artefact — the minimum for "a job to do". */
const WORK = [
  /\b(add|create|build|make|write|fix|change|update|refactor|remove|delete|rename|move|implement|install|run|test|check|verify|debug|optimi[sz]e|migrate|upgrade|downgrade|deploy|publish|release|document|explain|review|find|search|list|compare|generate|design|draw|translate|summari[sz]e|analy[sz]e)\b/i,
  /(帮我|请|麻烦|我要|我想|能不能|可以帮|改|修|加|写|做|建|删|查|跑|测|优化|重构|部署|发布|整理|生成|分析|翻译|解释|设计|对比|找|搜)/,
  /[\/\\][\w.-]+\.\w{1,6}\b/,
  /\b[\w.-]+\.(ts|tsx|js|jsx|vue|go|py|rs|java|json|md|css|ya?ml|toml|sh|ps1|sql|html)\b/i,
];

/** Sentences that take back an earlier instruction. */
const CORRECTION = /(不是|我是说|我说的是|我是让你|别这样|不要再|记住|以后都|你应该|不要用|改用|i\s+meant|not\s+what\s+i|i\s+said|don'?t|instead|next\s+time|remember)/i;

const MAX_RULES = 60;
const MAX_RULE_CHARS = 220;

function normalize(text: string): string {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

export function classifyTurn(message: string): { kind: TurnKind; reason: string } {
  const text = normalize(message);
  if (!text) return { kind: 'chat', reason: 'empty message' };
  const hasWork = WORK.some((pattern) => pattern.test(text));
  const hasPath = /[\/\\][\w.-]+\.\w{1,6}\b|\b[\w.-]+\.(ts|tsx|js|jsx|vue|go|py|rs|java|json|md|css|ya?ml|toml|sh|ps1|sql|html)\b/i.test(text);
  // Length is a weak but reliable signal: a task is usually spelled out. A
  // 120-character greeting is not a greeting.
  const long = text.length >= 120;
  if (hasPath) return { kind: 'task', reason: 'mentions a file or path' };
  if (hasWork && text.length >= 4) return { kind: 'task', reason: 'contains an action request' };
  if (long) return { kind: 'task', reason: 'long message, treated as a request' };
  if (SOCIAL.some((pattern) => pattern.test(text))) return { kind: 'chat', reason: 'social turn' };
  if (/[?？]$/.test(text) && text.length > 8) return { kind: 'task', reason: 'question' };
  return { kind: 'chat', reason: 'no action requested' };
}

export class RuleLibrary {
  private rules: LibraryRule[] = [];
  private readonly file: string;
  private loaded = false;
  private saveChain: Promise<void> = Promise.resolve();

  constructor(workspace: string) {
    const dir = path.join(workspace, '.0kay-agent');
    this.file = path.join(dir, 'rules.json');
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (Array.isArray(raw?.rules)) {
        this.rules = raw.rules
          .filter((rule: any) => rule && typeof rule.text === 'string')
          .slice(-MAX_RULES)
          .map((rule: any) => ({
            id: String(rule.id || randomUUID()),
            text: String(rule.text).slice(0, MAX_RULE_CHARS),
            source: rule.source === 'manual' ? 'manual' : 'correction',
            origin: String(rule.origin || '').slice(0, 400),
            createdAt: Number(rule.createdAt) || Date.now(),
            hits: Number(rule.hits) || 0,
          }));
      }
    } catch { /* no rules yet, or unreadable: start empty rather than fail the turn */ }
  }

  list(): LibraryRule[] {
    return this.rules.map((rule) => ({ ...rule }));
  }

  /** Await any queued disk write. Tests and shutdown use this; the turn never waits. */
  flush(): Promise<void> {
    return this.saveChain;
  }

  private persist(): Promise<void> {
    const snapshot = JSON.stringify({ rules: this.rules }, null, 2);
    this.saveChain = this.saveChain.then(async () => {
      try {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        await fs.writeFile(this.file, snapshot, 'utf8');
      } catch (error: any) {
        console.warn(`[Agent] could not persist rules: ${error?.message || error}`);
      }
    });
    return this.saveChain;
  }

  add(text: string, origin: string, source: LibraryRule['source'] = 'correction'): LibraryRule | undefined {
    const clean = normalize(text).slice(0, MAX_RULE_CHARS);
    if (!clean) return undefined;
    if (this.rules.some((rule) => rule.text.toLowerCase() === clean.toLowerCase())) return undefined;
    const rule: LibraryRule = { id: randomUUID(), text: clean, source, origin: normalize(origin).slice(0, 400), createdAt: Date.now(), hits: 0 };
    this.rules.push(rule);
    if (this.rules.length > MAX_RULES) this.rules.splice(0, this.rules.length - MAX_RULES);
    void this.persist();
    return rule;
  }

  remove(id: string): boolean {
    const index = this.rules.findIndex((rule) => rule.id === id);
    if (index < 0) return false;
    this.rules.splice(index, 1);
    void this.persist();
    return true;
  }

  /** Rules whose words overlap the message. Cheap on purpose: no model call. */
  match(message: string, limit = 6): LibraryRule[] {
    if (!this.rules.length) return [];
    const hay = normalize(message).toLowerCase();
    const tokens = new Set(hay.split(/[^a-z0-9_\u4e00-\u9fa5]+/).filter((token) => token.length >= 2));
    const scored: Array<{ rule: LibraryRule; score: number }> = [];
    for (const rule of this.rules) {
      const words = normalize(rule.text).toLowerCase().split(/[^a-z0-9_\u4e00-\u9fa5]+/).filter((word) => word.length >= 2);
      if (!words.length) continue;
      let hit = 0;
      for (const word of words) {
        if (tokens.has(word) || hay.includes(word)) hit++;
      }
      const score = hit / words.length;
      if (score >= 0.34) scored.push({ rule, score });
    }
    scored.sort((a, b) => b.score - a.score);
    const picked = scored.slice(0, limit).map((entry) => entry.rule);
    for (const rule of picked) rule.hits++;
    if (picked.length) void this.persist();
    return picked.map((rule) => ({ ...rule }));
  }
}

/**
 * The red line. Short on purpose: a preamble the model skips is worse than none,
 * and this one has to survive every compaction.
 */
export const RED_LINE = [
  'Non-negotiable ground rules for this conversation:',
  '- Never report work as done that you did not do. If a step failed, say it failed.',
  '- Never claim a command, test, or build passed unless you saw its output.',
  '- Never say an intent is complete while part of it is still missing. Name the gap instead.',
  '- If the user is factually wrong, say so directly and explain why before continuing.',
  '- If you cannot proceed, say what blocks you. Silence and invented success are the two worst outcomes.',
].join('\n');

export function buildInjection(rules: LibraryRule[], extra: string[] = []): string {
  const blocks = [RED_LINE];
  if (rules.length) {
    blocks.push(['Rules for this workspace (learned from earlier corrections; they override your defaults):', ...rules.map((rule) => `- ${rule.text}`)].join('\n'));
  }
  if (extra.length) blocks.push(['Session constraints:', ...extra.map((line) => `- ${line}`)].join('\n'));
  return blocks.join('\n\n');
}

/**
 * Turn a correction into a rule. Only explicit corrections qualify: guessing
 * intent from praise or complaint produces rules the user never asked for.
 */
export function extractRule(message: string): string | null {
  const text = normalize(message);
  if (text.length < 6 || text.length > 400) return null;
  if (!CORRECTION.test(text)) return null;
  const sentences = text.split(/(?<=[。！？.!?;；])\s*/).map((line) => line.trim()).filter(Boolean);
  const picked = sentences.find((line) => CORRECTION.test(line)) || text;
  const clean = picked.replace(/^(不对|错了|喂)[,，\s]*/i, '').trim();
  if (clean.length < 6) return null;
  return clean.slice(0, MAX_RULE_CHARS);
}

const libraries = new Map<string, RuleLibrary>();

/** One library per workspace; sessions in the same repo share their rules. */
export function libraryFor(workspace: string): RuleLibrary {
  const key = path.resolve(workspace);
  let library = libraries.get(key);
  if (!library) {
    library = new RuleLibrary(key);
    libraries.set(key, library);
  }
  return library;
}

export async function prepareTurn(workspace: string, message: string, extra: string[] = []): Promise<LibraryVerdict> {
  const library = libraryFor(workspace);
  await library.load();
  const { kind, reason } = classifyTurn(message);
  let learned: LibraryRule | undefined;
  if (kind === 'task') {
    const candidate = extractRule(message);
    if (candidate) learned = library.add(candidate, message, 'correction');
  }
  const rules = kind === 'task' ? library.match(message) : [];
  return {
    kind,
    reason,
    rules,
    injection: buildInjection(rules, extra),
    ...(learned ? { learned } : {}),
  };
}
