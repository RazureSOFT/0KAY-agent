// A craft project on disk.
//
// Craft Anything is a four-stage loop — Study, Build, Check, Ready — and the
// thing that makes it a loop rather than a prompt is the project directory: the
// study is captured once and reused for every round, each check is a durable
// artifact with a score and a mismatch list, change requests land in an inbox,
// and "Ready" is a decision recorded in craft.json rather than an opinion in a
// chat bubble.
//
//   <root>/
//     craft.json                 state machine, rounds, scores, inbox
//     capture/study/*.png        the original, one full-page shot per width
//     capture/build/round-N/    the rebuild, same widths, same viewport
//     app/                      the rebuild that a person can open
//     checks/round-N.{json,md}  "how alike" + the mismatch list + hotspots
//     checks/diff-*.png         highlighted difference images
//     checks/report.md          the latest report
//     investigation.cany/       study notes, evidence confidence, limitations
//     inbox/                    change requests, one Markdown file each
//
// Clean room is enforced here, not left to the model: in clean_room mode the
// original's markup is never written to disk or returned to a caller. Only
// visible text, computed styles, geometry, interaction states and pixels are.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeFileAtomic } from '../../tools/atomic_write.js';
import {
  observeAll, checkAll, checkReportMarkdown, localUrlFor, summarizeObservation,
  CHECK_WIDTHS, type Observation, type CraftMode, type ObserveOptions,
  type CheckResult, type CheckOptions,
} from './observe.js';

export type CraftStage = 'study' | 'build' | 'check' | 'ready';

export const CRAFT_STAGES: CraftStage[] = ['study', 'build', 'check', 'ready'];

/** Default "how alike" required before a project may be called Ready. */
export const DEFAULT_THRESHOLD = 95;

export interface CraftEvidenceRow {
  width: number;
  source: string;
  confidence: number;
  coverage: number;
  limitations: string[];
}

export interface CraftStudyRow {
  url: string;
  at: string;
  widths: number[];
  screenshots: string[];
  /** Relative to the project root. */
  observations: string;
  title: string;
  visibleText: string;
  evidence: CraftEvidenceRow[];
  errors: Array<{ width: number; error: string }>;
}

export interface CraftBuildRow {
  at: string;
  round: number;
  note: string;
  files: string[];
}

export interface CraftWidthScore {
  width: number;
  element: number;
  pixel?: number;
  differences: number;
}

export interface CraftCheckRow {
  round: number;
  at: string;
  overall: number;
  element: number;
  pixel?: number;
  differences: number;
  confidence: number;
  limitations: string[];
  widths: CraftWidthScore[];
  /** Paths relative to the project root. */
  report: string;
  json: string;
  diffImages: string[];
  ready: boolean;
}

export interface CraftInboxItem {
  id: string;
  at: string;
  text: string;
  applied: boolean;
  /** The check round this request was written against. */
  round: number;
  file: string;
}

export interface CraftProjectState {
  version: 1;
  id: string;
  objective: string;
  target: string;
  mode: CraftMode;
  stage: CraftStage;
  /** Number of completed checks. Round 1 is the first build. */
  round: number;
  threshold: number;
  createdAt: string;
  updatedAt: string;
  study?: CraftStudyRow;
  build?: CraftBuildRow;
  checks: CraftCheckRow[];
  inbox: CraftInboxItem[];
  best?: { round: number; overall: number };
  limitations: string[];
  readyAt?: string;
}

export interface CraftProjectInit {
  objective?: string;
  target?: string;
  mode?: CraftMode;
  threshold?: number;
}

/** Injectable observation, so a project can be exercised without a browser. */
export interface CraftIO {
  observeAll(url: string, options: ObserveOptions): Promise<Observation[]>;
}

const defaultIO: CraftIO = { observeAll };

export interface CraftArtifact {
  kind: 'capture' | 'app' | 'check' | 'investigation' | 'inbox' | 'state';
  name: string;
  /** Path relative to the project root. */
  file: string;
  bytes: number;
  at: string;
}

const MAX_CHECKS = 60;
const MAX_INBOX = 200;

export class CraftProject {
  private constructor(
    readonly root: string,
    readonly state: CraftProjectState,
    private readonly io: CraftIO,
  ) { }

