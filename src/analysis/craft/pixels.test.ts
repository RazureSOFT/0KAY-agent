import test from 'node:test';
import assert from 'node:assert/strict';
import { decodePng, encodePng, comparePixels, type Raster } from './pixels.js';

function raster(width: number, height: number, fill: [number, number, number, number]): Raster {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) data.set(fill, i * 4);
  return { width, height, data };
}

test('a PNG written here can be read back without losing a pixel', () => {
  const source = raster(3, 2, [12, 34, 56, 255]);
  source.data.set([200, 100, 50, 255], 4 * 4);
  const decoded = decodePng(encodePng(source));
  assert.equal(decoded.width, 3);
  assert.equal(decoded.height, 2);
  assert.deepEqual(Array.from(decoded.data.subarray(16, 20)), [200, 100, 50, 255]);
  assert.deepEqual(Array.from(decoded.data.subarray(0, 4)), [12, 34, 56, 255]);
});

test('identical screenshots score 100 with no hot regions', () => {
  const image = raster(4, 4, [10, 20, 30, 255]);
  const diff = comparePixels(image, image, { differenceImage: true });
  assert.equal(diff.similarity, 100);
  assert.equal(diff.different, 0);
  assert.deepEqual(diff.regions, []);
  assert.equal(diff.differenceImage?.width, 4);
});

test('one changed pixel lowers the score and points at its region', () => {
  const a = raster(4, 4, [10, 10, 10, 255]);
  const b = raster(4, 4, [10, 10, 10, 255]);
  b.data.set([250, 250, 250, 255], 0);
  const diff = comparePixels(a, b);
  assert.equal(diff.different, 1);
  assert.equal(diff.total, 16);
  assert.equal(diff.similarity, 94);
  assert.ok(diff.regions.length >= 1);
  assert.equal(diff.regions[0].x, 0);
  assert.equal(diff.regions[0].y, 0);
});

test('antialiasing-level noise is below the tolerance', () => {
  const a = raster(4, 4, [10, 10, 10, 255]);
  const b = raster(4, 4, [13, 9, 12, 255]);
  assert.equal(comparePixels(a, b).similarity, 100);
});

test('a rebuild that is shorter counts the missing area as mismatch', () => {
  const a = raster(4, 4, [0, 0, 0, 255]);
  const b = raster(4, 2, [0, 0, 0, 255]);
  const diff = comparePixels(a, b);
  assert.equal(diff.height, 4);
  assert.equal(diff.different, 8);
  assert.equal(diff.similarity, 50);
});

test('a non-PNG is rejected with a readable error', () => {
  assert.throws(() => decodePng(Buffer.from('hello')), /not a PNG/);
});
