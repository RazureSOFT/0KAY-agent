import test from 'node:test';
import assert from 'node:assert/strict';
import { fallbackKind, looksLikeAppShell, missingBrowserMessage } from './browser_fallback.js';

test('reading a page is classified as answerable by fetch', () => {
  // This is the set where refusing was making a model give up on something it
  // could have done.
  for (const action of ['goto', 'open', 'text', 'html', 'status']) {
    assert.equal(fallbackKind(action), 'fetch', action);
  }
});

test('actions that need a rendered page are classified as needing an engine', () => {
  for (const action of ['screenshot', 'frame', 'click', 'mouse', 'type', 'press', 'eval', 'wait', 'tabs', 'newtab']) {
    assert.equal(fallbackKind(action), 'needs-engine', action);
  }
});

test('start/stop need no page and are neither', () => {
  assert.equal(fallbackKind('start'), 'neutral');
  assert.equal(fallbackKind('stop'), 'neutral');
  assert.equal(fallbackKind('close'), 'neutral');
});

test('an unknown action is reported as unknown, not guessed', () => {
  assert.equal(fallbackKind('teleport'), 'unknown');
  assert.equal(fallbackKind(''), 'unknown');
});

test('classification is case-insensitive', () => {
  assert.equal(fallbackKind('SCREENSHOT'), 'needs-engine');
  assert.equal(fallbackKind('Text'), 'fetch');
});

test('the refusal says what failed, what it needed, and how to fix it', () => {
  const message = missingBrowserMessage('screenshot');
  assert.match(message, /screenshot/);
  assert.match(message, /not available/);
  // What it needed — the specific capability, not just "a browser".
  assert.match(message, /photograph/);
  // How to fix it, on the platform it is running on.
  assert.match(message, /OKAY_BROWSER_PATH/);
});

test('a read action is told what it can do instead, right now', () => {
  const message = missingBrowserMessage('text');
  assert.match(message, /action "text" or "html"/);
  assert.match(message, /HTTP fetch/);
});

test('an engine-only action is not told to retry the same call', () => {
  // Telling a model to retry `screenshot` without a browser would loop.
  const message = missingBrowserMessage('click');
  assert.match(message, /dispatch a click/);
  assert.match(message, /action "text" or "html"/, 'it is still offered the thing it CAN do');
});

test('the install hint names the platform', () => {
  assert.match(missingBrowserMessage('screenshot', 'win32'), /Chrome or Microsoft Edge/);
  assert.match(missingBrowserMessage('screenshot', 'darwin'), /Chrome or Chromium/);
  assert.match(missingBrowserMessage('screenshot', 'linux'), /chromium/);
});

test('a shell that fills itself in with JavaScript is called out', () => {
  // Fetching an SPA succeeds and returns almost nothing. Without this note a
  // caller reports "the page is empty", which is a wrong answer that looks like
  // a successful read.
  const shell = '<!doctype html><html><body><div id="root"></div><script src="a.js"></script><script src="b.js"></script><noscript>You need JavaScript.</noscript></body></html>';
  assert.equal(looksLikeAppShell(shell, 'You need JavaScript.'), true);
});

test('a Next.js root is recognised as a shell', () => {
  const shell = '<html><body><div id="__next"></div><script src="x.js"></script></body></html>';
  assert.equal(looksLikeAppShell(shell, ''), true);
});

test('an ordinary server-rendered page is not called a shell', () => {
  const page = '<html><head><title>Docs</title></head><body><h1>Docs</h1><p>' + 'real content '.repeat(40) + '</p></body></html>';
  assert.equal(looksLikeAppShell(page, 'real content '.repeat(40)), false);
});

test('a short but real page is not called a shell just for being short', () => {
  // "tiny" alone is not evidence — a 404 page is short and is exactly what the
  // caller wanted to see.
  const page = '<html><body><h1>Not found</h1></body></html>';
  assert.equal(looksLikeAppShell(page, 'Not found'), false);
});

test('an empty body is not a shell — there is nothing to diagnose', () => {
  assert.equal(looksLikeAppShell('', ''), false);
});
