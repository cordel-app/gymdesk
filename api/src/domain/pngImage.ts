// PNG reading and writing, with no dependency beyond node's zlib (#715).
//
// Two jobs, both pure:
//
//  - **Reading** — `readPngMetadata()` parses the IHDR (and looks for a `tRNS`
//    chunk) so a route can enforce "512×512 PNG with a transparent background"
//    from the bytes themselves rather than from what the client claimed.
//  - **Writing** — `encodePngRgba()` turns a raw RGBA buffer into a PNG, which
//    is what lets the Base Nutrition Library's image generator produce a real
//    transparent PNG offline, without an image library or a network call.
//
// Deliberately minimal: 8-bit, non-interlaced, one IDAT. That is the only shape
// this codebase writes, and the only shape #715 accepts as an upload.

import { deflateSync } from 'node:zlib';

/** The 8 bytes every PNG starts with. */
export const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');

/** Whether these bytes carry the PNG signature. */
export function isPng(body: unknown): boolean {
  // A string and an array both carry a `length` and numeric indices, so either
  // would read as a half-valid signature instead of being refused (CodeQL
  // `js/type-confusion-through-parameter-tampering`) — the same guard
  // `bytesMatchImageMime()` applies.
  if (typeof body === 'string' || Array.isArray(body) || !Buffer.isBuffer(body)) return false;
  return body.length >= 8 && body.subarray(0, 8).equals(PNG_SIGNATURE);
}

/**
 * PNG colour types, as the IHDR encodes them. 4 and 6 carry an alpha channel;
 * 0, 2 and 3 can only express transparency through a `tRNS` chunk.
 */
export const PNG_COLOR_TYPE = {
  grayscale: 0,
  truecolor: 2,
  indexed: 3,
  grayscaleAlpha: 4,
  truecolorAlpha: 6,
} as const;

export interface PngMetadata {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  /** True for colour types 4/6 — every pixel carries its own alpha. */
  hasAlphaChannel: boolean;
  /** True when a `tRNS` chunk is present (palette/greyscale transparency). */
  hasTransparencyChunk: boolean;
}

/**
 * IHDR (and `tRNS`) of a PNG, or null when the bytes are not a readable PNG.
 *
 * Chunks are walked rather than read at fixed offsets: IHDR is always first, but
 * `tRNS` can sit anywhere before the first IDAT, and stopping at IDAT keeps this
 * O(header) instead of scanning a whole image. A malformed length field ends the
 * walk instead of throwing — a truncated upload is "not a readable PNG", which
 * is a 400, not a 500.
 */
export function readPngMetadata(body: unknown): PngMetadata | null {
  if (!isPng(body)) return null;
  const bytes = body as Buffer;
  // 8 signature + 4 length + 4 type + 13 data + 4 CRC
  if (bytes.length < 33) return null;
  if (bytes.subarray(12, 16).toString('latin1') !== 'IHDR') return null;

  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const bitDepth = bytes[24];
  const colorType = bytes[25];
  if (width === 0 || height === 0) return null;

  let hasTransparencyChunk = false;
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString('latin1');
    if (type === 'tRNS') hasTransparencyChunk = true;
    if (type === 'IDAT' || type === 'IEND') break;
    const next = offset + 12 + length;
    if (next <= offset || next > bytes.length) break;
    offset = next;
  }

  return {
    width,
    height,
    bitDepth,
    colorType,
    hasAlphaChannel: colorType === PNG_COLOR_TYPE.grayscaleAlpha || colorType === PNG_COLOR_TYPE.truecolorAlpha,
    hasTransparencyChunk,
  };
}

/**
 * Whether a PNG is *able* to express a transparent background: it either carries
 * an alpha channel or declares a transparent colour through `tRNS`.
 *
 * This is a header check, not a pixel check. Proving that the *corner* pixels
 * really are transparent would mean inflating and un-filtering the whole image,
 * and an RGBA PNG whose alpha happens to be 255 everywhere would still pass a
 * naive version of that. So the rule is deliberately the one a header can
 * support — an opaque JPEG re-saved as `image/png` colour type 2 is rejected,
 * which is the mistake #715's "transparent background" requirement is there to
 * catch — and the visual check stays with the person uploading.
 */
export function pngSupportsTransparency(metadata: PngMetadata): boolean {
  return metadata.hasAlphaChannel || metadata.hasTransparencyChunk;
}

// ─── Writing ──────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

/**
 * Encodes `width × height` RGBA bytes (4 per pixel, row-major, no padding) as an
 * 8-bit truecolour-with-alpha PNG — colour type 6, so the result always
 * satisfies {@link pngSupportsTransparency}.
 *
 * Every scanline uses filter type 0 (None). A smarter filter would compress
 * better, but the images this writes are flat-shaded and small, and "no filter"
 * keeps the encoder something a reader can verify at a glance.
 */
export function encodePngRgba(width: number, height: number, rgba: Buffer): Buffer {
  const expected = width * height * 4;
  if (rgba.length !== expected) {
    throw new Error(`RGBA buffer must be ${expected} bytes for ${width}×${height}, got ${rgba.length}`);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = PNG_COLOR_TYPE.truecolorAlpha;
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter method: adaptive (per-scanline byte below)
  ihdr[12] = 0; // interlace: none

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: None
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
