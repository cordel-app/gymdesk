import { describe, expect, it } from 'vitest';
import { readProductsPageSource } from './productsSource';
import { readFileSync } from 'fs';
import { join } from 'path';

// #1832 — Products gets the Cards view of Exercises, Activities and Promotions.
const page = readProductsPageSource(join(__dirname, '..', 'app/[locale]/financials/products/page.tsx'));

describe('Products cards view (#1832)', () => {
  it('reuses the shared view toggle and card grid', () => {
    expect(page).toContain("from '@/components/exercises/ExerciseViewToggle'");
    expect(page).toContain("from '@/components/CardGrid'");
    expect(page).toContain('<ExerciseViewToggle value={view} onChange={setView} />');
  });

  it('Edit from a card switches to List view before opening the editor', () => {
    const body = page.slice(page.indexOf('function openEdit'));
    expect(body.indexOf("setView('list')")).toBeGreaterThan(-1);
    expect(body.indexOf("setView('list')")).toBeLessThan(body.indexOf('setEditingId(item.id)'));
    expect(body).toContain('product-card-${item.id}');
  });

  it('the card expands through the same row body as the list', () => {
    expect(page).toContain('show_all_attributes');
    expect(page).toContain('hide_all_attributes');
  });
});
