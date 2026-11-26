// #3328 stage 2: the nutrition-plan tree (gym templates, Base templates, assigned plans)
// takes its meals from the Base Meals and shows each with the one shared meal modal.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const tree = readFileSync(
  join(__dirname, '..', 'app', '[locale]', 'nutrition', 'nutrition-plan-templates', 'NutritionPlanTree.tsx'),
  'utf-8',
);

describe('nutrition-plan meals come from Base Meals (#3328 stage 2)', () => {
  it('reads the picker from the router serving the tree, not a fixed list', () => {
    expect(tree).toContain('`${apiBase}/base-meals`');
    expect(tree).not.toMatch(/const MEAL_TYPES\b/);
  });

  it('writes the meal by base_meal_id', () => {
    expect(tree).toContain('JSON.stringify({ base_meal_id: Number(addMealType) })');
    expect(tree).toMatch(/base_meal_id: v\.meal_type \? Number\(v\.meal_type\) : undefined/);
  });

  it('draws a meal with the shared MealThumbnail, which opens the one meal modal', () => {
    expect(tree).toContain("import { MealPicker, MealThumbnail, type MealImageTarget } from '@/components/meals/MealImage';");
    expect(tree).toContain('<MealThumbnail meal={mealImageTarget(meal, mealLabel(meal, t))}');
    expect(tree).not.toMatch(/MealImageModal|ProfessionalServiceImageModal/);
  });
});

describe('meal pickers show each Base Meal with its thumbnail (#3328 stage 4)', () => {
  const mealImage = readFileSync(join(__dirname, '..', 'components', 'meals', 'MealImage.tsx'), 'utf-8');

  it('chooses a meal through the shared MealPicker, never a name-only <select>', () => {
    expect(tree.match(/<MealPicker\b/g)?.length).toBe(2);
    expect(tree).not.toMatch(/baseMeals\.map\(\(bm\) => \(\s*<option/);
  });

  it('the picker is the app\'s searchable tree picker with the meal avatar left of the name', () => {
    expect(mealImage).toContain('<ExerciseCombobox');
    expect(mealImage).toMatch(/renderLeading=\{\(opt\) => \(\s*<MemberAvatar/);
  });
});
