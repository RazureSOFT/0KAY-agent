// Measuring a rebuild against the original, one pixel at a time.
//
// Element-level comparison says "the header colour differs". It cannot see a
// missing gradient, a shifted illustration, or a font that renders slightly
// differently. A screenshot diff sees all of those, and the two together are
// what makes a check actionable: the element list says what to change, the
// pixel score says whether the change helped.
//
// This is a self-contained PNG reader/writer. Screenshots are PNG, and decoding
// them here keeps a check independent of which browser backend produced them
// and lets the difference image be written next to the report with no extra
// process or dependency.

import { inflateSync, deflateSync } from 'node:zlib';

export interface Raster {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel, row-major. */
  data: Uint8Array;
}

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function crc32(buffer: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Decode an 8-bit non-interlaced PNG into RGBA. Throws on anything else. */
export function decodePng(input: Uint8Array | Buffer): Raster {
  const raw = Buffer.from(input);
  if (raw.length < 8 || !raw.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG');
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  while (offset + 8 <= raw.length) {
    const length = raw.readUInt32BE(offset);
    const type = raw.toString('ascii', offset + 4, offset + 8);
    const data = raw.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const depth = data[8];
      colorType = data[9];
      if (depth !== 8) throw new Error(`unsupported PNG bit depth ${depth}`);
      if (data[12] !== 0) throw new Error('interlaced PNG is not supported');
      channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 0 ? 1 : 0;
      if (!channels) throw new Error(`unsupported PNG colour type ${colorType}`);
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
  }
  if (!width || !height || !idat.length) throw new Error('incomplete PNG');
  const scanlines = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  if (scanlines.length < height * (stride + 1)) throw new Error('truncated PNG data');
  const out = new Uint8Array(width * height * 4);
  let previous = new Uint8Array(stride);
  let cursor = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = scanlines[cursor];
    cursor += 1;
    const line = new Uint8Array(stride);
    for (let x = 0; x < stride; x += 1) {
      const value = scanlines[cursor + x];
      const left = x >= channels ? line[x - channels] : 0;
      const up = previous[x];
      const upperLeft = x >= channels ? previous[x - channels] : 0;
      let restored = value;
      if (filter === 1) restored = (value + left) & 0xff;
      else if (filter === 2) restored = (value + up) & 0xff;
      else if (filter === 3) restored = (value + ((left + up) >> 1)) & 0xff;
      else if (filter === 4) restored = (value + paeth(left, up, upperLeft)) & 0xff;
      else if (filter !== 0) throw new Error(`unsupported PNG filter ${filter}`);
      line[x] = restored;
    }
    cursor += stride;
    for (let x = 0; x < width; x += 1) {
      const src = x * channels;
      const dst = (y * width + x) * 4;
      if (channels >= 3) {
        out[dst] = line[src];
        out[dst + 1] = line[src + 1];
        out[dst + 2] = line[src + 2];
        out[dst + 3] = channels === 4 ? line[src + 3] : 255;
      } else {
        out[dst] = line[src];
        out[dst + 1] = line[src];
        out[dst + 2] = line[src];
        out[dst + 3] = channels === 2 ? line[src + 1] : 255;
      }
    }
    previous = line;
  }
  return { width, height, data: out };
}

/** Encode RGBA as a non-interlaced 8-bit PNG, used for the difference image. */
export function encodePng(raster: Raster): Buffer {
  const { width, height, data } = raster;
  const stride = width * 4;
  const scanlines = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    const row = y * (stride + 1);
    scanlines[row] = 0;
    Buffer.from(data.buffer, data.byteOffset + y * stride, stride).copy(scanlines, row + 1);
  }
  const chunk = (type: string, body: Buffer): Buffer => {
    const out = Buffer.alloc(12 + body.length);
    out.writeUInt32BE(body.length, 0);
    out.write(type, 4, 'ascii');
    body.copy(out, 8);
    const crc = crc32(out.subarray(4, 8 + body.length));
    out.writeUInt32BE(crc, 8 + body.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(scanlines, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export interface PixelRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Fraction of pixels in this region that differ, 0-1. */
  ratio: number;
}

export interface PixelDiff {
  /** 0-100, rounded. 100 means every pixel matched within the tolerance. */
  similarity: number;
  /** Fraction of pixels that differ, 0-1. */
  ratio: number;
  different: number;
  total: number;
  width: number;
  height: number;
  /** Worst 4x4 grid cells, so the report can point at a place, not a number. */
  regions: PixelRegion[];
  /** RGBA raster: unchanged pixels dimmed, changed pixels highlighted. */
  differenceImage?: Raster;
}

/**
 * Compare two screenshots.
 *
 * Different image sizes are not an error: a rebuild that is 200px shorter is a
 * real difference, and padding both to the larger canvas counts the extra area
 * as mismatch instead of silently cropping it away. A small per-channel
 * tolerance absorbs antialiasing and subpixel text rendering.
 */
export function comparePixels(
  original: Raster,
  rebuilt: Raster,
  options: { tolerance?: number; grid?: number; differenceImage?: boolean } = {},
): PixelDiff {
  const tolerance = options.tolerance ?? 12;
  const grid = Math.max(1, options.grid ?? 4);
  const width = Math.max(original.width, rebuilt.width);
  const height = Math.max(original.height, rebuilt.height);
  const total = width * height;
  const differenceImage = options.differenceImage
    ? { width, height, data: new Uint8Array(total * 4) }
    : undefined;
  const cells = Array.from({ length: grid * grid }, () => ({ different: 0, total: 0 }));
  let different = 0;
  for (let y = 0; y < height; y += 1) {
    const cellY = Math.min(grid - 1, Math.floor((y * grid) / height));
    for (let x = 0; x < width; x += 1) {
      const a = pixelAt(original, x, y);
      const b = pixelAt(rebuilt, x, y);
      const delta = Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) + Math.abs(a[3] - b[3]);
      const changed = delta > tolerance * 3;
      const cell = cells[cellY * grid + Math.min(grid - 1, Math.floor((x * grid) / width))];
      cell.total += 1;
      if (changed) {
        different += 1;
        cell.different += 1;
      }
      if (differenceImage) {
        const dst = (y * width + x) * 4;
        if (changed) {
          differenceImage.data[dst] = 244;
          differenceImage.data[dst + 1] = 63;
          differenceImage.data[dst + 2] = 94;
          differenceImage.data[dst + 3] = 255;
        } else {
          const grey = (a[0] + a[1] + a[2]) / 3;
          const value = Math.round(grey * 0.35 + 74);
          differenceImage.data[dst] = value;
          differenceImage.data[dst + 1] = value;
          differenceImage.data[dst + 2] = value;
          differenceImage.data[dst + 3] = 255;
        }
      }
    }
  }
  const cellWidth = width / grid;
  const cellHeight = height / grid;
  const regions = cells
    .map((cell, index) => ({
      x: Math.round((index % grid) * cellWidth),
      y: Math.round(Math.floor(index / grid) * cellHeight),
      width: Math.ceil(cellWidth),
      height: Math.ceil(cellHeight),
      ratio: cell.total ? cell.different / cell.total : 0,
    }))
    .filter((region) => region.ratio > 0.01)
    .sort((a, b) => b.ratio - a.ratio)
    .slice(0, 8);
  return {
    similarity: Math.max(0, Math.round((1 - different / Math.max(total, 1)) * 100)),
    ratio: different / Math.max(total, 1),
    different,
    total,
    width,
    height,
    regions,
    ...(differenceImage ? { differenceImage } : {}),
  };
}

function pixelAt(raster: Raster, x: number, y: number): [number, number, number, number] {
  if (x >= raster.width || y >= raster.height) return [255, 255, 255, 255];
  const at = (y * raster.width + x) * 4;
  return [raster.data[at], raster.data[at + 1], raster.data[at + 2], raster.data[at + 3]];
}
