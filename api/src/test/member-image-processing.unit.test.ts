// #1449 — what the server makes of the one picture a client sends: a 1080 × 1080
// and a 256 × 256 WebP, in memory, from the decoded bytes. Pure of the DB and of
// the bucket (`domain/memberImageProcessing.ts`).

import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { processMemberImage } from '../domain/memberImageProcessing';

async function make(
  format: 'jpeg' | 'png' | 'webp' | 'gif' | 'tiff',
  width: number,
  height: number,
  extra?: (s: sharp.Sharp) => sharp.Sharp,
): Promise<Buffer> {
  let image = sharp({ create: { width, height, channels: 3, background: { r: 10, g: 140, b: 90 } } });
  if (extra) image = extra(image);
  return image[format]().toBuffer();
}

async function sizes(result: Awaited<ReturnType<typeof processMemberImage>>) {
  if ('rejection' in result) throw new Error(`rejected: ${result.rejection}`);
  const master = await sharp(result.image).metadata();
  const thumb = await sharp(result.thumbnail).metadata();
  return { master, thumb };
}

describe('processMemberImage (#1449)', () => {
  it.each(['jpeg', 'png', 'webp', 'gif'] as const)('turns a %s into a 1080 and a 256 WebP', async (format) => {
    const { master, thumb } = await sizes(await processMemberImage(await make(format, 640, 480)));
    expect([master.format, master.width, master.height]).toEqual(['webp', 1080, 1080]);
    expect([thumb.format, thumb.width, thumb.height]).toEqual(['webp', 256, 256]);
  });

  it('crops a non-square picture to its centre rather than squashing it', async () => {
    // Left half red, right half blue, 400 × 200: the centre crop straddles both.
    const left = await sharp({ create: { width: 200, height: 200, channels: 3, background: '#ff0000' } }).png().toBuffer();
    const right = await sharp({ create: { width: 200, height: 200, channels: 3, background: '#0000ff' } }).png().toBuffer();
    const wide = await sharp({ create: { width: 400, height: 200, channels: 3, background: '#000000' } })
      .composite([{ input: left, left: 0, top: 0 }, { input: right, left: 200, top: 0 }])
      .png().toBuffer();
    const result = await processMemberImage(wide);
    if ('rejection' in result) throw new Error('rejected');
    const { data, info } = await sharp(result.image).raw().toBuffer({ resolveWithObject: true });
    const px = (x: number, y: number) => [0, 1, 2].map((c) => data[(y * info.width + x) * info.channels + c]);
    expect(px(10, 540)[0]).toBeGreaterThan(200); // left edge of the crop is red
    expect(px(1070, 540)[2]).toBeGreaterThan(200); // right edge is blue
  });

  it('upscales a small picture to the fixed size', async () => {
    const { master } = await sizes(await processMemberImage(await make('png', 64, 64)));
    expect([master.width, master.height]).toEqual([1080, 1080]);
  });

  it('applies the EXIF orientation and keeps no metadata', async () => {
    const original = await make('jpeg', 400, 200, (s) => s.withMetadata({ orientation: 6 }));
    const { master } = await sizes(await processMemberImage(original));
    expect(master.exif).toBeUndefined();
    expect(master.icc).toBeUndefined();
    expect(master.orientation).toBeUndefined();
  });

  it('refuses a format outside the allow-list, judged from the bytes', async () => {
    expect(await processMemberImage(await make('tiff', 40, 40))).toEqual({ rejection: 'unsupported_format' });
  });

  it('refuses bytes that are not a picture', async () => {
    expect(await processMemberImage(Buffer.from('not an image at all'))).toEqual({ rejection: 'unreadable' });
    expect(await processMemberImage(Buffer.alloc(0))).toEqual({ rejection: 'unreadable' });
    // A JPEG header followed by nothing decodable.
    expect(await processMemberImage(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)])))
      .toEqual({ rejection: 'unreadable' });
  });

  it('refuses a picture over the pixel ceiling without decoding it', async () => {
    // 8000 × 8000 = 64 MP > 50 MP; a flat PNG of that size is tiny on the wire.
    const huge = await make('png', 8000, 8000);
    expect(await processMemberImage(huge)).toEqual({ rejection: 'too_many_pixels' });
  });
});
