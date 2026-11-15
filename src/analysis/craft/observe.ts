// Studying an observable surface, and measuring how far a rebuild has drifted.
//
// "Recreate this page" is only honest if the second half is a measurement. A
// comparison that says "looks close" is an opinion; a comparison that says
// "header background is #2563eb here and #3b82f6 there, at 1280 wide" is a task
// someone can finish. Everything here serves that second kind.
//
// Two observations are taken the same way — same widths, same viewport height,
// same wait, same interaction states — so the only variable left is the page.
//
// There are two kinds of evidence and they answer different questions:
//   * the live probe — computed styles, real geometry, visible text, interactive
//     state — says *what* to change;
//   * the screenshot diff — says *whether* the change helped, including the
//     things an element list cannot see (gradients, illustrations, font raster).
// A craft check reports both, plus the confidence and limitations of the
// evidence, because a number without its coverage is a guess with a % sign.

import * as fs from 'fs/promises';
import * as path from 'path';
import { renderWithBrowser, PROBE_PROPERTIES, type BrowserAction } from '../../tools/browser_driver.js';
import { decodePng, encodePng, comparePixels, type PixelRegion } from './pixels.js';

/** The widths a website is compared at. Narrow, tablet, desktop. */
export const CHECK_WIDTHS = [390, 768, 1280] as const;

export const VIEWPORT_HEIGHT = 900;

/** How many visible elements one probe reads before it stops. */
export const MAX_OBSERVED_ELEMENTS = 400;

/**
 * clean_room: only what a visitor can see is evidence — rendered pixels,
 * computed styles, visible text, interactive state. Source markup and network
 * are deliberately withheld, so a rebuild cannot be a copy-paste job.
 * deep: the rendered markup is kept as evidence too.
 */
export type CraftMode = 'clean_room' | 'deep';

export interface ElementState {
  hidden: boolean;
  disabled: boolean;
  checked: boolean;
  expanded?: string | null;
  selected?: string | null;
}

export interface ObservedElement {
  /** A path that is stable across a rebuild: tag + role + ordinal within parent. */
  path: string;
  tag: string;
  role?: string;
  text?: string;
  /** Computed style properties that decide how it looks. */
  style: Record<string, string>;
  rect: { x: number; y: number; width: number; height: number };
  /** The control's state at the moment of the probe. */
  state?: ElementState;
}

/** One interactive control, read after the page has settled. */
export interface InteractiveState {
  tag: string;
  label: string;
  expanded?: string | null;
  selected?: string | null;
  open?: boolean | null;
  checked?: boolean | null;
  value?: string | null;
}

/**
 * A named page state. A craft check reads "menus opened" as well as the
 * resting page, so a rebuild that never wires the menu up is still caught.
 */
export interface InteractionSnapshot {
  label: string;
  states: InteractiveState[];
  text: string;
  elementCount: number;
}

export interface Evidence {
  source: 'live' | 'static' | 'unavailable';
  /** 0-100: how much the numbers below can be trusted. */
  confidence: number;
  /** 0-100: how much of the surface was actually read. */
  coverage: number;
  limitations: string[];
}

export interface Observation {
  url: string;
  width: number;
  height: number;
  title: string;
  /** Visible text, whitespace-collapsed, so wording can be compared. */
  text: string;
  elements: ObservedElement[];
  /** Full-page screenshot on disk, when one was taken. */
  screenshot?: string;
  /** Inline PNG, only for callers that explicitly ask for it. */
  screenshotDataUrl?: string;
  states?: InteractiveState[];
  interactions?: InteractionSnapshot[];
  scroll?: { width: number; height: number };
  probeLabels?: string[];
  probeErrors?: string[];
  mode?: CraftMode;
  /** Source markup, deep mode only. Never populated in clean room. */
  markup?: string;
  evidence?: Evidence;
  /** Set when the surface could not be read at all. */
  error?: string;
}

/** A named interaction to replay before a probe, e.g. opening a menu. */
export interface CraftStateSpec {
  label: string;
  interactions: BrowserAction[];
}

/**
 * The resting page plus the states a visitor actually reaches.
 *
 * The resting page is always read; these two are the extra states that catch a
 * rebuild which never wires its menu up. Each selector list is ordered
 * most-specific first, and the browser backend clicks the first one that
 * exists, so "the menu" means the menu rather than every element that happens to
 * carry an aria-controls. A page with no menu at all is not a failure: the
 * interaction is reported with the evidence as a limitation.
 */
