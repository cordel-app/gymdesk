// The pure pieces of exercise media storage every feature shares: how an exercise
// name appears in an object key, and which objects a gym may delete (#719 §19).
// The legacy 2048 PNG pair's keys and upload rules were removed in #1420; the
// gender-specific media's are covered by exercise-gender-media.unit.test.ts.
//
// A unit test file (CLAUDE.md): no database, no HTTP, no `createTestGym`.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isGymOwnedImageUrl, sanitizeExerciseImageName } from '../domain/exerciseImages';

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

describe('isGymOwnedImageUrl (#719 §19)', () => {
  it('owns an object under this gym’s own prefix', () => {
    expect(isGymOwnedImageUrl(url(`${GYM_PREFIX}/exercises/images/42-Barbell-Press.png`), GYM_PREFIX)).toBe(true);
  });

  it('owns the legacy <uuid>.png shape the #417 upload route writes', () => {
    expect(isGymOwnedImageUrl(url(`${GYM_PREFIX}/exercises/images/6f1b-uuid.png`), GYM_PREFIX)).toBe(true);
  });

  it('never owns a System object, so a gym operation cannot delete one', () => {
    expect(isGymOwnedImageUrl(url('cordel/exercises/images/123-Barbell-Press.png'), GYM_PREFIX)).toBe(false);
  });

  it('never owns another gym’s object, even one whose prefix starts the same way', () => {
    expect(isGymOwnedImageUrl(url('gyms/99999999-0000-0000-0000-000000000000-Other/exercises/images/1.png'), GYM_PREFIX)).toBe(false);
    expect(isGymOwnedImageUrl(url(`${GYM_PREFIX}Plus/exercises/images/1.png`), GYM_PREFIX)).toBe(false);
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
