import test from 'node:test';
import assert from 'node:assert/strict';
import { MODES, DEFAULT_MODE_ID, resolveMode, listModes } from './modes.js';

test('resolveMode returns known modes and falls back to explore', () => {
  assert.equal(resolveMode('scout').id, 'scout');
  assert.equal(resolveMode('COUNCIL').id, 'council');
  assert.equal(resolveMode('nope').id, DEFAULT_MODE_ID);
  assert.equal(resolveMode(undefined).id, DEFAULT_MODE_ID);
});

test('only scout is read-only', () => {
  assert.equal(resolveMode('scout').readOnly, true);
  for (const id of ['explore', 'team', 'council']) assert.equal(resolveMode(id).readOnly, false);
});

test('every mode is well-formed with a positive fanout and a digest lead', () => {
  for (const mode of listModes()) {
    assert.ok(mode.id && mode.name && mode.summary && mode.digestLead);
    assert.ok(mode.fanout >= 1);
  }
  assert.equal(listModes().length, Object.keys(MODES).length);
});
