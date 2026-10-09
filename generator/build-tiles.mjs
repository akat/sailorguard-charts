// Generates SGD2 depth tiles from the EMODnet Bathymetry DTM (CC BY 4.0).
//
//   node generator/build-tiles.mjs mediterranean black-sea     # areas from regions.json
//   node generator/build-tiles.mjs 23,37,25,39                 # or west,south,east,north
//
// One WCS request per 1° tile at native resolution (1/960°). Resumable: tiles
// already on disk, and tiles known to be land only, are skipped. Run
// build-manifest.mjs afterwards.
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {fromArrayBuffer} from 'geotiff';
import {NATIVE_PER_DEGREE, encodeTile, reduceTile, tileKey} from './tile-format.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = JSON.parse(readFileSync(join(ROOT, 'generator', 'regions.json'), 'utf8'));
const TILE_DIR = join(ROOT, 'public', 'v1', 'tiles', CONFIG.dataset.id);
const EMPTY_FILE = join(ROOT, 'public', 'v1', 'land-tiles.json');
const WCS = 'https://ows.emodnet-bathymetry.eu/wcs';
const PAUSE_MS = 500; // be gentle with the EMODnet server
// Parallel WCS requests (CONCURRENCY=1 for the gentlest run).
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY) || 3);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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

async function fetchNative(south, west) {
  const url =
    `${WCS}?service=WCS&version=2.0.1&request=GetCoverage&coverageId=emodnet__mean&format=image/tiff` +
    `&subset=Lat(${south},${south + 1})&subset=Long(${west},${west + 1})`;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return await response.arrayBuffer();
      }
      if (response.status === 404 || response.status === 400) {
        return null; // outside the coverage
      }
      if (attempt >= 6) {
        throw new Error(`WCS responded ${response.status}`);
      }
    } catch (error) {
      if (attempt >= 6) {
        throw error;
      }
    }
    await sleep(5000 * attempt);
  }
}

/** Native samples of one tile, row 0 = north, NaN where the WCS has no data. */
async function readNative(south, west) {
  const native = new Float32Array(NATIVE_PER_DEGREE * NATIVE_PER_DEGREE).fill(Number.NaN);
  const data = await fetchNative(south, west);
  if (!data) {
    return native;
  }
  const image = await (await fromArrayBuffer(data)).getImage();
  const [raster] = await image.readRasters();
  const width = image.getWidth();
  const height = image.getHeight();
  const [minLon, , , maxLat] = image.getBoundingBox();
  const [resLon, resLat] = image.getResolution().map(Math.abs);
  const north = south + 1;
  for (let y = 0; y < height; y += 1) {
    const row = Math.floor((north - (maxLat - (y + 0.5) * resLat)) * NATIVE_PER_DEGREE);
    if (row < 0 || row >= NATIVE_PER_DEGREE) {
      continue;
    }
    for (let x = 0; x < width; x += 1) {
      const col = Math.floor((minLon + (x + 0.5) * resLon - west) * NATIVE_PER_DEGREE);
      if (col >= 0 && col < NATIVE_PER_DEGREE) {
        native[row * NATIVE_PER_DEGREE + col] = raster[y * width + x];
      }
    }
  }
  return native;
}

const areas = parseAreas(process.argv.slice(2));
mkdirSync(TILE_DIR, {recursive: true});
const landTiles = new Set(existsSync(EMPTY_FILE) ? JSON.parse(readFileSync(EMPTY_FILE, 'utf8')) : []);

const todo = [];
for (const [west, south, east, north] of areas) {
  for (let lat = Math.floor(south); lat < Math.ceil(north); lat += 1) {
    for (let lon = Math.floor(west); lon < Math.ceil(east); lon += 1) {
      const key = tileKey(lat, lon);
      if (!landTiles.has(key) && !existsSync(join(TILE_DIR, `${key}.sgd`)) && !todo.some(t => t.key === key)) {
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
    const values = reduceTile(await readNative(lat, lon));
    if (values) {
      writeFileSync(join(TILE_DIR, `${key}.sgd`), encodeTile(lat + 1, lon, values));
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
