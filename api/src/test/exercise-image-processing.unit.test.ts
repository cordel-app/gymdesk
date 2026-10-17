// #1420 stage 2 — what the server does to one picture: contain it whole in a
// 1080 square with transparent padding (the default, a Nutrition food's), or —
// since the #1527 follow-up, for an exercise — centre-crop it to the square; never
// stretch it, and make the thumbnail from the processed master.

import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { processExerciseImage } from '../domain/exerciseImageProcessing';
import { containedPictureBox } from '../domain/exerciseImageRecrop';
import { exerciseMediaUploadRateLimitMax } from '../domain/exerciseGenderMedia';

const solid = (width: number, height: number, format: 'png' | 'jpeg' | 'webp' | 'gif' = 'png') =>
  sharp({ create: { width, height, channels: 3, background: { r: 10, g: 200, b: 30 } } })[format]().toBuffer();

async function alphaColumn(buffer: Buffer, x: number): Promise<number[]> {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const out: number[] = [];
  for (let y = 0; y < info.height; y++) out.push(data[(y * info.width + x) * 4 + 3]);
  return out;
}

describe('processExerciseImage', () => {
  it.each(['png', 'jpeg', 'webp', 'gif'] as const)('turns a %s into a 1080 WebP and a 256 WebP thumbnail', async (format) => {
    const out = await processExerciseImage(await solid(400, 400, format));
    expect('rejection' in out).toBe(false);
    if ('rejection' in out) return;
    expect(await sharp(out.image).metadata()).toMatchObject({ format: 'webp', width: 1080, height: 1080 });
    expect(await sharp(out.thumbnail).metadata()).toMatchObject({ format: 'webp', width: 256, height: 256 });
  });

  it('fits a landscape picture whole and pads top and bottom with transparency', async () => {
    const out = await processExerciseImage(await solid(2000, 1000));
    if ('rejection' in out) throw new Error(out.rejection);
    const column = await alphaColumn(out.image, 540);
    expect(column[0]).toBe(0);
    expect(column[1079]).toBe(0);
    expect(column[540]).toBe(255);
    // 2:1 source: 540 rows of picture, centred — nothing cropped, nothing stretched.
    const opaque = column.filter((a) => a === 255).length;
    expect(opaque).toBeGreaterThan(530);
    expect(opaque).toBeLessThan(550);
    const left = await alphaColumn(out.image, 2);
    expect(left.filter((a) => a === 255).length).toBeGreaterThan(530);
  });

  it('fits a portrait picture whole and pads left and right', async () => {
    const out = await processExerciseImage(await solid(500, 1000));
    if ('rejection' in out) throw new Error(out.rejection);
    const { data, info } = await sharp(out.image).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const alphaAt = (x: number) => data[(540 * info.width + x) * 4 + 3];
    expect(alphaAt(5)).toBe(0);
    expect(alphaAt(1074)).toBe(0);
    expect(alphaAt(540)).toBe(255);
  });

  it('makes the thumbnail from the master, so its padding matches', async () => {
    const out = await processExerciseImage(await solid(2000, 1000));
    if ('rejection' in out) throw new Error(out.rejection);
    const column = await alphaColumn(out.thumbnail, 128);
    expect(column[0]).toBe(0);
    expect(column[255]).toBe(0);
    expect(column[128]).toBe(255);
  });

  it('cover: crops a landscape picture to the square, no transparent band (#1527)', async () => {
    const out = await processExerciseImage(await solid(2000, 1000), { fit: 'cover' });
    if ('rejection' in out) throw new Error(out.rejection);
    expect(await sharp(out.image).metadata()).toMatchObject({ width: 1080, height: 1080 });
    expect((await alphaColumn(out.image, 540)).every((a) => a === 255)).toBe(true);
    expect((await alphaColumn(out.thumbnail, 128)).every((a) => a === 255)).toBe(true);
  });

  it('refuses a format outside the allow-list and bytes that are not a picture', async () => {
    const tiff = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#000' } }).tiff().toBuffer();
    expect(await processExerciseImage(tiff)).toEqual({ rejection: 'unsupported_format' });
    expect(await processExerciseImage(Buffer.from('definitely not an image'))).toEqual({ rejection: 'unreadable' });
  });
});

describe('exerciseMediaUploadRateLimitMax', () => {
  it('defaults to 30 and accepts a positive integer only', () => {
    expect(exerciseMediaUploadRateLimitMax({} as NodeJS.ProcessEnv)).toBe(30);
    expect(exerciseMediaUploadRateLimitMax({ EXERCISE_MEDIA_UPLOAD_RATE_LIMIT_MAX: '5' } as any)).toBe(5);
    expect(exerciseMediaUploadRateLimitMax({ EXERCISE_MEDIA_UPLOAD_RATE_LIMIT_MAX: '0' } as any)).toBe(30);
    expect(exerciseMediaUploadRateLimitMax({ EXERCISE_MEDIA_UPLOAD_RATE_LIMIT_MAX: '2.5' } as any)).toBe(30);
  });
});

describe('containedPictureBox (#1527 re-crop)', () => {
  const raw = async (buffer: Buffer) => sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

  it('finds the picture inside a contained landscape master', async () => {
    const out = await processExerciseImage(await solid(2000, 1000));
    if ('rejection' in out) throw new Error(out.rejection);
    const { data, info } = await raw(out.image);
    const box = containedPictureBox(data, info.width, info.height);
    expect(box?.left).toBe(0);
    expect(box?.width).toBe(1080);
    expect(box!.height).toBeGreaterThan(530);
    expect(box!.height).toBeLessThan(550);
  });

  it('returns null for a square with no bands and for a cutout touching no edge pair', async () => {
    const full = await raw(await solid(100, 100));
    expect(containedPictureBox(full.data, full.info.width, full.info.height)).toBeNull();
    const cutout = await raw(await sharp({ create: { width: 100, height: 100, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: await solid(40, 60), left: 30, top: 20 }]).png().toBuffer());
    expect(containedPictureBox(cutout.data, cutout.info.width, cutout.info.height)).toBeNull();
  });
});
