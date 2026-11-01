import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #2204 — a food's image or name in an Assigned Nutrition Plan opens its details.
// Both views (Member card, standalone page) render NutritionPlanTree, so the
// opener lives there once. Scans the sources, as the neighbouring tests do.
const SRC = join(__dirname, '..');
const tree = readFileSync(join(SRC, 'app', '[locale]', 'nutrition', 'nutrition-plan-templates', 'NutritionPlanTree.tsx'), 'utf-8');
const modal = readFileSync(join(SRC, 'components', 'nutritionLibrary', 'FoodDetailsModal.tsx'), 'utf-8');
const member = readFileSync(join(SRC, 'app', '[locale]', 'members', 'MemberExpandedRow.tsx'), 'utf-8');
const page = readFileSync(join(SRC, 'app', '[locale]', 'nutrition', 'nutrition-plans', 'page.tsx'), 'utf-8');

describe('food details modal', () => {
  it('is reachable from both assigned-plan views through the shared tree', () => {
    expect(member).toContain('<NutritionPlanTree');
    expect(page).toContain('<NutritionPlanTree');
    expect(tree).toContain('<FoodDetailsModal');
  });

  it('opens from the image-and-name of meal items (read and edit rows) and restrictions', () => {
    expect(tree.match(/<FoodLink /g)?.length).toBe(3);
    expect(tree).toContain('onClick={() => open({ id, name, imageUrl })}');
  });

  it('shows every library field with monochrome icons and survives missing data', () => {
    for (const k of ['label_description', 'label_categories', 'nutritional_qualities_label', 'col_status', 'label_translations', 'no_image']) {
      expect(modal).toContain(k);
    }
    expect(modal).toContain('stroke="currentColor"');
    expect(modal).not.toMatch(/stroke="#|fill="#/);
    expect(modal).toContain('onError={() => setImageFailed(true)}');
    expect(modal).toContain('displayValue(');
  });

  it('has its title in every locale', () => {
    for (const l of ['en', 'es', 'ca']) {
      const json = JSON.parse(readFileSync(join(SRC, '..', 'locales', 'base', `${l}.json`), 'utf-8'));
      expect(json.nutrition_library.food_details_title).toBeTruthy();
    }
  });
});
