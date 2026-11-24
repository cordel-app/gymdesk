import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const tree = readFileSync(
  join(__dirname, '../app/[locale]/nutrition/nutrition-plan-templates/NutritionPlanTree.tsx'),
  'utf8',
);

describe('meal sections have no Display Name field (#1785)', () => {
  it('offers no Display Name input and never submits one', () => {
    expect(tree).not.toMatch(/tree_label_display_name/);
    expect(tree).not.toMatch(/displayNameVal/);
  });
  it('titles a meal by its Base Meal, then its legacy Meal Type (#3328 stage 2)', () => {
    expect(tree).toMatch(/if \(meal\.meal_name\) return meal\.meal_name;/);
    expect(tree).toMatch(/if \(meal\.meal_type\) return t\(`nutrition_plan_templates\.tree_meal_type_/);
    expect(tree).toContain('{mealLabel(meal, t)}');
  });
});
