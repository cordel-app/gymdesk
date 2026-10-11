import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #932 — a Nutrition Goal's illustration can be changed after the goal was
// created. `GoalsSection` renders on three screens (a gym's template, an
// assigned plan, Cordel's Base template) and reads `apiBase` from the page, so
// one inline selector serves all of them; the PUT behind it exists on each
// router. This repo has no component-test infra for apps/admin, so the
// structure is pinned down by scanning the source.

const TREE = join(
  __dirname, '..', 'app', '[locale]', 'nutrition', 'nutrition-plan-templates', 'NutritionPlanTree.tsx',
);
const src = readFileSync(TREE, 'utf-8');
const goals = src.slice(src.indexOf('function GoalsSection('));

describe('GoalsSection illustration editing', () => {
  it('saves a changed illustration with a PUT on the goal, from the section\'s own base', () => {
    expect(goals).toContain('async function changeIllustration(goalId: number, value: string)');
    expect(goals).toContain('`${base}/${goalId}`');
    expect(goals).toContain("method: 'PUT'");
    expect(goals).toContain('nutrition_library_item_id: value ? parseInt(value, 10) : null');
  });

  it('offers the same foods and the same "none" option as the add form', () => {
    const edit = goals.slice(goals.indexOf('changeIllustration(g.id'));
    expect(edit).toContain("t('nutrition_plan_templates.tree_goal_illustration_none')");
    expect(edit).toContain('libraryItems');
  });

  it('is a control only when the caller may write; otherwise the read-only line stays', () => {
    expect(goals).toMatch(/canWrite \? \(/);
    expect(goals).toContain("t('nutrition_plan_templates.tree_goal_illustrated_by'");
  });

  it('keeps the stored food as the selected value and refreshes after saving', () => {
    expect(goals).toContain('value={g.nutrition_library_item_id != null ? String(g.nutrition_library_item_id) : \'\'}');
    expect(goals).toMatch(/changeIllustration[\s\S]*await onChanged\(\)/);
  });
});
