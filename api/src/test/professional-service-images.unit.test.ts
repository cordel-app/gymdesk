// #2010 stage 1 — where a Professional Service's image lives and what a gym may delete.

import { describe, expect, it } from 'vitest';
import {
  buildProfessionalServiceImageKey,
  buildProfessionalServiceImageThumbnailKey,
  isOwnedProfessionalServiceImageUrl,
  professionalServiceImageFolderKeys,
} from '../domain/professionalServiceImages';

describe('professional service image keys', () => {
  it('builds the master and thumbnail keys under professional_services/ for both roots', () => {
    expect(buildProfessionalServiceImageKey('gyms/g_1-Gym', 7, 'Personal Training'))
      .toBe('gyms/g_1-Gym/professional_services/7-Personal-Training.webp');
    expect(buildProfessionalServiceImageThumbnailKey('cordel', 7, 'Personal Training'))
      .toBe('cordel/professional_services/7-Personal-Training-thumbnail.webp');
  });

  it('takes a variant before the extension', () => {
    expect(buildProfessionalServiceImageKey('cordel', 7, 'Yoga', '123')).toBe('cordel/professional_services/7-Yoga-123.webp');
    expect(buildProfessionalServiceImageThumbnailKey('cordel', 7, 'Yoga', '123')).toBe('cordel/professional_services/7-Yoga-123-thumbnail.webp');
  });

  it('lists the folder markers outermost first', () => {
    expect(professionalServiceImageFolderKeys('cordel')).toEqual(['cordel/', 'cordel/professional_services/']);
  });
});

describe('isOwnedProfessionalServiceImageUrl', () => {
  const endpoint = 'https://example.r2.cloudflarestorage.com/test-bucket';
  it('is true only for an object under the prefix\'s own professional_services/', () => {
    process.env.CLOUDFLARE_R2_ENDPOINT = 'https://example.r2.cloudflarestorage.com';
    process.env.CLOUDFLARE_R2_BUCKET = 'test-bucket';
    expect(isOwnedProfessionalServiceImageUrl(`${endpoint}/gyms/g_1/professional_services/1-a.webp`, 'gyms/g_1')).toBe(true);
    expect(isOwnedProfessionalServiceImageUrl(`${endpoint}/cordel/professional_services/1-a.webp`, 'gyms/g_1')).toBe(false);
    expect(isOwnedProfessionalServiceImageUrl(`${endpoint}/gyms/g_2/professional_services/1-a.webp`, 'gyms/g_1')).toBe(false);
    expect(isOwnedProfessionalServiceImageUrl(`${endpoint}/gyms/g_1/products/1-a.webp`, 'gyms/g_1')).toBe(false);
    expect(isOwnedProfessionalServiceImageUrl('https://elsewhere.test/x.webp', 'gyms/g_1')).toBe(false);
    expect(isOwnedProfessionalServiceImageUrl(null, 'gyms/g_1')).toBe(false);
  });
});
