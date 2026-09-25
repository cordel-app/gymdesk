// #716 — the pure half of Base Exercise images: where a platform object goes,
// and which objects a platform operation may delete.
//
// A unit test file (CLAUDE.md): no database, no HTTP, no `createTestGym`. The
// routes' own behaviour is covered by base-exercise-images.test.ts, and what
// counts as a *valid* image is covered once, in exercise-images.unit.test.ts —
// #716 §2/§3 are #719 §5 word for word, so both routers call the same
// `validateExerciseImagePair()` and the rules are not asserted twice.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildBaseExerciseImageKey,
  buildBaseExerciseImageThumbnailKey,
  baseExerciseImageFolderKeys,
  isPlatformOwnedExerciseImageUrl,
  PLATFORM_EXERCISE_IMAGES_PREFIX,
} from '../domain/baseExerciseImages';
import { buildGymExerciseImageKey } from '../domain/exerciseImages';
import { PLATFORM_STORAGE_ROOT } from '../infra/storage';

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

const url = (key: string) => `${R2_ENDPOINT}/${R2_BUCKET}/${key}`;

describe('buildBaseExerciseImageKey', () => {
  it('stores a base exercise under cordel/Exercises/Images/<id>-<Name>.png (§1, §13)', () => {
    expect(buildBaseExerciseImageKey(123, 'Barbell Back Squat'))
      .toBe('cordel/Exercises/Images/123-Barbell-Back-Squat.png');
  });

  it('names the thumbnail with -thumbnail before the extension', () => {
    expect(buildBaseExerciseImageThumbnailKey(456, 'Bench Press'))
      .toBe('cordel/Exercises/Images/456-Bench-Press-thumbnail.png');
  });

  it('hangs off the platform root, never a gym prefix (§15)', () => {
    const key = buildBaseExerciseImageKey(7, 'Lat Pulldown');
    expect(key.startsWith(`${PLATFORM_STORAGE_ROOT}/`)).toBe(true);
    expect(key).not.toContain('gyms/');
    expect(PLATFORM_EXERCISE_IMAGES_PREFIX).toBe('cordel/Exercises/Images');
  });

  it('sanitizes the name deterministically (§14)', () => {
    expect(buildBaseExerciseImageKey(9, 'Cable Row, Seated'))
      .toBe('cordel/Exercises/Images/9-Cable-Row-Seated.png');
    expect(buildBaseExerciseImageKey(9, 'Cable Row, Seated'))
      .toBe(buildBaseExerciseImageKey(9, 'Cable Row, Seated'));
    // Slashes and doubled separators collapse to single hyphens; combining marks
    // are stripped, so an accented name reads as itself rather than as a break.
    expect(buildBaseExerciseImageKey(10, 'Press  militar / máquina'))
      .toBe('cordel/Exercises/Images/10-Press-militar-maquina.png');
  });

  it('keeps the id in both keys, so two names that sanitize alike never collide', () => {
    expect(buildBaseExerciseImageKey(1, 'Row, Seated')).not.toBe(buildBaseExerciseImageKey(2, 'Row Seated'));
    expect(buildBaseExerciseImageKey(1, 'Row, Seated')).toContain('/1-');
    expect(buildBaseExerciseImageThumbnailKey(1, 'Row, Seated')).toContain('/1-');
  });

  it('always ends in .png (§13)', () => {
    expect(buildBaseExerciseImageKey(3, 'Deadlift').endsWith('.png')).toBe(true);
    expect(buildBaseExerciseImageThumbnailKey(3, 'Deadlift').endsWith('.png')).toBe(true);
  });

  it('falls back to a name rather than producing "<id>-.png"', () => {
    expect(buildBaseExerciseImageKey(4, '!!!')).toBe('cordel/Exercises/Images/4-exercise.png');
  });

  it('is the same leaf a gym uses, under a different root (§15)', () => {
    expect(buildGymExerciseImageKey(GYM_PREFIX, 5, 'Squat'))
      .toBe(`${GYM_PREFIX}/Exercises/Images/5-Squat.png`);
    expect(buildBaseExerciseImageKey(5, 'Squat')).toBe('cordel/Exercises/Images/5-Squat.png');
  });
});

describe('baseExerciseImageFolderKeys', () => {
  it('lists every marker from the platform root down, outermost first', () => {
    expect(baseExerciseImageFolderKeys()).toEqual([
      'cordel/',
      'cordel/Exercises/',
      'cordel/Exercises/Images/',
    ]);
  });
});

describe('isPlatformOwnedExerciseImageUrl', () => {
  it('accepts an object under cordel/Exercises/Images/', () => {
    expect(isPlatformOwnedExerciseImageUrl(url('cordel/Exercises/Images/12-Squat.png'))).toBe(true);
    expect(isPlatformOwnedExerciseImageUrl(url('cordel/Exercises/Images/12-Squat-thumbnail.png'))).toBe(true);
  });

  it("refuses a gym's own object — a platform operation never deletes one", () => {
    expect(isPlatformOwnedExerciseImageUrl(url(`${GYM_PREFIX}/Exercises/Images/12-Squat.png`))).toBe(false);
  });

  it('refuses another platform feature\'s object', () => {
    expect(isPlatformOwnedExerciseImageUrl(url('cordel/Nutrition/12-Chicken.png'))).toBe(false);
    expect(isPlatformOwnedExerciseImageUrl(url('cordel/Themes/3-Base/Members/training.png'))).toBe(false);
  });

  it('refuses an external URL and an empty reference', () => {
    expect(isPlatformOwnedExerciseImageUrl('https://example.com/squat.png')).toBe(false);
    expect(isPlatformOwnedExerciseImageUrl(null)).toBe(false);
    expect(isPlatformOwnedExerciseImageUrl(undefined)).toBe(false);
    expect(isPlatformOwnedExerciseImageUrl('')).toBe(false);
  });

  it('refuses a URL from another bucket or endpoint', () => {
    expect(isPlatformOwnedExerciseImageUrl(`${R2_ENDPOINT}/other-bucket/cordel/Exercises/Images/12-Squat.png`)).toBe(false);
    expect(isPlatformOwnedExerciseImageUrl(`https://elsewhere.example.com/${R2_BUCKET}/cordel/Exercises/Images/12-Squat.png`)).toBe(false);
  });

  it('anchors the prefix, so a sibling folder cannot pass as this one', () => {
    expect(isPlatformOwnedExerciseImageUrl(url('cordel/Exercises/ImagesArchive/12-Squat.png'))).toBe(false);
  });
});
