// #1035 stage 2 — everything about a Personal Goal's image that needs no
// database and no bucket: the two object keys, the name sanitizer, the folder
// markers, the two ownership predicates and the upload rules.
//
// Unit tests per CLAUDE.md: pure functions only, so no `createTestGym`, no
// `cleanupTestGyms` and no `db.end()`.

import { beforeEach, describe, expect, it } from 'vitest';
import { encodePngRgba, PNG_COLOR_TYPE } from '../domain/pngImage';
import {
  GOALS_FOLDER,
  PERSONAL_GOAL_IMAGE_MAX_BYTES,
  PERSONAL_GOAL_IMAGE_MAX_SIZE,
  PERSONAL_GOAL_IMAGE_MIME,
  PERSONAL_GOAL_IMAGE_REJECTION_MESSAGES,
  PLATFORM_GOALS_PREFIX,
  basePersonalGoalImageFolderKeys,
  buildBasePersonalGoalImageKey,
  buildGymPersonalGoalImageKey,
  gymPersonalGoalImageFolderKeys,
  isGymOwnedPersonalGoalImageUrl,
  isPlatformOwnedPersonalGoalImageUrl,
  sanitizePersonalGoalImageName,
  validatePersonalGoalImage,
} from '../domain/personalGoalImages';
import { GOALS_FOLDER as STORAGE_GOALS_FOLDER, PLATFORM_STORAGE_ROOT } from '../infra/storage';
import { IMAGE_GOAL_KINDS, goalKindHasImage } from '../domain/goalLibrary';

/** A transparent PNG of the given size — the shape a legitimate upload has. */
function png(width: number, height = width): Buffer {
  return encodePngRgba(width, height, Buffer.alloc(width * height * 4));
}

/**
 * A header-only PNG with an arbitrary IHDR. The validator reads the IHDR and
 * stops, so this stands in for "a 4000px photograph" without encoding one.
 */
function pngHeader(width: number, height: number, colorType = PNG_COLOR_TYPE.truecolor): Buffer {
  const copy = Buffer.from(png(1));
  copy.writeUInt32BE(width, 16);
  copy.writeUInt32BE(height, 20);
  copy[25] = colorType;
  return copy;
}

const GYM_PREFIX = 'gyms/gym_123-FitClub';

describe('personal goal image keys', () => {
  it('spells the folder exactly as infra/storage does', () => {
    // The marker Gym Bucket Initialization writes and the key an upload lands
    // under have to be the same string: in R2 a case difference is a different
    // key, so a second spelling would add a folder beside the one uploads
    // populate rather than rename it.
    expect(GOALS_FOLDER).toBe(STORAGE_GOALS_FOLDER);
    expect(GOALS_FOLDER).toBe('goals');
  });

  it("builds a gym goal's key under the gym's own prefix", () => {
    expect(buildGymPersonalGoalImageKey(GYM_PREFIX, 7, 'Weight Loss'))
      .toBe(`${GYM_PREFIX}/goals/7-Weight-Loss.png`);
  });

  it("builds a System goal's key under the platform root", () => {
    expect(buildBasePersonalGoalImageKey(7, 'Weight Loss'))
      .toBe('cordel/goals/7-Weight-Loss.png');
    expect(PLATFORM_GOALS_PREFIX).toBe(`${PLATFORM_STORAGE_ROOT}/goals`);
  });

  it('is deterministic, so replacing an image overwrites its own object', () => {
    const a = buildGymPersonalGoalImageKey(GYM_PREFIX, 7, 'Weight Loss');
    const b = buildGymPersonalGoalImageKey(GYM_PREFIX, 7, 'Weight Loss');
    expect(a).toBe(b);
  });

  it('keeps two goals whose names sanitize alike apart, by id', () => {
    const a = buildGymPersonalGoalImageKey(GYM_PREFIX, 7, 'Weight Loss');
    const b = buildGymPersonalGoalImageKey(GYM_PREFIX, 8, 'Weight, Loss');
    expect(a).not.toBe(b);
    expect(a.endsWith('7-Weight-Loss.png')).toBe(true);
    expect(b.endsWith('8-Weight-Loss.png')).toBe(true);
  });

  it('takes the name from the row, never from an uploaded file name', () => {
    // Everything that would have to be escaped in a URL becomes a separator,
    // accents are folded, and a name of nothing but punctuation falls back.
    expect(sanitizePersonalGoalImageName('Pérdida de peso')).toBe('Perdida-de-peso');
    expect(sanitizePersonalGoalImageName('Ganancia / Muscular')).toBe('Ganancia-Muscular');
    expect(sanitizePersonalGoalImageName('   ')).toBe('goal');
    expect(sanitizePersonalGoalImageName('%%%')).toBe('goal');
  });

  it('caps the name part so the URL cannot outgrow its column', () => {
    const key = buildGymPersonalGoalImageKey(GYM_PREFIX, 7, 'A'.repeat(400));
    const namePart = key.slice(key.lastIndexOf('/') + 1).replace(/^7-/, '').replace(/\.png$/, '');
    expect(namePart.length).toBe(80);
    // Never a trailing separator left behind by the cut.
    expect(key.endsWith('-.png')).toBe(false);
  });

  it('writes the markers between the bucket root and each goals folder', () => {
    expect(gymPersonalGoalImageFolderKeys(GYM_PREFIX)).toEqual([
      `${GYM_PREFIX}/`,
      `${GYM_PREFIX}/goals/`,
    ]);
    expect(basePersonalGoalImageFolderKeys()).toEqual(['cordel/', 'cordel/goals/']);
  });
});

