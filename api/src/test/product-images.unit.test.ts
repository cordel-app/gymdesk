// #1715 — where a Product's image goes and which objects a gym may delete.

import { describe, expect, it } from 'vitest';
import {
  buildProductImageKey,
  buildProductImageThumbnailKey,
  isGymOwnedProductImageUrl,
  productImageFolderKeys,
  pickImageVariant,
  sanitizeProductImageName,
} from '../domain/productImages';

const PREFIX = 'gyms/7-Fit Gym';

describe('product image keys', () => {
  it('builds <prefix>/products/<id>-<name>.webp and its -thumbnail sibling', () => {
    expect(buildProductImageKey(PREFIX, 12, 'Gold Product, 2026!')).toBe(`${PREFIX}/products/12-Gold-Product-2026.webp`);
    expect(buildProductImageThumbnailKey(PREFIX, 12, 'Gold Product, 2026!')).toBe(`${PREFIX}/products/12-Gold-Product-2026-thumbnail.webp`);
  });

  it('falls back to a word when the name has nothing usable, and caps long names', () => {
    expect(sanitizeProductImageName('!!!')).toBe('product');
    expect(sanitizeProductImageName('a'.repeat(300)).length).toBeLessThanOrEqual(80);
  });

  it('lists the markers from the gym root down to products/', () => {
    expect(productImageFolderKeys(PREFIX)).toEqual([`${PREFIX}/`, `${PREFIX}/products/`]);
  });
});

describe('isGymOwnedProductImageUrl', () => {
  const base = 'https://example.r2.cloudflarestorage.com/test-bucket';
  const saved = { ...process.env };
  process.env.CLOUDFLARE_R2_ENDPOINT = 'https://example.r2.cloudflarestorage.com';
  process.env.CLOUDFLARE_R2_BUCKET = 'test-bucket';

  it('is true only under this gym\'s products/ folder', () => {
    expect(isGymOwnedProductImageUrl(`${base}/${PREFIX}/products/1-x.webp`, PREFIX)).toBe(true);
    expect(isGymOwnedProductImageUrl(`${base}/${PREFIX}/members/1-x.webp`, PREFIX)).toBe(false);
    expect(isGymOwnedProductImageUrl(`${base}/gyms/8-Other/products/1-x.webp`, PREFIX)).toBe(false);
    expect(isGymOwnedProductImageUrl('https://elsewhere.test/products/1.webp', PREFIX)).toBe(false);
    expect(isGymOwnedProductImageUrl(null, PREFIX)).toBe(false);
    expect(isGymOwnedProductImageUrl(`${base}/${PREFIX}/products/1-x.webp`, null)).toBe(false);
    Object.assign(process.env, saved);
  });
});

describe('pickImageVariant', () => {
  it('keeps the deterministic key unless another product already points at it', () => {
    expect(pickImageVariant(false)).toBeUndefined();
    expect(pickImageVariant(true, 1700000000000)).toBe('1700000000000');
    expect(buildProductImageKey(PREFIX, 12, 'Locker', '1700000000000')).toBe(`${PREFIX}/products/12-Locker-1700000000000.webp`);
    expect(buildProductImageThumbnailKey(PREFIX, 12, 'Locker', '1700000000000')).toBe(`${PREFIX}/products/12-Locker-1700000000000-thumbnail.webp`);
  });
});
