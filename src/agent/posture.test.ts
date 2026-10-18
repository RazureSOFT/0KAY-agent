import test from 'node:test';
import assert from 'node:assert/strict';
import { POSTURES, DEFAULT_POSTURE_ID, resolvePosture, listPostures, postureDirective } from './posture.js';

test('resolvePosture returns the requested posture and falls back to default', () => {
  assert.equal(resolvePosture('verifier').id, 'verifier');
  assert.equal(resolvePosture('VERIFIER').id, 'verifier');
  assert.equal(resolvePosture('nope').id, DEFAULT_POSTURE_ID);
  assert.equal(resolvePosture(undefined).id, DEFAULT_POSTURE_ID);
});

test('every posture has id/name/summary/belief and a unique id', () => {
  const ids = new Set<string>();
  for (const p of listPostures()) {
    assert.ok(p.id && p.name && p.summary && p.belief);
    assert.ok(!ids.has(p.id), `duplicate posture id ${p.id}`);
    ids.add(p.id);
  }
  assert.equal(ids.size, Object.keys(POSTURES).length);
});

test('the default posture injects no directive (keeps behavior unchanged)', () => {
  assert.equal(postureDirective(resolvePosture('default')), '');
});

test('a non-default posture injects its belief and honours a tool allow-list', () => {
  const directive = postureDirective(resolvePosture('verifier'));
  assert.ok(directive.includes('Yaoguang'));
  assert.ok(directive.includes('reproduced'));
});

test('verifier posture is flagged strict for the delivery gate', () => {
  assert.equal(resolvePosture('verifier').strictDelivery, true);
  assert.notEqual(resolvePosture('bold').strictDelivery, true);
});
