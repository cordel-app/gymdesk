// #719 part 1 — the pure half of Gym Exercise images: where an object goes,
// what is accepted, and which objects a gym may delete.
//
// A unit test file (CLAUDE.md): no database, no HTTP, no `createTestGym`. The
// router's own behaviour is covered by gym-exercise-images.test.ts.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EXERCISE_IMAGE_MASTER_SIZE,
  EXERCISE_IMAGE_THUMBNAIL_MAX_BYTES,
  EXERCISE_IMAGE_THUMBNAIL_SIZE,
  buildGymExerciseImageKey,
  buildGymExerciseImageThumbnailKey,
  gymExerciseImageFolderKeys,
  isGymOwnedImageUrl,
  sanitizeExerciseImageName,
  validateExerciseImage,
  validateExerciseImagePair,
} from '../domain/exerciseImages';
import { PLATFORM_STORAGE_ROOT } from '../infra/storage';
import { encodePngRgba } from '../domain/pngImage';

const R2_ENDPOINT = 'https://example.r2.cloudflarestorage.com';
const R2_BUCKET = 'test-bucket';
const GYM_PREFIX = 'gyms/11111111-2222-3333-4444-555555555555-IronWorks';

const R2_ENV_KEYS = [
  'CLOUDFLARE_R2_ENDPOINT',
  'CLOUDFLARE_R2_ACCESS_KEY_ID',
  'CLOUDFLARE_R2_SECRET_ACCESS_KEY',
  'CLOUDFLARE_R2_BUCKET',
] as const;
const originalEnv: Record<string, string | undefined> = {};
for (const key of R2_ENV_KEYS) originalEnv[key] = process.env[key];

beforeEach(() => {
  process.env.CLOUDFLARE_R2_ENDPOINT = R2_ENDPOINT;
  process.env.CLOUDFLARE_R2_ACCESS_KEY_ID = 'test-key-id';
  process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY = 'test-secret';
  process.env.CLOUDFLARE_R2_BUCKET = R2_BUCKET;
});

