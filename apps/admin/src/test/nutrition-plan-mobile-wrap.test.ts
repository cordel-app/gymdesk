import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #2207 — the plan tree (Assigned Nutrition Plans) wraps instead of overflowing on narrow screens.
const src = readFileSync(
  join(__dirname, '..', 'app', '[locale]', 'nutrition', 'nutrition-plan-templates', 'NutritionPlanTree.tsx'),
  'utf-8',
);

describe('nutrition plan tree is responsive', () => {
  it('meal header and food rows may wrap', () => {
    expect(src).toContain("gap: 8, flexWrap: 'wrap', padding: '9px 12px'");
    expect(src).toContain("gap: 6, flexWrap: 'wrap', minWidth: 0, padding: '4px 0'");
  });
  it('goal form grid is fluid', () => {
    expect(src).toContain('repeat(auto-fit, minmax(110px, 1fr))');
    expect(src).not.toContain("'2fr 1fr 1fr'");
  });
});
