// #2260 — where a Space's image lives and what a gym may delete.

import { describe, expect, it } from 'vitest';
import {
  buildSpaceImageKey,
  buildSpaceImageThumbnailKey,
  spaceImageFolderKeys,
  isOwnedSpaceImageUrl,
} from '../domain/spaceImages';

describe('space image keys', () => {
  it('builds the master and thumbnail keys under spaces/', () => {
    expect(buildSpaceImageKey('gyms/g_1-Gym', 7, 'Main Space')).toBe('gyms/g_1-Gym/spaces/7-Main-Space.webp');
    expect(buildSpaceImageThumbnailKey('gyms/g_1-Gym', 7, 'Main Space')).toBe('gyms/g_1-Gym/spaces/7-Main-Space-thumbnail.webp');
  });

  it('lists the folder markers outermost first', () => {
    expect(spaceImageFolderKeys('gyms/g_1-Gym')).toEqual(['gyms/g_1-Gym/', 'gyms/g_1-Gym/spaces/']);
  });
});

describe('isOwnedSpaceImageUrl', () => {
  const base = 'https://example.r2.cloudflarestorage.com/test-bucket';
  it('accepts only an object under the gym prefix spaces/', () => {
    process.env.CLOUDFLARE_R2_ENDPOINT = 'https://example.r2.cloudflarestorage.com';
    process.env.CLOUDFLARE_R2_BUCKET = 'test-bucket';
    expect(isOwnedSpaceImageUrl(`${base}/gyms/g_1-Gym/spaces/7-A.webp`, 'gyms/g_1-Gym')).toBe(true);
    expect(isOwnedSpaceImageUrl(`${base}/gyms/g_2-Other/spaces/7-A.webp`, 'gyms/g_1-Gym')).toBe(false);
    expect(isOwnedSpaceImageUrl(`${base}/gyms/g_1-Gym/products/7-A.webp`, 'gyms/g_1-Gym')).toBe(false);
    expect(isOwnedSpaceImageUrl('https://elsewhere.test/spaces/7.webp', 'gyms/g_1-Gym')).toBe(false);
    expect(isOwnedSpaceImageUrl(null, 'gyms/g_1-Gym')).toBe(false);
  });
});