  /** Open an existing project, or create the whole directory layout for a new one. */
  static async open(root: string, init: CraftProjectInit = {}, io: CraftIO = defaultIO): Promise<CraftProject> {
    const absolute = path.resolve(root);
    const dirs = [
      absolute,
      path.join(absolute, 'capture', 'study'),
      path.join(absolute, 'capture', 'build'),
      path.join(absolute, 'app'),
      path.join(absolute, 'checks'),
      path.join(absolute, 'investigation.cany'),
      path.join(absolute, 'inbox'),
    ];
    for (const dir of dirs) await fs.mkdir(dir, { recursive: true });

    const file = path.join(absolute, 'craft.json');
    let state: CraftProjectState | undefined;
    try {
      state = JSON.parse(await fs.readFile(file, 'utf8')) as CraftProjectState;
    } catch { /* a fresh project, or a damaged one we recreate below */ }
    if (!state || state.version !== 1) {
      const now = new Date().toISOString();
      state = {
        version: 1,
        id: `craft_${randomUUID().slice(0, 8)}`,
        objective: init.objective || 'Recreate the studied surface',
        target: init.target || '',
        mode: init.mode || 'clean_room',
        stage: 'study',
        round: 0,
        threshold: init.threshold ?? DEFAULT_THRESHOLD,
        createdAt: now,
        updatedAt: now,
        checks: [],
        inbox: [],
        limitations: [],
      };
      await writeFileAtomic(file, `${JSON.stringify(state, null, 2)}\n`);
    }
    // Fields added after a project was created are filled in on read, so an old
    // craft.json does not crash a resumed task.
    state.checks ||= [];
    state.inbox ||= [];
    state.limitations ||= [];
    state.threshold ??= DEFAULT_THRESHOLD;
    return new CraftProject(absolute, state, io);
  }

  /** Absolute paths for the standard folders. */
  paths(): Record<'capture' | 'study' | 'build' | 'app' | 'checks' | 'investigation' | 'inbox' | 'state' | 'entry' | 'report', string> {
    return {
      capture: path.join(this.root, 'capture'),
      study: path.join(this.root, 'capture', 'study'),
      build: path.join(this.root, 'capture', 'build'),
      app: path.join(this.root, 'app'),
      checks: path.join(this.root, 'checks'),
      investigation: path.join(this.root, 'investigation.cany'),
      inbox: path.join(this.root, 'inbox'),
      state: path.join(this.root, 'craft.json'),
      entry: path.join(this.root, 'app', 'index.html'),
      report: path.join(this.root, 'checks', 'report.md'),
    };
  }

  private async save(): Promise<void> {
    this.state.updatedAt = new Date().toISOString();
    await writeFileAtomic(this.paths().state, `${JSON.stringify(this.state, null, 2)}\n`);
  }

  private rel(file: string): string {
    return path.relative(this.root, file).replace(/\\/g, '/');
  }

  // ---- Study ---------------------------------------------------------------