describe('personal goal image ownership', () => {
  beforeEach(() => {
    process.env.CLOUDFLARE_R2_PUBLIC_URL = 'https://cdn.example.com';
  });

  const url = (key: string) => `https://cdn.example.com/${key}`;

  it("lets a gym delete its own object and nothing else", () => {
    expect(isGymOwnedPersonalGoalImageUrl(url(`${GYM_PREFIX}/goals/7-Weight-Loss.png`), GYM_PREFIX)).toBe(true);
    // The platform's object: a gym operation must never delete it.
    expect(isGymOwnedPersonalGoalImageUrl(url('cordel/goals/7-Weight-Loss.png'), GYM_PREFIX)).toBe(false);
    // Another gym's, including one whose prefix is a string prefix of this one.
    expect(isGymOwnedPersonalGoalImageUrl(url('gyms/gym_999-Other/goals/1-X.png'), GYM_PREFIX)).toBe(false);
    expect(isGymOwnedPersonalGoalImageUrl(url('gyms/gym_123-FitClubPlus/goals/1-X.png'), GYM_PREFIX)).toBe(false);
    // An external URL: there is no object of ours behind it.
    expect(isGymOwnedPersonalGoalImageUrl('https://example.org/x.png', GYM_PREFIX)).toBe(false);
    // A gym with no bucket owns nothing, which is the safe direction.
    expect(isGymOwnedPersonalGoalImageUrl(url(`${GYM_PREFIX}/goals/7-X.png`), null)).toBe(false);
    expect(isGymOwnedPersonalGoalImageUrl(null, GYM_PREFIX)).toBe(false);
  });

  it('lets the platform delete only its own goals objects', () => {
    expect(isPlatformOwnedPersonalGoalImageUrl(url('cordel/goals/7-Weight-Loss.png'))).toBe(true);
    // A gym's object is not the platform's to delete.
    expect(isPlatformOwnedPersonalGoalImageUrl(url(`${GYM_PREFIX}/goals/7-X.png`))).toBe(false);
    // Another platform feature's object is not this one's either.
    expect(isPlatformOwnedPersonalGoalImageUrl(url('cordel/nutrition/7-Salmon.png'))).toBe(false);
    expect(isPlatformOwnedPersonalGoalImageUrl(url('cordel/themes/3-Dark/logo/logo.png'))).toBe(false);
    expect(isPlatformOwnedPersonalGoalImageUrl('https://example.org/x.png')).toBe(false);
    expect(isPlatformOwnedPersonalGoalImageUrl(null)).toBe(false);
  });
});

describe('personal goal image upload rules', () => {
  it('accepts a PNG at the ceiling', () => {
    expect(validatePersonalGoalImage(png(PERSONAL_GOAL_IMAGE_MAX_SIZE))).toBeNull();
  });

  it('accepts a smaller and a non-square PNG — the ceiling is a maximum, not an exact size', () => {
    // #1035 `Q3`: "a maximum of 512×512 px". Deliberately not the exact square a
    // Base Nutrition Library food is held to (#715 §2).
    expect(validatePersonalGoalImage(png(64))).toBeNull();
    expect(validatePersonalGoalImage(pngHeader(400, 300))).toBeNull();
  });

  it('accepts an opaque PNG — there is no transparency requirement', () => {
    // `Q3`: "no need to alpha". A truecolour PNG with no alpha channel and no
    // `tRNS` chunk is what a Base Nutrition food's validator refuses.
    expect(validatePersonalGoalImage(pngHeader(512, 512, PNG_COLOR_TYPE.truecolor))).toBeNull();
  });

  it('refuses anything that is not a readable PNG', () => {
    expect(validatePersonalGoalImage(Buffer.from('not a png at all'))).toBe('not_a_png');
    expect(validatePersonalGoalImage(Buffer.alloc(0))).toBe('not_a_png');
    // A string and an array both carry a `length` and numeric indices, so they
    // must be refused rather than read as bytes (CodeQL
    // `js/type-confusion-through-parameter-tampering`).
    expect(validatePersonalGoalImage('\x89PNG\r\n\x1a\n')).toBe('not_a_png');
    expect(validatePersonalGoalImage([0x89, 0x50, 0x4e, 0x47])).toBe('not_a_png');
    expect(validatePersonalGoalImage(undefined)).toBe('not_a_png');
  });

  it('refuses a PNG over the ceiling in either dimension', () => {
    expect(validatePersonalGoalImage(pngHeader(513, 512))).toBe('too_large_dimensions');
    expect(validatePersonalGoalImage(pngHeader(512, 513))).toBe('too_large_dimensions');
    expect(validatePersonalGoalImage(pngHeader(2048, 2048))).toBe('too_large_dimensions');
  });

  it('has a message for every rejection', () => {
    for (const reason of ['not_a_png', 'too_large_dimensions'] as const) {
      expect(PERSONAL_GOAL_IMAGE_REJECTION_MESSAGES[reason]).toBeTruthy();
    }
    expect(PERSONAL_GOAL_IMAGE_REJECTION_MESSAGES.too_large_dimensions).toContain('512');
  });

  it('fixes the MIME type and the byte ceiling', () => {
    expect(PERSONAL_GOAL_IMAGE_MIME).toBe('image/png');
    expect(PERSONAL_GOAL_IMAGE_MAX_BYTES).toBe(2 * 1024 * 1024);
  });
});

describe('which goal kinds have an image', () => {
  it('is Personal Goals alone', () => {
    // `nutrition_goals` has no `image_url` column, so a router that projected
    // one would answer ER_BAD_FIELD_ERROR — a bare 500 through the global
    // handler (#966). The declaration is what stops that.
    expect([...IMAGE_GOAL_KINDS]).toEqual(['personal']);
    expect(goalKindHasImage('personal')).toBe(true);
    expect(goalKindHasImage('nutrition')).toBe(false);
  });
});
