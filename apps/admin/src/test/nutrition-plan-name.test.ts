import { describe, expect, it } from 'vitest';
import { displayNutritionPlanName } from '@/lib/nutritionPlanName';

describe('displayNutritionPlanName (#2153)', () => {
  it('strips the version date suffix', () => {
    expect(displayNutritionPlanName('NPT2 [2026-10-28 - Open End]')).toBe('NPT2');
    expect(displayNutritionPlanName('NPT1 [2026-10-28 - 2026-11-02]')).toBe('NPT1');
  });
  it('leaves other names, including brackets elsewhere, untouched', () => {
    expect(displayNutritionPlanName('Cut [phase 1] plan')).toBe('Cut [phase 1] plan');
    expect(displayNutritionPlanName('Plain')).toBe('Plain');
  });
});
