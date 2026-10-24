import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { DiagramTool, renderSvg, renderMermaid } from './diagram.js';

const spec = {
  kind: 'architecture' as const,
  title: 'Request path',
  direction: 'LR' as const,
  nodes: [
    { id: 'web', label: 'WebUI', group: 'client' },
    { id: 'core', label: 'Core', group: 'server' },
    { id: 'db', label: 'SQLite', group: 'data' },
  ],
  edges: [
    { from: 'web', to: 'core', label: 'HTTP' },
    { from: 'core', to: 'db' },
  ],
};

test('renderSvg draws every node label and edge label', () => {
  const { svg, width, height } = renderSvg(spec);
  assert.ok(width > 0 && height > 0, 'diagram has no size');
  for (const label of ['WebUI', 'Core', 'SQLite', 'HTTP']) {
    assert.ok(svg.includes(label), `missing label: ${label}`);
  }
  assert.match(svg, /<svg[\s>]/, 'output is not an SVG document');
});

test('renderMermaid emits a graph the model can re-embed', () => {
  const mermaid = renderMermaid(spec);
  assert.match(mermaid, /^(graph|flowchart)/, `unexpected mermaid header: ${mermaid.slice(0, 40)}`);
  assert.ok(mermaid.includes('WebUI'));
});

test('outline input is expanded into nodes', () => {
  const { svg } = renderSvg({ kind: 'mindmap', outline: 'Root\n  Child A\n  Child B' });
  assert.ok(svg.includes('Root') && svg.includes('Child A') && svg.includes('Child B'));
});

test('DiagramTool writes the svg and a self-contained html viewer', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'diagram-'));
  const tool = new DiagramTool();
  const result: any = await tool.execute(
    { ...spec, out: dir, name: 'probe', inline: false },
    { cwd: dir, taskId: 'test' } as any,
  );
  assert.equal(result?.success, true, `tool failed: ${JSON.stringify(result).slice(0, 200)}`);
  const payload = result?.data ?? {};
  const files: string[] = payload.files || [];
  assert.equal(files.length, 2, `expected svg + html, got ${files.join(', ')}`);

  const html = files.find((file) => file.endsWith('.html'));
  assert.ok(html && existsSync(html), 'html viewer was not written');
  const markup = readFileSync(html!, 'utf8');
  assert.ok(markup.includes('<svg'), 'viewer does not embed the svg');
  assert.ok(!/<script[^>]+src=/.test(markup), 'viewer pulls a remote script');
  assert.ok(!/<link[^>]+href="http/.test(markup), 'viewer pulls a remote stylesheet');
});