  /**
   * Capture the original once. Every later check reuses these observations, so
   * a refinement round cannot accidentally measure a changed target.
   */
  async study(url: string, options: ObserveOptions = {}): Promise<CraftStudyRow> {
    const target = url || this.state.target;
    if (!target) throw new Error('study needs a target URL');
    const { study, investigation } = this.paths();
    const observations = await this.io.observeAll(target, {
      ...options,
      screenshotDir: study,
      mode: options.mode ?? this.state.mode,
      captureInlineScreenshot: false,
    });

    const errors = observations
      .filter((row) => row.error)
      .map((row) => ({ width: row.width, error: row.error || 'unreadable' }));
    if (errors.length === observations.length) {
      throw new Error(`the original could not be rendered at any width: ${errors[0]?.error}`);
    }

    const observationsFile = path.join(investigation, 'study.json');
    await writeFileAtomic(observationsFile, `${JSON.stringify(storedObservations(observations, this.root, this.state.mode), null, 2)}\n`);

    const evidence: CraftEvidenceRow[] = observations.map((row) => ({
      width: row.width,
      source: row.evidence?.source || 'unknown',
      confidence: row.evidence?.confidence ?? 0,
      coverage: row.evidence?.coverage ?? 0,
      limitations: row.evidence?.limitations || [],
    }));
    const notes: string[] = [
      '# Study',
      '',
      `- Target: ${target}`,
      `- Mode: ${this.state.mode === 'clean_room' ? 'clean room (visible evidence only)' : 'deep (source markup allowed)'}`,
      `- Captured: ${new Date().toISOString()}`,
      `- Widths: ${CHECK_WIDTHS.join(', ')}px`,
      `- Title: ${observations.find((row) => row.title)?.title || '(none)'}`,
      '',
      '## What a visitor sees',
      '',
      '```text',
      (observations.find((row) => row.text)?.text || '(no visible text)').slice(0, 4000),
      '```',
      '',
      '## Capture',
      '',
      ...observations.map((row) => `- ${row.width}px: ${row.elements.length} visible elements, ${row.states?.length ?? 0} interactive controls — ${row.screenshot ? this.rel(row.screenshot) : 'no screenshot'}${row.error ? ` — ERROR ${row.error}` : ''}`),
      '',
      '## Interaction states',
      '',
      ...(observations[0]?.interactions || []).map((row) => `- ${row.label}: ${row.states.length} controls, ${row.elementCount} elements`),
    ];
    if (errors.length) notes.push('', '## Capture errors', '', ...errors.map((row) => `- ${row.width}px: ${row.error}`));
    await writeFileAtomic(path.join(investigation, 'study.md'), `${notes.join('\n')}\n`);
    await writeFileAtomic(path.join(investigation, 'evidence.md'), evidenceMarkdown(evidence, this.state.mode));

    const row: CraftStudyRow = {
      url: target,
      at: new Date().toISOString(),
      widths: observations.map((item) => item.width),
      screenshots: observations.flatMap((item) => item.screenshot ? [this.rel(item.screenshot)] : []),
      observations: this.rel(observationsFile),
      title: observations.find((item) => item.title)?.title || '',
      visibleText: (observations.find((item) => item.text)?.text || '').slice(0, 4000),
      evidence,
      errors,
    };
    this.state.target = target;
    this.state.study = row;
    this.state.stage = 'build';
    this.state.limitations = unique([...this.state.limitations, ...evidence.flatMap((item) => item.limitations), ...errors.map((item) => `${item.width}px: ${item.error}`)]);
    this.state.readyAt = undefined;
    await this.save();
    return row;
  }

  /** Load the study that `check` measures against. */
  async studyObservations(): Promise<Observation[]> {
    if (!this.state.study) throw new Error('study the surface before checking a rebuild');
    const file = path.join(this.root, this.state.study.observations);
    const rows = JSON.parse(await fs.readFile(file, 'utf8')) as Observation[];
    return resolvedObservations(rows, this.root);
  }

  // ---- Build ---------------------------------------------------------------

  /** Record a build round. The workers own `app/`; this records what they did. */
  async build(note: string, files: string[] = [], appliedIds: string[] = []): Promise<CraftBuildRow> {
    if (!this.state.study) throw new Error('study the surface before building');
    const row: CraftBuildRow = {
      at: new Date().toISOString(),
      round: this.state.round + 1,
      note,
      files: files.map((file) => this.rel(path.resolve(file))),
    };
    this.state.build = row;
    this.state.stage = 'build';
    this.state.readyAt = undefined;
    for (const item of this.state.inbox) {
      if (appliedIds.includes(item.id)) item.applied = true;
    }
    await this.save();
    await writeFileAtomic(path.join(this.paths().investigation, 'build.md'), [
      '# Build',
      '',
      `- Round: ${row.round}`,
      `- At: ${row.at}`,
      `- Note: ${row.note}`,
      ...(row.files.length ? ['', '## Files', '', ...row.files.map((file) => `- ${file}`)] : []),
      '',
    ].join('\n'));
    return row;
  }

  // ---- Check ---------------------------------------------------------------

