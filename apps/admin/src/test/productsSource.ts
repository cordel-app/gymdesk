import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * #2105: the Products list is drawn by `components/products/ProductListChrome.tsx`
 * (shared by the Gym and, from stage 2, the Base Products pages), so the source
 * tests that used to read only the page read the page and the shared renderer.
 */
export function readProductsPageSource(pagePath: string): string {
  const chrome = join(__dirname, '..', 'components', 'products', 'ProductListChrome.tsx');
  return `${readFileSync(chrome, 'utf-8')}\n${readFileSync(pagePath, 'utf-8')}`;
}
