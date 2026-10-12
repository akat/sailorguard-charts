// Generates SGD2 depth tiles and SGC1 contour tiles from the EMODnet
// Bathymetry DTM (CC BY 4.0).
//
//   node generator/build-tiles.mjs mediterranean black-sea     # areas from regions.json
//   node generator/build-tiles.mjs 23,37,25,39                 # or west,south,east,north
//
// One WCS request per 1° tile at native resolution (1/960°). Resumable: tiles
// whose depth and contour files are both on disk, and tiles known to be land
// only, are skipped. Run build-manifest.mjs afterwards.
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {encodeTile, reduceTile, tileKey} from './tile-format.mjs';
import {readNative} from './emodnet.mjs';
import {buildContours} from './contours.mjs';
import {encodeContours} from './contour-format.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = JSON.parse(readFileSync(join(ROOT, 'generator', 'regions.json'), 'utf8'));
const TILE_DIR = join(ROOT, 'public', 'v1', 'tiles', CONFIG.dataset.id);
const EMPTY_FILE = join(ROOT, 'public', 'v1', 'land-tiles.json');
const PAUSE_MS = 500; // be gentle with the EMODnet server
// Parallel WCS requests (CONCURRENCY=1 for the gentlest run).
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY) || 3);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Contour detail, in tile grid units (1/960° ≈ 115 m): coarse for zoomed-out
// views, fine when zoomed in.
const CONTOUR_LEVELS = [
  {tolerance: 1.0, minArea: 16, minLength: 8},
  {tolerance: 0.15, minArea: 1, minLength: 2}
];
const isBuilt = key => existsSync(join(TILE_DIR, `${key}.sgd`)) && existsSync(join(TILE_DIR, `${key}.sgc`));

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
    const values = reduceTile(native);
    if (values) {
      writeFileSync(join(TILE_DIR, `${key}.sgd`), encodeTile(lat + 1, lon, values));
      const levels = CONTOUR_LEVELS.map(detail => buildContours(native, detail));
      writeFileSync(join(TILE_DIR, `${key}.sgc`), encodeContours(lat + 1, lon, levels));
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
