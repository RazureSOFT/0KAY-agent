// Studying an observable surface, and measuring how far a rebuild has drifted.
//
// "Recreate this page" is only honest if the second half is a measurement. A
// comparison that says "looks close" is an opinion; a comparison that says
// "header background is #2563eb here and #3b82f6 there, at 1280 wide" is a task
// someone can finish. Everything here serves that second kind.
//
// Two observations are taken the same way — same widths, same viewport height,
// same wait — so the only variable left is the page itself.

import { renderWithBrowser } from '../../tools/browser_driver.js';

/** The widths a website is compared at. Narrow, tablet, desktop. */
export const CHECK_WIDTHS = [390, 768, 1280] as const;

export const VIEWPORT_HEIGHT = 900;

export interface ObservedElement {
  /** A path that is stable across a rebuild: tag + role + ordinal within parent. */
  path: string;
  tag: string;
  role?: string;
  text?: string;
  /** Computed style properties that decide how it looks. */
  style: Record<string, string>;
  rect: { x: number; y: number; width: number; height: number };
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
  /** Set when the surface could not be read at all. */
  error?: string;
}

/**
 * Read what a page looks like at one width.
 *
 * The style set is deliberately small and visual: layout, colour, typography,
 * spacing. Reading every computed property would produce thousands of values
 * that differ for irrelevant reasons (user-agent internals, animation state) and
 * bury the handful that matter.
 */
export async function observeAt(
  url: string,
  width: number,
  options: { screenshotDir?: string; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<Observation> {
  const shot = options.screenshotDir;
  const run = await renderWithBrowser({
    url,
    timeoutMs: options.timeoutMs ?? 30_000,
    waitUntil: 'networkidle',
    viewport: { width, height: VIEWPORT_HEIGHT },
    screenshot: Boolean(shot),
    ...(shot ? { actions: [{ type: 'screenshot' as const, path: `${shot}/${width}.png`, fullPage: true }] } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  if (!run) {
    return { url, width, height: VIEWPORT_HEIGHT, title: '', text: '', elements: [], error: 'the browser could not render this page' };
  }

  // The HTML comes back; the elements are read from it. A page that depends on
  // script for its final look is already settled by `networkidle` above, so the
  // markup at this point is the markup a person sees.
  const elements = extractElements(run.html);
  return {
    url: run.finalUrl || url,
    width,
    height: VIEWPORT_HEIGHT,
    title: extractTitle(run.html),
    text: extractText(run.html),
    elements,
    ...(shot ? { screenshot: `${shot}/${width}.png` } : {}),
  };
}

/** Observe the target at every comparison width. */
export async function observeAll(
  url: string,
  options: { screenshotDir?: string; timeoutMs?: number; signal?: AbortSignal } = {},
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

// ---- comparison ------------------------------------------------------------

export type DifferenceKind = 'missing' | 'text' | 'style' | 'position' | 'size' | 'extra';

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
}

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

  const byPath = new Map(rebuilt.elements.map((element) => [element.path, element]));
  const seen = new Set<string>();

  for (const element of original.elements) {
    const counterpart = byPath.get(element.path);
    if (!counterpart) {
      differences.push({ kind: 'missing', path: element.path, width, original: element.tag });
      continue;
    }
    seen.add(element.path);

    if ((element.text || '') !== (counterpart.text || '')) {
      differences.push({ kind: 'text', path: element.path, width, original: element.text, rebuilt: counterpart.text });
    }

    for (const [property, value] of Object.entries(element.style)) {
      const other = counterpart.style[property];
      if (other === undefined) continue;
      if (other !== value) {
        differences.push({ kind: 'style', path: element.path, width, original: `${property}: ${value}`, rebuilt: `${property}: ${other}` });
      }
    }

    for (const axis of ['width', 'height'] as const) {
      const delta = Math.round(counterpart.rect[axis] - element.rect[axis]);
      // Sub-pixel and rounding noise is not a difference anyone can act on.
      if (Math.abs(delta) > 1) {
        differences.push({ kind: axis === 'width' ? 'size' : 'size', path: element.path, width, original: `${axis} ${Math.round(element.rect[axis])}`, rebuilt: `${axis} ${Math.round(counterpart.rect[axis])}`, delta });
      }
    }
  }

  for (const element of rebuilt.elements) {
    if (!seen.has(element.path) && !original.elements.some((row) => row.path === element.path)) {
      differences.push({ kind: 'extra', path: element.path, width, rebuilt: element.tag });
    }
  }

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
 */
function score(elementCount: number, differences: Difference[]): number {
  const weight: Record<DifferenceKind, number> = {
    missing: 12,
    extra: 6,
    text: 4,
    size: 3,
    position: 3,
    style: 1,
  };
  const penalty = differences.reduce((total, row) => total + (weight[row.kind] || 1), 0);
  // Normalised by element count so a big page with a few issues scores higher
  // than a small page with the same few issues — which is the honest read.
  const normalised = penalty / Math.max(elementCount, 8);
  return Math.max(0, Math.min(100, Math.round(100 - normalised * 100)));
}

// ---- reading a page --------------------------------------------------------

const VISUAL_PROPERTIES = [
  'display', 'position', 'flex-direction', 'justify-content', 'align-items',
  'width', 'height', 'margin', 'padding', 'gap',
  'color', 'background-color', 'border', 'border-radius',
  'font-size', 'font-weight', 'font-family', 'line-height', 'letter-spacing', 'text-align',
];

/**
 * Pull comparable elements out of rendered markup.
 *
 * A real computed-style read needs a live document; this is the static
 * approximation over the rendered HTML. Inline styles and class-based rules from
 * `<style>` blocks are folded in, which covers the pages a rebuild is compared
 * against — and where it cannot know a value it leaves the property out rather
 * than inventing one.
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

    const path = classes.length ? `${tag}.${classes[0]}#${ordinal}` : `${tag}#${ordinal}`;
    const style: Record<string, string> = {};
    for (const property of VISUAL_PROPERTIES) {
      const value = resolveProperty(property, attrs, classes, rules);
      if (value) style[property] = value;
    }

    // The text of a leaf element, trimmed: comparing prose is what catches a
    // section whose wording drifted.
    const closing = body.indexOf(`</${tag}>`, tagRe.lastIndex);
    const inner = closing > 0 ? body.slice(tagRe.lastIndex, closing) : '';
    const text = inner.includes('<') ? '' : collapse(inner);

    elements.push({
      path,
      tag,
      ...(attrs.role ? { role: attrs.role } : {}),
      ...(text ? { text } : {}),
      style,
      rect: { x: 0, y: 0, width: numberFrom(style.width), height: numberFrom(style.height) },
    });
    if (elements.length >= 400) break;
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
      const [selectorPart, body] = rule.split('{');
      if (!selectorPart || !body) continue;
      const declarations: Record<string, string> = {};
      for (const line of body.split(';')) {
        const [property, value] = line.split(':');
        if (!property || !value) continue;
        declarations[property.trim().toLowerCase()] = value.trim();
      }
      if (Object.keys(declarations).length) rules.push({ selector: selectorPart.trim(), declarations });
    }
  }
  return rules;
}

function resolveProperty(property: string, attrs: Record<string, string>, classes: string[], rules: CssRule[]): string {
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
      || rule.selector === attrs.tag;
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