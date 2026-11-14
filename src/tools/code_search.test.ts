import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createServer } from 'node:http';
import { CodeSearchTool, buildLexicalIndex, vocabularyFromIndex } from './code_search.js';
import { chunkText } from '../analysis/codeindex/vectors.js';
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

test('the lexical builder and the store agree on what a chunk is', async () => {
  // The builder writes a vector per chunk; the search path re-chunks to lay the
  // sparse weights out against a vocabulary. If the two disagree, a hit lands on
  // the wrong line.
  const text = Array.from({ length: 200 }, (_, i) => `export const value${i} = ${i}`).join('\n');
  const root = await repo({ 'src/big.ts': text });
  const files = [{ file: 'src/big.ts', text }];
  const stored = buildLexicalIndex(root, files);
  const chunks = stored.files['src/big.ts'].chunks;
  assert.ok(chunks.length > 1, 'a 200-line file should span several chunks');

  const { vocabulary } = vocabularyFromIndex(stored);
  // Every stored chunk carries a vector of the vocabulary's width, or the search
  // path cannot lay it out.
  for (const chunk of chunks) {
    assert.equal(chunk.vector.length, vocabulary.size);
  }
  // The chunk lines are the ones the splitter produces, not a re-derivation.
  assert.deepEqual(chunks.map((chunk) => chunk.line), chunkText(text, {}).map((chunk) => chunk.line));
});

// --- the two backends -------------------------------------------------------

test('with no embeddings provider the index is lexical and says so', async () => {
  // No embeddings model is a normal state, and the reply has to make it obvious
  // which vectors answered — otherwise a user who configured a model and got
  // lexical results cannot tell whether the fallback fired.
  const root = await repo(PROJECT);
  // No Core running, so provider discovery finds nothing.
  const saved = process.env.CORE_HTTP_ADDR;
  process.env.CORE_HTTP_ADDR = 'http://127.0.0.1:1';
  try {
    const tool = new CodeSearchTool();
    const indexed = await tool.execute({ action: 'index' }, ctx(root));
    assert.equal(indexed.success, true, indexed.error);
    assert.equal(indexed.data.backend, 'lexical');
    assert.match(String(indexed.data.backendReason), /no embeddings provider/);

    const found = await tool.execute({ action: 'search', query: 'palette blue' }, ctx(root));
    assert.equal(found.data.backend, 'lexical');
    assert.equal(found.data.hits[0].file, 'src/colours.ts');
  } finally {
    if (saved === undefined) delete process.env.CORE_HTTP_ADDR;
    else process.env.CORE_HTTP_ADDR = saved;
  }
});

test('with an embeddings provider configured, search uses it', async () => {
  // The whole point of the second backend: a query that shares no words with the
  // target still finds it, because the model supplies the synonymy.
  const root = await repo({
    'src/extract.ts': 'export function readable(body, kind) { return body }\n',
  });

  // A stand-in Core that advertises an embeddings provider, and a stand-in
  // embeddings endpoint that maps its inputs onto a tiny fixed space: "readable"
  // and "extract text" land on the same direction, which is what a real model
  // would do and what lexical search cannot.
  const embeddingServer = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    const inputs: string[] = Array.isArray(body.input) ? body.input : [body.input];
    const data = inputs.map((text: string, index: number) => {
      const lower = String(text).toLowerCase();
      const semantic = lower.includes('extract text') || lower.includes('readable');
      return { embedding: semantic ? [1, 0] : [0, 1], index };
    });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data }));
  });
  await new Promise<void>((resolve) => embeddingServer.listen(0, '127.0.0.1', () => resolve()));
  const embedPort = (embeddingServer.address() as { port: number }).port;

  const coreServer = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      providers: [{
        id: 'p-embed', provider: 'test', kind: 'embedding',
        base_url: `http://127.0.0.1:${embedPort}`, api_key: '',
        models: ['tiny'], default_model: 'tiny', enabled: true,
      }],
      default_provider_id: 'p-embed',
    }));
    void req;
  });
  await new Promise<void>((resolve) => coreServer.listen(0, '127.0.0.1', () => resolve()));
  const corePort = (coreServer.address() as { port: number }).port;

  const saved = process.env.CORE_HTTP_ADDR;
  process.env.CORE_HTTP_ADDR = `http://127.0.0.1:${corePort}`;
  try {
    const tool = new CodeSearchTool();
    const indexed = await tool.execute({ action: 'index' }, ctx(root));
    assert.equal(indexed.success, true, indexed.error);
    assert.equal(indexed.data.backend, 'embedding');
    assert.equal(indexed.data.model, 'tiny');

    // "extract text" shares no word with the file; only the vectors connect them.
    const found = await tool.execute({ action: 'search', query: 'extract text' }, ctx(root));
    assert.equal(found.data.backend, 'embedding');
    assert.equal(found.data.hits[0]?.file, 'src/extract.ts', `got ${JSON.stringify(found.data.hits)}`);
  } finally {
    if (saved === undefined) delete process.env.CORE_HTTP_ADDR;
    else process.env.CORE_HTTP_ADDR = saved;
    embeddingServer.close();
    coreServer.close();
  }
});

test('an embeddings endpoint that fails falls back to lexical rather than failing', async () => {
  // An endpoint being down must not take code search down with it.
  const root = await repo(PROJECT);
  const coreServer = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      providers: [{ id: 'p', kind: 'embedding', base_url: 'http://127.0.0.1:1', models: ['m'], default_model: 'm', enabled: true }],
      default_provider_id: 'p',
    }));
    void req;
  });
  await new Promise<void>((resolve) => coreServer.listen(0, '127.0.0.1', () => resolve()));
  const corePort = (coreServer.address() as { port: number }).port;

  const saved = process.env.CORE_HTTP_ADDR;
  process.env.CORE_HTTP_ADDR = `http://127.0.0.1:${corePort}`;
  try {
    const tool = new CodeSearchTool();
    const indexed = await tool.execute({ action: 'index' }, ctx(root));
    assert.equal(indexed.success, true, indexed.error);
    // The build fell back, and it says so instead of pretending.
    assert.equal(indexed.data.backend, 'lexical');
    assert.match(String(indexed.data.warning), /embeddings failed/);

    const found = await tool.execute({ action: 'search', query: 'palette blue' }, ctx(root));
    assert.equal(found.success, true, found.error);
    assert.equal(found.data.hits[0].file, 'src/colours.ts');
  } finally {
    if (saved === undefined) delete process.env.CORE_HTTP_ADDR;
    else process.env.CORE_HTTP_ADDR = saved;
    coreServer.close();
  }
});

test('switching backend invalidates the cache rather than mixing vector spaces', async () => {
  // A lexical index and an embedding index cannot be compared, so reusing one
  // for the other would rank a query against incompatible vectors.
  const root = await repo(PROJECT);
  const saved = process.env.CORE_HTTP_ADDR;
  process.env.CORE_HTTP_ADDR = 'http://127.0.0.1:1';
  try {
    const tool = new CodeSearchTool();
    await tool.execute({ action: 'index' }, ctx(root));
    const lexical = await tool.execute({ action: 'status' }, ctx(root));
    assert.equal(lexical.data.backend, 'lexical');
    // The indexer name is part of the stored record, so a different backend reads
    // as "nothing stored" and rebuilds.
    const stored = JSON.parse(await fs.readFile(path.join(root, '.0kay-agent', 'code-index.json'), 'utf8'));
    assert.equal(stored.model, 'lexical-tfidf-1');
  } finally {
    if (saved === undefined) delete process.env.CORE_HTTP_ADDR;
    else process.env.CORE_HTTP_ADDR = saved;
  }
});