export const DEFAULT_CRAFT_STATES: CraftStateSpec[] = [
  {
    label: 'menu-open',
    interactions: [
      { type: 'click', selector: 'header [aria-haspopup="true"], header [aria-expanded="false"], nav [aria-haspopup="true"], nav [aria-expanded="false"], button[aria-haspopup="true"], details > summary' },
      { type: 'wait', ms: 250 },
    ],
  },
  {
    label: 'hover-nav',
    interactions: [
      { type: 'hover', selector: 'nav a, nav button, header nav a' },
      { type: 'wait', ms: 200 },
    ],
  },
];

export interface ObserveOptions {
  /** Write one full-page PNG per width into this directory. */
  screenshotDir?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  mode?: CraftMode;
  /** Extra states to study. `false` studies only the resting page. */
  states?: CraftStateSpec[] | false;
  maxElements?: number;
  /** Keep the screenshot as a data URL instead of a file (off by default). */
  captureInlineScreenshot?: boolean;
}

/**
 * Read what a page looks like at one width.
 *
 * The screenshot is taken first, before any interaction is replayed, so the
 * pixel check always measures the resting page. Probes come after: the base
 * one supplies the element list, the rest supply opened-menu / hover states.
 */
export async function observeAt(
  url: string,
  width: number,
  options: ObserveOptions = {},
): Promise<Observation> {
  const mode = options.mode ?? 'clean_room';
  const maxElements = options.maxElements ?? MAX_OBSERVED_ELEMENTS;
  const stateSpecs = options.states === false ? [] : (options.states ?? DEFAULT_CRAFT_STATES);
  const shot = options.screenshotDir;
  const shotPath = shot ? path.join(shot, `${width}.png`) : undefined;

  const actions: BrowserAction[] = [];
  if (shotPath) actions.push({ type: 'screenshot', path: shotPath, fullPage: true });
  else if (options.captureInlineScreenshot) actions.push({ type: 'screenshot', fullPage: true });
  actions.push({ type: 'probe', probe: { label: 'base', maxElements } });
  for (const spec of stateSpecs) {
    actions.push({ type: 'probe', probe: { label: spec.label, interactions: spec.interactions, maxElements } });
  }

  const run = await renderWithBrowser({
    url,
    timeoutMs: options.timeoutMs ?? 30_000,
    waitUntil: 'networkidle',
    viewport: { width, height: VIEWPORT_HEIGHT },
    // Explicit actions carry the screenshot; the driver's trailing screenshot
    // would capture the *last* interaction state instead of the resting page.
    screenshot: false,
    actions,
    ...(options.signal ? { signal: options.signal } : {}),
  });

  if (!run) {
    return {
      url, width, height: VIEWPORT_HEIGHT, title: '', text: '', elements: [], mode,
      error: 'the browser could not render this page',
      evidence: {
        source: 'unavailable', confidence: 0, coverage: 0,
        limitations: ['no browser backend was available, so nothing could be measured'],
      },
    };
  }

  // The browser already wrote the file; this only matters when the directory
  // did not exist and the driver created it. Kept idempotent on purpose.
  if (shotPath) await fs.mkdir(path.dirname(shotPath), { recursive: true }).catch(() => undefined);

  const base = run.probes.find((row) => row.label === 'base')?.data;
  const live = isProbeData(base);
  const elements = live ? elementsFromProbe(base, maxElements) : extractElements(run.html);
  const probeErrors = (run.probeErrors || []).map((row) => `${row.label}: ${row.error}`);
  const interactions: InteractionSnapshot[] = run.probes
    .filter((row) => isProbeData(row.data))
    .map((row) => ({
      label: row.label,
      states: statesFromProbe(row.data),
      text: String(row.data.text || '').slice(0, 30_000),
      elementCount: Array.isArray(row.data.elements) ? row.data.elements.length : 0,
    }));
  const inlineShot = run.screenshots.find((row) => row.dataUrl)?.dataUrl;
  const hasShot = Boolean(shotPath || inlineShot);

  return {
    url: run.finalUrl || url,
    width,
    height: VIEWPORT_HEIGHT,
    title: live ? String(base.title || '') : extractTitle(run.html),
    text: live ? String(base.text || '') : extractText(run.html),
    elements,
    ...(live ? { states: statesFromProbe(base) } : {}),
    interactions,
    ...(live && base.scroll ? { scroll: sanitizeRect(base.scroll) } : {}),
    probeLabels: run.probes.map((row) => row.label),
    ...(probeErrors.length ? { probeErrors } : {}),
    mode,
    ...(mode === 'deep' ? { markup: run.html } : {}),
    ...(shotPath ? { screenshot: shotPath } : {}),
    ...(!shotPath && inlineShot ? { screenshotDataUrl: inlineShot } : {}),
    evidence: evidenceFor({ live, hasShot, elementCount: elements.length, maxElements, probeErrors, stateCount: interactions.length, mode }),
  };
}

