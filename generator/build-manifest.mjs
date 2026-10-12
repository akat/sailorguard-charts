// Writes public/v1/manifest.json from the tiles on disk and regions.json.
//
//   node generator/build-manifest.mjs
//
// The app reads the manifest to list regions, compute download sizes, verify
// tiles (sha256) and find updates (a tile changes when its sha256 changes).
// `tiles` are the depth tiles (.sgd), `contours` the contour tiles (.sgc);
// apps that predate contours ignore the latter.
import {createHash} from 'node:crypto';
import {readdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {parseKey, tilesInBbox} from './tile-format.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = JSON.parse(readFileSync(join(ROOT, 'generator', 'regions.json'), 'utf8'));
const V1 = join(ROOT, 'public', 'v1');
const TILE_DIR = join(V1, 'tiles', CONFIG.dataset.id);

function listFiles(extension) {
  const files = {};
  for (const file of readdirSync(TILE_DIR).filter(f => f.endsWith(extension)).sort()) {
    const key = file.slice(0, -extension.length);
    if (!parseKey(key)) {
      continue;
    }
    const data = readFileSync(join(TILE_DIR, file));
    files[key] = {size: data.length, sha256: createHash('sha256').update(data).digest('hex')};
  }
  return files;
}

const tiles = listFiles('.sgd');
const contours = listFiles('.sgc');
const keys = Object.keys(tiles);
const sizeOf = key => tiles[key].size + (contours[key]?.size ?? 0);

const regions = CONFIG.regions
  .map(region => {
    const regionTiles = tilesInBbox(keys, region.bbox);
    return {...region, tiles: regionTiles, size: regionTiles.reduce((sum, key) => sum + sizeOf(key), 0)};
  })
  .filter(region => region.tiles.length > 0);

const manifest = {
  format: 'SGD2',
  version: new Date().toISOString(),
  dataset: CONFIG.dataset,
  tileUrl: `tiles/${CONFIG.dataset.id}/{key}.sgd`,
  tiles,
  contourUrl: `tiles/${CONFIG.dataset.id}/{key}.sgc`,
  contours,
  regions
};
writeFileSync(join(V1, 'manifest.json'), JSON.stringify(manifest));
const total = keys.reduce((sum, key) => sum + sizeOf(key), 0);
console.log(
  `manifest: ${keys.length} depth tiles, ${Object.keys(contours).length} contour tiles (${(total / 1048576).toFixed(1)} MB), ${regions.length} regions`
);
