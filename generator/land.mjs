// Real coastline from OpenStreetMap land polygons (© OpenStreetMap
// contributors, ODbL; https://osmdata.openstreetmap.de/data/land-polygons.html).
//
// EMODnet's ~115 m grid draws small islands too big and coasts a cell or two
// off. The land polygons (accurate to a few metres) are used to:
//   - mark EMODnet samples that fall on real land as land, so no sounding and
//     no depth sits on land;
//   - cut isobaths and depth areas where they run over real land.
// Where EMODnet says land but the real map shows water there is no depth data,
// and the chart stays empty there instead of guessing.
import {appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {open as openShapefile} from 'shapefile';
import {difference} from 'polyclip-ts';
import {NATIVE_PER_DEGREE, tileKey} from './tile-format.mjs';
import {simplify} from './contours.mjs';

const SOURCE_URL = 'https://osmdata.openstreetmap.de/download/land-polygons-split-4326.zip';
const N = NATIVE_PER_DEGREE;
// Land polygons touching a tile within this margin (degrees) are kept with it.
const MARGIN = 0.01;
// Line clipping resolution: 8 x 8 mask cells per EMODnet sample (~14 m x 11 m).
const LINE_MASK_SCALE = 8;

export function landPaths(cacheDir) {
  return {
    zip: join(cacheDir, 'land-polygons-split-4326.zip'),
    shp: join(cacheDir, 'land-polygons-split-4326', 'land_polygons.shp'),
    index: join(cacheDir, 'land-tiles'),
    url: SOURCE_URL
  };
}

/**
 * Split the land polygons into one NDJSON file per 1° tile, for the tiles of
 * `areas` ([west, south, east, north] each). Done once; redone when the source
 * file or the areas change.
 */
export async function ensureLandIndex(cacheDir, areas, log = console.log) {
  const paths = landPaths(cacheDir);
  if (!existsSync(paths.shp)) {
    throw new Error(`Land polygons missing: download ${paths.url} and unzip it into ${cacheDir}`);
  }
  const stamp = JSON.stringify({source: statSync(paths.shp).mtimeMs, areas});
  const stampFile = join(paths.index, 'index.json');
  if (existsSync(stampFile) && readFileSync(stampFile, 'utf8') === stamp) {
    return;
  }
  log('Indexing OpenStreetMap land polygons by tile (once)…');
  rmSync(paths.index, {recursive: true, force: true});
  mkdirSync(paths.index, {recursive: true});

  const inAreas = (lat, lon) => areas.some(([w, s, e, n]) => lat >= Math.floor(s) && lat < Math.ceil(n) && lon >= Math.floor(w) && lon < Math.ceil(e));
  const pending = new Map();
  const flush = key => {
    appendFileSync(join(paths.index, `${key}.ndjson`), pending.get(key).join('\n') + '\n');
    pending.delete(key);
  };

  const source = await openShapefile(paths.shp);
  let count = 0;
  for (let result = await source.read(); !result.done; result = await source.read()) {
    const geometry = result.value.geometry;
    const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
    for (const polygon of polygons) {
      let w = 180;
      let s = 90;
      let e = -180;
      let n = -90;
      for (const [lon, lat] of polygon[0]) {
        w = Math.min(w, lon);
        e = Math.max(e, lon);
        s = Math.min(s, lat);
        n = Math.max(n, lat);
      }
      const line = JSON.stringify(polygon);
      for (let lat = Math.floor(s - MARGIN); lat <= Math.floor(n + MARGIN); lat += 1) {
        for (let lon = Math.floor(w - MARGIN); lon <= Math.floor(e + MARGIN); lon += 1) {
          if (!inAreas(lat, lon)) {
            continue;
          }
          const key = tileKey(lat, lon);
          if (!pending.has(key)) {
            pending.set(key, []);
          }
          pending.get(key).push(line);
          if (pending.get(key).length >= 500) {
            flush(key);
          }
        }
      }
    }
    count += 1;
    if (count % 100000 === 0) {
      log(`  ${count} land polygons read`);
    }
  }
  [...pending.keys()].forEach(flush);
  writeFileSync(stampFile, stamp);
  log(`  done: ${count} polygons, ${readdirSync(paths.index).length - 1} tiles with land`);
}

/** Land polygons ([[lon, lat], ...] rings) for a tile, converted to tile grid units. */
export function loadLand(cacheDir, south, west) {
  const file = join(landPaths(cacheDir).index, `${tileKey(south, west)}.ndjson`);
  if (!existsSync(file)) {
    return [];
  }
  const north = south + 1;
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line).map(ring => ring.map(([lon, lat]) => [(lon - west) * N, (north - lat) * N])));
}

