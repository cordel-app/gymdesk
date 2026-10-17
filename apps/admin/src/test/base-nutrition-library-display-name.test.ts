import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// Regression test for #1672: the Base Nutrition Library (Cordel) listed the
// base English `name` while the gym library already rendered the localized
// `display_name`. Both lists must show the same field.
const PAGES = [
  join(__dirname, '..', 'app', '[locale]', 'cordel', 'nutrition-library', 'page.tsx'),
  join(__dirname, '..', 'app', '[locale]', 'nutrition', 'nutrition-library', 'page.tsx'),
];

describe('Nutrition Library lists render the localized name (#1672)', () => {
  for (const page of PAGES) {
    it(`${page.split('app')[1]} shows display_name with a fallback to name`, () => {
      const src = readFileSync(page, 'utf-8');
      expect(src).toContain('<strong>{item.display_name ?? item.name}</strong>');
      expect(src).not.toContain('<strong>{item.name}</strong>');
    });
  }
});
