import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// #3348 — every entity that carries a persisted slug shows it in its Details modal, read-only,
// and nowhere else: not on the list row, the read-only expansion or the Edit / Create form.
const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

/** File, the expression its Details modal renders the slug with. */
const DETAILS_SLUG: Array<[string, string]> = [
  ['components/exercises/ExerciseDetailModal.tsx', 'exercise.slug'],
  ['components/goalLibrary/GoalDetailsModal.tsx', 'goal.entity_slug'],
  ['components/nutritionLibrary/NutritionItemDetailsModal.tsx', 'item.slug'],
  ['components/professionalServices/ProfessionalServicesView.tsx', 'details.slug'],
  ['app/[locale]/cordel/base-payment-methods/page.tsx', 'details.slug'],
  ['app/[locale]/cordel/base-meals/page.tsx', 'details.slug'],
  ['app/[locale]/cordel/payment-providers/page.tsx', 'details.slug'],
  ['app/[locale]/system/gyms/page.tsx', 'details.slug'],
  ['app/[locale]/cordel/muscles/page.tsx', 'details.slug'],
];

describe('#3348 the slug is shown in Details modals only', () => {
  it.each(DETAILS_SLUG)('%s renders the persisted slug in its Details modal', (file, expr) => {
    expect(read(file)).toContain(expr);
  });

  it.each(DETAILS_SLUG)('%s reads the slug from nothing but the Details row', (file, expr) => {
    const src = read(file);
    const owner = expr.split('.')[0];
    // Any other `<x>.slug` / `<x>.entity_slug` would be a row, card or form rendering it.
    const others = [...src.matchAll(/\b(\w+)\.(entity_slug|slug)\b/g)]
      .filter(([, who]) => who !== owner)
      // Lookup catalogues (categories, qualities, result types) are keyed by a slug for their label.
      .filter(([, who]) => !['c', 'q', 'o', 'option', 'rt', 'm', 'record', 'entity', 'f', 'opts'].includes(who));
    expect(others.map(([m]) => m)).toEqual([]);
  });

  it('Cordel → Muscles no longer prints the slug on the row or in the read-only expansion', () => {
    const src = read('app/[locale]/cordel/muscles/page.tsx');
    expect(src).not.toContain('row.slug');
    expect(src).toContain("[t('slug'), details.slug]");
  });
});
