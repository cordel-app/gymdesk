import { describe, expect, it } from 'vitest';
import {
  PLATFORM_MUSCLE_IMAGES_PREFIX,
  buildMuscleImageKey,
  buildMuscleImageThumbnailKey,
  isPlatformOwnedMuscleImageUrl,
  muscleImageFolderKeys,
  sanitizeMuscleImageName,
  parseMuscleSex,
  validateMuscleImagePair,
} from '../domain/muscleImages';
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