afterEach(() => {
  for (const key of R2_ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

/** A transparent PNG of the given square size. */
function png(size: number): Buffer {
  return encodePngRgba(size, size, Buffer.alloc(size * size * 4, 0x40));
}

/** A PNG whose IHDR claims `size` but carries no alpha channel (colour type 2). */
function opaquePng(size: number): Buffer {
  const bytes = Buffer.from(png(1));
  bytes.writeUInt32BE(size, 16);
  bytes.writeUInt32BE(size, 20);
  bytes[25] = 2;
  return bytes;
}

const url = (key: string) => `${R2_ENDPOINT}/${R2_BUCKET}/${key}`;

describe('sanitizeExerciseImageName', () => {
  it('turns a phrase into hyphens rather than deleting the spaces', () => {
    expect(sanitizeExerciseImageName('Barbell Back Squat')).toBe('Barbell-Back-Squat');
  });

  it('collapses punctuation and strips accents', () => {
    expect(sanitizeExerciseImageName('Press militar (de pie), 45°')).toBe('Press-militar-de-pie-45');
    expect(sanitizeExerciseImageName('Elevación lateral')).toBe('Elevacion-lateral');
  });

  it('never yields an empty segment', () => {
    expect(sanitizeExerciseImageName('///')).toBe('exercise');
    expect(sanitizeExerciseImageName('')).toBe('exercise');
  });

  it('is deterministic, so a re-upload overwrites rather than orphans', () => {
    expect(sanitizeExerciseImageName('Barbell Press')).toBe(sanitizeExerciseImageName('Barbell  Press'));
  });

  it('caps the name so a long one cannot outgrow the URL columns', () => {
    const long = 'Barbell '.repeat(40);
    const sanitized = sanitizeExerciseImageName(long);
    expect(sanitized.length).toBeLessThanOrEqual(80);
    expect(sanitized.endsWith('-')).toBe(false);
  });
});

describe('object keys (#719 §5, §18)', () => {
  it('puts the master and its thumbnail in the gym folder, keyed by id and name', () => {
    expect(buildGymExerciseImageKey(GYM_PREFIX, 42, 'Barbell Press'))
      .toBe(`${GYM_PREFIX}/Exercises/Images/42-Barbell-Press.png`);
    expect(buildGymExerciseImageThumbnailKey(GYM_PREFIX, 42, 'Barbell Press'))
      .toBe(`${GYM_PREFIX}/Exercises/Images/42-Barbell-Press-thumbnail.png`);
  });

  it('never writes into the platform root (§18)', () => {
    const key = buildGymExerciseImageKey(GYM_PREFIX, 42, 'Barbell Press');
    expect(key.startsWith(`${PLATFORM_STORAGE_ROOT}/`)).toBe(false);
    expect(key).not.toContain(`/${PLATFORM_STORAGE_ROOT}/`);
  });

  it('keeps two exercises that sanitize alike apart, because the id leads', () => {
    expect(buildGymExerciseImageKey(GYM_PREFIX, 1, 'Barbell Press'))
      .not.toBe(buildGymExerciseImageKey(GYM_PREFIX, 2, 'Barbell  Press'));
  });

  it('keeps both URLs inside the columns that store them, whatever the names', () => {
    // The worst case the schema allows: a 255-character gym name (`gyms.name`)
    // and an exercise name far longer than the key may carry, behind a real R2
    // endpoint (account id + bucket) rather than this file's short test one.
    const prefix = `gyms/11111111-2222-3333-4444-555555555555-${'A'.repeat(255)}`;
    const name = 'Extremely Descriptive Exercise Name '.repeat(6);
    const endpointAndBucket = `https://${'0'.repeat(32)}.r2.cloudflarestorage.com/${'b'.repeat(63)}/`;
    const master = `${endpointAndBucket}${buildGymExerciseImageKey(prefix, 999999999, name)}`;
    const thumbnail = `${endpointAndBucket}${buildGymExerciseImageThumbnailKey(prefix, 999999999, name)}`;
    // Both columns are VARCHAR(1024) (migration 187), and the thumbnail URL is
    // the longer of the two by exactly `-thumbnail`.
    expect(thumbnail.length - master.length).toBe('-thumbnail'.length);
    expect(thumbnail.length).toBeLessThanOrEqual(1024);
  });

  it('names every folder marker between the bucket root and Exercises/Images', () => {
    expect(gymExerciseImageFolderKeys(GYM_PREFIX)).toEqual([
      `${GYM_PREFIX}/`,
      `${GYM_PREFIX}/Exercises/`,
      `${GYM_PREFIX}/Exercises/Images/`,
    ]);
  });
});

describe('isGymOwnedImageUrl (#719 §19)', () => {
  it('owns an object under this gym’s own prefix', () => {
    expect(isGymOwnedImageUrl(url(`${GYM_PREFIX}/Exercises/Images/42-Barbell-Press.png`), GYM_PREFIX)).toBe(true);
  });

  it('owns the legacy <uuid>.png shape the #417 upload route writes', () => {
    expect(isGymOwnedImageUrl(url(`${GYM_PREFIX}/Exercises/Images/6f1b-uuid.png`), GYM_PREFIX)).toBe(true);
  });

  it('never owns a System object, so a gym operation cannot delete one', () => {
    expect(isGymOwnedImageUrl(url('cordel/Exercises/Images/123-Barbell-Press.png'), GYM_PREFIX)).toBe(false);
  });

  it('never owns another gym’s object, even one whose prefix starts the same way', () => {
    expect(isGymOwnedImageUrl(url('gyms/99999999-0000-0000-0000-000000000000-Other/Exercises/Images/1.png'), GYM_PREFIX)).toBe(false);
    expect(isGymOwnedImageUrl(url(`${GYM_PREFIX}Plus/Exercises/Images/1.png`), GYM_PREFIX)).toBe(false);
  });

  it('never owns an external URL or a URL from another deployment', () => {
    expect(isGymOwnedImageUrl('https://example.com/barbell.png', GYM_PREFIX)).toBe(false);
    expect(isGymOwnedImageUrl(`https://other.r2.cloudflarestorage.com/${R2_BUCKET}/${GYM_PREFIX}/x.png`, GYM_PREFIX)).toBe(false);
  });

  it('owns nothing when either side is missing', () => {
    expect(isGymOwnedImageUrl(null, GYM_PREFIX)).toBe(false);
    expect(isGymOwnedImageUrl(url(`${GYM_PREFIX}/x.png`), null)).toBe(false);
  });
});

describe('validateExerciseImage (#719 §5, §21)', () => {
  it('accepts a 2048×2048 transparent PNG as the master', () => {
    expect(validateExerciseImage(png(EXERCISE_IMAGE_MASTER_SIZE), 'image')).toBeNull();
  });

  it('accepts a 512×512 transparent PNG as the thumbnail', () => {
    expect(validateExerciseImage(png(EXERCISE_IMAGE_THUMBNAIL_SIZE), 'thumbnail')).toBeNull();
  });

  it('rejects the thumbnail size for the master and vice versa', () => {
    expect(validateExerciseImage(png(EXERCISE_IMAGE_THUMBNAIL_SIZE), 'image')?.rejection).toBe('wrong_size');
    expect(validateExerciseImage(png(EXERCISE_IMAGE_MASTER_SIZE), 'thumbnail')?.rejection).toBe('wrong_size');
  });

  it('rejects anything that is not a PNG, whatever the request claimed', () => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
    expect(validateExerciseImage(jpeg, 'image')?.rejection).toBe('not_a_png');
    // A string and an array carry a `length` and numeric indices; neither is bytes.
    expect(validateExerciseImage('not bytes', 'image')?.rejection).toBe('not_a_png');
    expect(validateExerciseImage([0x89, 0x50], 'image')?.rejection).toBe('not_a_png');
  });

  it('rejects an opaque PNG — transparency is the point of the format here', () => {
    expect(validateExerciseImage(opaquePng(EXERCISE_IMAGE_MASTER_SIZE), 'image')?.rejection).toBe('not_transparent');
  });

  it('rejects an oversized file before decoding it', () => {
    const huge = Buffer.alloc(EXERCISE_IMAGE_THUMBNAIL_MAX_BYTES + 1);
    expect(validateExerciseImage(huge, 'thumbnail')?.rejection).toBe('too_large');
  });

  it('names the file each problem is about', () => {
    expect(validateExerciseImage(png(8), 'thumbnail')).toMatchObject({ kind: 'thumbnail' });
    expect(validateExerciseImage(png(8), 'image')?.message).toContain('Image');
  });
});

describe('validateExerciseImagePair', () => {
  it('passes only when both files pass', () => {
    expect(validateExerciseImagePair(png(EXERCISE_IMAGE_MASTER_SIZE), png(EXERCISE_IMAGE_THUMBNAIL_SIZE))).toBeNull();
  });

  it('fails the whole upload when the browser’s thumbnail is wrong (#719 Q2)', () => {
    const problem = validateExerciseImagePair(png(EXERCISE_IMAGE_MASTER_SIZE), png(256));
    expect(problem).toMatchObject({ kind: 'thumbnail', rejection: 'wrong_size' });
  });

  it('reports the master first when both are wrong', () => {
    expect(validateExerciseImagePair(png(256), png(256))?.kind).toBe('image');
  });
});