/** Observe the target at every comparison width. */
export async function observeAll(
  url: string,
  options: ObserveOptions = {},
): Promise<Observation[]> {
  const rows: Observation[] = [];
  for (const width of CHECK_WIDTHS) {
    rows.push(await observeAt(url, width, options));
  }
  return rows;
}

/** Read the same widths from a local build, served or opened as a file. */
export function localUrlFor(root: string, entry = 'index.html'): string {
  const normalised = root.replace(/\\/g, '/').replace(/\/+$/, '');
  return `file:///${normalised}/${entry}`.replace(/\/{3,}/g, '///');
}

/** A short, tool-result-safe view of an observation (no inline PNG, no source). */
export function summarizeObservation(row: Observation): Record<string, unknown> {
  return {
    width: row.width,
    url: row.url,
    title: row.title,
    elements: row.elements.length,
    states: row.states?.length ?? 0,
    interactions: row.interactions?.map((item) => item.label) ?? [],
    textLength: row.text.length,
    ...(row.screenshot ? { screenshot: row.screenshot } : {}),
    ...(row.evidence ? { evidence: row.evidence } : {}),
    ...(row.error ? { error: row.error } : {}),
  };
}

// ---- comparison ------------------------------------------------------------

export type DifferenceKind = 'missing' | 'text' | 'style' | 'position' | 'size' | 'extra' | 'state';

export interface Difference {
  kind: DifferenceKind;
  /** The element path, when the difference is on one element. */
  path?: string;
  /** Which width it was measured at. */
  width: number;
  /** What it is here. */
  original?: string;
  /** What it is in the rebuild. */
  rebuilt?: string;
  /** How far off, for numbers: pixels. */
  delta?: number;
}

export interface Comparison {
  width: number;
  differences: Difference[];
  /**
   * How close the rebuild is, 0-100.
   *
   * Deliberately a weighted count rather than a pixel diff: a pixel diff says
   * "3% different" and stops, which is not actionable. Counting differences by
   * kind says *what* is different, and the score is only there to sort rounds.
   */
  similarity: number;
  /** Attached by `checkAll` once the screenshot diff has run. */
  pixel?: PixelCheck;
}

const MAX_DIFFERENCES = 400;

/**
 * Compare one observation of the original with one of the rebuild.
 *
 * Elements are matched by path. A path that exists on one side only is a
 * `missing` or `extra` difference — which is the difference people most often
 * skip, and the one that matters most: a rebuild that drops a section is not
 * "96% similar".
 */
export function compareAt(original: Observation, rebuilt: Observation): Comparison {
  const differences: Difference[] = [];
  const width = original.width;
  const push = (...rows: Difference[]): void => {
    for (const row of rows) {
      if (differences.length < MAX_DIFFERENCES) differences.push(row);
    }
  };

  // The page's own visible text, not just per-element text. A paragraph that
  // moved into a different tag would otherwise slip through the element list.
  if (original.text && rebuilt.text && original.text !== rebuilt.text) {
    push({ kind: 'text', path: 'page', width, original: clip(original.text), rebuilt: clip(rebuilt.text) });
  }

  const byPath = new Map(rebuilt.elements.map((element) => [element.path, element]));
  const seen = new Set<string>();

  for (const element of original.elements) {
    const counterpart = byPath.get(element.path);
    if (!counterpart) {
      push({ kind: 'missing', path: element.path, width, original: element.tag });
      continue;
    }
    seen.add(element.path);

    if ((element.text || '') !== (counterpart.text || '')) {
      push({ kind: 'text', path: element.path, width, original: element.text, rebuilt: counterpart.text });
    }

    for (const [property, value] of Object.entries(element.style)) {
      const other = counterpart.style[property];
      if (other === undefined || styleValueEqual(value, other)) continue;
      push({ kind: 'style', path: element.path, width, original: `${property}: ${value}`, rebuilt: `${property}: ${other}` });
    }

    // Element state belongs to the surface too: a disabled or collapsed control
    // in the resting page is a difference a visitor can feel.
    push(...compareElementStates(element.state, counterpart.state, element.path, width));

    for (const axis of ['x', 'y'] as const) {
      const delta = Math.round(counterpart.rect[axis] - element.rect[axis]);
      if (Math.abs(delta) > 2) {
        push({ kind: 'position', path: element.path, width, original: `${axis} ${Math.round(element.rect[axis])}`, rebuilt: `${axis} ${Math.round(counterpart.rect[axis])}`, delta });
      }
    }

    for (const axis of ['width', 'height'] as const) {
      const delta = Math.round(counterpart.rect[axis] - element.rect[axis]);
      // Sub-pixel and rounding noise is not a difference anyone can act on.
      if (Math.abs(delta) > 1) {
        push({ kind: 'size', path: element.path, width, original: `${axis} ${Math.round(element.rect[axis])}`, rebuilt: `${axis} ${Math.round(counterpart.rect[axis])}`, delta });
      }
    }
  }

  for (const element of rebuilt.elements) {
    if (!seen.has(element.path) && !original.elements.some((row) => row.path === element.path)) {
      push({ kind: 'extra', path: element.path, width, rebuilt: element.tag });
    }
  }

  push(...compareInteractionStates(original.interactions, rebuilt.interactions, width));

  return { width, differences, similarity: score(original.elements.length, differences) };
}

