// #1373 — an **Activity Type's image**: the key it is stored under, the folder
// markers, the ownership predicate and the upload rules. Pure, so no DB and no
// bucket (`domain/activityImages.ts` is the one place all four are decided).

import { beforeEach, describe, expect, it } from 'vitest';
import {
  ACTIVITIES_FOLDER,
  activityImageThumbnailUrl,
  buildActivityImageThumbnailKey,
  buildActivityImageKey,
  isGymOwnedActivityImageUrl,
  activityImageFolderKeys,
  sanitizeActivityImageName,
} from '../domain/activityImages';

const PREFIX = 'gyms/gym_abc-Fitness-Club';

describe('activity image key (#1373 §1)', () => {
  it('is <prefix>/activities/<activity_id>-<sanitized name>.webp', () => {
    expect(buildActivityImageKey(PREFIX, 42, 'Yoga Flow Avanzado'))
      .toBe(`${PREFIX}/activities/42-Yoga-Flow-Avanzado.webp`);
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
    expect(buildActivityImageKey(PREFIX, 9, '...')).toBe(`${PREFIX}/activities/9-activity.webp`);
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
    expect(isGymOwnedActivityImageUrl(url(`${PREFIX}/activities/1-a.webp`), null)).toBe(false);
    expect(isGymOwnedActivityImageUrl(`${PREFIX}/activities/1-a.png`, PREFIX)).toBe(false);
  });

  it("is true only under this gym's activities/ branch", () => {
    expect(isGymOwnedActivityImageUrl(url(`${PREFIX}/activities/1-Ana.webp`), PREFIX)).toBe(true);
    // Another gym whose prefix starts the same way.
    expect(isGymOwnedActivityImageUrl(url(`${PREFIX}Plus/activities/1-Ana.webp`), PREFIX)).toBe(false);
    // The gym's own object of another feature is not this one's to delete.
    expect(isGymOwnedActivityImageUrl(url(`${PREFIX}/goals/1-Weight.webp`), PREFIX)).toBe(false);
    // The platform's.
    expect(isGymOwnedActivityImageUrl(url('cordel/goals/1-Weight.png'), PREFIX)).toBe(false);
  });
});

describe('thumbnail (#1714)', () => {
  it('is <id>-<name>-thumbnail.webp beside the master', () => {
    expect(buildActivityImageThumbnailKey(PREFIX, 42, 'Yoga Flow'))
      .toBe(`${PREFIX}/activities/42-Yoga-Flow-thumbnail.webp`);
  });

  it('is derived from a WebP master URL, and absent for a legacy PNG', () => {
    expect(activityImageThumbnailUrl('https://cdn.example.com/g/activities/1-A.webp'))
      .toBe('https://cdn.example.com/g/activities/1-A-thumbnail.webp');
    expect(activityImageThumbnailUrl('https://cdn.example.com/g/activities/1-A.webp?v=3'))
      .toBe('https://cdn.example.com/g/activities/1-A-thumbnail.webp?v=3');
    expect(activityImageThumbnailUrl('https://cdn.example.com/g/activities/1-A.png')).toBeNull();
    expect(activityImageThumbnailUrl(null)).toBeNull();
  });
});
