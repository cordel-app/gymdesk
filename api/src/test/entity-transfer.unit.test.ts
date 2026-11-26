// #2952 stage 1: the pure rules of Cordel → Export / Import.

import { describe, expect, it } from 'vitest';
import {
  PAYMENT_PROVIDER_TRANSFER_FIELDS,
  isTransferableObjectKey,
  isValidEntitySlug,
  isValidGoalSlug,
  parseSlugTransferRecord,
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
    expect(parseTransferEntityType('gyms')).toBe('gyms');
    expect(parseTransferEntityType('base_meals')).toBe('base_meals');
    expect(parseTransferEntityType('members')).toBeNull();
    expect(parseTransferEntityType(undefined)).toBeNull();
    expect(transferImageRateLimitMax({})).toBe(600);
    expect(transferImageRateLimitMax({ TRANSFER_IMAGE_RATE_LIMIT_MAX: '50' })).toBe(50);
    expect(transferImageRateLimitMax({ TRANSFER_IMAGE_RATE_LIMIT_MAX: 'x' })).toBe(600);
  });

  it('accepts only #2951\'s hyphen slug shape for the entities beyond Muscles (#2952 stage 2)', () => {
    expect(isValidEntitySlug('monei')).toBe(true);
    expect(isValidEntitySlug('personal-training-1-1')).toBe(true);
    expect(isValidEntitySlug('Monei')).toBe(false);
    expect(isValidEntitySlug('-monei')).toBe(false);
    expect(isValidEntitySlug('a--b')).toBe(false);
    expect(isValidEntitySlug('x'.repeat(121))).toBe(false);
  });

  it('accepts a seeded goal\'s snake_case slug beside the hyphen shape for goals only (#2952 stage 4)', () => {
    expect(isValidGoalSlug('weight_loss')).toBe(true);
    expect(isValidGoalSlug('my-goal-2')).toBe(true);
    expect(isValidGoalSlug('Weight_Loss')).toBe(false);
    expect(isValidGoalSlug('a__b')).toBe(false);
    expect(isValidGoalSlug('_a')).toBe(false);
    expect('error' in parseSlugTransferRecord({ slug: 'weight_loss', name: 'W' }, ['name'])).toBe(true);
    const parsed = parseSlugTransferRecord({ slug: 'weight_loss', name: 'W' }, ['name'], { goalSlug: true });
    expect(parsed).toEqual({ record: { slug: 'weight_loss', input: { name: 'W' } } });
  });

  it('keeps only the listed fields of an imported record, so no flag or id reaches a writer', () => {
    const parsed = parseSlugTransferRecord(
      { slug: 'monei', name: 'Monei', provider_key: 'monei', is_default: true, id: 7 },
      PAYMENT_PROVIDER_TRANSFER_FIELDS,
    );
    expect(parsed).toEqual({ record: { slug: 'monei', input: { name: 'Monei', provider_key: 'monei' } } });
    expect(parseSlugTransferRecord({ slug: 'Bad' }, PAYMENT_PROVIDER_TRANSFER_FIELDS)).toHaveProperty('error');
    expect(parseSlugTransferRecord([], PAYMENT_PROVIDER_TRANSFER_FIELDS)).toHaveProperty('error');
  });
});
