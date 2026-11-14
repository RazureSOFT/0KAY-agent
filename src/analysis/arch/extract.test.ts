import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { analyzeArchitecture, architectureToMermaid, describeArchitecture } from './extract.js';

/** Write a fixture tree and hand back its root. */
async function fixture(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'arch-'));
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, body, 'utf8');
  }
  return root;
}

test('source files group into their directory', async () => {
  const root = await fixture({
    'src/alpha/a.ts': 'export const a = 1',
    'src/alpha/b.ts': 'export const b = 2',
    'src/beta/c.ts': 'export const c = 3',
  });
  const arch = await analyzeArchitecture(root);
  assert.equal(arch.sourceFiles, 3);
  const alpha = arch.modules.find((m) => m.id === 'src/alpha');
  assert.equal(alpha?.files, 2);
  assert.deepEqual(alpha?.languages, ['ts']);
});

test('a relative import becomes an edge between modules', async () => {
  // This is the property that was silently broken on the first attempt: the
  // graph is in directory units but a specifier names a file, so a naive
  // implementation produces a diagram with no arrows at all.
  const root = await fixture({
    'src/alpha/a.ts': "import { b } from '../beta/b.js'",
    'src/beta/b.ts': 'export const b = 2',
  });
  const arch = await analyzeArchitecture(root);
  assert.equal(arch.edges.length, 1, `expected one edge, got ${JSON.stringify(arch.edges)}`);
  assert.equal(arch.edges[0].from, 'src/alpha');
  assert.equal(arch.edges[0].to, 'src/beta');
});

test('a .js specifier resolves to the .ts file beside it', async () => {
  // TypeScript's ESM output writes `.js` for a file that is `.ts` on disk, which
  // is how every import in this repository is written.
  const root = await fixture({
    'x/a.ts': "import './sibling.js'",
    'x/sibling.ts': 'export const s = 1',
  });
  const arch = await analyzeArchitecture(root);
  // Same directory, so no cross-module edge — but it must not crash or invent a
  // module named "sibling.ts".
  assert.deepEqual(arch.modules.map((m) => m.id).sort(), ['x']);
});

test('a bare specifier is not treated as a workspace module', async () => {
  // Otherwise the diagram fills with node_modules.
  const root = await fixture({
    'src/a.ts': "import { x } from 'some-package'\nimport React from 'react'",
  });
  const arch = await analyzeArchitecture(root);
  assert.equal(arch.edges.length, 0);
});

test('repeated imports collapse into one weighted edge', async () => {
  const root = await fixture({
    'src/a/one.ts': "import '../b/x.js'",
    'src/a/two.ts': "import '../b/y.js'",
    'src/b/x.ts': 'export const x = 1',
    'src/b/y.ts': 'export const y = 2',
  });
  const arch = await analyzeArchitecture(root);
  assert.equal(arch.edges.length, 1);
  assert.equal(arch.edges[0].weight, 2);
});

test('a module nothing imports is marked as an orphan', async () => {
  const root = await fixture({
    'src/core/a.ts': "import '../leaf/l.js'",
    'src/leaf/l.ts': 'export const l = 1',
    'src/stranded/s.ts': 'export const s = 1',
  });
  const arch = await analyzeArchitecture(root);
  assert.equal(arch.modules.find((m) => m.id === 'src/leaf')?.orphan, false);
  assert.equal(arch.modules.find((m) => m.id === 'src/stranded')?.orphan, true);
});

test('a directory that contains other modules is not an orphan', async () => {
  // `src` holds no files of its own but is a parent; calling it an orphan
  // because nothing imports the bare path "src" would be misleading.
  const root = await fixture({
    'src/a/x.ts': "import '../b/y.js'",
    'src/b/y.ts': 'export const y = 1',
  });
  const arch = await analyzeArchitecture(root);
  const parent = arch.modules.find((m) => m.id === 'src');
  assert.equal(parent, undefined, 'a directory with no files of its own is not a module');
});

test('a .gitignore directory is excluded from the architecture', async () => {
  // A reference clone next to the source would otherwise dominate the diagram,
  // answering a question nobody asked.
  const root = await fixture({
    '.gitignore': 'reference/\n# a comment\nscratch\n',
    'src/a.ts': 'export const a = 1',
    'reference/vendored/big.ts': 'export const big = 1',
    'scratch/tmp.ts': 'export const t = 1',
  });
  const arch = await analyzeArchitecture(root);
  assert.deepEqual(arch.modules.map((m) => m.id), ['src']);
});

test('a wildcard gitignore pattern is left alone rather than guessed at', async () => {
  // A pattern engine that is right nine times out of ten would silently drop a
  // real module the tenth time.
  const root = await fixture({
    '.gitignore': '**/generated\nsrc/keep*/\n',
    'src/a.ts': 'export const a = 1',
    'src/keepme/b.ts': 'export const b = 1',
  });
  const arch = await analyzeArchitecture(root);
  assert.ok(arch.modules.some((m) => m.id === 'src/keepme'), 'a wildcard must not be applied as a literal name');
});

test('a gitignore pattern with a path excludes exactly that path', async () => {
  // The real case that exposed this: a reference clone under a subdirectory
  // (`/tui/Claude-Code-rev/`) was matching nothing, so the diagram was dominated
  // by vendored code.
  const root = await fixture({
    '.gitignore': '/refs/reference/\n',
    'src/a.ts': 'export const a = 1',
    'refs/reference/big.ts': 'export const big = 1',
  });
  const arch = await analyzeArchitecture(root);
  assert.deepEqual(arch.modules.map((m) => m.id), ['src']);
});

