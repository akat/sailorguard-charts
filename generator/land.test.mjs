import test from 'node:test';
import assert from 'node:assert/strict';
import {NATIVE_PER_DEGREE as N} from './tile-format.mjs';
import {applyLandMask, clipAreas, clipLines, dilate, fillCoastalGaps, LINE_MASK, rasterize} from './land.mjs';

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

test('coastal cells EMODnet wrongly marks as land get depths from the real coast', () => {
  // Sea 10 m deep; the real islet is 100..106, EMODnet draws it at 103..112 (shifted, bigger).
  const native = new Float32Array(N * N).fill(-10);
  for (let y = 103; y < 112; y += 1) {
    native.fill(5, y * N + 103, y * N + 112);
  }
  const realIslet = [[[100, 100], [106, 100], [106, 106], [100, 106], [100, 100]]];
  const mask = rasterize([realIslet]);
  applyLandMask(native, mask);
  const filled = fillCoastalGaps(native, mask);
  const depth = (x, y) => -filled[y * N + x];
  assert.equal(native[108 * N + 108], 5, 'soundings grid unchanged');
  assert.ok(filled[103 * N + 103] > 0, 'real land stays land');
  const nearCoast = depth(106, 106);
  const farther = depth(108, 108);
  assert.ok(nearCoast > 0 && nearCoast < farther && farther < 10, `depth rises away from the real coast (${nearCoast}, ${farther})`);
  assert.ok(filled[111 * N + 111] > 0, 'beyond 8 samples from the real coast nothing is invented');
  assert.equal(depth(300, 300), 10, 'open sea unchanged');
});

test('simplified isobaths do not cut corners over land', () => {
  // A line hugging the island's north-east corner, 0.05 units off the coast.
  const fineMask = rasterize([island], LINE_MASK);
  const points = [];
  for (let x = 150; x <= 200.05; x += 0.5) points.push([x, 99.95]);
  for (let y = 99.95; y <= 150; y += 0.5) points.push([200.05, y]);
  const [line] = clipLines([{depth: 2, points}], fineMask, 2);
  for (let i = 1; i < line.points.length; i += 1) {
    const [a, b] = [line.points[i - 1], line.points[i]];
    for (let k = 0; k <= 20; k += 1) {
      const x = a[0] + ((b[0] - a[0]) * k) / 20;
      const y = a[1] + ((b[1] - a[1]) * k) / 20;
      assert.ok(!(x > 100.2 && x < 199.8 && y > 100.2 && y < 199.8), `segment over land at ${x},${y}`);
    }
  }
});

test('isobaths stop short of a grown coast and leave no stubs', () => {
  const fineMask = dilate(rasterize([island], LINE_MASK), 2);
  const line = {depth: 10, points: [[50, 150], [250, 150]]};
  const [west, east] = clipLines([line], fineMask, 0.05);
  assert.ok(Math.max(...west.points.map(p => p[0])) < 99.8, 'stops ~2 fine cells before the coast');
  assert.ok(Math.min(...east.points.map(p => p[0])) > 200.2);
  // A line that only grazes the island leaves pieces shorter than minPiece: dropped.
  const graze = {depth: 2, points: [[99.6, 120], [99.6, 120.3], [100.5, 121], [99.6, 121.3]]};
  assert.deepEqual(clipLines([graze], fineMask, 0.05), []);
});
