// #2262 — where a Staff's image lives and what a gym may delete.

import { describe, expect, it } from 'vitest';
import {
  buildStaffImageKey,
  buildStaffImageThumbnailKey,
  staffImageFolderKeys,
  isOwnedStaffImageUrl,
} from '../domain/staffImages';

describe('staff image keys', () => {
  it('builds the master and thumbnail keys under staff/', () => {
    expect(buildStaffImageKey('gyms/g_1-Gym', 7, 'Ana López')).toBe('gyms/g_1-Gym/staff/7-Ana-Lopez.webp');
    expect(buildStaffImageThumbnailKey('gyms/g_1-Gym', 7, 'Ana López')).toBe('gyms/g_1-Gym/staff/7-Ana-Lopez-thumbnail.webp');
  });

  it('lists the folder markers outermost first', () => {
    expect(staffImageFolderKeys('gyms/g_1-Gym')).toEqual(['gyms/g_1-Gym/', 'gyms/g_1-Gym/staff/']);
  });
});

describe('isOwnedStaffImageUrl', () => {
  const base = 'https://example.r2.cloudflarestorage.com/test-bucket';
  it('accepts only an object under the gym prefix staff/', () => {
    process.env.CLOUDFLARE_R2_ENDPOINT = 'https://example.r2.cloudflarestorage.com';
    process.env.CLOUDFLARE_R2_BUCKET = 'test-bucket';
    expect(isOwnedStaffImageUrl(`${base}/gyms/g_1-Gym/staff/7-A.webp`, 'gyms/g_1-Gym')).toBe(true);
    expect(isOwnedStaffImageUrl(`${base}/gyms/g_2-Other/staff/7-A.webp`, 'gyms/g_1-Gym')).toBe(false);
    expect(isOwnedStaffImageUrl(`${base}/gyms/g_1-Gym/products/7-A.webp`, 'gyms/g_1-Gym')).toBe(false);
    expect(isOwnedStaffImageUrl('https://elsewhere.test/staff/7.webp', 'gyms/g_1-Gym')).toBe(false);
    expect(isOwnedStaffImageUrl(null, 'gyms/g_1-Gym')).toBe(false);
  });
});

describe('staffImageName', () => {
  it('uses the full name', async () => {
    const { staffImageName } = await import('../domain/staffImages');
    expect(staffImageName({ first_name: 'Ana', last_name: 'López' })).toBe('Ana López');
  });
});
