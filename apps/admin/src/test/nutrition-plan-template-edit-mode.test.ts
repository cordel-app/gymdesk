import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// #3482: a Nutrition Plan Template's content is editable in Edit mode only, and
// Cancel discards the whole edit session through the server's checkpoint.
const DIR = join(__dirname, '..', 'app', '[locale]', 'nutrition', 'nutrition-plan-templates');
const page = readFileSync(join(DIR, 'page.tsx'), 'utf-8');
const tree = readFileSync(join(DIR, 'NutritionPlanTree.tsx'), 'utf-8');

describe('Nutrition Plan Template edit mode (#3482)', () => {
  it('renders the plan tree read-only outside Edit mode', () => {
    expect(page).toContain('canWrite={canWrite && editing}');
  });

  it('opens, cancels and closes an edit session on the server', () => {
    expect(page).toContain('/edit-session`, { method: \'POST\' }');
    expect(page).toContain('/edit-session/cancel`, { method: \'POST\' }');
    expect(page).toContain('/edit-session`, { method: \'DELETE\' }');
  });

  it('does not push Add Meal to the far edge of the day', () => {
    const block = tree.slice(tree.indexOf("tree_select_meal_type')}\n                onChange={(id) => setAddMealType"), tree.indexOf("tree_add_meal')}"));
    expect(tree).toContain("flex: '0 1 320px'");
    expect(block).not.toContain('flex: 1');
  });
});
