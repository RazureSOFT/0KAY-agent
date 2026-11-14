import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ArchitectureTool } from './architecture.js';
import type { ToolContext } from './types.js';

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'arch-tool-'));
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, body, 'utf8');
  }
  return root;
}

function context(cwd: string): ToolContext {
  return { cwd, taskId: 'arch-1', agentType: 'general' } as ToolContext;
}

const TREE = {
  'src/core/c.ts': 'export const c = 1',
  'src/web/w.ts': "import '../core/c.js'",
  'src/lonely/l.ts': 'export const l = 1',
};

test('scan derives the structure from the code', async () => {
  const root = await fixture(TREE);
  const result = await new ArchitectureTool().execute({ action: 'scan' }, context(root));
  assert.equal(result.success, true, result.error);
  assert.equal(result.data.sourceFiles, 3);
  assert.match(result.data.architecture, /src\/core/);
  // Nothing was saved, so there is no drift to report — and it says why.
  assert.match(String(result.data.note), /save/);
});

test('scan is read-only: it does not create the stored map', async () => {
  // A read that rewrites state makes "has this changed" a question the reader
  // answers by asking.
  const root = await fixture(TREE);
  await new ArchitectureTool().execute({ action: 'scan' }, context(root));
  const entries = await fs.readdir(path.join(root, '.0kay-agent')).catch(() => [] as string[]);
  assert.equal(entries.includes('architecture.json'), false);
});

test('save then diff reports a new module by name', async () => {
  const root = await fixture(TREE);
  const tool = new ArchitectureTool();
  const saved = await tool.execute({ action: 'save' }, context(root));
  assert.equal(saved.success, true, saved.error);
  assert.ok(saved.data.file.endsWith('architecture.json'));

  await fs.mkdir(path.join(root, 'src/added'), { recursive: true });
  await fs.writeFile(path.join(root, 'src/added/a.ts'), 'export const a = 1', 'utf8');

  const diff = await tool.execute({ action: 'diff' }, context(root));
  assert.equal(diff.success, true, diff.error);
  assert.equal(diff.data.clean, false);
  assert.deepEqual(diff.data.added, ['src/added']);
  assert.match(String(diff.data.drift), /src\/added/);
});

test('diff with no change is reported as clean', async () => {
  const root = await fixture(TREE);
  const tool = new ArchitectureTool();
  await tool.execute({ action: 'save' }, context(root));
  const diff = await tool.execute({ action: 'diff' }, context(root));
  assert.equal(diff.data.clean, true);
});

test('diff with no saved map says so instead of reporting a fake clean', async () => {
  const root = await fixture(TREE);
  const diff = await new ArchitectureTool().execute({ action: 'diff' }, context(root));
  assert.equal(diff.success, true);
  assert.match(String(diff.data.note), /no saved map/);
  assert.equal(diff.data.clean, undefined);
});

test('save reports what it replaced', async () => {
  const root = await fixture(TREE);
  const tool = new ArchitectureTool();
  const first = await tool.execute({ action: 'save' }, context(root));
  assert.equal(first.data.replaced, null);
  const second = await tool.execute({ action: 'save' }, context(root));
  assert.ok(second.data.replaced, 'second save should report the snapshot it replaced');
});

test('draw writes an svg and reports the file', async () => {
  const root = await fixture(TREE);
  const result = await new ArchitectureTool().execute({ action: 'draw' }, context(root));
  assert.equal(result.success, true, result.error);
  assert.equal(result.data.format, 'svg');
  const body = await fs.readFile(result.data.file, 'utf8');
  assert.match(body, /<svg/);
});

test('draw writes mermaid for a caller who wants the source', async () => {
  const root = await fixture(TREE);
  const result = await new ArchitectureTool().execute({ action: 'draw', format: 'mermaid' }, context(root));
  assert.equal(result.success, true, result.error);
  assert.match(await fs.readFile(result.data.file, 'utf8'), /^flowchart/);
  assert.match(String(result.data.mermaid), /^flowchart/);
});

test('draw writes a portable html page', async () => {
  const root = await fixture(TREE);
  const result = await new ArchitectureTool().execute({ action: 'draw', format: 'html' }, context(root));
  assert.equal(result.success, true, result.error);
  const body = await fs.readFile(result.data.file, 'utf8');
  assert.match(body, /<pre class="mermaid">/);
  // The diagram source is in the page, so it is readable without the CDN.
  assert.match(body, /flowchart/);
});

test('a dark theme changes the palette, not the structure', async () => {
  const root = await fixture(TREE);
  const light = await new ArchitectureTool().execute({ action: 'draw', format: 'mermaid' }, context(root));
  const dark = await new ArchitectureTool().execute({ action: 'draw', format: 'mermaid', theme: 'dark' }, context(root));
  const edges = (text: string) => text.split('\n').filter((line) => line.includes('-->')).join('\n');
  assert.equal(edges(light.data.mermaid), edges(dark.data.mermaid));
  assert.notEqual(light.data.mermaid, dark.data.mermaid);
});

test('a name with a slash cannot write outside the output directory', async () => {
  // `out` can be user-supplied, so the base name has to be a base name.
  const root = await fixture(TREE);
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'arch-out-'));
  const result = await new ArchitectureTool().execute(
    { action: 'draw', format: 'mermaid', out, name: '../../escape' },
    context(root),
  );
  assert.equal(result.success, true, result.error);
  assert.equal(path.dirname(result.data.file), out);
});

test('an unknown action is refused with the valid ones named', async () => {
  const root = await fixture(TREE);
  const result = await new ArchitectureTool().execute({ action: 'explode' }, context(root));
  assert.equal(result.success, false);
  assert.match(String(result.error), /scan, draw, save or diff/);
});

test('maxModules caps the diagram but reports the real total', async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 30; i += 1) files[`m${String(i).padStart(2, '0')}/a.ts`] = `export const v = 1\n`.repeat(i + 1);
  const root = await fixture(files);
  const result = await new ArchitectureTool().execute({ action: 'scan', maxModules: 5 }, context(root));
  assert.equal(result.data.modules, 5);
  assert.equal(result.data.totalModules, 30);
});

test('the tool is marked dangerous because save writes stored state', () => {
  // "The agent rewrote its understanding of your codebase" is exactly the kind
  // of thing an operator should get to see happen.
  assert.equal(new ArchitectureTool().dangerous, true);
});