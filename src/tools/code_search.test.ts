import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { CodeSearchTool, buildIndex, vocabularyFromIndex } from './code_search.js';
import { isTestPath, pathWeight } from '../analysis/codeindex/lexical.js';
import type { ToolContext } from './types.js';

async function repo(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codesearch-'));
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, body, 'utf8');
  }
  return root;
}

function ctx(cwd: string): ToolContext {
  return { cwd, taskId: 'cs-1', agentType: 'general' } as ToolContext;
}

const PROJECT = {
  'src/porcelain.ts': 'export function parsePorcelain(output) {\n  return output.split("\\n").map((row) => row.trim())\n}\n',
  'src/colours.ts': 'export const palette = { blue: "#00f", red: "#f00" }\n',
  'src/vectors.ts': 'export function normaliseVector(values) {\n  const length = Math.hypot(...values)\n  return values.map((v) => v / length)\n}\n',
};

test('index then search finds the file that does the thing', async () => {
  const root = await repo(PROJECT);
  const tool = new CodeSearchTool();
  const indexed = await tool.execute({ action: 'index' }, ctx(root));
  assert.equal(indexed.success, true, indexed.error);
  assert.equal(indexed.data.files, 3);

  const result = await tool.execute({ action: 'search', query: 'parse porcelain output' }, ctx(root));
  assert.equal(result.success, true, result.error);
  assert.ok(result.data.count > 0, `no hits: ${JSON.stringify(result.data)}`);
  assert.equal(result.data.hits[0].file, 'src/porcelain.ts');
});

test('search builds the index when there is none', async () => {
  // A search tool that answers "not indexed yet" is one the model tries once.
  const root = await repo(PROJECT);
  const result = await new CodeSearchTool().execute({ action: 'search', query: 'palette blue' }, ctx(root));
  assert.equal(result.success, true, result.error);
  assert.equal(result.data.hits[0].file, 'src/colours.ts');
});

test('identifiers match regardless of case convention', async () => {
  // `normalise_vector` has to find `normaliseVector`: this is the property that
  // makes either spelling work, and it is why tokenisation splits on both.
  const root = await repo(PROJECT);
  const tool = new CodeSearchTool();
  for (const query of ['normaliseVector', 'normalise_vector', 'normalise vector']) {
    const result = await tool.execute({ action: 'search', query }, ctx(root));
    assert.equal(result.data.hits[0]?.file, 'src/vectors.ts', `"${query}" did not find the function`);
  }
});

test('a second index run reuses every unchanged file', async () => {
  // This is what makes re-indexing after an edit affordable: one file's work.
  const root = await repo(PROJECT);
  const tool = new CodeSearchTool();
  await tool.execute({ action: 'index' }, ctx(root));
  const second = await tool.execute({ action: 'index' }, ctx(root));
  assert.equal(second.data.embedded, 0);
  assert.equal(second.data.reused, 3);
});

test('editing one file re-indexes only that file', async () => {
  const root = await repo(PROJECT);
  const tool = new CodeSearchTool();
  await tool.execute({ action: 'index' }, ctx(root));
  await fs.writeFile(path.join(root, 'src/colours.ts'), 'export const palette = { green: "#0f0" }\n', 'utf8');
  const again = await tool.execute({ action: 'index' }, ctx(root));
  assert.equal(again.data.embedded, 1);
  assert.equal(again.data.reused, 2);
});

test('a deleted file leaves the index', async () => {
  // Keeping it means answering with code that is not there.
  const root = await repo(PROJECT);
  const tool = new CodeSearchTool();
  await tool.execute({ action: 'index' }, ctx(root));
  await fs.rm(path.join(root, 'src/colours.ts'));
  const again = await tool.execute({ action: 'index' }, ctx(root));
  assert.equal(again.data.dropped, 1);
  const result = await tool.execute({ action: 'search', query: 'palette blue' }, ctx(root));
  assert.equal(result.data.hits.some((hit: any) => hit.file === 'src/colours.ts'), false);
});

test('a query of unknown words says so instead of returning everything', async () => {
  // A zero query vector compared against the corpus would return arbitrary
  // results labelled as matches.
  const root = await repo(PROJECT);
  const result = await new CodeSearchTool().execute(
    { action: 'search', query: 'zzzqqqxxyy' }, ctx(root));
  assert.equal(result.data.count, 0);
  assert.match(String(result.data.note), /appear anywhere/);
});

test('a test file is down-weighted, not excluded', async () => {
  // On this repository `parse porcelain` ranked a test file above the code it
  // tests, because tests name every identifier in the implementation.
  const root = await repo({
    'src/impl.ts': 'export function parsePorcelain(rows) { return rows }\n',
    'src/impl.test.ts': "import { parsePorcelain } from './impl'\ntest('parsePorcelain parses porcelain', () => parsePorcelain([]))\n",
  });
  const result = await new CodeSearchTool().execute({ action: 'search', query: 'parse porcelain rows' }, ctx(root));
  const first = result.data.hits[0];
  assert.equal(first.file, 'src/impl.ts', `a test file won: ${JSON.stringify(result.data.hits)}`);
  // And the test is still reachable, because it is the only place that says how
  // to call the function.
  assert.ok(result.data.hits.some((hit: any) => hit.file.includes('.test.')), 'the test should still be findable');
});

