// Writes public/v1/manifest.json from the tiles on disk and regions.json.
//
//   node generator/build-manifest.mjs
//
// The app reads the manifest to list regions, compute download sizes, verify
// tiles (sha256) and find updates (a tile changes when its sha256 changes).
import {createHash} from 'node:crypto';
import {readdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {parseKey, tilesInBbox} from './tile-format.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = JSON.parse(readFileSync(join(ROOT, 'generator', 'regions.json'), 'utf8'));
const V1 = join(ROOT, 'public', 'v1');
const TILE_DIR = join(V1, 'tiles', CONFIG.dataset.id);

const tiles = {};
for (const file of readdirSync(TILE_DIR).filter(f => f.endsWith('.sgd')).sort()) {
  const key = file.replace(/\.sgd$/, '');
  if (!parseKey(key)) {
    continue;
  }
  const data = readFileSync(join(TILE_DIR, file));
  tiles[key] = {size: data.length, sha256: createHash('sha256').update(data).digest('hex')};
}
const keys = Object.keys(tiles);

const regions = CONFIG.regions
  .map(region => {
    const regionTiles = tilesInBbox(keys, region.bbox);
    return {...region, tiles: regionTiles, size: regionTiles.reduce((sum, key) => sum + tiles[key].size, 0)};
  })
  .filter(region => region.tiles.length > 0);

const manifest = {
  format: 'SGD2',
  version: new Date().toISOString(),
  dataset: CONFIG.dataset,
  tileUrl: `tiles/${CONFIG.dataset.id}/{key}.sgd`,
  tiles,
  regions
};
writeFileSync(join(V1, 'manifest.json'), JSON.stringify(manifest));
const total = keys.reduce((sum, key) => sum + tiles[key].size, 0);
console.log(`manifest: ${keys.length} tiles (${(total / 1048576).toFixed(1)} MB), ${regions.length} regions`);