  /**
   * Compare the rebuild against the study at every width, write the artifacts,
   * and move the state machine. A score below the threshold (or an open change
   * request) sends the project back to Build rather than declaring it Ready.
   */
  async check(rebuiltUrl?: string, options: CheckOptions & ObserveOptions = {}): Promise<CraftCheckRow> {
    const before = await this.studyObservations();
    const { app, build, checks } = this.paths();
    const url = rebuiltUrl || localUrlFor(app);
    if (!rebuiltUrl) {
      try { await fs.access(this.paths().entry); }
      catch { throw new Error(`no rebuild at ${this.paths().entry} — build the app before checking`); }
    }

    const round = this.state.round + 1;
    const captureDir = path.join(build, `round-${round}`);
    const checkDir = path.join(checks, `round-${round}`);
    await fs.mkdir(captureDir, { recursive: true });
    await fs.mkdir(checkDir, { recursive: true });
    const after = await this.io.observeAll(url, {
      screenshotDir: captureDir,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      mode: this.state.mode,
      states: options.states,
      captureInlineScreenshot: false,
    });
    const failed = after.filter((row) => row.error);
    if (failed.length === after.length) {
      throw new Error(`the rebuild could not be rendered at any width: ${failed[0]?.error}`);
    }

    const result: CheckResult = await checkAll(before, after, {
      ...(options.checkDir ? { checkDir: options.checkDir } : { checkDir }),
      ...(options.tolerance != null ? { tolerance: options.tolerance } : {}),
      ...(options.differenceImage != null ? { differenceImage: options.differenceImage } : {}),
    });

    const diffImages = result.checks.flatMap((row) => row.differenceImage ? [this.rel(row.differenceImage)] : []);
    const jsonFile = path.join(checkDir, 'check.json');
    const mdFile = path.join(checkDir, 'check.md');
    const widths: CraftWidthScore[] = result.comparisons.map((comparison) => ({
      width: comparison.width,
      element: comparison.similarity,
      ...(comparison.pixel && !comparison.pixel.error ? { pixel: comparison.pixel.similarity } : {}),
      differences: comparison.differences.length,
    }));
    const pending = this.state.inbox.filter((row) => !row.applied).length;
    const ready = result.overall >= this.state.threshold && pending === 0;

    const payload = {
      round,
      at: new Date().toISOString(),
      stage: ready ? 'ready' : 'check',
      rebuiltUrl: url,
      ...result,
      observed: {
        original: before.map(summarizeObservation),
        rebuild: after.map(summarizeObservation),
      },
      inboxPending: pending,
    };
    await writeFileAtomic(jsonFile, `${JSON.stringify(payload, null, 2)}\n`);
    const markdown = [
      `# Check — round ${round}`,
      '',
      `- Stage: **${ready ? 'Ready' : 'Check'}** (threshold ${this.state.threshold}%)`,
      `- Rebuild: ${url}`,
      `- Open change requests: ${pending}`,
      '',
      checkReportMarkdown(result),
    ].join('\n');
    await writeFileAtomic(mdFile, markdown);
    await writeFileAtomic(this.paths().report, markdown);
    await writeFileAtomic(path.join(checks, 'latest.json'), `${JSON.stringify(payload, null, 2)}\n`);

    const row: CraftCheckRow = {
      round,
      at: payload.at,
      overall: result.overall,
      element: result.similarity,
      ...(result.pixelSimilarity !== undefined ? { pixel: result.pixelSimilarity } : {}),
      differences: result.differenceCount,
      confidence: result.confidence,
      limitations: result.limitations,
      widths,
      report: this.rel(mdFile),
      json: this.rel(jsonFile),
      diffImages,
      ready,
    };
    this.state.round = round;
    this.state.checks = [...this.state.checks, row].slice(-MAX_CHECKS);
    if (!this.state.best || row.overall > this.state.best.overall) this.state.best = { round, overall: row.overall };
    this.state.limitations = unique([...this.state.limitations, ...result.limitations]).slice(-40);
    this.state.stage = ready ? 'ready' : 'check';
    if (ready) this.state.readyAt = row.at;
    else this.state.readyAt = undefined;
    await this.save();
    return row;
  }

  /** The actionable mismatch list from the latest check, for the planner. */
  async differences(): Promise<Array<{ width: number; kind: string; path: string; original: string; rebuilt: string; delta?: number }>> {
    const file = path.join(this.paths().checks, 'latest.json');
    let payload: CheckResult;
    try { payload = JSON.parse(await fs.readFile(file, 'utf8')) as CheckResult; }
    catch { return []; }
    return payload.comparisons.flatMap((comparison) => comparison.differences.map((difference) => ({
      width: comparison.width,
      kind: difference.kind,
      path: difference.path || 'page',
      original: difference.original || '',
      rebuilt: difference.rebuilt || '',
      ...(difference.delta != null ? { delta: difference.delta } : {}),
    })));
  }