/** Compare every width and give one number for the whole surface. */
export function compareAll(originals: Observation[], rebuilds: Observation[]): { comparisons: Comparison[]; similarity: number } {
  const comparisons: Comparison[] = [];
  for (const original of originals) {
    const rebuilt = rebuilds.find((row) => row.width === original.width);
    if (!rebuilt) continue;
    comparisons.push(compareAt(original, rebuilt));
  }
  const similarity = comparisons.length
    ? Math.round(comparisons.reduce((total, row) => total + row.similarity, 0) / comparisons.length)
    : 0;
  return { comparisons, similarity };
}

/**
 * The score.
 *
 * A missing or extra element costs far more than a colour that is slightly off:
 * the first means part of the page is not there, the second means it needs a
 * tweak. A rebuild with three missing sections and perfect colours is not close.
 *
 * The penalty is per element, not a flat count. Summing weights across the whole
 * page made a small page collapse to 0 the moment four sections were missing —
 * which destroys the ordering between "40% of the page is gone" and "every colour
 * is slightly wrong", the one comparison a person needs. Here each element can
 * lose at most its own share: one fully wrong element costs 1/n of the score, and
 * a single bad colour on a one-element page is 92, not 0 and not 100.
 */
function score(elementCount: number, differences: Difference[]): number {
  const weight: Record<DifferenceKind, number> = {
    missing: 12,
    extra: 6,
    text: 4,
    size: 3,
    position: 3,
    state: 3,
    style: 1,
  };
  // 12 — the heaviest single finding — is one element's full share.
  const perElementCap = 12;
  const byPath = new Map<string, number>();
  for (const row of differences) {
    const key = row.path || 'page';
    byPath.set(key, (byPath.get(key) || 0) + (weight[row.kind] || 1));
  }
  let badness = 0;
  for (const penalty of byPath.values()) badness += Math.min(1, penalty / perElementCap);
  const denominator = Math.max(elementCount, byPath.size, 1);
  const ratio = Math.min(1, badness / denominator);
  return Math.max(0, Math.min(100, Math.round(100 * (1 - ratio))));
}

function compareElementStates(
  a: ElementState | undefined,
  b: ElementState | undefined,
  elementPath: string,
  width: number,
): Difference[] {
  if (!a && !b) return [];
  const out: Difference[] = [];
  for (const key of ['hidden', 'disabled', 'checked', 'expanded', 'selected'] as const) {
    const left = a?.[key] ?? null;
    const right = b?.[key] ?? null;
    if (String(left) !== String(right)) {
      out.push({ kind: 'state', path: elementPath, width, original: `${key}: ${String(left)}`, rebuilt: `${key}: ${String(right)}` });
    }
  }
  return out;
}

function compareInteractionStates(
  a: InteractionSnapshot[] = [],
  b: InteractionSnapshot[] = [],
  width: number,
): Difference[] {
  if (!a.length && !b.length) return [];
  const out: Difference[] = [];
  const byLabel = new Map(b.map((row) => [row.label, row]));
  for (const snapshot of a) {
    const other = byLabel.get(snapshot.label);
    if (!other) {
      out.push({ kind: 'state', path: snapshot.label, width, original: `${snapshot.states.length} controls`, rebuilt: 'state not observed' });
      continue;
    }
    const count = Math.max(snapshot.states.length, other.states.length);
    for (let index = 0; index < count && out.length < 80; index += 1) {
      const left = snapshot.states[index];
      const right = other.states[index];
      if (!left || !right) {
        out.push({ kind: 'state', path: `${snapshot.label}#${index + 1}`, width, original: left ? `${left.tag}:${left.label}` : 'absent', rebuilt: right ? `${right.tag}:${right.label}` : 'absent' });
        continue;
      }
      for (const key of ['expanded', 'selected', 'open', 'checked', 'value'] as const) {
        const lv = left[key] ?? null;
        const rv = right[key] ?? null;
        if (String(lv) === String(rv)) continue;
        out.push({
          kind: 'state',
          path: `${snapshot.label}/${left.tag}:${left.label}#${index + 1}`,
          width,
          original: `${key}: ${String(lv)}`,
          rebuilt: `${key}: ${String(rv)}`,
        });
      }
    }
  }
  return out;
}

