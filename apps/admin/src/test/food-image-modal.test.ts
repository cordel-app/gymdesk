import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #2307 — the Foods lists open the full-size image (never the thumbnail) with the description.
const read = (...p: string[]) => readFileSync(join(__dirname, '..', ...p), 'utf-8');
const pages = [
  read('app', '[locale]', 'nutrition', 'nutrition-library', 'page.tsx'),
  read('app', '[locale]', 'cordel', 'nutrition-library', 'page.tsx'),
];

describe('food image modal', () => {
  it('both libraries open it from the thumbnail with image_url', () => {
    for (const src of pages) {
      expect(src).toContain('<FoodImageModal');
      expect(src).toMatch(/setImageTarget\(\{[^}]*imageUrl: item\.image_url/);
      expect(src).not.toMatch(/setImageTarget\(\{[^}]*thumbnail/);
    }
  });
  it('has its no-description label in every locale', () => {
    for (const l of ['en', 'es', 'ca']) {
      const j = JSON.parse(readFileSync(join(__dirname, '..', '..', 'locales', 'base', `${l}.json`), 'utf-8'));
      expect(j.nutrition_library.image_modal_no_description).toBeTruthy();
    }
  });
});
