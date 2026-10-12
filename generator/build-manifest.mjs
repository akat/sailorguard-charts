// Writes public/v1/manifest.json from the tiles on disk and regions.json.
//
//   node generator/build-manifest.mjs
//
// The app reads the manifest to list regions, compute download sizes, verify
// tiles (sha256) and find updates (a tile changes when its sha256 changes).
// `tiles` are the depth tiles (.sgd), `contours` the contour tiles (.sgc);
// apps that predate contours ignore the latter.
import {createHash} from 'node:crypto';
import {existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {dirname, join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';

import {parseKey, tilesInBbox} from './tile-format.mjs';
import {buildDir, datasetDir} from './build-info.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = JSON.parse(readFileSync(join(ROOT, 'generator', 'regions.json'), 'utf8'));
const V1 = join(ROOT, 'public', 'v1');
const TILE_DIR = buildDir(ROOT, CONFIG.dataset);
const MANIFEST = join(V1, 'manifest.json');
// Path of the tile folder relative to /v1, as used in the URLs.
const tilePath = relative(V1, TILE_DIR).split('\\').join('/');

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
  tileUrl: `${tilePath}/{key}.sgd`,
  tiles,
  contourUrl: `${tilePath}/{key}.sgc`,
  contours,
  regions
};
// The folder the served manifest points at: kept one more build, for apps that
// fetched that manifest moments before this one replaces it.
const previous = existsSync(MANIFEST) ? dirname(JSON.parse(readFileSync(MANIFEST, 'utf8')).tileUrl) : null;
writeFileSync(`${MANIFEST}.part`, JSON.stringify(manifest));
renameSync(`${MANIFEST}.part`, MANIFEST);

// Remove older builds: folders of other versions, and the tiles of the first
// builds, which sat directly in the dataset folder.
const keep = new Set([tilePath, previous]);
const root = datasetDir(ROOT, CONFIG.dataset);
for (const name of readdirSync(root)) {
  const path = join(root, name);
  const isDir = statSync(path).isDirectory();
  const folder = isDir ? relative(V1, path).split('\\').join('/') : relative(V1, root).split('\\').join('/');
  if (!keep.has(folder)) {
    rmSync(path, {recursive: true, force: true});
  }
}
rmSync(join(V1, 'built-tiles.json'), {force: true}); // used by earlier builds
const total = keys.reduce((sum, key) => sum + sizeOf(key), 0);
console.log(
  `manifest: ${keys.length} depth tiles, ${Object.keys(contours).length} contour tiles (${(total / 1048576).toFixed(1)} MB), ${regions.length} regions`
);
