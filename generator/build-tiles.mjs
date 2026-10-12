// Generates SGD2 depth tiles and SGC1 contour tiles from the EMODnet
// Bathymetry DTM (CC BY 4.0).
//
//   node generator/build-tiles.mjs mediterranean black-sea     # areas from regions.json
//   node generator/build-tiles.mjs 23,37,25,39                 # or west,south,east,north
//
// One WCS request per 1° tile at native resolution (1/960°). Resumable: tiles
// whose depth and contour files are both in this build's folder, and tiles
// known to be land only, are skipped. Run build-manifest.mjs afterwards; until
// then the served manifest keeps pointing at the previous build.
import {existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {encodeTile, reduceTile, tileKey} from './tile-format.mjs';
import {readNative} from './emodnet.mjs';
import {buildContours} from './contours.mjs';
import {encodeContours} from './contour-format.mjs';
import {applyLandMask, clipAreas, clipLines, ensureLandIndex, fillCoastalGaps, LINE_MASK, landPaths, loadLand, rasterize} from './land.mjs';
import {execFileSync} from 'node:child_process';
import {buildDir} from './build-info.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = JSON.parse(readFileSync(join(ROOT, 'generator', 'regions.json'), 'utf8'));
const TILE_DIR = buildDir(ROOT, CONFIG.dataset);
// Tiles with no water. The OSM coastline only ever adds land, so this list
// stays valid across build versions.
const EMPTY_FILE = join(ROOT, 'public', 'v1', 'land-tiles.json');
// Downloads (OSM land polygons) and indexes; not served (nginx only serves /v1).
const CACHE_DIR = join(ROOT, 'public', '.cache');
const PAUSE_MS = 500; // be gentle with the EMODnet server
// Parallel WCS requests (CONCURRENCY=1 for the gentlest run).
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY) || 3);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Contour detail, in tile grid units (1/960° ≈ 115 m): coarse for zoomed-out
// views, fine when zoomed in.
// Both are rounded with two Chaikin passes, then thinned to ~12 m (fine) and
// ~45 m (coarse), which keeps the curves for about 17% more data.
const CONTOUR_LEVELS = [
  {tolerance: 1.0, minArea: 16, minLength: 8, smooth: 2, smoothTolerance: 0.4},
  {tolerance: 0.15, minArea: 1, minLength: 2, smooth: 2, smoothTolerance: 0.1}
];
const isBuilt = key => existsSync(join(TILE_DIR, `${key}.sgd`)) && existsSync(join(TILE_DIR, `${key}.sgc`));

/** Write via a temporary file, so a stopped build never leaves a truncated tile. */
function writeAtomic(file, data) {
  writeFileSync(`${file}.part`, data);
  renameSync(`${file}.part`, file);
}

/** Download and unzip the OSM land polygons once (~930 MB). */
async function ensureLandPolygons() {
  const paths = landPaths(CACHE_DIR);
  if (existsSync(paths.shp)) {
    return;
  }
  mkdirSync(CACHE_DIR, {recursive: true});
  if (!existsSync(paths.zip)) {
    console.log(`Downloading ${paths.url} (~930 MB, once)…`);
    const response = await fetch(paths.url);
    if (!response.ok) {
      throw new Error(`Land polygons download failed: ${response.status}`);
    }
    const {createWriteStream, renameSync} = await import('node:fs');
    const {Readable} = await import('node:stream');
    const {pipeline} = await import('node:stream/promises');
    await pipeline(Readable.fromWeb(response.body), createWriteStream(`${paths.zip}.part`));
    renameSync(`${paths.zip}.part`, paths.zip);
  }
  console.log('Unzipping land polygons…');
  execFileSync('unzip', ['-o', '-q', paths.zip, '-d', CACHE_DIR]);
  rmSync(paths.zip);
}

function parseAreas(args) {
  if (!args.length) {
    throw new Error(`Usage: build-tiles.mjs <area|west,south,east,north>...  areas: ${Object.keys(CONFIG.areas).join(', ')}`);
  }
  return args.map(arg => {
    if (CONFIG.areas[arg]) {
      return CONFIG.areas[arg];
    }
    const bbox = arg.split(',').map(Number);
    if (bbox.length !== 4 || bbox.some(Number.isNaN)) {
      throw new Error(`Unknown area "${arg}"`);
    }
    return bbox;
  });
}

const areas = parseAreas(process.argv.slice(2));
await ensureLandPolygons();
// Index all configured areas, so building another area later reuses the index.
await ensureLandIndex(CACHE_DIR, Object.values(CONFIG.areas));
mkdirSync(TILE_DIR, {recursive: true});
const landTiles = new Set(existsSync(EMPTY_FILE) ? JSON.parse(readFileSync(EMPTY_FILE, 'utf8')) : []);

const todo = [];
for (const [west, south, east, north] of areas) {
  for (let lat = Math.floor(south); lat < Math.ceil(north); lat += 1) {
    for (let lon = Math.floor(west); lon < Math.ceil(east); lon += 1) {
      const key = tileKey(lat, lon);
      if (!landTiles.has(key) && !isBuilt(key) && !todo.some(t => t.key === key)) {
        todo.push({key, lat, lon});
      }
    }
  }
}

console.log(`${todo.length} tiles to build into ${TILE_DIR} (${CONCURRENCY} at a time)`);
let written = 0;
let done = 0;
let next = 0;

async function worker() {
  while (next < todo.length) {
    const {key, lat, lon} = todo[next];
    next += 1;
    const native = await readNative(lat, lon);
    // Real coastline: EMODnet samples on OSM land become land (no soundings there).
    const land = loadLand(CACHE_DIR, lat, lon);
    const landMask = land.length ? rasterize(land) : null;
    if (landMask) {
      applyLandMask(native, landMask);
    }
    const values = reduceTile(native);
    if (values) {
      writeAtomic(join(TILE_DIR, `${key}.sgd`), encodeTile(lat + 1, lon, values));
      const fineMask = land.length ? rasterize(land, LINE_MASK) : null;
      // Where EMODnet misplaces the coast, contours use depths interpolated
      // from the real coast (soundings above keep EMODnet's own values).
      const contourGrid = landMask ? fillCoastalGaps(native, landMask) : native;
      const levels = CONTOUR_LEVELS.map(detail => {
        const contours = buildContours(contourGrid, detail);
        if (!fineMask) {
          return contours;
        }
        // Cut what still crosses real land (the grid is ~115 m; the coast is not).
        const tolerance = detail.smoothTolerance || detail.tolerance;
        return {
          lines: clipLines(contours.lines, fineMask, tolerance),
          areas: clipAreas(contours.areas, land, tolerance)
        };
      });
      writeAtomic(join(TILE_DIR, `${key}.sgc`), encodeContours(lat + 1, lon, levels));
      written += 1;
    } else {
      landTiles.add(key);
      writeFileSync(EMPTY_FILE, JSON.stringify([...landTiles].sort()));
    }
    done += 1;
    console.log(`  ${done}/${todo.length} ${key} ${values ? 'water' : 'land only'}`);
    await sleep(PAUSE_MS);
  }
}

await Promise.all(Array.from({length: CONCURRENCY}, worker));
console.log(`Done: ${written} tiles written. Now run: node generator/build-manifest.mjs`);
