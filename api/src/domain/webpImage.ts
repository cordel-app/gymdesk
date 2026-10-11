// WebP reading, with no dependency (#1412). `readWebpMetadata()` parses the RIFF
// container far enough to know the pixel size and whether the image can carry
// transparency, so a route enforces "1080x1080 WebP" from the bytes and never
// from the Content-Type or the file name.

export interface WebpMetadata {
  width: number;
  height: number;
  format: 'VP8' | 'VP8L' | 'VP8X';
}

/** Whether these bytes are a RIFF/WEBP container. */
export function isWebp(body: unknown): body is Buffer {
  if (!Buffer.isBuffer(body) || body.length < 16) return false;
  return body.toString('ascii', 0, 4) === 'RIFF' && body.toString('ascii', 8, 12) === 'WEBP';
}

export function readWebpMetadata(body: unknown): WebpMetadata | null {
  if (!isWebp(body)) return null;
  // The first chunk follows the 12-byte RIFF header: fourcc, size, payload.
  const fourcc = body.toString('ascii', 12, 16);
  if (fourcc === 'VP8X') {
    if (body.length < 30) return null;
    const width = 1 + body.readUIntLE(24, 3);
    const height = 1 + body.readUIntLE(27, 3);
    return { width, height, format: 'VP8X' };
  }
  if (fourcc === 'VP8L') {
    if (body.length < 25 || body[20] !== 0x2f) return null;
    const b = body.readUInt32LE(21);
    return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1, format: 'VP8L' };
  }
  if (fourcc === 'VP8 ') {
    // Frame tag (3 bytes), start code 9d 01 2a, then 14-bit width and height.
    if (body.length < 30 || body[23] !== 0x9d || body[24] !== 0x01 || body[25] !== 0x2a) return null;
    return { width: body.readUInt16LE(26) & 0x3fff, height: body.readUInt16LE(28) & 0x3fff, format: 'VP8' };
  }
  return null;
}
