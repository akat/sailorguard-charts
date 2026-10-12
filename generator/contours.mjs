// Depth contours (isobaths) and depth areas for one 1° tile, from the EMODnet
// native grid (1/960°, ~115 m), as on a paper nautical chart.
//
// Lines:  isobaths at CONTOUR_DEPTHS. Land counts as 0 m, so no line runs
//         along the coast, and pieces that only follow the tile edge are dropped.
// Areas:  "water with depth <= T" for each T in AREA_DEPTHS. Drawn from the
//         deepest band to the shallowest, each on top of the previous, they
//         give the chart's depth bands. Land is excluded.
//
// Coordinates are in tile grid units: x = column (0 at the west edge), y = row
// (0 at the north edge), 0..NATIVE_PER_DEGREE.
import {contours} from 'd3-contour';
import {NATIVE_PER_DEGREE} from './tile-format.mjs';

export const CONTOUR_DEPTHS = [2, 5, 10, 20, 50, 100, 200];
export const AREA_DEPTHS = [2, 5, 10, 20];

const N = NATIVE_PER_DEGREE;
const LAND = -10000; // far below any area threshold, so land is never inside an area

/** Douglas–Peucker on an open polyline [[x, y], ...]. */
export function simplify(points, tolerance) {
  if (points.length <= 2) {
    return points.slice();
  }
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  const tol2 = tolerance * tolerance;
  while (stack.length) {
    const [first, last] = stack.pop();
    const [ax, ay] = points[first];
    const [bx, by] = points[last];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let worst = -1;
    let worstDist = tol2;
    for (let i = first + 1; i < last; i += 1) {
      const [px, py] = points[i];
      let d2;
      if (len2 === 0) {
        d2 = (px - ax) ** 2 + (py - ay) ** 2;
      } else {
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
        d2 = (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2;
      }
      if (d2 > worstDist) {
        worstDist = d2;
        worst = i;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([first, worst], [worst, last]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/**
 * Chaikin corner cutting: each pass replaces every corner with two points at
 * 1/4 and 3/4 of its segments, turning the grid's angles into smooth curves.
 * Open lines keep their end points; closed rings (first point repeated at the
 * end) stay closed.
 */
export function chaikin(points, iterations, closed) {
  let out = points;
  for (let n = 0; n < iterations && out.length > 2; n += 1) {
    const next = [];
    const count = closed ? out.length - 1 : out.length - 1;
    if (!closed) {
      next.push(out[0]);
    }
    for (let i = 0; i < count; i += 1) {
      const [ax, ay] = out[i];
      const [bx, by] = out[i + 1];
      next.push([0.75 * ax + 0.25 * bx, 0.75 * ay + 0.25 * by], [0.25 * ax + 0.75 * bx, 0.25 * ay + 0.75 * by]);
    }
    if (closed) {
      next.push(next[0]);
    } else {
      next.push(out[out.length - 1]);
    }
    out = next;
  }
  return out;
}

/** Simplify a closed ring (first point repeated at the end). */
function simplifyRing(ring, tolerance) {
  // Split in two halves so the closing point is kept and the shape stays closed.
  const mid = Math.floor(ring.length / 2);
  const a = simplify(ring.slice(0, mid + 1), tolerance);
  const b = simplify(ring.slice(mid), tolerance);
  return a.concat(b.slice(1));
}

function ringArea(ring) {
  let area = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    area += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  }
  return Math.abs(area / 2);
}

const onEdge = ([x, y]) => x <= 0 || y <= 0 || x >= N || y >= N;

/** Split a closed ring into open polylines, dropping the parts on the tile edge. */
function ringToLines(ring) {
  const lines = [];
  let current = [];
  for (let i = 0; i < ring.length - 1; i += 1) {
    const p = ring[i];
    const q = ring[i + 1];
    if (onEdge(p) && onEdge(q)) {
      if (current.length > 1) {
        lines.push(current);
      }
      current = [];
      continue;
    }
    if (current.length === 0) {
      current.push(p);
    }
    current.push(q);
  }
  if (current.length > 1) {
    lines.push(current);
  }
  // A ring that never touched the edge comes back as one line; keep it closed.
  if (lines.length === 1 && !ring.some(onEdge)) {
    return [ring];
  }
  return lines;
}

function polylineLength(points) {
  let length = 0;
  for (let i = 1; i < points.length; i += 1) {
    length += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  }
  return length;
}

/**
 * @param {Float32Array} native elevation grid, row 0 = north, NaN = no data
 * @param {{tolerance: number, minArea: number, minLength: number, smooth?: number, smoothTolerance?: number}} detail
 *        in grid units. `smooth` = Chaikin passes after simplification (0 = angular);
 *        `smoothTolerance` then drops the near-collinear points the passes add,
 *        keeping the curves at a fraction of the size.
 * @returns {{lines: {depth, points}[], areas: {depth, rings}[]}}
 */
export function buildContours(native, {tolerance, minArea, minLength, smooth = 0, smoothTolerance = 0}) {
  const smoothLine = (points, closed) => {
    const curved = chaikin(points, smooth, closed);
    if (!smooth || !smoothTolerance) {
      return curved;
    }
    return closed ? simplifyRing(curved, smoothTolerance) : simplify(curved, smoothTolerance);
  };
  const depth = new Float64Array(N * N);
  const shallow = new Float64Array(N * N);
  for (let i = 0; i < N * N; i += 1) {
    const e = native[i];
    const water = Number.isFinite(e) && e < 0;
    depth[i] = water ? -e : 0;
    shallow[i] = water ? e : LAND; // -depth: "-depth >= -T" means "depth <= T"
  }

  const lines = [];
  for (const geometry of contours().size([N, N]).thresholds(CONTOUR_DEPTHS)(depth)) {
    for (const polygon of geometry.coordinates) {
      for (const ring of polygon) {
        for (const line of ringToLines(ring)) {
          const closed = line.length > 3 && line[0][0] === line.at(-1)[0] && line[0][1] === line.at(-1)[1];
          const points = simplify(line, tolerance);
          if (points.length > 1 && polylineLength(points) >= minLength) {
            lines.push({depth: geometry.value, points: smoothLine(points, closed)});
          }
        }
      }
    }
  }

  const areas = [];
  for (const geometry of contours().size([N, N]).thresholds(AREA_DEPTHS.map(t => -t))(shallow)) {
    for (const polygon of geometry.coordinates) {
      const [outer, ...holes] = polygon;
      if (ringArea(outer) < minArea) {
        continue;
      }
      const rings = [outer, ...holes.filter(hole => ringArea(hole) >= minArea)]
        .map(ring => simplifyRing(ring, tolerance))
        .filter(ring => ring.length >= 4)
        .map(ring => smoothLine(ring, true));
      if (rings.length && rings[0].length >= 4) {
        areas.push({depth: -geometry.value, rings});
      }
    }
  }
  // Deepest band first, so shallower bands are drawn on top.
  areas.sort((a, b) => b.depth - a.depth);
  return {lines, areas};
}
