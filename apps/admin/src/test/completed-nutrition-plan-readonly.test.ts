import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #2201 — completed assigned nutrition plans are read-only in both places.
const SRC = join(__dirname, '..', 'app', '[locale]');
const page = readFileSync(join(SRC, 'nutrition', 'nutrition-plans', 'page.tsx'), 'utf8');
const row = readFileSync(join(SRC, 'members', 'MemberExpandedRow.tsx'), 'utf8');

describe('completed nutrition plans are read-only (#2201)', () => {
  it('Assigned Nutrition Plans menu offers Edit only for active plans and Delete not for completed', () => {
    expect(page).toContain("...(isActive ? [{ label: t('nutrition_plans.edit')");
    expect(page).toContain("...(plan.status !== 'completed' ? [{ label: t('nutrition_plans.delete')");
  });
  it('Member Nutrition Plan list hides Edit for completed plans', () => {
    expect(row).toContain("canManageNutrition && p.status !== 'completed' && (");
  });
});