test('a path pattern does not hide the same name elsewhere in the tree', async () => {
  // `/refs/reference/` names one directory. Matching only its last segment would
  // also drop the project's own `src/reference`, which is real code.
  const root = await fixture({
    '.gitignore': '/refs/reference/\n',
    'refs/reference/vendored.ts': 'export const v = 1',
    'src/reference/ours.ts': 'export const o = 1',
  });
  const arch = await analyzeArchitecture(root);
  assert.deepEqual(arch.modules.map((m) => m.id), ['src/reference']);
});

test('a bare name still matches at any depth', async () => {
  // That is what a bare name means in a .gitignore, so it must keep working.
  const root = await fixture({
    '.gitignore': 'scratch\n',
    'src/a.ts': 'export const a = 1',
    'deep/nested/scratch/b.ts': 'export const b = 1',
  });
  const arch = await analyzeArchitecture(root);
  assert.ok(!arch.modules.some((m) => m.id.includes('scratch')), `scratch was not excluded: ${arch.modules.map((m) => m.id)}`);
});

test('node_modules and build output are never architecture', async () => {
  const root = await fixture({
    'src/a.ts': 'export const a = 1',
    'node_modules/dep/index.ts': 'export const d = 1',
    'dist/bundle.ts': 'export const b = 1',
    '.git/objects/x.ts': 'export const g = 1',
  });
  const arch = await analyzeArchitecture(root);
  assert.deepEqual(arch.modules.map((m) => m.id), ['src']);
});

test('a Python import from a package resolves to the module', async () => {
  const root = await fixture({
    'app/main.py': 'from lib.util import helper\nimport lib.other',
    'lib/util.py': 'def helper(): pass',
    'lib/other.py': 'x = 1',
  });
  const arch = await analyzeArchitecture(root);
  const edge = arch.edges.find((e) => e.from === 'app' && e.to === 'lib');
  assert.ok(edge, `no app -> lib edge in ${JSON.stringify(arch.edges)}`);
});

test('a Go import path lands on the deepest matching directory', async () => {
  const root = await fixture({
    'internal/gateway/server.go': 'package gateway\nimport "example.com/proj/internal/netguard"',
    'internal/netguard/netguard.go': 'package netguard',
  });
  const arch = await analyzeArchitecture(root);
  const edge = arch.edges.find((e) => e.from === 'internal/gateway');
  assert.equal(edge?.to, 'internal/netguard');
});

test('a huge workspace is capped, keeping the busiest modules', async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 40; i += 1) {
    files[`mod${String(i).padStart(2, '0')}/a.ts`] = `export const v = 1\n`.repeat(i + 1);
  }
  const root = await fixture(files);
  const arch = await analyzeArchitecture(root, { maxModules: 6 });
  assert.equal(arch.modules.length, 6);
  // The cap is reported honestly — the workspace was not smaller than it is.
  assert.equal(arch.total, 40);
});

test('dropping a module drops the arrows that pointed at it', async () => {
  // A dangling edge renders as a box the reader cannot find in the legend.
  const files: Record<string, string> = {};
  for (let i = 0; i < 30; i += 1) {
    files[`big${String(i).padStart(2, '0')}/a.ts`] = `export const v = 1\n`.repeat(20);
  }
  files['tiny/t.ts'] = "import '../big00/a.js'";
  const root = await fixture(files);
  const arch = await analyzeArchitecture(root, { maxModules: 4 });
  const kept = new Set(arch.modules.map((m) => m.id));
  for (const edge of arch.edges) {
    assert.ok(kept.has(edge.from), `edge from dropped module ${edge.from}`);
    assert.ok(kept.has(edge.to), `edge to dropped module ${edge.to}`);
  }
});

test('an empty workspace produces an empty architecture, not a crash', async () => {
  const root = await fixture({ 'readme.md': '# nothing here' });
  const arch = await analyzeArchitecture(root);
  assert.deepEqual(arch.modules, []);
  assert.deepEqual(arch.edges, []);
  assert.equal(arch.sourceFiles, 0);
});

test('the mermaid output is well-formed and marks orphans', async () => {
  const root = await fixture({
    'src/a/x.ts': "import '../b/y.js'",
    'src/b/y.ts': 'export const y = 1',
    'src/lonely/z.ts': 'export const z = 1',
  });
  const mermaid = await analyzeArchitecture(root).then((arch) => architectureToMermaid(arch, 'Test'));
  assert.match(mermaid, /^flowchart LR/);
  assert.match(mermaid, /classDef orphan/);
  // Every edge references a node id that was declared.
  const declared = new Set([...mermaid.matchAll(/^\s+(m\d+)\[/gm)].map((m) => m[1]));
  for (const match of mermaid.matchAll(/^\s+(m\d+) -->/gm)) {
    assert.ok(declared.has(match[1]), `edge from undeclared node ${match[1]}`);
  }
});

test('the description names the most depended-on module first', async () => {
  const root = await fixture({
    'src/core/c.ts': 'export const c = 1',
    'src/a1/x.ts': "import '../core/c.js'",
    'src/a2/y.ts': "import '../core/c.js'",
    'src/a3/z.ts': "import '../core/c.js'",
  });
  const text = await analyzeArchitecture(root).then(describeArchitecture);
  const first = text.split('\n').find((line) => line.startsWith('- '));
  assert.match(first || '', /src\/core/, `most depended-on was not first: ${first}`);
});

test('a workspace with no imports reports no dependencies section', async () => {
  const root = await fixture({ 'src/a.ts': 'export const a = 1' });
  const text = await analyzeArchitecture(root).then(describeArchitecture);
  assert.match(text, /1 source file/);
  assert.doesNotMatch(text, /Dependencies:/);
});
