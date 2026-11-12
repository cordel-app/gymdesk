// #2737 — My Products shows what the member holds; plans and Products are
// bought on two pages of their own. Pure halves and the page wiring (API suite,
// because CI runs `npm test` in `api/` only).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  ADD_PLAN_PATH,
  ADD_PRODUCT_PATH,
  MEMBERSHIP_PATH,
  membershipPageMode,
} from '../../../apps/member/src/lib/membershipPages';
import { productsPathForServices } from '../../../apps/member/src/lib/serviceRequired';

const MEMBER = join(__dirname, '..', '..', '..', 'apps', 'member');
const read = (...p: string[]) => readFileSync(join(MEMBER, ...p), 'utf8');
const PAGE_DIR = ['src', 'app', '[locale]', 'membership'];

describe('membershipPageMode', () => {
  it('selects the page from the route', () => {
    expect(membershipPageMode('/en/membership')).toBe('overview');
    expect(membershipPageMode('/es/membership/add-plan')).toBe('add_plan');
    expect(membershipPageMode('/ca/membership/add-product')).toBe('add_product');
  });

  it('reads anything else as My Products', () => {
    expect(membershipPageMode(null)).toBe('overview');
    expect(membershipPageMode('/en/membership/unknown')).toBe('overview');
    expect(membershipPageMode('/en/schedule/add-plan')).toBe('overview');
  });

  it('spells paths the routes exist for', () => {
    expect(MEMBERSHIP_PATH).toBe('/membership');
    expect(read(...PAGE_DIR, 'add-plan', 'page.tsx')).toContain("export { default } from '../page'");
    expect(read(...PAGE_DIR, 'add-product', 'page.tsx')).toContain("export { default } from '../page'");
    expect(membershipPageMode(`/en${ADD_PLAN_PATH}`)).toBe('add_plan');
    expect(membershipPageMode(`/en${ADD_PRODUCT_PATH}`)).toBe('add_product');
  });

  it('sends a refused booking to the Add Product page', () => {
    expect(productsPathForServices([3])).toBe(`${ADD_PRODUCT_PATH}?professional_service_ids=3`);
  });
});

describe('My Products page wiring', () => {
  const page = read(...PAGE_DIR, 'page.tsx');
  const branch = (from: string, to: string) => page.slice(page.indexOf(from), page.indexOf(to, page.indexOf(from)));

  it('renders the plan catalogue on the Add Plan page only', () => {
    expect(page.match(/\{renderPlanCatalogue\(\)\}/g)).toHaveLength(1);
    expect(branch("if (mode === 'add_plan') {", '</main>')).toContain('{renderPlanCatalogue()}');
  });

  it('renders the Products catalogue on the Add Product page only', () => {
    expect(page.match(/\{renderProducts\(\)\}/g)).toHaveLength(1);
    expect(branch("if (mode === 'add_product') {", '</main>')).toContain('{renderProducts()}');
  });

  it('offers + Add Plan and + Add Product side by side, with a way back from both pages', () => {
    expect(page).toContain("t('membership.add_plan')");
    expect(page).toContain("t('membership.add_product')");
    expect(branch("if (mode === 'add_plan') {", '</main>')).toContain('{renderBackLink()}');
    expect(branch("if (mode === 'add_product') {", '</main>')).toContain('{renderBackLink()}');
  });

  it('has every new label in the three languages', () => {
    for (const locale of ['en', 'es', 'ca']) {
      const m = JSON.parse(read('locales', 'base', `${locale}.json`)).membership;
      expect(m.add_product).toBeTruthy();
      expect(m.back_to_products).toBeTruthy();
    }
  });
});
