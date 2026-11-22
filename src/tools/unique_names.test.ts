import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uniqueNames } from './unique_names.js';

test('a duplicated symbol gets its address, so a call resolves to one entry', () => {
  // `internal/bytealg.countGeneric` is built once per element size and every copy keeps
  // the name. Naming both `countGeneric` made a call to the second print as a recursive
  // call to the first, and `cl` then reported `C2198: too few arguments for call` against
  // the wrong signature.
  const names = uniqueNames([
    { entry: 0x14000e020, name: 'internal/bytealg.countGeneric' },
    { entry: 0x14000ec60, name: 'internal/bytealg.countGeneric' },
  ]);
  assert.equal(names.get(0x14000e020), 'internal_bytealg_countGeneric_14000e020');
  assert.equal(names.get(0x14000ec60), 'internal_bytealg_countGeneric_14000ec60');
});

test('a symbol that appears once keeps its plain name', () => {
  const names = uniqueNames([{ entry: 0x1000, name: 'runtime.main' }]);
  assert.equal(names.get(0x1000), 'runtime_main');
});

test('a name longer than MSVC accepts is cut, and the address keeps it apart', () => {
  // Generics are the long ones: one shape-parameterised method reaches 246 characters.
  // MSVC truncates to 63 and then compares, so a dozen distinct methods became one name
  // redefined many times. The readable prefix survives the cut on purpose.
  const long = `internal/sync.(*HashTrieMap[go.shape.interface {${'x'.repeat(120)} }]).Store`;
  const names = uniqueNames([
    { entry: 0x140010000, name: long },
    { entry: 0x140020000, name: `${long}y` },
  ]);
  const first = names.get(0x140010000)!;
  const second = names.get(0x140020000)!;
  assert.ok(first.length <= 63, `within the limit: ${first.length}`);
  assert.ok(second.length <= 63, `within the limit: ${second.length}`);
  assert.notEqual(first, second);
  assert.match(first, /_140010000$/, `the address is the suffix\n${first}`);
});
