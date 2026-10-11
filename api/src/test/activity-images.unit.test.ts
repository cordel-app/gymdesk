// #1373 — an **Activity Type's image**: the key it is stored under, the folder
// markers, the ownership predicate and the upload rules. Pure, so no DB and no
// bucket (`domain/activityImages.ts` is the one place all four are decided).

import { beforeEach, describe, expect, it } from 'vitest';
import { encodePngRgba } from '../domain/pngImage';
import {
  ACTIVITIES_FOLDER,
  ACTIVITY_IMAGE_SIZE,
  buildActivityImageKey,
  isGymOwnedActivityImageUrl,
  activityImageFolderKeys,
  sanitizeActivityImageName,
  validateActivityImage,
} from '../domain/activityImages';

const PREFIX = 'gyms/gym_abc-Fitness-Club';

describe('activity image key (#1373 §1)', () => {
  it('is <prefix>/activities/<activity_id>-<sanitized name>.png', () => {
    expect(buildActivityImageKey(PREFIX, 42, 'Yoga Flow Avanzado'))
      .toBe(`${PREFIX}/activities/42-Yoga-Flow-Avanzado.png`);
  });

  it('spells the folder as the storage constant, lowercase', () => {
    expect(ACTIVITIES_FOLDER).toBe('activities');
    expect(buildActivityImageKey(PREFIX, 1, 'x')).toContain(`/${ACTIVITIES_FOLDER}/`);
  });

  it('is deterministic: the same activity builds the same key', () => {
    expect(buildActivityImageKey(PREFIX, 7, 'Spin Express')).toBe(buildActivityImageKey(PREFIX, 7, 'Spin Express'));
  });

  it('never takes the uploaded file name: punctuation-only names fall back to "activity"', () => {
    expect(sanitizeActivityImageName('!!!')).toBe('activity');
    expect(buildActivityImageKey(PREFIX, 9, '...')).toBe(`${PREFIX}/activities/9-activity.png`);
  });

  it('caps the name part so the URL fits VARCHAR(1024), without a trailing hyphen', () => {
    const long = Array.from({ length: 40 }, (_, i) => `Name${i}`).join(' ');
    const sanitized = sanitizeActivityImageName(long);
    expect(sanitized.length).toBeLessThanOrEqual(80);
    expect(sanitized.endsWith('-')).toBe(false);
  });

  it('lists the folder markers outermost first', () => {
    expect(activityImageFolderKeys(PREFIX)).toEqual([`${PREFIX}/`, `${PREFIX}/activities/`]);
  });
});

describe('ownership (#719 §19, one feature over)', () => {
  beforeEach(() => {
    process.env.CLOUDFLARE_R2_PUBLIC_URL = 'https://cdn.example.com';
  });

  const url = (key: string) => `https://cdn.example.com/${key}`;

  it('answers false for nothing, for a URL that is not ours and for a bare key', () => {
    expect(isGymOwnedActivityImageUrl(null, PREFIX)).toBe(false);
    expect(isGymOwnedActivityImageUrl('https://example.org/photo.png', PREFIX)).toBe(false);
    expect(isGymOwnedActivityImageUrl(url(`${PREFIX}/activities/1-a.png`), null)).toBe(false);
    expect(isGymOwnedActivityImageUrl(`${PREFIX}/activities/1-a.png`, PREFIX)).toBe(false);
  });

  it("is true only under this gym's activities/ branch", () => {
    expect(isGymOwnedActivityImageUrl(url(`${PREFIX}/activities/1-Ana.png`), PREFIX)).toBe(true);
    // Another gym whose prefix starts the same way.
    expect(isGymOwnedActivityImageUrl(url(`${PREFIX}Plus/activities/1-Ana.png`), PREFIX)).toBe(false);
    // The gym's own object of another feature is not this one's to delete.
    expect(isGymOwnedActivityImageUrl(url(`${PREFIX}/goals/1-Weight.png`), PREFIX)).toBe(false);
    // The platform's.
    expect(isGymOwnedActivityImageUrl(url('cordel/goals/1-Weight.png'), PREFIX)).toBe(false);
  });
});

describe('upload rules (#1373 §3)', () => {
  function png(width: number, height = width, colorType = 6): Buffer {
    const buf = Buffer.from(encodePngRgba(1, 1, Buffer.alloc(4, 0x40)));
    buf.writeUInt32BE(width, 16);
    buf.writeUInt32BE(height, 20);
    buf[25] = colorType;
    return buf;
  }

  it('accepts exactly 1080×1080, with or without an alpha channel', () => {
    expect(validateActivityImage(encodePngRgba(ACTIVITY_IMAGE_SIZE, ACTIVITY_IMAGE_SIZE, Buffer.alloc(ACTIVITY_IMAGE_SIZE * ACTIVITY_IMAGE_SIZE * 4)))).toBeNull();
    expect(validateActivityImage(png(1080, 1080, 2))).toBeNull();
  });

  it('refuses any other size — smaller, larger or non-square', () => {
    expect(validateActivityImage(png(511, 1080))).toBe('wrong_dimensions');
    expect(validateActivityImage(png(513))).toBe('wrong_dimensions');
    expect(validateActivityImage(png(256))).toBe('wrong_dimensions');
    expect(validateActivityImage(png(1080, 768))).toBe('wrong_dimensions');
  });

  it('refuses anything that is not a PNG, from the bytes', () => {
    expect(validateActivityImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]))).toBe('not_a_png');
    expect(validateActivityImage('not bytes')).toBe('not_a_png');
    expect(validateActivityImage(Buffer.alloc(0))).toBe('not_a_png');
  });
});
