import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #2661: an expanded meal opens straight into its editor and every change
// persists by itself — no Edit button, no Save/Cancel pair. apps/admin has no
// component-test infra, so this pins the wiring by source scan; the save
// ordering itself is unit-tested in latest-wins-save.test.ts.
const tree = readFileSync(
  join(__dirname, '..', 'app', '[locale]', 'nutrition', 'nutrition-plan-templates', 'NutritionPlanTree.tsx'),
  'utf-8',
);
const section = (from: string, to: string) => tree.slice(tree.indexOf(from), tree.indexOf(to));

describe('#2661 meal ingredients: inline editing with automatic persistence', () => {
  const meal = section('function MealRow(', '/* ---- Autosave (#2661)');
  const items = section('function MealItemsEditor(', '/* ---- RestrictionsSection');

  it('offers no Edit, Save or Cancel on a meal or its ingredients', () => {
    for (const src of [meal, items]) {
      expect(src).not.toContain("t('nutrition_plan_templates.edit')");
      expect(src).not.toContain("t('nutrition_plan_templates.save_changes')");
      expect(src).not.toContain("t('nutrition_plan_templates.cancel')}</button>");
    }
    expect(meal).not.toContain('setEditing');
  });

  it('renders the editor whenever a writable meal is expanded', () => {
    expect(meal).toContain('{expanded && canWrite && (');
    expect(meal).toContain('<MealItemsEditor');
    expect(items).toContain('<ItemEditRow');
  });

  it('persists through the latest-wins saver and never resets an unacknowledged edit', () => {
    expect(tree).toContain('createLatestWinsSaver<T>(');
    expect(tree.match(/if \(save\.dirty\) return;/g)?.length).toBe(2);
    expect(tree).toContain('<AutosaveStatus state={save.state} onRetry={save.retry} t={t} />');
  });
});
