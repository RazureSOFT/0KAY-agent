import test from 'node:test';
import assert from 'node:assert/strict';
import { readable, extractContent } from './readable.js';

const PAGE = `<!doctype html>
<html lang="en">
<head>
  <title>Install the thing</title>
  <meta name="description" content="How to install it" />
  <style>.a{color:red}</style>
  <script>window.__data = {secret: 1};</script>
</head>
<body>
  <nav><a href="/">Home</a><a href="/docs">Docs</a></nav>
  <article>
    <h1>Install the thing</h1>
    <p>Run the installer, then <strong>restart</strong> the shell.</p>
    <h2>Options</h2>
    <ul><li>--quiet</li><li>--dry-run</li></ul>
    <pre><code class="language-sh">npm install -g thing</code></pre>
    <table>
      <tr><th>flag</th><th>meaning</th></tr>
      <tr><td>--quiet</td><td>no output</td></tr>
    </table>
    <p>See <a href="/changelog">the changelog</a>.</p>
  </article>
  <footer>Copyright nobody</footer>
</body>
</html>`;

test('a page comes back as its content, not its markup', () => {
  const result = readable(PAGE, 'text/html; charset=utf-8', { base: 'https://example.com/install' });
  assert.equal(result.kind, 'html');
  assert.equal(result.title, 'Install the thing');
  const body = result.content;
  assert.doesNotMatch(body, /<[a-z/][^>]*>/i, 'no tags survive');
  assert.doesNotMatch(body, /__data/, 'inline script is gone');
  assert.doesNotMatch(body, /color:red/, 'inline style is gone');
  assert.doesNotMatch(body, /Copyright nobody/, 'the footer is gone');
});

test('structure survives: headings, lists, code, tables', () => {
  const body = readable(PAGE, 'text/html', { base: 'https://example.com/install' }).content;
  assert.match(body, /^# Install the thing$/m);
  assert.match(body, /^## Options$/m);
  assert.match(body, /^- --quiet$/m);
  assert.match(body, /\*\*restart\*\*/, 'emphasis survives');
  assert.match(body, /```[\s\S]*npm install -g thing[\s\S]*```/, 'fenced code survives');
  assert.match(body, /\| flag \| meaning \|/, 'table becomes a markdown table');
  assert.match(body, /\| --quiet \| no output \|/);
});

test('relative links are resolved and listed', () => {
  const body = readable(PAGE, 'text/html', { base: 'https://example.com/install' }).content;
  assert.match(body, /https:\/\/example\.com\/changelog/);
  assert.match(body, /## Links/);
});

test('plain text drops the markdown structure', () => {
  const body = readable(PAGE, 'text/html', { plain: true, base: 'https://example.com/' }).content;
  assert.doesNotMatch(body, /^#/m, 'no heading markers');
  assert.doesNotMatch(body, /\*\*/, 'no emphasis markers');
  assert.match(body, /Install the thing/);
  assert.match(body, /restart the shell/);
});

test('raw returns the page untouched, for markup work', () => {
  const body = readable(PAGE, 'text/html', { raw: true }).content;
  assert.match(body, /<!doctype html>/i);
  assert.match(body, /__data/);
});

test('json is pretty-printed rather than flattened', () => {
  const result = readable('{"a":1,"b":[2,3]}', 'application/json');
  assert.equal(result.kind, 'json');
  assert.match(result.content, /"a": 1/);
  assert.match(result.content, /\n/, 'it is formatted, not one line');
});

test('plain text is returned as-is', () => {
  const result = readable('line one\nline two\n', 'text/plain');
  assert.equal(result.kind, 'text');
  assert.equal(result.content, 'line one\nline two');
});

test('a binary body is described instead of being returned as mojibake', () => {
  const result = readable('\u0000\u0001binary', 'image/png');
  assert.equal(result.kind, 'binary');
  assert.match(result.content, /image\/png/);
  assert.match(result.content, /bytes/);
  assert.doesNotMatch(result.content, /\u0000/);
});

test('a body with no content type is sniffed', () => {
  assert.equal(readable('<html><body><p>hi</p></body></html>', '').kind, 'html');
  assert.equal(readable('just words', '').kind, 'text');
});

test('a page without a main element still yields its content', () => {
  const flat = `<html><head><title>t</title></head><body>
    <div class="nav"><a href="/a">A</a></div>
    <div class="post-body"><p>${'The actual paragraph. '.repeat(20)}</p></div>
    <div class="sidebar">Related junk</div>
  </body></html>`;
  const body = extractContent(flat, 'https://example.com/');
  assert.match(body, /The actual paragraph/);
  assert.doesNotMatch(body, /Related junk/);
});

test('a tiny wrapper does not win over the real article', () => {
  const page = `<html><body>
    <main><p>tiny</p></main>
    <article><p>${'real content here. '.repeat(30)}</p></article>
  </body></html>`;
  const body = extractContent(page, 'https://example.com/');
  assert.match(body, /real content here/);
});

test('a fenced block keeps its language and does not leak the class name', () => {
  const page = '<html><body><pre><code class="language-js">const a = 1;</code></pre></body></html>';
  const body = readable(page, 'text/html').content;
  assert.match(body, /```js\nconst a = 1;\n```/);
  assert.doesNotMatch(body, /language-js/);
});

test('a pre without a language still fences the code', () => {
  const page = '<html><body><pre>plain code</pre></body></html>';
  assert.match(readable(page, 'text/html').content, /```\nplain code\n```/);
});

test('output never leaves runs of blank lines', () => {
  const body = readable(PAGE, 'text/html', { base: 'https://example.com/' }).content;
  assert.doesNotMatch(body, /\n{3,}/);
});
