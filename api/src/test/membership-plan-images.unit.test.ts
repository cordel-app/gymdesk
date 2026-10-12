// #1514 — where a Membership Plan's image goes and which objects a gym may delete.

import { describe, expect, it } from 'vitest';
import {
  buildPlanImageKey,
  buildPlanImageThumbnailKey,
  isGymOwnedPlanImageUrl,
  planImageFolderKeys,
  sanitizePlanImageName,
} from '../domain/planImages';

const PREFIX = 'gyms/7-Fit Gym';

describe('plan image keys', () => {
  it('builds <prefix>/plans/<id>-<name>.webp and its -thumbnail sibling', () => {
    expect(buildPlanImageKey(PREFIX, 12, 'Gold Plan, 2026!')).toBe(`${PREFIX}/plans/12-Gold-Plan-2026.webp`);
    expect(buildPlanImageThumbnailKey(PREFIX, 12, 'Gold Plan, 2026!')).toBe(`${PREFIX}/plans/12-Gold-Plan-2026-thumbnail.webp`);
  });

  it('falls back to a word when the name has nothing usable, and caps long names', () => {
    expect(sanitizePlanImageName('!!!')).toBe('plan');
    expect(sanitizePlanImageName('a'.repeat(300)).length).toBeLessThanOrEqual(80);
  });

  it('lists the markers from the gym root down to plans/', () => {
    expect(planImageFolderKeys(PREFIX)).toEqual([`${PREFIX}/`, `${PREFIX}/plans/`]);
  });
});

describe('isGymOwnedPlanImageUrl', () => {
  const base = 'https://example.r2.cloudflarestorage.com/test-bucket';
  const saved = { ...process.env };
  process.env.CLOUDFLARE_R2_ENDPOINT = 'https://example.r2.cloudflarestorage.com';
  process.env.CLOUDFLARE_R2_BUCKET = 'test-bucket';

  it('is true only under this gym\'s plans/ folder', () => {
    expect(isGymOwnedPlanImageUrl(`${base}/${PREFIX}/plans/1-x.webp`, PREFIX)).toBe(true);
    expect(isGymOwnedPlanImageUrl(`${base}/${PREFIX}/members/1-x.webp`, PREFIX)).toBe(false);
    expect(isGymOwnedPlanImageUrl(`${base}/gyms/8-Other/plans/1-x.webp`, PREFIX)).toBe(false);
    expect(isGymOwnedPlanImageUrl('https://elsewhere.test/plans/1.webp', PREFIX)).toBe(false);
    expect(isGymOwnedPlanImageUrl(null, PREFIX)).toBe(false);
    expect(isGymOwnedPlanImageUrl(`${base}/${PREFIX}/plans/1-x.webp`, null)).toBe(false);
    Object.assign(process.env, saved);
  });
});
