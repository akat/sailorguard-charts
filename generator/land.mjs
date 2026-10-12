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

/** Subtract land from depth areas; one area may split into several. */
export function clipAreas(areas, land) {
  const landBoxes = land.map(polygon => ({polygon, box: ringBox(polygon[0])}));
  const out = [];
  for (const area of areas) {
    const box = ringBox(area.rings[0]);
    const near = landBoxes
      .filter(l => l.box.w <= box.e && l.box.e >= box.w && l.box.s <= box.n && l.box.n >= box.s)
      .map(l => l.polygon);
    if (!near.length) {
      out.push(area);
      continue;
    }
    for (const rings of difference(area.rings, ...near)) {
      if (rings[0].length >= 4) {
        out.push({depth: area.depth, rings});
      }
    }
  }
  return out;
}

export const LINE_MASK = LINE_MASK_SCALE;
