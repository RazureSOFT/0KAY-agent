import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { ReportArtifactsTool } from './report_artifacts.js';
import type { ToolContext } from './types.js';

function ctx(cwd: string): ToolContext {
  return { cwd, taskId: 't1', sessionId: 's1', agentType: 'general' } as ToolContext;
}

test('registers files that exist and resolves them against the cwd', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'artifacts-'));
  writeFileSync(path.join(root, 'report.md'), 'hello');
  const tool = new ReportArtifactsTool();

  const result = await tool.execute(
    { artifacts: [{ path: 'report.md', description: 'the report' }, { path: path.join(root, 'report.md') }] },
    ctx(root),
  );

  assert.equal(result.success, true);
  assert.equal(result.data.artifacts.length, 1, 'the same file listed twice must collapse');
  assert.equal(result.data.artifacts[0].path, path.join(root, 'report.md'));
  assert.equal(result.data.artifacts[0].description, 'the report');
  assert.equal(result.data.artifacts[0].bytes, 5);
  assert.match(result.data.text, /1 artifact\(s\) registered/);
});

test('drops paths that are not on disk and says so', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'artifacts-'));
  writeFileSync(path.join(root, 'real.txt'), 'x');
  const tool = new ReportArtifactsTool();

  const result = await tool.execute(
    { artifacts: [{ path: 'real.txt' }, { path: 'ghost.txt' }] },
    ctx(root),
  );

  assert.equal(result.success, true);
  assert.equal(result.data.artifacts.length, 1);
  assert.match(result.data.text, /Not found \(dropped\): ghost\.txt/);
});

test('rejects a list where nothing exists rather than returning an empty success', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'artifacts-'));
  const tool = new ReportArtifactsTool();
  const result = await tool.execute({ artifacts: [{ path: 'nope.txt' }] }, ctx(root));
  assert.equal(result.success, false);
  assert.match(String(result.error), /no artifact exists on disk/);
});

test('rejects directories and an empty list', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'artifacts-'));
  mkdirSync(path.join(root, 'subdir'));
  const tool = new ReportArtifactsTool();

  const dir = await tool.execute({ artifacts: [{ path: 'subdir' }] }, ctx(root));
  assert.equal(dir.success, false);
  assert.match(String(dir.error), /not a file/);

  const empty = await tool.execute({ artifacts: [] }, ctx(root));
  assert.equal(empty.success, false);
  assert.match(String(empty.error), /non-empty array/);
});
