import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #3491 — My Nutrition reads: progress cards → day selector → plan header →
// MEALS → Nutrition Goals → Dietary Restrictions. No component-test infra here
// (no jsdom), so the page's order is pinned by scanning its source.
const SRC = join(__dirname, '..');
const page = readFileSync(join(SRC, 'app', '[locale]', 'nutrition', 'page.tsx'), 'utf-8');
const header = readFileSync(join(SRC, 'components', 'NutritionPlanHeader.tsx'), 'utf-8');

describe('My Nutrition layout (#3491)', () => {
  it('orders the sections as the design does', () => {
    const at = (needle: string) => {
      const i = page.indexOf(needle);
      expect(i, needle).toBeGreaterThan(-1);
      return i;
    };
    const order = [
      at('<TrainingSummaryCards'),
      at('styles.weekCard'),
      at('<NutritionPlanHeader'),
      at("t('nutrition.meals_title')"),
      at("t('nutrition.goals')"),
      at("t('nutrition.restrictions')"),
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('no longer titles the meals with the selected date', () => {
    expect(page).not.toMatch(/<h2[^>]*>\{dayText\(locale, selectedDate/);
  });

  it('feeds the header the plan in force on the selected day, with its Member Notes', () => {
    expect(page).toMatch(/<NutritionPlanHeader name=\{shown\.name\} notes=\{shown\.member_notes\}/);
  });

  it('clamps notes to two lines and toggles them with a button, rendering nothing without notes', () => {
    expect(header).toContain('WebkitLineClamp: 2');
    expect(header).toContain('aria-expanded={expanded}');
    expect(header).toMatch(/\{text && \(/);
  });

  it('has its labels in every locale', () => {
    for (const loc of ['en', 'es', 'ca']) {
      const msgs = JSON.parse(readFileSync(join(SRC, '..', 'locales', 'base', `${loc}.json`), 'utf-8'));
      for (const k of ['meals_title', 'plan_notes_expand', 'plan_notes_collapse']) {
        expect(msgs.nutrition[k], `${loc} ${k}`).toBeTruthy();
      }
    }
  });
});
