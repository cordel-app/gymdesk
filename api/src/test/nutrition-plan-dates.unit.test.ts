import { describe, it, expect } from 'vitest';
import { parseNutritionPlanDate, planEffectiveOnSql } from '../domain/nutritionPlanDates';

describe('parseNutritionPlanDate (#1957)', () => {
  it('treats an absent date as today and rejects malformed or impossible ones', () => {
    expect(parseNutritionPlanDate(undefined)).toBeUndefined();
    expect(parseNutritionPlanDate('2026-10-21')).toBe('2026-10-21');
    expect(parseNutritionPlanDate('21/10/2026')).toBeNull();
    expect(parseNutritionPlanDate('2026-02-30')).toBeNull();
  });
});

describe('planEffectiveOnSql (#1957)', () => {
  it('binds the date twice and keeps both bounds inclusive', () => {
    const sql = planEffectiveOnSql('p');
    expect(sql.match(/\?/g)).toHaveLength(2);
    expect(sql).toContain('p.start_date <= ?');
    expect(sql).toContain('p.end_date >= ?');
  });
});