/**
 * Hex and rgb() are the same colour to a browser but different strings. A live
 * computed style always returns rgb(); static markup is usually hex. Comparing
 * raw strings there would report a difference that no visitor can see.
 * The *reported* values stay in their original form so the finding is readable.
 */
function styleValueEqual(a: string, b: string): boolean {
  return a === b || canonicalStyle(a) === canonicalStyle(b);
}

function canonicalStyle(value: string): string {
  let text = String(value || '').trim().toLowerCase().replace(/\s+/g, '');
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(text);
  if (hex) {
    const digits = hex[1].length === 3 ? hex[1].split('').map((char) => char + char).join('') : hex[1];
    const [r, g, blue] = [0, 2, 4].map((at) => parseInt(digits.slice(at, at + 2), 16));
    text = `rgb(${r},${g},${blue})`;
  }
  // 100.4px and 100px are the same box as far as a screenshot is concerned.
  return text.replace(/-?\d+\.\d+px/g, (match) => `${Math.round(parseFloat(match))}px`);
}

function clip(value: string): string {
  return value.length > 220 ? `${value.slice(0, 220)}…` : value;
}

// ---- pixel checks ----------------------------------------------------------

export interface PixelCheck {
  width: number;
  /** 0-100, or 0 with an `error` when the screenshots could not be read. */
  similarity: number;
  ratio: number;
  different: number;
  total: number;
  regions: PixelRegion[];
  /** Path of the highlighted difference image, when a check directory was given. */
  differenceImage?: string;
  error?: string;
}

export interface CheckOptions {
  /** Diff images and the Markdown report are written here. */
  checkDir?: string;
  /** Per-channel tolerance, defaults to 12. */
  tolerance?: number;
  /** Write a highlighted PNG per width. Defaults to true when checkDir is set. */
  differenceImage?: boolean;
}

export interface CheckResult {
  comparisons: Comparison[];
  /** Element / text / layout / state score, 0-100. */
  similarity: number;
  /** Screenshot score, 0-100. Undefined when no screenshots were available. */
  pixelSimilarity?: number;
  /** The "how alike" number: both measurements, or just the first one. */
  overall: number;
  checks: PixelCheck[];
  differenceCount: number;
  confidence: number;
  limitations: string[];
}

/** Read a screenshot from disk or from an inline data URL. */
async function readScreenshot(row: Observation): Promise<Buffer | undefined> {
  if (row.screenshot) {
    try { return await fs.readFile(row.screenshot); } catch { return undefined; }
  }
  const prefix = 'data:image/png;base64,';
  if (row.screenshotDataUrl?.startsWith(prefix)) {
    return Buffer.from(row.screenshotDataUrl.slice(prefix.length), 'base64');
  }
  return undefined;
}

/**
 * Measure two screenshots at one width.
 *
 * A rebuild that is 200px shorter is a real difference: `comparePixels` pads
 * both to the larger canvas and counts the missing area as mismatch instead of
 * silently cropping it away. The difference image points at the place.
 */
export async function compareScreenshotsAt(
  original: Observation,
  rebuilt: Observation,
  options: CheckOptions = {},
): Promise<PixelCheck | undefined> {
  const a = await readScreenshot(original);
  const b = await readScreenshot(rebuilt);
  if (!a || !b) return undefined;
  const width = original.width;
  const empty: PixelCheck = { width, similarity: 0, ratio: 1, different: 0, total: 0, regions: [] };
  try {
    const diff = comparePixels(decodePng(a), decodePng(b), {
      ...(options.tolerance != null ? { tolerance: options.tolerance } : {}),
      differenceImage: options.differenceImage !== false && Boolean(options.checkDir),
    });
    let differenceImage: string | undefined;
    if (diff.differenceImage && options.checkDir) {
      await fs.mkdir(options.checkDir, { recursive: true });
      differenceImage = path.join(options.checkDir, `diff-${width}.png`);
      await fs.writeFile(differenceImage, encodePng(diff.differenceImage));
    }
    return {
      width,
      similarity: diff.similarity,
      ratio: diff.ratio,
      different: diff.different,
      total: diff.total,
      regions: diff.regions,
      ...(differenceImage ? { differenceImage } : {}),
    };
  } catch (error) {
    return { ...empty, error: `screenshot comparison failed: ${(error as Error)?.message || String(error)}` };
  }
}

