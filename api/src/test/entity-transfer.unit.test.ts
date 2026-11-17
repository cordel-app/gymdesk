// #2952 stage 1: the pure rules of Cordel → Export / Import.

import { describe, expect, it } from 'vitest';
import {
  isTransferableObjectKey,
  isValidMuscleSlug,
  parseMuscleTransferRecord,
  parseTransferEntityType,
  transferImageRateLimitMax,
} from '../domain/entityTransfer';

describe('entity transfer rules', () => {
  it('accepts only the catalogue slug shape, never a normalised one', () => {
    expect(isValidMuscleSlug('middle_back')).toBe(true);
    expect(isValidMuscleSlug('Middle Back')).toBe(false);
    expect(isValidMuscleSlug('middle__back')).toBe(false);
    expect(isValidMuscleSlug('_x')).toBe(false);
    expect(isValidMuscleSlug('a'.repeat(61))).toBe(false);
  });

  it('judges a record: absent translations keep, present ones replace', () => {
    expect(parseMuscleTransferRecord({ slug: 'chest', name: ' Chest ' })).toEqual({ record: { slug: 'chest', name: 'Chest' } });
    expect(parseMuscleTransferRecord({ slug: 'chest', name: 'Chest', translations: {} }))
      .toEqual({ record: { slug: 'chest', name: 'Chest', translations: {} } });
    expect('error' in parseMuscleTransferRecord({ slug: 'chest', name: '' })).toBe(true);
    expect('error' in parseMuscleTransferRecord([])).toBe(true);
    expect('error' in parseMuscleTransferRecord({ slug: 'chest', name: 'C', translations: 'x' })).toBe(true);
  });

  it('reads back platform objects only, never a climbing or gym key', () => {
    expect(isTransferableObjectKey('cordel/muscles/images/chest-male.webp')).toBe(true);
    expect(isTransferableObjectKey('gyms/abc/members/1.webp')).toBe(false);
    expect(isTransferableObjectKey('cordel/../gyms/abc/x.webp')).toBe(false);
    expect(isTransferableObjectKey('cordel//x.webp')).toBe(false);
    expect(isTransferableObjectKey(null)).toBe(false);
  });

  it('knows its types and its upload budget', () => {
    expect(parseTransferEntityType('muscles')).toBe('muscles');
    expect(parseTransferEntityType('gyms')).toBeNull();
    expect(transferImageRateLimitMax({})).toBe(600);
    expect(transferImageRateLimitMax({ TRANSFER_IMAGE_RATE_LIMIT_MAX: '50' })).toBe(50);
    expect(transferImageRateLimitMax({ TRANSFER_IMAGE_RATE_LIMIT_MAX: 'x' })).toBe(600);
  });
});
