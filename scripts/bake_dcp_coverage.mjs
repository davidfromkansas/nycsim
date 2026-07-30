/* Bake the Brooklyn/Bronx/Queens DCP fabric coverage used to suppress fallback boxes.
 *
 * The old client used neighborhood rectangles, claim circles, and coarse masks,
 * which can extend beyond the buildings present in a chunk and erase fallback
 * neighborhoods.
 * The LOD chunks are the shipped, cheap representation of the same DCP fabric:
 * every eight vertices form one axis-aligned building/aggregate box. Rasterizing
 * their ground footprints makes suppression follow actual rendered coverage.
 *
 * Format (little endian):
 *   u32 magic "DCP1", f32 x0, f32 z0, f32 cell, u32 width, u32 height, bitset
 * Bits are column-major (gx * height + gz), MSB first within each byte.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUB = join(ROOT, 'public');
const CELL = 10;
const PAD = 5; // half a cell: closes quantization seams without spanning a city lot
const EXCLUDED = new Set([
  'qn-jfk.lod.bin', 'qn-lga.lod.bin',               // airport grounds have their own carve-outs
  'qn-flushmeadows.lod.bin', 'qn-forestpark.lod.bin' // sparse park structures do not own surrounding fabric
]);
const files = readdirSync(PUB)
  .filter(n => /^(bk|bx|qn)-.+\.lod\.bin$/.test(n) && !/-parks\.lod\.bin$/.test(n) && !EXCLUDED.has(n))
  .sort();

function boxesFromChunk(name) {
  const buf = readFileSync(join(PUB, name));
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0, true) !== 0x3143594E) throw new Error(`${name}: bad NYC1 magic`);
  const nv = dv.getUint32(8, true);
  if (nv % 8) throw new Error(`${name}: LOD vertex count ${nv} is not box-aligned`);
  const scale = [16, 20, 24].map(o => dv.getFloat32(o, true));
  const off = [28, 32, 36].map(o => dv.getFloat32(o, true));
  const q = new Uint16Array(buf.buffer, buf.byteOffset + 40, nv * 3);
  const boxes = [];
  for (let b = 0; b < nv; b += 8) {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let v = b; v < b + 8; v++) {
      const x = q[v * 3] / 65535 * scale[0] + off[0];
      const z = q[v * 3 + 2] / 65535 * scale[2] + off[2];
      x0 = Math.min(x0, x); x1 = Math.max(x1, x);
      z0 = Math.min(z0, z); z1 = Math.max(z1, z);
    }
    if (x1 > x0 && z1 > z0) boxes.push([x0, x1, z0, z1]);
  }
  return boxes;
}

const chunks = files.map(name => [name, boxesFromChunk(name)]);
const all = chunks.flatMap(([, boxes]) => boxes);
const bounds = all.reduce((a, b) => [
  Math.min(a[0], b[0]), Math.max(a[1], b[1]),
  Math.min(a[2], b[2]), Math.max(a[3], b[3])
], [Infinity, -Infinity, Infinity, -Infinity]);
const x0 = Math.floor((bounds[0] - PAD) / CELL) * CELL;
const z0 = Math.floor((bounds[2] - PAD) / CELL) * CELL;
const x1 = Math.ceil((bounds[1] + PAD) / CELL) * CELL;
const z1 = Math.ceil((bounds[3] + PAD) / CELL) * CELL;
const width = Math.round((x1 - x0) / CELL);
const height = Math.round((z1 - z0) / CELL);
const bits = Buffer.alloc(Math.ceil(width * height / 8));

function setCell(gx, gz) {
  if (gx < 0 || gx >= width || gz < 0 || gz >= height) return;
  const bit = gx * height + gz;
  bits[bit >> 3] |= 128 >> (bit & 7);
}
for (const b of all) {
  // Mark cells by their center. A point lookup can therefore extend at most one
  // half-cell beyond PAD, rather than a whole extra cell at every box edge.
  const gx0 = Math.ceil((b[0] - PAD - x0) / CELL - 0.5);
  const gx1 = Math.floor((b[1] + PAD - x0) / CELL - 0.5);
  const gz0 = Math.ceil((b[2] - PAD - z0) / CELL - 0.5);
  const gz1 = Math.floor((b[3] + PAD - z0) / CELL - 0.5);
  for (let gx = gx0; gx <= gx1; gx++)
    for (let gz = gz0; gz <= gz1; gz++) setCell(gx, gz);
}

const header = Buffer.alloc(24);
header.writeUInt32LE(0x31504344, 0); // "DCP1"
header.writeFloatLE(x0, 4); header.writeFloatLE(z0, 8);
header.writeFloatLE(CELL, 12);
header.writeUInt32LE(width, 16); header.writeUInt32LE(height, 20);
writeFileSync(join(PUB, 'dcp-coverage.bin'), Buffer.concat([header, bits]));

const occupied = bits.reduce((n, byte) => n + byte.toString(2).replace(/0/g, '').length, 0);
const covered = (x, z) => {
  const gx = Math.floor((x - x0) / CELL), gz = Math.floor((z - z0) / CELL);
  if (gx < 0 || gx >= width || gz < 0 || gz >= height) return false;
  const bit = gx * height + gz;
  return (bits[bit >> 3] & (128 >> (bit & 7))) !== 0;
};
const missedCenters = all.reduce((n, b) => n + !covered((b[0] + b[1]) / 2, (b[2] + b[3]) / 2), 0);
if (missedCenters) throw new Error(`${missedCenters} DCP box centers missing from coverage`);
console.log(JSON.stringify({
  chunks: chunks.length,
  boxes: all.length,
  verifiedBoxCenters: all.length - missedCenters,
  bounds: [x0, x1, z0, z1],
  cell: CELL,
  grid: [width, height],
  occupiedCells: occupied,
  coverageKm2: occupied * CELL * CELL / 1e6,
  bytes: header.length + bits.length
}, null, 2));
