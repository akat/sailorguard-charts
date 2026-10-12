import test from 'node:test';
import assert from 'node:assert/strict';
import {NATIVE_PER_DEGREE as N} from './tile-format.mjs';
import {buildContours, chaikin, simplify} from './contours.mjs';
import {decodeContours, encodeContours} from './contour-format.mjs';

const DETAIL = {tolerance: 0.15, minArea: 1, minLength: 2};

/** Elevation grid from f(x, y) at sample centres; return >= 0 for land. */
function grid(f) {
  const native = new Float32Array(N * N);
  for (let y = 0; y < N; y += 1) {
    for (let x = 0; x < N; x += 1) {
      native[y * N + x] = f(x + 0.5, y + 0.5);
    }
  }
  return native;
}

// A round bay in the middle of the tile: 0 m at radius 300, 30 m at the centre.
const bowl = grid((x, y) => {
  const r = Math.hypot(x - N / 2, y - N / 2);
  return r >= 300 ? 10 : -(300 - r) / 10;
});

test('isobaths of a round bay are closed circles at the right radius', () => {
  const {lines} = buildContours(bowl, DETAIL);
  assert.deepEqual([...new Set(lines.map(l => l.depth))].sort((a, b) => a - b), [2, 5, 10, 20]);
  for (const line of lines) {
    const [first, last] = [line.points[0], line.points.at(-1)];
    assert.deepEqual(first, last, `${line.depth} m line is closed`);
    const expected = 300 - line.depth * 10;
    for (const [x, y] of line.points) {
      assert.ok(Math.abs(Math.hypot(x - N / 2, y - N / 2) - expected) < 2, `${line.depth} m line at radius ${expected}`);
    }
  }
});

test('depth areas stay in the water and nest from deep to shallow', () => {
  const {areas} = buildContours(bowl, DETAIL);
  assert.deepEqual(areas.map(a => a.depth), [20, 10, 5, 2]);
  for (const area of areas) {
    const [outer, hole] = area.rings;
    // Outer edge on the shoreline (r = 300), hole where it gets deeper than the band.
    const radius = ring => Math.hypot(ring[0][0] - N / 2, ring[0][1] - N / 2);
    assert.ok(Math.abs(radius(outer) - 300) < 2, 'area does not spill onto land');
    assert.ok(Math.abs(radius(hole) - (300 - area.depth * 10)) < 2, 'hole at the band depth');
  }
});

test('no isobath is drawn along the tile edge', () => {
  // Land in the west, sloping to 300 m in the east: lines run north-south.
  const slope = grid(x => (x < 100 ? 5 : -(x - 100) * 0.4));
  const {lines} = buildContours(slope, DETAIL);
  assert.ok(lines.length >= 5);
  for (const line of lines) {
    for (let i = 1; i < line.points.length; i += 1) {
      const [ax, ay] = line.points[i - 1];
      const [bx, by] = line.points[i];
      const alongEdge = (ay <= 0 && by <= 0) || (ay >= N && by >= N) || (ax <= 0 && bx <= 0) || (ax >= N && bx >= N);
      assert.ok(!alongEdge, `${line.depth} m line has a segment on the tile edge`);
    }
  }
});

test('simplify drops points within the tolerance only', () => {
  const straight = [[0, 0], [1, 0.05], [2, 0], [3, 0.04], [4, 0]];
  assert.deepEqual(simplify(straight, 0.1), [[0, 0], [4, 0]]);
  const corner = [[0, 0], [5, 0], [5, 5]];
  assert.deepEqual(simplify(corner, 0.1), corner);
});

test('contour tiles round-trip within ~7 m', () => {
  const coarse = buildContours(bowl, {tolerance: 1, minArea: 16, minLength: 8});
  const fine = buildContours(bowl, DETAIL);
  const decoded = decodeContours(encodeContours(38, 23, [coarse, fine]));
  assert.equal(decoded.north, 38);
  assert.equal(decoded.levels.length, 2);
  assert.equal(decoded.levels[1].lines.length, fine.lines.length);
  assert.equal(decoded.levels[1].areas.length, fine.areas.length);
  const [x, y] = fine.lines[0].points[3];
  const [dx, dy] = decoded.levels[1].lines[0].points[3];
  assert.ok(Math.hypot(x - dx, y - dy) <= 1 / 16, 'quantised to 1/16 grid unit');
});

test('chaikin rounds corners and keeps rings closed and lines anchored', () => {
  const square = [[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]];
  const round = chaikin(square, 2, true);
  assert.deepEqual(round[0], round.at(-1), 'ring stays closed');
  assert.ok(!round.some(([x, y]) => (x === 0 || x === 4) && (y === 0 || y === 4)), 'no sharp corner left');
  const line = chaikin([[0, 0], [4, 0], [4, 4]], 2, false);
  assert.deepEqual(line[0], [0, 0]);
  assert.deepEqual(line.at(-1), [4, 4]);
});

test('smoothed isobaths stay on their depth', () => {
  const {lines} = buildContours(bowl, {...DETAIL, smooth: 2, smoothTolerance: 0.1});
  for (const line of lines) {
    const expected = 300 - line.depth * 10;
    for (const [x, y] of line.points) {
      assert.ok(Math.abs(Math.hypot(x - N / 2, y - N / 2) - expected) < 2);
    }
  }
});