/**
 * The full check: element-level findings at every width, a screenshot diff at
 * every width where both screenshots exist, one "how alike" number, and the
 * evidence's confidence and limitations.
 */
export async function checkAll(
  originals: Observation[],
  rebuilds: Observation[],
  options: CheckOptions = {},
): Promise<CheckResult> {
  const measured = compareAll(originals, rebuilds);
  const checks: PixelCheck[] = [];
  for (const comparison of measured.comparisons) {
    const before = originals.find((row) => row.width === comparison.width);
    const after = rebuilds.find((row) => row.width === comparison.width);
    if (!before || !after) continue;
    const pixel = await compareScreenshotsAt(before, after, options);
    if (!pixel) continue;
    comparison.pixel = pixel;
    checks.push(pixel);
  }
  const usable = checks.filter((row) => !row.error);
  const pixelSimilarity = usable.length
    ? Math.round(usable.reduce((total, row) => total + row.similarity, 0) / usable.length)
    : undefined;
  const limitations = new Set<string>();
  for (const row of [...originals, ...rebuilds]) {
    for (const item of row.evidence?.limitations || []) limitations.add(item);
    if (row.error) limitations.add(`${row.width}px: ${row.error}`);
  }
  for (const row of checks) {
    if (row.error) limitations.add(`${row.width}px: ${row.error}`);
  }
  if (pixelSimilarity === undefined) limitations.add('no screenshots were available, so the "how alike" number covers measured elements only');
  if (originals.some((row) => row.evidence?.source === 'static') || rebuilds.some((row) => row.evidence?.source === 'static')) {
    limitations.add('one side was read from static markup; element paths may not line up with a live read');
  }
  const confidence = Math.min(...[...originals, ...rebuilds].map((row) => row.evidence?.confidence ?? 50));
  return {
    comparisons: measured.comparisons,
    similarity: measured.similarity,
    ...(pixelSimilarity !== undefined ? { pixelSimilarity } : {}),
    overall: pixelSimilarity === undefined ? measured.similarity : Math.round(measured.similarity * 0.5 + pixelSimilarity * 0.5),
    checks,
    differenceCount: measured.comparisons.reduce((total, row) => total + row.differences.length, 0),
    confidence: Number.isFinite(confidence) ? confidence : 50,
    limitations: [...limitations],
  };
}

/** The readable artifact that lands in `checks/`. */
export function checkReportMarkdown(result: CheckResult): string {
  const lines: string[] = [
    '# How alike',
    '',
    `- Overall: **${result.overall}%**`,
    `- Measured elements / text / layout / state: **${result.similarity}%**`,
  ];
  if (result.pixelSimilarity !== undefined) lines.push(`- Screenshots: **${result.pixelSimilarity}%**`);
  lines.push(`- Recorded differences: **${result.differenceCount}**`);
  lines.push(`- Evidence confidence: **${result.confidence}%**`);
  if (result.limitations.length) {
    lines.push('', '## Limitations', ...result.limitations.map((item) => `- ${item}`));
  }
  for (const comparison of result.comparisons) {
    lines.push('', `## ${comparison.width}px — ${comparison.similarity}%`, '');
    const pixel = comparison.pixel;
    if (pixel) {
      lines.push(pixel.error
        ? `- Screenshots: ${pixel.error}`
        : `- Screenshots: **${pixel.similarity}%** (${pixel.different} / ${pixel.total} px)${pixel.differenceImage ? ` — [difference image](${path.basename(pixel.differenceImage)})` : ''}`);
      for (const region of pixel.regions.slice(0, 4)) {
        lines.push(`  - hotspot (${region.x}, ${region.y}, ${region.width}×${region.height}): ${Math.round(region.ratio * 100)}% changed`);
      }
    }
    if (!comparison.differences.length) lines.push('No measurable differences.');
    for (const difference of comparison.differences.slice(0, 60)) {
      lines.push(`- \`${difference.kind}\` ${difference.path || 'page'}: ${difference.original ?? '—'} → ${difference.rebuilt ?? '—'}${difference.delta != null ? ` (${difference.delta}px)` : ''}`);
    }
    if (comparison.differences.length > 60) lines.push(`- … ${comparison.differences.length - 60} more`);
  }
  return `${lines.join('\n')}\n`;
}

