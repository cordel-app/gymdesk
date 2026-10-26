import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #2105 stage 3 — Gym Products and Base Products draw their list through one renderer.
const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf-8');
const gym = read('app/[locale]/financials/products/page.tsx');
const base = read('app/[locale]/cordel/base-products/page.tsx');
const chrome = read('components/products/ProductListChrome.tsx');

describe('Products list renderer is shared (#2105)', () => {
  it.each([['Gym', gym], ['Base', base]])('%s page uses the shared list frame and row', (_n, src) => {
    expect(src).toContain("from '@/components/products/ProductListChrome'");
    expect(src).toContain('<ProductListFrame');
    expect(src).toContain('<ProductListRow');
  });

  it('neither page restates the list grid or header band', () => {
    for (const src of [gym, base]) {
      expect(src).not.toContain('LIST_COLUMNS');
      expect(src).not.toContain('LIST_GRID_ROW_CLASS');
      expect(src).not.toContain('listCellClasses');
    }
  });

  it('the grid is declared once, in the shared renderer', () => {
    expect(chrome).toContain('LIST_GRID_ROW_CLASS');
  });
});
