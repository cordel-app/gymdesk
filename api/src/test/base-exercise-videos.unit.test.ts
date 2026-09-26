// #717 — the pure half of Base Exercise videos: where a platform object goes,
// and which objects a platform operation may delete.
//
// A unit test file (CLAUDE.md): no database, no HTTP, no `createTestGym`. The
// routes' own behaviour is covered by base-exercise-videos.test.ts, and what
// counts as a *valid* upload is covered once, in exercise-videos.unit.test.ts —
// this ticket's Q3 and Q4 reuse `validateExerciseVideoPair()` unchanged, so
// both routers call the one implementation and the rules are not asserted twice.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PLATFORM_EXERCISE_VIDEOS_PREFIX,
  baseExerciseVideoFolderKeys,
  buildBaseExerciseVideoKey,
  buildBaseExerciseVideoPosterKey,
  isPlatformOwnedExerciseVideoUrl,
} from '../domain/baseExerciseVideos';
import { isPlatformOwnedExerciseImageUrl } from '../domain/baseExerciseImages';
import { buildGymExerciseVideoKey } from '../domain/exerciseVideos';
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

describe('buildBaseExerciseVideoKey', () => {
  it('stores a base exercise under cordel/Exercises/Videos/<id>-<Name>.mp4 (§1)', () => {
    expect(buildBaseExerciseVideoKey(123, 'Barbell Back Squat'))
      .toBe('cordel/Exercises/Videos/123-Barbell-Back-Squat.mp4');
    expect(buildBaseExerciseVideoKey(456, 'Bench Press'))
      .toBe('cordel/Exercises/Videos/456-Bench-Press.mp4');
    expect(buildBaseExerciseVideoKey(789, 'Lat Pulldown'))
      .toBe('cordel/Exercises/Videos/789-Lat-Pulldown.mp4');
  });

  it('names the poster with -thumbnail before the extension, and as a PNG (Q4)', () => {
    expect(buildBaseExerciseVideoPosterKey(456, 'Bench Press'))
      .toBe('cordel/Exercises/Videos/456-Bench-Press-thumbnail.png');
  });

  it('hangs off the platform root, never a gym prefix (§1)', () => {
    const key = buildBaseExerciseVideoKey(7, 'Lat Pulldown');
    expect(key.startsWith(`${PLATFORM_STORAGE_ROOT}/`)).toBe(true);
    expect(key).not.toContain('gyms/');
    expect(PLATFORM_EXERCISE_VIDEOS_PREFIX).toBe('cordel/Exercises/Videos');
  });

  it('sanitizes the name deterministically, exactly as the image keys do', () => {
    expect(buildBaseExerciseVideoKey(9, 'Cable Row, Seated'))
      .toBe('cordel/Exercises/Videos/9-Cable-Row-Seated.mp4');
    expect(buildBaseExerciseVideoKey(10, 'Press  militar / máquina'))
      .toBe('cordel/Exercises/Videos/10-Press-militar-maquina.mp4');
  });

  it('keeps the id in both keys, so two names that sanitize alike never collide', () => {
    expect(buildBaseExerciseVideoKey(1, 'Row, Seated')).not.toBe(buildBaseExerciseVideoKey(2, 'Row Seated'));
    expect(buildBaseExerciseVideoPosterKey(1, 'Row, Seated')).toContain('/1-');
  });

  it('falls back to a name rather than producing "<id>-.mp4"', () => {
    expect(buildBaseExerciseVideoKey(4, '!!!')).toBe('cordel/Exercises/Videos/4-exercise.mp4');
  });

  it('is the same leaf a gym uses, under a different root (#719 §18)', () => {
    expect(buildGymExerciseVideoKey(GYM_PREFIX, 5, 'Squat'))
      .toBe(`${GYM_PREFIX}/Exercises/Videos/5-Squat.mp4`);
    expect(buildBaseExerciseVideoKey(5, 'Squat')).toBe('cordel/Exercises/Videos/5-Squat.mp4');
  });
});

describe('baseExerciseVideoFolderKeys', () => {
  it('lists every marker from the platform root down, outermost first', () => {
    expect(baseExerciseVideoFolderKeys()).toEqual([
      'cordel/',
      'cordel/Exercises/',
      'cordel/Exercises/Videos/',
    ]);
  });
});

describe('isPlatformOwnedExerciseVideoUrl', () => {
  it('accepts an object under cordel/Exercises/Videos/', () => {
    expect(isPlatformOwnedExerciseVideoUrl(url('cordel/Exercises/Videos/12-Squat.mp4'))).toBe(true);
    expect(isPlatformOwnedExerciseVideoUrl(url('cordel/Exercises/Videos/12-Squat-thumbnail.png'))).toBe(true);
  });

  it("refuses a gym's own object — a platform operation never deletes one", () => {
    expect(isPlatformOwnedExerciseVideoUrl(url(`${GYM_PREFIX}/Exercises/Videos/12-Squat.mp4`))).toBe(false);
  });

  it('refuses the image folder, and is refused by it — neither sweep owns the other', () => {
    expect(isPlatformOwnedExerciseVideoUrl(url('cordel/Exercises/Images/12-Squat.png'))).toBe(false);
    expect(isPlatformOwnedExerciseImageUrl(url('cordel/Exercises/Videos/12-Squat.mp4'))).toBe(false);
  });

  it("refuses another platform feature's object", () => {
    expect(isPlatformOwnedExerciseVideoUrl(url('cordel/Nutrition/12-Chicken.png'))).toBe(false);
    expect(isPlatformOwnedExerciseVideoUrl(url('cordel/Themes/3-Base/Members/training.png'))).toBe(false);
  });

  it('refuses a YouTube link, an external URL and an empty reference', () => {
    // The column holds an external link on some rows today (Q5); nothing there
    // is an object of ours, so nothing there is ever deleted.
    expect(isPlatformOwnedExerciseVideoUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(false);
    expect(isPlatformOwnedExerciseVideoUrl('https://example.com/squat.mp4')).toBe(false);
    expect(isPlatformOwnedExerciseVideoUrl(null)).toBe(false);
    expect(isPlatformOwnedExerciseVideoUrl(undefined)).toBe(false);
    expect(isPlatformOwnedExerciseVideoUrl('')).toBe(false);
  });

  it('refuses a URL from another bucket or endpoint', () => {
    expect(isPlatformOwnedExerciseVideoUrl(`${R2_ENDPOINT}/other-bucket/cordel/Exercises/Videos/12-Squat.mp4`)).toBe(false);
    expect(isPlatformOwnedExerciseVideoUrl(`https://elsewhere.example.com/${R2_BUCKET}/cordel/Exercises/Videos/12-Squat.mp4`)).toBe(false);
  });

  it('anchors the prefix, so a sibling folder cannot pass as this one', () => {
    expect(isPlatformOwnedExerciseVideoUrl(url('cordel/Exercises/VideosArchive/12-Squat.mp4'))).toBe(false);
  });
});
