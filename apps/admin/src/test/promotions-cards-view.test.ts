import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #1831 — Promotions gets the Cards view of Exercises and Activities.
const SRC = join(__dirname, '..');
const page = readFileSync(join(SRC, 'app/[locale]/promotions/page.tsx'), 'utf8');

describe('Promotions cards view (#1831)', () => {
  it('reuses the shared view toggle and card grid', () => {
    expect(page).toContain("from '@/components/exercises/ExerciseViewToggle'");
    expect(page).toContain("from '@/components/CardGrid'");
    expect(page).toContain('<ExerciseViewToggle value={view} onChange={setView} />');
  });

  it('Edit from a card switches to List view before opening the editor', () => {
    const body = page.slice(page.indexOf('async function enterEdit'));
    expect(body.indexOf("setView('list')")).toBeGreaterThan(-1);
    expect(body.indexOf("setView('list')")).toBeLessThan(body.indexOf('setEditingId(promo.id)'));
  });

  it('the card expands through the same row body as the list', () => {
    expect(page).toContain('show_all_attributes');
    expect(page).toContain('hide_all_attributes');
  });
});
