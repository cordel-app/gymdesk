import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  PLATFORM_MUSCLE_IMAGES_PREFIX,
  buildMuscleImageKey,
  buildMuscleImageThumbnailKey,
  isPlatformOwnedMuscleImageUrl,
  muscleImageFolderKeys,
  sanitizeMuscleImageName,
  parseMuscleSex,
  muscleImageMaxBytes,
  muscleImageUploadRateLimitMax,
  validateMuscleImagePair,
} from '../domain/muscleImages';
import { processMuscleImage } from '../domain/muscleImageProcessing';
import { readWebpMetadata } from '../domain/webpImage';
import { slugFromMuscleName } from '../api/platform-muscles';

describe('muscle image keys (#1368 stage 3)', () => {
  it('builds the cordel/muscles/images keys from the name', () => {
    expect(PLATFORM_MUSCLE_IMAGES_PREFIX).toBe('cordel/muscles/images');
    expect(buildMuscleImageKey('Middle Back', 'male')).toBe('cordel/muscles/images/Middle-Back-male.webp');
    expect(buildMuscleImageThumbnailKey('Middle Back', 'female')).toBe('cordel/muscles/images/Middle-Back-female-thumbnail.webp');
  });

  it('falls back for a name with nothing usable', () => {
    expect(sanitizeMuscleImageName('///')).toBe('muscle');
  });

  it('lists the folder markers outermost first', () => {
    expect(muscleImageFolderKeys()).toEqual(['cordel/', 'cordel/muscles/', 'cordel/muscles/images/']);
  });

  it('never treats a missing or external URL as platform-owned', () => {
    expect(isPlatformOwnedMuscleImageUrl(null)).toBe(false);
    expect(isPlatformOwnedMuscleImageUrl('https://example.com/cordel/muscles/images/x.png')).toBe(false);
  });
});

describe('muscle slug', () => {
  it('derives the catalogue slug shape', () => {
    expect(slugFromMuscleName('Middle Back')).toBe('middle_back');
    expect(slugFromMuscleName('  Éxtensores!  ')).toBe('extensores');
    expect(slugFromMuscleName('***')).toBe('');
  });
});

describe('muscle image validation (#1412)', () => {
  const vp8x = (w: number, h: number) => {
    const b = Buffer.alloc(30);
    b.write('RIFF', 0, 'ascii'); b.writeUInt32LE(22, 4); b.write('WEBPVP8X', 8, 'ascii');
    b.writeUInt32LE(10, 16); b.writeUIntLE(w - 1, 24, 3); b.writeUIntLE(h - 1, 27, 3);
    return b;
  };

  it('reads the size from the bytes and accepts exact sizes', () => {
    expect(readWebpMetadata(vp8x(1080, 1080))).toMatchObject({ width: 1080, height: 1080 });
    expect(validateMuscleImagePair(vp8x(1080, 1080), vp8x(256, 256))).toBeNull();
  });

  it('rejects wrong sizes and non-WebP bytes', () => {
    expect(validateMuscleImagePair(vp8x(2048, 2048), vp8x(256, 256))?.rejection).toBe('wrong_size');
    expect(validateMuscleImagePair(vp8x(1080, 1080), vp8x(512, 512))).toMatchObject({ kind: 'thumbnail', rejection: 'wrong_size' });
    expect(validateMuscleImagePair(Buffer.from('not an image'), vp8x(256, 256))?.rejection).toBe('not_webp');
  });

  it('parses only male and female', () => {
    expect(parseMuscleSex('male')).toBe('male');
    expect(parseMuscleSex('other')).toBeNull();
  });
});

describe('muscle image processing is the server\'s (#1413)', () => {
  const picture = (width: number, height: number, format: 'png' | 'jpeg' = 'png') =>
    sharp({ create: { width, height, channels: 3, background: { r: 200, g: 30, b: 30 } } })[format]().toBuffer();

  it('fits any size into a 1080 WebP master and a 256 WebP thumbnail', async () => {
    for (const [w, h] of [[2048, 2048], [300, 200], [4000, 1000], [1080, 1080]] as const) {
      const out = await processMuscleImage(await picture(w, h));
      if ('rejection' in out) throw new Error(`rejected ${w}x${h}`);
      expect(validateMuscleImagePair(out.image, out.thumbnail)).toBeNull();
      const meta = await sharp(out.image).metadata();
      expect(meta).toMatchObject({ format: 'webp', width: 1080, height: 1080 });
      expect((await sharp(out.thumbnail).metadata())).toMatchObject({ format: 'webp', width: 256, height: 256 });
    }
  });

  it('contains the picture: no distortion, no crop, transparent padding', async () => {
    const out = await processMuscleImage(await picture(2000, 500));
    if ('rejection' in out) throw new Error('rejected');
    const { data, info } = await sharp(out.image).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const alphaAt = (x: number, y: number) => data[(y * info.width + x) * 4 + 3];
    expect(alphaAt(540, 5)).toBe(0); // padding above the wide picture
    expect(alphaAt(540, 540)).toBe(255); // the picture itself
    expect(alphaAt(2, 540)).toBe(255); // reaches both left and right edges: nothing cropped
  });

  it('refuses what is not a decodable image of an accepted format', async () => {
    expect(await processMuscleImage(Buffer.from('not an image'))).toEqual({ rejection: 'unreadable' });
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
    expect(await processMuscleImage(svg)).toEqual({ rejection: 'unsupported_format' });
  });

  it('bounds the original by MUSCLE_IMAGE_MAX_MB (default 10, clamped at 25) and the budget by its own variable', () => {
    expect(muscleImageMaxBytes({})).toBe(10 * 1024 * 1024);
    expect(muscleImageMaxBytes({ MUSCLE_IMAGE_MAX_MB: '5' })).toBe(5 * 1024 * 1024);
    expect(muscleImageMaxBytes({ MUSCLE_IMAGE_MAX_MB: '500' })).toBe(25 * 1024 * 1024);
    expect(muscleImageMaxBytes({ MUSCLE_IMAGE_MAX_MB: 'abc' })).toBe(10 * 1024 * 1024);
    expect(muscleImageUploadRateLimitMax({})).toBe(30);
    expect(muscleImageUploadRateLimitMax({ MUSCLE_IMAGE_UPLOAD_RATE_LIMIT_MAX: '5' })).toBe(5);
  });

  it('keeps the route raw-bodied and the browser out of the encoding', () => {
    const root = path.resolve(__dirname, '../../..');
    const route = fs.readFileSync(path.join(root, 'api/src/api/platform-muscles.ts'), 'utf8');
    const app = fs.readFileSync(path.join(root, 'api/src/app.ts'), 'utf8');
    const lib = fs.readFileSync(path.join(root, 'apps/admin/src/lib/muscleImageUpload.ts'), 'utf8');
    expect(route).toContain('express.raw(');
    expect(route).toContain('processMuscleImage(');
    expect(route).not.toContain('decodeBase64File');
    expect(app).not.toContain('platformMuscleImageBodyParser');
    expect(lib).not.toMatch(/canvas|toBlob|createImageBitmap|image\/webp'/i);
  });
});
