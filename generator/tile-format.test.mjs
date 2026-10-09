import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NATIVE_PER_DEGREE,
  CELLS_PER_DEGREE,
  decodeDepth,
  decodeTile,
  encodeTile,
  parseKey,
  reduceTile,
  tileKey,
  tilesInBbox
} from './tile-format.mjs';

test('tile keys round-trip and cover both hemispheres', () => {
  assert.equal(tileKey(37, 23), 'N37E023');
  assert.equal(tileKey(-5, -10), 'S05W010');
  assert.deepEqual(parseKey('N37E023'), {south: 37, west: 23});
  assert.deepEqual(parseKey('S05W010'), {south: -5, west: -10});
});

test('reduce keeps the shallowest sample of each cell and where it is', () => {
  const native = new Float32Array(NATIVE_PER_DEGREE * NATIVE_PER_DEGREE).fill(25); // land
  // Cell (0, 0): water with a 3.6 m shoal at sample row 2, column 1.
  for (let r = 0; r < 4; r += 1) {
    for (let c = 0; c < 4; c += 1) {
      native[r * NATIVE_PER_DEGREE + c] = -40;
    }
  }
  native[2 * NATIVE_PER_DEGREE + 1] = -3.6;
  // Cell (0, 1): a single water sample among land is still water.
  native[NATIVE_PER_DEGREE * 3 + 4 + 2] = -12;

  const values = reduceTile(native);
  assert.equal(values[0] >> 14, 2);
  assert.equal((values[0] >> 12) & 3, 1);
  assert.ok(Math.abs(decodeDepth(values[0]) - 3.6) < 1e-9);
  assert.equal(decodeDepth(values[1]), 12);
  assert.equal(values.filter(Boolean).length, 2);
});

test('a land-only tile produces nothing', () => {
  assert.equal(reduceTile(new Float32Array(NATIVE_PER_DEGREE * NATIVE_PER_DEGREE).fill(100)), null);
  assert.equal(reduceTile(new Float32Array(NATIVE_PER_DEGREE * NATIVE_PER_DEGREE).fill(Number.NaN)), null);
});

test('encode and decode round-trip with long land runs', () => {
  const values = new Uint16Array(CELLS_PER_DEGREE * CELLS_PER_DEGREE);
  values[5] = 1234;
  values[values.length - 1] = 4000;
  const tile = decodeTile(encodeTile(38, 23, values));
  assert.equal(tile.north, 38);
  assert.equal(tile.west, 23);
  assert.equal(tile.cell, 1 / 240);
  assert.deepEqual(Array.from(tile.values), Array.from(values));
});

test('regions pick the tiles their bbox intersects', () => {
  const keys = ['N37E022', 'N37E023', 'N38E023', 'N36E025'];
  assert.deepEqual(tilesInBbox(keys, [22.5, 37.0, 24.2, 38.1]), ['N37E022', 'N37E023', 'N38E023']);
});
