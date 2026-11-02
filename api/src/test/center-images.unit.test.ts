// #2261 — where a Center's image lives and what a gym may delete.

import { describe, expect, it } from 'vitest';
import {
  buildCenterImageKey,
  buildCenterImageThumbnailKey,
  centerImageFolderKeys,
  isOwnedCenterImageUrl,
} from '../domain/centerImages';

describe('center image keys', () => {
  it('builds the master and thumbnail keys under centers/', () => {
    expect(buildCenterImageKey('gyms/g_1-Gym', 7, 'Main Center')).toBe('gyms/g_1-Gym/centers/7-Main-Center.webp');
    expect(buildCenterImageThumbnailKey('gyms/g_1-Gym', 7, 'Main Center')).toBe('gyms/g_1-Gym/centers/7-Main-Center-thumbnail.webp');
  });

  it('lists the folder markers outermost first', () => {
    expect(centerImageFolderKeys('gyms/g_1-Gym')).toEqual(['gyms/g_1-Gym/', 'gyms/g_1-Gym/centers/']);
  });
});

describe('isOwnedCenterImageUrl', () => {
  const base = 'https://example.r2.cloudflarestorage.com/test-bucket';
  it('accepts only an object under the gym prefix centers/', () => {
    process.env.CLOUDFLARE_R2_ENDPOINT = 'https://example.r2.cloudflarestorage.com';
    process.env.CLOUDFLARE_R2_BUCKET = 'test-bucket';
    expect(isOwnedCenterImageUrl(`${base}/gyms/g_1-Gym/centers/7-A.webp`, 'gyms/g_1-Gym')).toBe(true);
    expect(isOwnedCenterImageUrl(`${base}/gyms/g_2-Other/centers/7-A.webp`, 'gyms/g_1-Gym')).toBe(false);
    expect(isOwnedCenterImageUrl(`${base}/gyms/g_1-Gym/products/7-A.webp`, 'gyms/g_1-Gym')).toBe(false);
    expect(isOwnedCenterImageUrl('https://elsewhere.test/centers/7.webp', 'gyms/g_1-Gym')).toBe(false);
    expect(isOwnedCenterImageUrl(null, 'gyms/g_1-Gym')).toBe(false);
  });
});
