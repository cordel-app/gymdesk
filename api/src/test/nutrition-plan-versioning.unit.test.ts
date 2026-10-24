import { describe, expect, it } from 'vitest';
import { baseNutritionPlanName, nextDay, versionedNutritionPlanName } from '../domain/nutritionPlanVersioning';

describe('nutrition plan versioning (#1970)', () => {
  it('names versions and never accumulates suffixes', () => {
    const v1 = versionedNutritionPlanName('Cut', '2026-10-01', '2026-10-22');
    expect(v1).toBe('Cut [2026-10-01 - 2026-10-22]');
    expect(versionedNutritionPlanName(v1, '2026-10-23', null)).toBe('Cut [2026-10-23 - Open End]');
    expect(baseNutritionPlanName('Cut [2026-10-23 - Open End]')).toBe('Cut');
    expect(baseNutritionPlanName('Cut')).toBe('Cut');
  });
  it('computes the next day across month and year ends', () => {
    expect(nextDay('2026-10-31')).toBe('2026-11-01');
    expect(nextDay('2026-12-31')).toBe('2027-01-01');
  });
});
