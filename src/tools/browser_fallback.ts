// What to do when there is no browser.
//
// The browser tool drove a real Chrome over the DevTools protocol, and when no
// Chrome was installed every action failed with the same message: "no
// Chrome/Chromium/Edge found". That is honest but it is not useful. Half of
// what the tool does — open a URL and tell me what is on the page — needs a
// rendering engine only for the JavaScript on it. A plain HTTP fetch answers
// that question for the majority of pages, and it answers it on a machine that
// will never have a browser installed.
//
// So the actions split in two:
//
//   - `fetch`: the question is "what does this URL say". A GET plus the same
//     readable() extraction webfetch uses is an honest answer, labelled as one
//     so nobody mistakes it for DOM output.
//   - `needs-engine`: the question is only answerable by running the page —
//     clicking a button, reading a rendered DOM, a screenshot. There is no
//     honest fallback; the answer is a clear refusal that names what is missing
//     and what to do about it.
//
// The failure this replaces was worse than a refusal: a model that gets
// "no Chrome found" for a simple read concludes the page cannot be read, and
// gives up on something it could have done.

export type FallbackKind = 'fetch' | 'needs-engine';

/** Actions whose answer comes from the page's text, not from running it. */
const FETCH_ACTIONS = new Set(['goto', 'open', 'text', 'html', 'status']);

/** Actions that can only be answered by a real rendering engine. */
const ENGINE_ACTIONS = new Set([
  'screenshot', 'frame', 'click', 'mouse', 'wheel', 'type', 'press',
  'eval', 'wait', 'back', 'forward', 'reload', 'tabs', 'newtab',
  'activate', 'closetab',
]);

/** Actions that neither need nor use a page. */
const NEUTRAL_ACTIONS = new Set(['start', 'stop', 'close']);

export function fallbackKind(command: string): FallbackKind | 'neutral' | 'unknown' {
  const value = String(command || '').toLowerCase();
  if (FETCH_ACTIONS.has(value)) return 'fetch';
  if (ENGINE_ACTIONS.has(value)) return 'needs-engine';
  if (NEUTRAL_ACTIONS.has(value)) return 'neutral';
  return 'unknown';
}

/**
 * The message a caller gets when the browser is missing and the action needs
 * one.
 *
 * It has three jobs: say what happened, say what the caller can do instead
 * right now, and say what would fix it permanently. "no Chrome found" did only
 * the first, which is why a model would retry it.
 */
export function missingBrowserMessage(command: string, platform: string = process.platform): string {
  const how = installHint(platform);
  // Offered for every action, not only the engine-only ones: whatever was
  // asked for, "read the page over HTTP" is something this tool can still do
  // right now, and a model that knows that does not give up on the task.
  const instead = 'The same tool can still read a page: call it with action "text" or "html" and a URL — those fall back to a plain HTTP fetch (no JavaScript, no DOM).';
  return [
    `the browser engine is not available on this machine, so "${command}" cannot run.`,
    `It needs a real Chrome/Chromium/Edge; only the engine can ${describeNeed(command)}.`,
    instead,
    how,
  ].filter(Boolean).join(' ');
}

function describeNeed(command: string): string {
  switch (String(command || '').toLowerCase()) {
    case 'screenshot': case 'frame': return 'render the page and photograph it';
    case 'click': case 'mouse': return 'dispatch a click into the page';
    case 'type': case 'press': return 'send keystrokes to the page';
    case 'eval': return 'run JavaScript inside the page and return its value';
    case 'wait': return 'observe the DOM changing over time';
    case 'back': case 'forward': case 'reload': return 'drive the page\'s own history';
    case 'tabs': case 'newtab': case 'activate': case 'closetab': return 'manage open tabs';
    default: return 'run the page';
  }
}

function installHint(platform: string): string {
  switch (platform) {
    case 'win32':
      return 'Install Google Chrome or Microsoft Edge, or point OKAY_BROWSER_PATH at an existing browser executable.';
    case 'darwin':
      return 'Install Google Chrome or Chromium, or point OKAY_BROWSER_PATH at an existing browser executable.';
    default:
      return 'Install chromium (or google-chrome), or point OKAY_BROWSER_PATH at an existing browser executable.';
  }
}

/**
 * The result of reading a URL without a browser.
 *
 * `fetched` is carried in the payload rather than being implied, because a
 * caller that asked for `text` and silently got a fetch instead would draw the
 * wrong conclusion about a JavaScript-rendered page: an empty body is not an
 * empty page.
 */
export interface FetchFallback {
  fetched: true;
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  title: string;
  text: string;
  /** Set when the response looks like a shell that only JavaScript would fill. */
  note?: string;
}

/**
 * Detect a page whose content is not in the HTML.
 *
 * A single-page app serves a near-empty document and fills it in the browser.
 * Fetching it succeeds and returns almost nothing, and a caller who does not
 * know that will report "the page is empty" — a wrong answer that looks like a
 * successful read. Saying so is the difference between a fallback and a trap.
 */
export function looksLikeAppShell(html: string, text: string): boolean {
  const body = String(html || '');
  if (!body) return false;
  const scriptHeavy = (body.match(/<script/gi) || []).length >= 2;
  const hasFrameworkRoot = /<div[^>]+id=["'](root|app|__next|__nuxt)["']/i.test(body);
  const thin = String(text || '').trim().length < 200;
  const noscript = /<noscript/i.test(body);
  return thin && (hasFrameworkRoot || (scriptHeavy && noscript));
}