  /** Per-width pass/fail, the list the task panel shows. */
  async checklist(): Promise<Array<{ width: number; element: number; pixel?: number; differences: number; pass: boolean }>> {
    const latest = this.state.checks.at(-1);
    if (!latest) return CHECK_WIDTHS.map((width) => ({ width, element: 0, differences: 0, pass: false }));
    return latest.widths.map((row) => {
      const perWidth = row.pixel === undefined ? row.element : Math.round(row.element * 0.5 + row.pixel * 0.5);
      return { ...row, pass: perWidth >= this.state.threshold && row.differences === 0 };
    });
  }

  // ---- Inbox / Ready -------------------------------------------------------

  /** A change request from the user. It reopens the project at Build. */
  async request(text: string): Promise<CraftInboxItem> {
    const line = text.trim();
    if (!line) throw new Error('a change request needs text');
    const id = `cr_${randomUUID().slice(0, 8)}`;
    const file = path.join(this.paths().inbox, `${id}.md`);
    const item: CraftInboxItem = {
      id, at: new Date().toISOString(), text: line, applied: false,
      round: this.state.round, file: this.rel(file),
    };
    await writeFileAtomic(file, [
      `# Change request ${id}`,
      '',
      `- At: ${item.at}`,
      `- Against check round: ${item.round}`,
      `- Status: open`,
      '',
      line,
      '',
    ].join('\n'));
    this.state.inbox = [...this.state.inbox, item].slice(-MAX_INBOX);
    this.state.stage = 'build';
    this.state.readyAt = undefined;
    await this.save();
    return item;
  }

  async pending(): Promise<CraftInboxItem[]> {
    return this.state.inbox.filter((row) => !row.applied);
  }

  async apply(ids: string[]): Promise<number> {
    let count = 0;
    for (const item of this.state.inbox) {
      if (!ids.includes(item.id) || item.applied) continue;
      item.applied = true;
      count += 1;
      const file = path.join(this.root, item.file);
      try {
        const text = await fs.readFile(file, 'utf8');
        await writeFileAtomic(file, text.replace('- Status: open', '- Status: applied'));
      } catch { /* the inbox file is a convenience; the ledger is the truth */ }
    }
    if (count) await this.save();
    return count;
  }

  /** Switch evidence policy. Clean room is the default and is enforced on disk. */
  async setMode(mode: CraftMode): Promise<void> {
    this.state.mode = mode === 'deep' ? 'deep' : 'clean_room';
    await this.save();
  }

  /** Change the "how alike" bar. Does not rewrite a Ready decision already made. */
  async setThreshold(value: number): Promise<void> {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new Error('threshold must be a number');
    this.state.threshold = Math.max(0, Math.min(100, Math.round(parsed)));
    await this.save();
  }

  /** A human decision: Ready even if the score is below the threshold. */
  async markReady(note = ''): Promise<void> {
    this.state.stage = 'ready';
    this.state.readyAt = new Date().toISOString();
    await this.save();
    await writeFileAtomic(path.join(this.paths().investigation, 'ready.md'), [
      '# Ready',
      '',
      `- At: ${this.state.readyAt}`,
      `- Best round: ${this.state.best?.round ?? 0} (${this.state.best?.overall ?? 0}%)`,
      ...(note ? [`- Note: ${note}`] : []),
      '',
    ].join('\n'));
  }

  // ---- reads for the panel -------------------------------------------------

