// #2009 stage 3 — where a Base Product's image lives and what may be deleted.

import { describe, expect, it } from 'vitest';
import {
  baseProductImageFolderKeys,
  buildBaseProductImageKey,
  buildBaseProductImageThumbnailKey,
  isBaseProductImageUrl,
} from '../domain/baseProductImages';

describe('base product image keys', () => {
  it('builds the master and thumbnail keys under cordel/base_products/', () => {
    expect(buildBaseProductImageKey(7, 'Locker Rental')).toBe('cordel/base_products/7-Locker-Rental.webp');
    expect(buildBaseProductImageThumbnailKey(7, 'Locker Rental')).toBe('cordel/base_products/7-Locker-Rental-thumbnail.webp');
  });

  it('takes a variant before the extension', () => {
    expect(buildBaseProductImageKey(7, 'Towel', '123')).toBe('cordel/base_products/7-Towel-123.webp');
    expect(buildBaseProductImageThumbnailKey(7, 'Towel', '123')).toBe('cordel/base_products/7-Towel-123-thumbnail.webp');
  });

  it('lists the folder markers outermost first', () => {
    expect(baseProductImageFolderKeys()).toEqual(['cordel/', 'cordel/base_products/']);
  });
});

describe('isBaseProductImageUrl', () => {
  it('is true only for an object under cordel/base_products/', () => {
    process.env.CLOUDFLARE_R2_ENDPOINT = 'https://example.r2.cloudflarestorage.com';
    process.env.CLOUDFLARE_R2_BUCKET = 'test-bucket';
    const endpoint = 'https://example.r2.cloudflarestorage.com/test-bucket';
    expect(isBaseProductImageUrl(`${endpoint}/cordel/base_products/1-a.webp`)).toBe(true);
    expect(isBaseProductImageUrl(`${endpoint}/gyms/g_1/products/1-a.webp`)).toBe(false);
    expect(isBaseProductImageUrl(`${endpoint}/cordel/themes/1-a/logo/logo.png`)).toBe(false);
    expect(isBaseProductImageUrl('https://elsewhere.test/x.webp')).toBe(false);
    expect(isBaseProductImageUrl(null)).toBe(false);
  });
});