// ---- reading a live probe --------------------------------------------------

function isProbeData(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && Array.isArray((value as Record<string, any>).elements);
}

function elementsFromProbe(data: Record<string, any>, maxElements: number): ObservedElement[] {
  const rows: ObservedElement[] = [];
  for (const raw of (data.elements || []).slice(0, maxElements)) {
    const tag = String(raw?.tag || 'div');
    const element: ObservedElement = {
      path: String(raw?.path || ''),
      tag,
      style: sanitizeStyle(raw?.style),
      rect: sanitizeRect(raw?.rect),
    };
    if (raw?.role) element.role = String(raw.role);
    if (raw?.text) element.text = String(raw.text);
    if (raw?.state && typeof raw.state === 'object') {
      element.state = {
        hidden: Boolean(raw.state.hidden),
        disabled: Boolean(raw.state.disabled),
        checked: Boolean(raw.state.checked),
        ...(raw.state.expanded != null ? { expanded: String(raw.state.expanded) } : {}),
        ...(raw.state.selected != null ? { selected: String(raw.state.selected) } : {}),
      };
    }
    if (element.path) rows.push(element);
  }
  return rows;
}

function statesFromProbe(data: Record<string, any>): InteractiveState[] {
  const out: InteractiveState[] = [];
  for (const raw of (data.states || []).slice(0, 120)) {
    out.push({
      tag: String(raw?.tag || ''),
      label: String(raw?.label || ''),
      ...(raw?.expanded != null ? { expanded: String(raw.expanded) } : {}),
      ...(raw?.selected != null ? { selected: String(raw.selected) } : {}),
      ...(raw?.open != null ? { open: Boolean(raw.open) } : {}),
      ...(raw?.checked != null ? { checked: Boolean(raw.checked) } : {}),
      ...(raw?.value != null ? { value: String(raw.value) } : {}),
    });
  }
  return out;
}

function sanitizeStyle(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const property of PROBE_PROPERTIES) {
    const value = (raw as Record<string, unknown>)[property];
    if (typeof value === 'string' && value.trim()) out[property] = value.trim();
  }
  return out;
}