  async summary(): Promise<Record<string, unknown>> {
    const latest = this.state.checks.at(-1);
    const checklist = await this.checklist();
    return {
      id: this.state.id,
      root: this.root,
      objective: this.state.objective,
      target: this.state.target,
      mode: this.state.mode,
      stage: this.state.stage,
      stages: CRAFT_STAGES.map((stage) => ({
        id: stage,
        done: CRAFT_STAGES.indexOf(stage) < CRAFT_STAGES.indexOf(this.state.stage) || this.state.stage === 'ready',
        active: stage === this.state.stage,
      })),
      round: this.state.round,
      threshold: this.state.threshold,
      best: this.state.best ?? null,
      latest,
      checklist,
      checks: this.state.checks.length,
      inbox: await this.pending(),
      limitations: this.state.limitations,
      readyAt: this.state.readyAt ?? null,
      study: this.state.study
        ? { url: this.state.study.url, widths: this.state.study.widths, evidence: this.state.study.evidence, screenshots: this.state.study.screenshots }
        : null,
      build: this.state.build ?? null,
      paths: {
        app: this.paths().app,
        entry: this.paths().entry,
        report: this.paths().report,
        checks: this.paths().checks,
        investigation: this.paths().investigation,
        inbox: this.paths().inbox,
      },
    };
  }

  /** The files a person may open from the task page. */
  async artifacts(): Promise<CraftArtifact[]> {
    const folders: Array<[CraftArtifact['kind'], string]> = [
      ['state', this.root],
      ['capture', path.join(this.root, 'capture')],
      ['app', this.paths().app],
      ['check', this.paths().checks],
      ['investigation', this.paths().investigation],
      ['inbox', this.paths().inbox],
    ];
    const out: CraftArtifact[] = [];
    const walk = async (kind: CraftArtifact['kind'], dir: string, depth: number): Promise<void> => {
      if (depth > 4) return;
      let names: string[];
      try { names = await fs.readdir(dir); } catch { return; }
      for (const name of names) {
        const file = path.join(dir, name);
        let stat;
        try { stat = await fs.stat(file); } catch { continue; }
        if (stat.isDirectory()) { await walk(kind, file, depth + 1); continue; }
        out.push({ kind, name, file: this.rel(file), bytes: stat.size, at: stat.mtime.toISOString() });
      }
    };
    // The root only contributes craft.json; the rest are walked.
    try {
      const stat = await fs.stat(this.paths().state);
      out.push({ kind: 'state', name: 'craft.json', file: 'craft.json', bytes: stat.size, at: stat.mtime.toISOString() });
    } catch { /* no state file yet */ }
    for (const [kind, dir] of folders.slice(1)) await walk(kind, dir, 0);
    return out.sort((a, b) => a.file.localeCompare(b.file));
  }
}

// ---- file helpers ----------------------------------------------------------

const ROOT_MARK = '@root/';

/** Screenshots are stored relative to the project so a moved folder still works. */
function storedObservations(rows: Observation[], root: string, mode: CraftMode): Observation[] {
  return rows.map((row) => ({
    ...row,
    ...(row.screenshot ? { screenshot: `${ROOT_MARK}${path.relative(root, row.screenshot).replace(/\\/g, '/')}` } : {}),
    screenshotDataUrl: undefined,
    // Clean room is a property of the project, not of the model's good manners:
    // the original's markup is never persisted where a build worker could read it.
    ...(mode === 'clean_room' ? { markup: undefined } : {}),
  }));
}

function resolvedObservations(rows: Observation[], root: string): Observation[] {
  return rows.map((row) => {
    if (!row.screenshot?.startsWith(ROOT_MARK)) return row;
    return { ...row, screenshot: path.join(root, row.screenshot.slice(ROOT_MARK.length)) };
  });
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function evidenceMarkdown(rows: CraftEvidenceRow[], mode: CraftMode): string {
  const lines = [
    '# Evidence',
    '',
    `- Mode: ${mode === 'clean_room' ? 'clean room — visible evidence only' : 'deep — source markup allowed'}`,
    `- Confidence: ${rows.length ? Math.min(...rows.map((row) => row.confidence)) : 0}%`,
    `- Coverage: ${rows.length ? Math.round(rows.reduce((total, row) => total + row.coverage, 0) / rows.length) : 0}%`,
    '',
    '## By width',
    '',
    ...rows.map((row) => `- ${row.width}px: ${row.source}, confidence ${row.confidence}%, coverage ${row.coverage}%`),
    '',
    '## Limitations',
    '',
    ...(unique(rows.flatMap((row) => row.limitations)).map((row) => `- ${row}`)),
  ];
  return `${lines.join('\n')}\n`;
}
