import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #1788 — the plan tree (shared by Plan Templates and Assigned Plans) draws no
// "OR" separator between food items of the same food type.
const src = readFileSync(
  join(__dirname, '..', 'app', '[locale]', 'nutrition', 'nutrition-plan-templates', 'NutritionPlanTree.tsx'),
  'utf-8',
);

describe('no OR separators between food items', () => {
  it('renders no separator label', () => {
    expect(src).not.toContain('tree_food_type_or');
    expect(src).not.toContain('showOr');
  });

  it('keeps every food item row', () => {
    expect(src.match(/<FoodThumbnail imageUrl=/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