function sanitizeRect(raw: unknown): { x: number; y: number; width: number; height: number } {
  const value = (raw || {}) as Record<string, unknown>;
  const number = (key: string): number => {
    const parsed = Number(value[key]);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return { x: number('x'), y: number('y'), width: number('width'), height: number('height') };
}

/**
 * A state the page simply does not have is not a limitation of the evidence.
 *
 * A page with no nav cannot fail a hover check, and reporting it as a limitation
 * would teach a reader to ignore the list — which is worse than an empty list.
 * A control that exists but could not be driven *is* a limitation, because the
 * state was supposed to be measured and was not.
 */
const MISSING_CONTROL = /no visible element for|no element for/i;

function evidenceFor(input: {
  live: boolean;
  hasShot: boolean;
  elementCount: number;
  maxElements: number;
  probeErrors: string[];
  stateCount: number;
  mode: CraftMode;
}): Evidence {
  const limitations: string[] = [];
  const absent = input.probeErrors.filter((row) => MISSING_CONTROL.test(row));
  const failed = input.probeErrors.filter((row) => !MISSING_CONTROL.test(row));
  if (!input.live) limitations.push('the live document could not be probed; measurements come from static markup');
  if (!input.hasShot) limitations.push('no screenshot was captured, so pixel-level checks are unavailable');
  if (input.elementCount >= input.maxElements) limitations.push(`only the first ${input.maxElements} visible elements were read`);
  if (failed.length) limitations.push(`${failed.length} interaction(s) could not be replayed: ${failed.slice(0, 3).join('; ')}`);
  if (input.stateCount <= 1) limitations.push('only the resting page was observed; opened menus and hover states were not');
  if (input.mode === 'clean_room') limitations.push('clean room: source markup and network are deliberately not used as evidence');
  let confidence = input.live ? 92 : 45;
  if (!input.hasShot) confidence -= 16;
  if (failed.length) confidence -= Math.min(12, failed.length * 3);
  if (input.stateCount <= 1) confidence -= 6;
  const coverage = Math.round(100
    * (input.elementCount >= input.maxElements ? 0.6 : 1)
    * (input.stateCount > 1 ? 1 : 0.85)
    * (input.hasShot ? 1 : 0.7));
  return {
    source: input.live ? 'live' : 'static',
    confidence: Math.max(0, Math.min(100, confidence)),
    coverage: Math.max(0, Math.min(100, coverage)),
    // Listed last and phrased as a fact about the page, not a failure.
    ...(absent.length ? { limitations: [...limitations, `no such control on this page: ${absent.slice(0, 3).join('; ')}`] } : { limitations }),
  };
}

// ---- reading a page (static fallback) --------------------------------------

/**
 * Pull comparable elements out of rendered markup.
 *
 * A real computed-style read needs a live document; this is the static
 * approximation used when the browser backend cannot run the probe. Inline
 * styles and class-based rules from `<style>` blocks are folded in, and where
 * it cannot know a value it leaves the property out rather than inventing one.
 */
export function extractElements(html: string): ObservedElement[] {
  const rules = readStyleRules(html);
  const body = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
  const elements: ObservedElement[] = [];
  const counts = new Map<string, number>();

  const tagRe = /<([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/g;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(body))) {
    const tag = match[1].toLowerCase();
    if (['html', 'head', 'meta', 'link', 'title', 'br', 'hr'].includes(tag)) continue;
    const attrs = parseAttributes(match[2] || '');
    const classes = (attrs.class || '').split(/\s+/).filter(Boolean);
    const ordinal = (counts.get(tag) || 0) + 1;
    counts.set(tag, ordinal);

    const elementPath = classes.length ? `${tag}.${classes[0]}#${ordinal}` : `${tag}#${ordinal}`;
    const style: Record<string, string> = {};
    for (const property of PROBE_PROPERTIES) {
      const value = resolveProperty(property, attrs, classes, rules, tag);
      if (value) style[property] = value;
    }

    // The text of a leaf element, trimmed: comparing prose is what catches a
    // section whose wording drifted.
    const closing = body.indexOf(`</${tag}>`, tagRe.lastIndex);
    const inner = closing > 0 ? body.slice(tagRe.lastIndex, closing) : '';
    const text = inner.includes('<') ? '' : collapse(inner);

    elements.push({
      path: elementPath,
      tag,
      ...(attrs.role ? { role: attrs.role } : {}),
      ...(text ? { text } : {}),
      style,
      rect: { x: 0, y: 0, width: numberFrom(style.width), height: numberFrom(style.height) },
    });
    if (elements.length >= MAX_OBSERVED_ELEMENTS) break;
  }
  return elements;
}

interface CssRule {
  selector: string;
  declarations: Record<string, string>;
}

function readStyleRules(html: string): CssRule[] {
  const rules: CssRule[] = [];
  const styleBlocks = html.match(/<style[^>]*>([\s\S]*?)<\/style>/gi) || [];
  for (const block of styleBlocks) {
    const css = block.replace(/<style[^>]*>|<\/style>/gi, '');
    for (const rule of css.split('}')) {
      const [selectorPart, declarationBody] = rule.split('{');
      if (!selectorPart || !declarationBody) continue;
      const declarations: Record<string, string> = {};
      for (const line of declarationBody.split(';')) {
        const [property, value] = line.split(':');
        if (!property || !value) continue;
        declarations[property.trim().toLowerCase()] = value.trim();
      }
      if (Object.keys(declarations).length) rules.push({ selector: selectorPart.trim(), declarations });
    }
  }
  return rules;
}

function resolveProperty(property: string, attrs: Record<string, string>, classes: string[], rules: CssRule[], tag: string): string {
  const inline = (attrs.style || '').split(';').reduce<Record<string, string>>((out, line) => {
    const [name, value] = line.split(':');
    if (name && value) out[name.trim().toLowerCase()] = value.trim();
    return out;
  }, {});
  if (inline[property]) return inline[property];

  let resolved = '';
  for (const rule of rules) {
    const matches =
      (rule.selector.startsWith('.') && classes.includes(rule.selector.slice(1)))
      || (rule.selector.startsWith('#') && attrs.id === rule.selector.slice(1))
      || rule.selector === tag;
    if (matches && rule.declarations[property]) resolved = rule.declarations[property];
  }
  return resolved;
}

function parseAttributes(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw))) {
    const key = match[1].toLowerCase();
    out[key] = (match[2] ?? match[3] ?? match[4] ?? '').trim();
  }
  return out;
}

function extractTitle(html: string): string {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return collapse(match?.[1] || '');
}

function extractText(html: string): string {
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<head[\s\S]*?<\/head>/gi, '');
  return collapse(body.replace(/<[^>]+>/g, ' '));
}

function collapse(value: string): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function numberFrom(value?: string): number {
  if (!value) return 0;
  const match = /^(-?\d+(?:\.\d+)?)/.exec(value.trim());
  return match ? Number(match[1]) : 0;
}
