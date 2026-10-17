// #1711 — where a Promotion's image goes and which objects a gym may delete.

import { describe, expect, it } from 'vitest';
import {
  buildPromotionImageKey,
  buildPromotionImageThumbnailKey,
  isGymOwnedPromotionImageUrl,
  promotionImageFolderKeys,
  sanitizePromotionImageName,
} from '../domain/promotionImages';

const PREFIX = 'gyms/7-Fit Gym';

describe('promotion image keys', () => {
  it('builds <prefix>/promotions/<id>-<name>.webp and its -thumbnail sibling', () => {
    expect(buildPromotionImageKey(PREFIX, 12, 'Gold Promotion, 2026!')).toBe(`${PREFIX}/promotions/12-Gold-Promotion-2026.webp`);
    expect(buildPromotionImageThumbnailKey(PREFIX, 12, 'Gold Promotion, 2026!')).toBe(`${PREFIX}/promotions/12-Gold-Promotion-2026-thumbnail.webp`);
  });

  it('falls back to a word when the name has nothing usable, and caps long names', () => {
    expect(sanitizePromotionImageName('!!!')).toBe('promotion');
    expect(sanitizePromotionImageName('a'.repeat(300)).length).toBeLessThanOrEqual(80);
  });

  it('lists the markers from the gym root down to promotions/', () => {
    expect(promotionImageFolderKeys(PREFIX)).toEqual([`${PREFIX}/`, `${PREFIX}/promotions/`]);
  });
});

describe('isGymOwnedPromotionImageUrl', () => {
  const base = 'https://example.r2.cloudflarestorage.com/test-bucket';
  const saved = { ...process.env };
  process.env.CLOUDFLARE_R2_ENDPOINT = 'https://example.r2.cloudflarestorage.com';
  process.env.CLOUDFLARE_R2_BUCKET = 'test-bucket';

  it('is true only under this gym\'s promotions/ folder', () => {
    expect(isGymOwnedPromotionImageUrl(`${base}/${PREFIX}/promotions/1-x.webp`, PREFIX)).toBe(true);
    expect(isGymOwnedPromotionImageUrl(`${base}/${PREFIX}/members/1-x.webp`, PREFIX)).toBe(false);
    expect(isGymOwnedPromotionImageUrl(`${base}/gyms/8-Other/promotions/1-x.webp`, PREFIX)).toBe(false);
    expect(isGymOwnedPromotionImageUrl('https://elsewhere.test/promotions/1.webp', PREFIX)).toBe(false);
    expect(isGymOwnedPromotionImageUrl(null, PREFIX)).toBe(false);
    expect(isGymOwnedPromotionImageUrl(`${base}/${PREFIX}/promotions/1-x.webp`, null)).toBe(false);
    Object.assign(process.env, saved);
  });
});