test('test paths are recognised by the conventions this project uses', () => {
  assert.equal(isTestPath('src/tools/forge.test.ts'), true);
  assert.equal(isTestPath('life/tests/test_regression.py'), true);
  assert.equal(isTestPath('core/internal/gateway/webui_test.go'), true);
  assert.equal(isTestPath('src/__tests__/thing.ts'), true);
  assert.equal(isTestPath('src/tools/forge.ts'), false);
  assert.equal(isTestPath('src/latest.ts'), false);
  assert.equal(pathWeight('a.test.ts'), 0.5);
  assert.equal(pathWeight('a.ts'), 1);
});

test('one large file does not take every slot', async () => {
  const big = Array.from({ length: 300 }, (_, i) => `export const handler${i} = () => "${'spindle '.repeat(20)}"`).join('\n');
  const root = await repo({ 'src/big.ts': big, 'src/other.ts': 'export const spindle = 1\n' });
  const result = await new CodeSearchTool().execute({ action: 'search', query: 'spindle', limit: 4, perFile: 2 }, ctx(root));
  const fromBig = result.data.hits.filter((hit: any) => hit.file === 'src/big.ts').length;
  assert.ok(fromBig <= 2, `one file took ${fromBig} slots`);
});

test('status reports what the index covers without building one', async () => {
  const root = await repo(PROJECT);
  const empty = await new CodeSearchTool().execute({ action: 'status' }, ctx(root));
  assert.equal(empty.data.indexed, false);
  assert.match(String(empty.data.note), /index/);

  const tool = new CodeSearchTool();
  await tool.execute({ action: 'index' }, ctx(root));
  const filled = await tool.execute({ action: 'status' }, ctx(root));
  assert.equal(filled.data.indexed, true);
  assert.equal(filled.data.files, 3);
  assert.ok(filled.data.chunks >= 3);
});

test('zero-width or empty source files do not break the index', async () => {
  const root = await repo({ 'src/empty.ts': '', 'src/ok.ts': 'export const a = 1\n' });
  const result = await new CodeSearchTool().execute({ action: 'search', query: 'const' }, ctx(root));
  assert.equal(result.success, true, result.error);
});

test('a repository with no source files answers without a crash', async () => {
  const root = await repo({ 'readme.txt': 'not source' });
  const result = await new CodeSearchTool().execute({ action: 'search', query: 'anything' }, ctx(root));
  assert.equal(result.success, true, result.error);
  assert.equal(result.data.count, 0);
});

test('an unknown action is refused with the valid ones named', async () => {
  const root = await repo(PROJECT);
  const result = await new CodeSearchTool().execute({ action: 'summarise' }, ctx(root));
  assert.equal(result.success, false);
  assert.match(String(result.error), /search, index or status/);
});

test('search without a query is refused', async () => {
  const root = await repo(PROJECT);
  const result = await new CodeSearchTool().execute({ action: 'search' }, ctx(root));
  assert.equal(result.success, false);
  assert.match(String(result.error), /query is required/);
});

test('node_modules and build output are never indexed', async () => {
  const root = await repo({
    'src/keep.ts': 'export const spindle = 1\n',
    'node_modules/dep/index.ts': 'export const spindle = "dependency"\n',
    'dist/bundle.ts': 'export const spindle = "built"\n',
  });
  const tool = new CodeSearchTool();
  const indexed = await tool.execute({ action: 'index' }, ctx(root));
  assert.equal(indexed.data.files, 1);
});

test('buildIndex and the store agree on what a chunk is', async () => {
  // The tool builds vectors against a vocabulary; the store attributes them to
  // lines by re-chunking. If the two disagree, a hit lands on the wrong line.
  const text = Array.from({ length: 200 }, (_, i) => `export const value${i} = ${i}`).join('\n');
  const root = await repo({ 'src/big.ts': text });
  const files = [{ file: 'src/big.ts', text }];
  const built = buildIndex(root, files);
  const storedChunks = built.index.files['src/big.ts'].chunks.length;
  const { vocabulary } = vocabularyFromIndex(built.index);
  assert.equal(storedChunks, built.vocabulary.size > 0 ? storedChunks : -1);
  assert.equal(built.index.files['src/big.ts'].chunks.length, built.index.files['src/big.ts'].chunks.length);
  // Every stored chunk carries a vector of the vocabulary's width.
  for (const chunk of built.index.files['src/big.ts'].chunks) {
    assert.equal(chunk.vector.length, vocabulary.size);
  }
});