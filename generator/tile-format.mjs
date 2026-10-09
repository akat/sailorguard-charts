// SGD2 depth tile format, shared with the app (src/services/depthGrid.ts).
//
// A tile covers 1° x 1° (south-west corner at integer degrees) split into
// 1/240° cells (~460 m x 360 m). A cell covers 4 x 4 EMODnet samples (~115 m)
// and stores the SHALLOWEST water sample and which of the 16 it was, so the app
// can place a sounding at the real position and never hides a shoal.
//
// Little endian:
//   0  char[4]  magic "SGD2"
//   4  float64  north edge (degrees)
//   12 float64  west edge (degrees)
//   20 float64  cell size (degrees)
//   28 uint32   cols
//   32 uint32   rows
//   36 uint16[] row-major values, run-length encoded:
//        0, count     `count` cells of land / no data
//        otherwise    bits 15-14 sample row, 13-12 sample column (0-3, from the
//                     cell's north-west corner), 11-0 depth code (see depthCode)

export const CELLS_PER_DEGREE = 240;
export const SAMPLES_PER_CELL_SIDE = 4;
export const NATIVE_PER_DEGREE = CELLS_PER_DEGREE * SAMPLES_PER_CELL_SIDE; // EMODnet 1/960°
const HEADER_BYTES = 36;

/** 0.1 m steps to 200 m (codes 1-2001), then 5 m steps. */
export function depthCode(depth) {
  const code = depth < 200 ? Math.round(depth * 10) + 1 : 2001 + Math.round((depth - 200) / 5);
  return Math.min(4095, Math.max(1, code));
}

export function decodeDepth(value) {
  const code = value & 0x0fff;
  return code <= 2001 ? (code - 1) / 10 : 200 + (code - 2001) * 5;
}

/** Tile key from its south-west corner, e.g. N37E023, S05W010. */
export function tileKey(south, west) {
  const lat = `${south < 0 ? 'S' : 'N'}${String(Math.abs(south)).padStart(2, '0')}`;
  const lon = `${west < 0 ? 'W' : 'E'}${String(Math.abs(west)).padStart(3, '0')}`;
  return lat + lon;
}

/** South-west corner of a tile key such as N37E023 or S05W010. */
export function parseKey(key) {
  const m = /^([NS])(\d{2})([EW])(\d{3})$/.exec(key);
  if (!m) {
    return null;
  }
  return {south: (m[1] === 'S' ? -1 : 1) * Number(m[2]), west: (m[3] === 'W' ? -1 : 1) * Number(m[4])};
}

/** Tiles (1° x 1°) whose area intersects the bbox [west, south, east, north]. */
export function tilesInBbox(keys, [west, south, east, north]) {
  return keys.filter(key => {
    const {south: s, west: w} = parseKey(key);
    return s < north && s + 1 > south && w < east && w + 1 > west;
  });
}

/**
 * Reduce native samples to cells.
 * @param {Float32Array|number[]} native row-major, row 0 = north, NATIVE_PER_DEGREE square,
 *        elevation in metres (negative = depth), NaN = no data
 * @returns {Uint16Array|null} cell values (0 = land) or null when the tile has no water
 */
export function reduceTile(native) {
  const n = CELLS_PER_DEGREE;
  const s = SAMPLES_PER_CELL_SIDE;
  const values = new Uint16Array(n * n);
  let water = 0;
  for (let row = 0; row < n; row += 1) {
    for (let col = 0; col < n; col += 1) {
      let shallowest = -Infinity;
      let at = 0;
      for (let sr = 0; sr < s; sr += 1) {
        const offset = (row * s + sr) * NATIVE_PER_DEGREE + col * s;
        for (let sc = 0; sc < s; sc += 1) {
          const elevation = native[offset + sc];
          if (elevation < 0 && elevation > shallowest) {
            shallowest = elevation;
            at = sr * s + sc;
          }
        }
      }
      if (shallowest > -Infinity) {
        values[row * n + col] = (Math.floor(at / s) << 14) | ((at % s) << 12) | depthCode(-shallowest);
        water += 1;
      }
    }
  }
  return water > 0 ? values : null;
}

/** Encode cell values (row-major, 0 = land) into an SGD2 buffer. */
export function encodeTile(north, west, values, cols = CELLS_PER_DEGREE, rows = CELLS_PER_DEGREE) {
  const tokens = [];
  let land = 0;
  const flush = () => {
    while (land > 0) {
      const count = Math.min(land, 65535);
      tokens.push(0, count);
      land -= count;
    }
  };
  for (const value of values) {
    if (value === 0) {
      land += 1;
    } else {
      flush();
      tokens.push(value);
    }
  }
  flush();
  const buffer = Buffer.alloc(HEADER_BYTES + tokens.length * 2);
  buffer.write('SGD2', 0, 'ascii');
  buffer.writeDoubleLE(north, 4);
  buffer.writeDoubleLE(west, 12);
  buffer.writeDoubleLE(1 / CELLS_PER_DEGREE, 20);
  buffer.writeUInt32LE(cols, 28);
  buffer.writeUInt32LE(rows, 32);
  tokens.forEach((token, i) => buffer.writeUInt16LE(token, HEADER_BYTES + i * 2));
  return buffer;
}

/** Decode an SGD2 buffer (used by tests and tools; the app has its own decoder). */
export function decodeTile(buffer) {
  if (buffer.toString('ascii', 0, 4) !== 'SGD2') {
    throw new Error('Unknown depth tile format');
  }
  const cols = buffer.readUInt32LE(28);
  const rows = buffer.readUInt32LE(32);
  const values = new Uint16Array(cols * rows);
  let out = 0;
  for (let offset = HEADER_BYTES; offset < buffer.length; offset += 2) {
    const value = buffer.readUInt16LE(offset);
    if (value === 0) {
      offset += 2;
      out += buffer.readUInt16LE(offset);
    } else {
      values[out] = value;
      out += 1;
    }
  }
  return {
    north: buffer.readDoubleLE(4),
    west: buffer.readDoubleLE(12),
    cell: buffer.readDoubleLE(20),
    cols,
    rows,
    values
  };
}
