import test from 'node:test';
import assert from 'node:assert/strict';
import {NATIVE_PER_DEGREE as N} from './tile-format.mjs';
import {applyLandMask, clipAreas, clipLines, LINE_MASK, rasterize} from './land.mjs';

// A square island, grid units 100..200 on both axes.
const island = [[[100, 100], [200, 100], [200, 200], [100, 200], [100, 100]]];

test('rasterize marks cells whose centre is inside the polygon', () => {
  const mask = rasterize([island]);
  assert.equal(mask[150 * N + 150], 1);
  assert.equal(mask[100 * N + 100], 1, 'first cell inside (centre 100.5)');
  assert.equal(mask[199 * N + 199], 1, 'last cell inside (centre 199.5)');
  assert.equal(mask[200 * N + 150], 0);
  assert.equal(mask[99 * N + 150], 0);
  assert.equal(mask.reduce((n, v) => n + v, 0), 100 * 100);
});

test('rasterize handles holes (a lake in the island)', () => {
  const withLake = [island[0], [[140, 140], [160, 140], [160, 160], [140, 160], [140, 140]]];
  const mask = rasterize([withLake]);
  assert.equal(mask[150 * N + 150], 0);
  assert.equal(mask[120 * N + 120], 1);
});

test('land just outside the tile does not spill into it', () => {
  const east = [[[N + 5, 10], [N + 20, 10], [N + 20, 20], [N + 5, 20], [N + 5, 10]]];
  const west = [[[-20, 10], [-5, 10], [-5, 20], [-20, 20], [-20, 10]]];
  assert.equal(rasterize([east, west]).reduce((n, v) => n + v, 0), 0);
});

test('EMODnet samples on real land become land', () => {
  const native = new Float32Array(N * N).fill(-20);
  applyLandMask(native, rasterize([island]));
  assert.equal(native[150 * N + 150], 1);
  assert.equal(native[50 * N + 50], -20);
});

test('isobaths are cut where they cross real land', () => {
  const fineMask = rasterize([island], LINE_MASK);
  const line = {depth: 10, points: [[50, 150], [250, 150]]};
  const pieces = clipLines([line], fineMask, 0.05);
  assert.equal(pieces.length, 2);
  const [west, east] = pieces;
  assert.ok(Math.max(...west.points.map(p => p[0])) <= 100, 'western piece stops at the coast');
  assert.ok(Math.min(...east.points.map(p => p[0])) >= 200, 'eastern piece starts at the coast');
  assert.ok(Math.max(...west.points.map(p => p[0])) > 99, 'and reaches it');
});

test('depth areas lose the part on real land', () => {
  const area = {depth: 5, rings: [[[50, 50], [250, 50], [250, 250], [50, 250], [50, 50]]]};
  const [clipped] = clipAreas([area], [island]);
  // The island becomes a hole in the area.
  assert.equal(clipped.rings.length, 2);
  const xs = clipped.rings[1].map(p => p[0]);
  assert.equal(Math.min(...xs), 100);
  assert.equal(Math.max(...xs), 200);
});

test('areas away from land are left untouched', () => {
  const area = {depth: 2, rings: [[[300, 300], [320, 300], [320, 320], [300, 320], [300, 300]]]};
  assert.deepEqual(clipAreas([area], [island]), [area]);
});
