// Reads the EMODnet Bathymetry DTM (CC BY 4.0) at native resolution through
// WCS, one 1° tile at a time. Shared by the depth tiles and the contours.
import {fromArrayBuffer} from 'geotiff';
import {NATIVE_PER_DEGREE} from './tile-format.mjs';

const WCS = 'https://ows.emodnet-bathymetry.eu/wcs';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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
export async function readNative(south, west) {
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
