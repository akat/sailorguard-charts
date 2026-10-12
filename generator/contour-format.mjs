// SGC1 contour tile format, shared with the app (src/services/contourTile.ts).
//
// One file per 1° tile with two levels of detail: coarse (zoomed out) and fine
// (zoomed in). Coordinates are tile grid units (1/960°, x from the west edge,
// y from the north edge) quantised to 1/16 unit (~7 m) and stored as
// zig-zag varint deltas.
//
//   0  char[4]  magic "SGC1"
//   4  float64  north edge (degrees)
//   12 float64  west edge (degrees)
//   20 uint8    level count (2: coarse, fine)
//   per level:
//     varint line count
//       per line:  varint depth (m), varint point count, points
//     varint area count
//       per area:  varint depth (m), varint ring count,
//                  per ring: varint point count, points (first ring outer, then holes)
//   points: zig-zag varint (dx, dy) pairs, the first relative to (0, 0)

const QUANT = 16;

class Writer {
  constructor() {
    this.bytes = [];
  }
  varint(value) {
    let v = value >>> 0;
    while (v >= 0x80) {
      this.bytes.push((v & 0x7f) | 0x80);
      v >>>= 7;
    }
    this.bytes.push(v);
  }
  zigzag(value) {
    this.varint(value >= 0 ? value * 2 : -value * 2 - 1);
  }
  points(points) {
    this.varint(points.length);
    let px = 0;
    let py = 0;
    for (const [x, y] of points) {
      const qx = Math.round(x * QUANT);
      const qy = Math.round(y * QUANT);
      this.zigzag(qx - px);
      this.zigzag(qy - py);
      px = qx;
      py = qy;
    }
  }
}

/** @param levels [{lines: [{depth, points}], areas: [{depth, rings}]}, ...] coarse first */
export function encodeContours(north, west, levels) {
  const w = new Writer();
  for (const level of levels) {
    w.varint(level.lines.length);
    for (const line of level.lines) {
      w.varint(line.depth);
      w.points(line.points);
    }
    w.varint(level.areas.length);
    for (const area of level.areas) {
      w.varint(area.depth);
      w.varint(area.rings.length);
      for (const ring of area.rings) {
        w.points(ring);
      }
    }
  }
  const header = Buffer.alloc(21);
  header.write('SGC1', 0, 'ascii');
  header.writeDoubleLE(north, 4);
  header.writeDoubleLE(west, 12);
  header.writeUInt8(levels.length, 20);
  return Buffer.concat([header, Buffer.from(w.bytes)]);
}

/** Decode (tests and tools; the app has its own decoder). Coordinates come back in grid units. */
export function decodeContours(buffer) {
  if (buffer.toString('ascii', 0, 4) !== 'SGC1') {
    throw new Error('Unknown contour tile format');
  }
  let offset = 21;
  const varint = () => {
    let result = 0;
    let shift = 0;
    let byte;
    do {
      byte = buffer[offset];
      offset += 1;
      result += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    } while (byte & 0x80);
    return result;
  };
  const zigzag = () => {
    const v = varint();
    return v % 2 === 0 ? v / 2 : -(v + 1) / 2;
  };
  const points = () => {
    const count = varint();
    const out = [];
    let x = 0;
    let y = 0;
    for (let i = 0; i < count; i += 1) {
      x += zigzag();
      y += zigzag();
      out.push([x / QUANT, y / QUANT]);
    }
    return out;
  };
  const levels = [];
  for (let l = 0; l < buffer.readUInt8(20); l += 1) {
    const lines = Array.from({length: varint()}, () => ({depth: varint(), points: points()}));
    const areas = Array.from({length: varint()}, () => {
      const depth = varint();
      return {depth, rings: Array.from({length: varint()}, points)};
    });
    levels.push({lines, areas});
  }
  return {north: buffer.readDoubleLE(4), west: buffer.readDoubleLE(12), levels};
}