/**
 * Rasterise polygons (grid units) into a mask of `size` x `size` cells, where
 * one grid unit is `scale` cells. A cell is land when its centre is inside.
 */
export function rasterize(polygons, scale = 1) {
  const size = N * scale;
  const mask = new Uint8Array(size * size);
  for (const polygon of polygons) {
    const edges = [];
    let minY = Infinity;
    let maxY = -Infinity;
    for (const ring of polygon) {
      for (let i = 0; i < ring.length - 1; i += 1) {
        const [x1, y1] = ring[i];
        const [x2, y2] = ring[i + 1];
        if (y1 !== y2) {
          edges.push([x1 * scale, y1 * scale, x2 * scale, y2 * scale]);
        }
        minY = Math.min(minY, y1 * scale, y2 * scale);
        maxY = Math.max(maxY, y1 * scale, y2 * scale);
      }
    }
    const rowStart = Math.max(0, Math.ceil(minY - 0.5));
    const rowEnd = Math.min(size - 1, Math.floor(maxY - 0.5));
    for (let row = rowStart; row <= rowEnd; row += 1) {
      const y = row + 0.5;
      const xs = [];
      for (const [x1, y1, x2, y2] of edges) {
        if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) {
          xs.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
        }
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const from = Math.max(0, Math.ceil(xs[k] - 0.5));
        const to = Math.min(size - 1, Math.floor(xs[k + 1] - 0.5));
        // Spans wholly outside the tile (polygons in the margin) would spill
        // into the neighbouring row.
        if (from <= to) {
          mask.fill(1, row * size + from, row * size + to + 1);
        }
      }
    }
  }
  return mask;
}

/** Mark EMODnet samples whose centre is on real land as land (elevation 1 m). */
export function applyLandMask(native, landMask) {
  for (let i = 0; i < native.length; i += 1) {
    if (landMask[i]) {
      native[i] = 1;
    }
  }
}

/** Grid distance (4-neighbour steps, capped at `limit + 1`) to the nearest source cell. */
function distanceTo(isSource, limit) {
  const far = limit + 1;
  const dist = new Uint8Array(N * N).fill(far);
  let frontier = [];
  for (let i = 0; i < N * N; i += 1) {
    if (isSource(i)) {
      dist[i] = 0;
      frontier.push(i);
    }
  }
  for (let d = 1; d <= limit && frontier.length; d += 1) {
    const next = [];
    for (const i of frontier) {
      const x = i % N;
      for (const j of [i - N, i + N, x > 0 ? i - 1 : -1, x < N - 1 ? i + 1 : -1]) {
        if (j >= 0 && j < N * N && dist[j] === far) {
          dist[j] = d;
          next.push(j);
        }
      }
    }
    frontier = next;
  }
  return dist;
}

/**
 * Depths for the coastal cells EMODnet gets wrong, for contours only.
 *
 * Where EMODnet says land (or has no data) but OSM shows sea, EMODnet has
 * drawn the coast or an islet in the wrong place, and isobaths would ring that
 * phantom land instead of the real one. Those cells get a depth by harmonic
 * interpolation (Laplace): 0 m along the real (OSM) coast, rising smoothly to
 * the EMODnet depths around them, so the isobaths follow the real coastline.
 * Only cells within `maxDistance` samples of both EMODnet water and real land
 * are filled. Returns a new grid; `native` (and so the soundings) is unchanged.
 *
 * @param native elevation grid, after applyLandMask
 * @param landMask OSM land at native resolution (rasterize(land))
 */
export function fillCoastalGaps(native, landMask, maxDistance = 8) {
  const isWater = i => native[i] < 0;
  const isGap = i => !landMask[i] && !(native[i] < 0);
  const nearWater = distanceTo(isWater, maxDistance);
  const nearLand = distanceTo(i => landMask[i] === 1, maxDistance);
  const gaps = [];
  for (let i = 0; i < N * N; i += 1) {
    if (isGap(i) && nearWater[i] <= maxDistance && nearLand[i] <= maxDistance) {
      gaps.push(i);
    }
  }
  const filled = Float32Array.from(native);
  if (!gaps.length) {
    return filled;
  }
  // Depth (m, positive) per cell; NaN = not part of the problem (ignored).
  const depth = new Float64Array(N * N).fill(Number.NaN);
  for (let i = 0; i < N * N; i += 1) {
    if (isWater(i)) {
      depth[i] = -native[i];
    } else if (landMask[i]) {
      depth[i] = 0;
    }
  }
  gaps.forEach(i => {
    depth[i] = 0;
  });
  // Successive over-relaxation on the gap cells; boundary values stay fixed.
  const OMEGA = 1.8;
  for (let iteration = 0; iteration < 2000; iteration += 1) {
    let change = 0;
    for (const i of gaps) {
      const x = i % N;
      let sum = 0;
      let count = 0;
      for (const j of [i - N, i + N, x > 0 ? i - 1 : -1, x < N - 1 ? i + 1 : -1]) {
        if (j >= 0 && j < N * N && !Number.isNaN(depth[j])) {
          sum += depth[j];
          count += 1;
        }
      }
      if (count) {
        const next = depth[i] + OMEGA * (sum / count - depth[i]);
        change = Math.max(change, Math.abs(next - depth[i]));
        depth[i] = next;
      }
    }
    if (change < 0.01) {
      break;
    }
  }
  for (const i of gaps) {
    // Stay water even right at the coast (elevation must be below 0).
    filled[i] = -Math.max(depth[i], 0.05);
  }
  return filled;
}

