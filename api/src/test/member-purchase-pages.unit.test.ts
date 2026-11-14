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
  headerBackPath,
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

  it('sends the header back control to My Products from the purchasing pages only (#2741)', () => {
    expect(headerBackPath('/en/membership/add-plan')).toBe(MEMBERSHIP_PATH);
    expect(headerBackPath('/es/membership/add-product')).toBe(MEMBERSHIP_PATH);
    expect(headerBackPath('/en/membership')).toBe('');
    expect(headerBackPath('/en/schedule')).toBe('');
    expect(headerBackPath(null)).toBe('');
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

  it('offers + Add Plan and + Add Product side by side', () => {
    expect(page).toContain("t('membership.add_plan')");
    expect(page).toContain("t('membership.add_product')");
  });

  it('draws the two add actions inside the cart while there is one, never both there and above the plans (#2814)', () => {
    // One pair of buttons, drawn by one function with one set of conditions.
    expect(page.match(/t\('membership\.add_plan'\)/g)).toHaveLength(1);
    expect(page.match(/t\('membership\.add_product'\)/g)).toHaveLength(1);
    // Both carts (Draft and Pending Payment) carry them, under the items.
    expect(page.match(/<\/ul>\s*\{renderCartAddButtons\(\)\}/g)).toHaveLength(2);
    // Secondary inside the cart, left-aligned.
    expect(page).toMatch(/renderAddButtons\(\{ \.\.\.cartSecondaryButtonStyle/);
    expect(page).toMatch(/cartAddRow: \{[^}]*justifyContent: 'flex-start'/);
    // The row above the plans steps aside while the cart is shown.
    const header = page.slice(page.indexOf('function renderPlansHeader()'), page.indexOf('function renderAddButtons('));
    expect(header).toContain('if (cartPhase(setView, appMember?.id ?? null) != null) return null;');
  });

  it('draws no back link of its own: the header\'s "← My Products" is the only one (#2741)', () => {
    expect(page).not.toContain('back_to_products');
    expect(page).not.toContain('renderBackLink');
    const topBar = read('src', 'components', 'TopBar.tsx');
    expect(topBar).toContain('headerBackPath(pathname)');
    expect(topBar).toContain("t('nav.back_to_products')");
  });

  it('has every new label in the three languages', () => {
    for (const locale of ['en', 'es', 'ca']) {
      const m = JSON.parse(read('locales', 'base', `${locale}.json`)).membership;
      expect(m.add_product).toBeTruthy();
      expect(m.back_to_products).toBeUndefined();
      expect(JSON.parse(read('locales', 'base', `${locale}.json`)).nav.back_to_products).toBeTruthy();
    }
  });
});
