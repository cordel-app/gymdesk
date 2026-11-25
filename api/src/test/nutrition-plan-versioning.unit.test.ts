import { describe, expect, it } from 'vitest';
import { baseNutritionPlanName, nextDay, nutritionPlanEditMode, versionedNutritionPlanName } from '../domain/nutritionPlanVersioning';

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

describe('nutrition plan edit mode (#3405)', () => {
  const today = '2026-11-25';
  it('edits a Draft and an Active plan starting today or later in place', () => {
    expect(nutritionPlanEditMode({ status: 'draft', start_date: '2026-01-01' }, today)).toBe('in_place');
    expect(nutritionPlanEditMode({ status: 'active', start_date: '2026-11-25' }, today)).toBe('in_place');
    expect(nutritionPlanEditMode({ status: 'active', start_date: '2026-12-01' }, today)).toBe('in_place');
  });
  it('versions an Active plan effective before today, or with no start date', () => {
    expect(nutritionPlanEditMode({ status: 'active', start_date: '2026-11-24' }, today)).toBe('versioned');
    expect(nutritionPlanEditMode({ status: 'active', start_date: new Date('2026-11-01T00:00:00Z') }, today)).toBe('versioned');
    expect(nutritionPlanEditMode({ status: 'active', start_date: null }, today)).toBe('versioned');
  });
  it('never edits a completed or deleted plan', () => {
    expect(nutritionPlanEditMode({ status: 'completed', start_date: '2026-12-01' }, today)).toBe('read_only');
    expect(nutritionPlanEditMode({ status: 'deleted', start_date: null }, today)).toBe('read_only');
  });
});