/** Cut lines where they cross land, using a fine land mask (LINE_MASK_SCALE). */
export function clipLines(lines, fineMask, tolerance) {
  const size = N * LINE_MASK_SCALE;
  const onLand = ([x, y]) => {
    const col = Math.floor(x * LINE_MASK_SCALE);
    const row = Math.floor(y * LINE_MASK_SCALE);
    return row >= 0 && row < size && col >= 0 && col < size && fineMask[row * size + col] === 1;
  };
  const step = 1 / LINE_MASK_SCALE;
  const out = [];
  for (const line of lines) {
    let piece = [];
    const finish = () => {
      if (piece.length > 1) {
        out.push({depth: line.depth, points: simplify(piece, tolerance)});
      }
      piece = [];
    };
    for (let i = 0; i < line.points.length; i += 1) {
      const p = line.points[i];
      // Densify each segment so short land crossings are not skipped.
      const q = line.points[i + 1];
      const samples = [p];
      if (q) {
        const steps = Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / step);
        for (let k = 1; k < steps; k += 1) {
          samples.push([p[0] + ((q[0] - p[0]) * k) / steps, p[1] + ((q[1] - p[1]) * k) / steps]);
        }
      }
      for (const s of samples) {
        if (onLand(s)) {
          finish();
        } else {
          piece.push(s);
        }
      }
    }
    finish();
  }
  return out;
}

function ringBox(ring) {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const [x, y] of ring) {
    w = Math.min(w, x);
    e = Math.max(e, x);
    s = Math.min(s, y);
    n = Math.max(n, y);
  }
  return {w, s, e, n};
}

const boxesMeet = (a, b) => a.w <= b.e && a.e >= b.w && a.s <= b.n && a.n >= b.s;

/** Simplify closed rings, keeping the closing point. */
function simplifyRing(ring, tolerance) {
  const mid = Math.floor(ring.length / 2);
  return simplify(ring.slice(0, mid + 1), tolerance).concat(simplify(ring.slice(mid), tolerance).slice(1));
}

/**
 * Subtract land from depth areas; one area may split into several. Areas of
 * one depth never overlap, so all those touching land are clipped together in
 * a single polygon operation per depth (one per area is ~50x slower).
 * The coastline is first simplified to `tolerance` (the level's detail), so
 * the areas do not carry every OSM coast vertex.
 */
export function clipAreas(areas, land, tolerance = 0) {
  const simplified = !tolerance
    ? land
    : land
        .map(polygon => polygon.map(ring => simplifyRing(ring, tolerance)))
        // An islet smaller than the tolerance collapses: drop it, holes and all.
        .filter(([outer]) => outer.length >= 4)
        .map(([outer, ...holes]) => [outer, ...holes.filter(hole => hole.length >= 4)]);
  const landBoxes = simplified.map(polygon => ({polygon, box: ringBox(polygon[0])}));
  const out = [];
  const byDepth = new Map();
  for (const area of areas) {
    const box = ringBox(area.rings[0]);
    const near = landBoxes.filter(l => boxesMeet(l.box, box));
    if (!near.length) {
      out.push(area);
      continue;
    }
    if (!byDepth.has(area.depth)) {
      byDepth.set(area.depth, {areas: [], land: new Set()});
    }
    const group = byDepth.get(area.depth);
    group.areas.push(area.rings);
    near.forEach(l => group.land.add(l.polygon));
  }
  for (const [depth, group] of byDepth) {
    for (const rings of difference(group.areas, ...group.land)) {
      if (rings[0].length >= 4) {
        out.push({depth, rings});
      }
    }
  }
  // Deepest band first, so shallower bands are drawn on top.
  return out.sort((a, b) => b.depth - a.depth);
}

export const LINE_MASK = LINE_MASK_SCALE;
