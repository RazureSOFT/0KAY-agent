import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { changedModules, diffArchitectures, readArchMap, writeArchMap } from './store.js';
import type { Architecture } from './extract.js';

function arch(modules: Array<[string, number]>, edges: Array<[string, string]>): Architecture {
  return {
    modules: modules.map(([id, lines]) => ({ id, label: id.split('/').pop() || id, files: 1, lines, languages: ['ts'], orphan: false })),
    edges: edges.map(([from, to]) => ({ from, to, weight: 1 })),
    files: modules.length,
    sourceFiles: modules.length,
    total: modules.length,
  };
}

async function cwd(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'arch-store-'));
}

test('nothing changed is reported as clean', () => {
  const before = arch([['a', 10], ['b', 20]], [['a', 'b']]);
  const after = arch([['a', 10], ['b', 20]], [['a', 'b']]);
  const diff = diffArchitectures(before, after);
  assert.equal(diff.clean, true);
  assert.match(diff.summary, /unchanged/);
});

test('a new module is reported by name', () => {
  const diff = diffArchitectures(arch([['a', 1]], []), arch([['a', 1], ['b', 2]], []));
  assert.deepEqual(diff.added, ['b']);
  assert.equal(diff.clean, false);
  assert.match(diff.summary, /1 module\(s\) appeared: b/);
});

test('a removed module is reported by name', () => {
  const diff = diffArchitectures(arch([['a', 1], ['gone', 2]], []), arch([['a', 1]], []));
  assert.deepEqual(diff.removed, ['gone']);
  assert.match(diff.summary, /gone/);
});

test('a new dependency is reported with both ends', () => {
  const diff = diffArchitectures(arch([['a', 1], ['b', 2]], []), arch([['a', 1], ['b', 2]], [['a', 'b']]));
  assert.deepEqual(diff.newEdges, [{ from: 'a', to: 'b' }]);
  assert.match(diff.summary, /a -> b/);
});

test('a dropped dependency is counted but not itemised', () => {
  // What a person acts on is a summary; a diff of two graphs is not read.
  const diff = diffArchitectures(arch([['a', 1], ['b', 2]], [['a', 'b']]), arch([['a', 1], ['b', 2]], []));
  assert.deepEqual(diff.droppedEdges, [{ from: 'a', to: 'b' }]);
  assert.match(diff.summary, /1 dependency\(ies\) removed/);
});

test('a change of only line count is not a structural change', () => {
  // The architecture did not change because a module grew; that is what
  // changedModules is for.
  const diff = diffArchitectures(arch([['a', 10]], []), arch([['a', 99]], []));
  assert.equal(diff.clean, true);
  assert.deepEqual(changedModules(arch([['a', 10]], []), arch([['a', 99]], [])), ['a']);
});

test('an unchanged module is not reported as changed', () => {
  assert.deepEqual(changedModules(arch([['a', 10]], []), arch([['a', 10]], [])), []);
});

test('a module that only gained files is reported as changed', () => {
  const before = arch([['a', 10]], []);
  const after = arch([['a', 10]], []);
  after.modules[0].files = 4;
  assert.deepEqual(changedModules(before, after), ['a']);
});

test('a map round-trips through disk', async () => {
  const dir = await cwd();
  const written = await writeArchMap(dir, arch([['src/a', 5]], []), '/some/root');
  const read = await readArchMap(dir);
  assert.ok(read);
  assert.equal(read.root, '/some/root');
  assert.equal(read.arch.modules[0].id, 'src/a');
  assert.ok(written.endsWith('architecture.json'));
});

test('a missing map reads as undefined, not a crash', async () => {
  const dir = await cwd();
  assert.equal(await readArchMap(dir), undefined);
});

test('a corrupt map reads as undefined, not a crash', async () => {
  // A truncated file must cost one regeneration, not a thrown error in whatever
  // tool happened to ask.
  const dir = await cwd();
  await fs.mkdir(path.join(dir, '.0kay-agent'), { recursive: true });
  await fs.writeFile(path.join(dir, '.0kay-agent', 'architecture.json'), '{"arch":{"modules":', 'utf8');
  assert.equal(await readArchMap(dir), undefined);
});

test('a JSON file of the wrong shape reads as undefined', async () => {
  const dir = await cwd();
  await fs.mkdir(path.join(dir, '.0kay-agent'), { recursive: true });
  await fs.writeFile(path.join(dir, '.0kay-agent', 'architecture.json'), '{"arch":{"modules":"nope"}}', 'utf8');
  assert.equal(await readArchMap(dir), undefined);
});

test('writing a map twice keeps the newest', async () => {
  const dir = await cwd();
  await writeArchMap(dir, arch([['old', 1]], []), '/r');
  await writeArchMap(dir, arch([['new', 1]], []), '/r');
  const read = await readArchMap(dir);
  assert.equal(read?.arch.modules[0].id, 'new');
});
