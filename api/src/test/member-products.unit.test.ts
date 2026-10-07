// #1121 stages 1 and 2 — the member-facing Product catalogue: which Products a
// member may be shown, what they are shown of each one, how the Members App
// words it, and what buying one means.
//
// Both halves are pure, which is the whole reason they are separate modules:
// `api/src/domain/memberProductCatalogue.ts` owns the predicate and the wire
// shape, `apps/member/src/lib/memberProducts.ts` owns the labels and the
// formatting, and neither needs a database, a server or a browser to assert.
//
// It lives in the **API** suite because CI runs `npm test` in `api/` only
// (#1009's reason, the same one `member-payments.unit.test.ts` gives).

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  MEMBER_CATALOGUE_ENROLLMENT,
  MEMBER_CATALOGUE_STATUS,
  type MemberProductRow,
  memberProductCatalogueParams,
  memberProductCatalogueSql,
  shapeMemberProduct,
} from '../domain/memberProductCatalogue';
import {
  type MemberProduct,
  productFrequencyKey,
  productPackageNote,
  productPriceText,
  productTaxNoteKey,
} from '../../../apps/member/src/lib/memberProducts';
import { STORED_PRODUCT_FREQUENCIES } from '../domain/productFrequency';

const REPO = join(__dirname, '..', '..', '..');
const MEMBER = join(REPO, 'apps', 'member');
const LOCALES = ['en', 'es', 'ca'] as const;

function read(...parts: string[]): string {
  return readFileSync(join(...parts), 'utf-8');
}

function messages(code: string): any {
  return JSON.parse(read(MEMBER, 'locales', 'base', `${code}.json`));
}

function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

function row(over: Partial<MemberProductRow> & Record<string, unknown> = {}): MemberProductRow {
  return {
    id: 7,
    name: 'Locker Rental',
    description: 'A locker for the season',
    type: 'fee',
    units: null,
    billing_frequency: 'month',
    currency: 'EUR',
    tax_rate_percent: '21.00',
    ...over,
  } as MemberProductRow;
}

function product(over: Partial<MemberProduct> = {}): MemberProduct {
  return {
    id: 7,
    name: 'Locker Rental',
    description: null,
    type: 'fee',
    units: null,
    billing_frequency: 'month',
    price_incl_tax: 15,
    currency: 'EUR',
    tax_included: true,
    purchase_state: 'available',
    purchasable: true,
    ...over,
  };
}

describe('which Products a member may be shown (#1121 Q1)', () => {
  it('is the gym’s own two columns: active and public', () => {
    expect(MEMBER_CATALOGUE_STATUS).toBe('active');
    expect(MEMBER_CATALOGUE_ENROLLMENT).toBe('public');
  });

  it('excludes soft-deleted rows and binds its two values in order', () => {
    const sql = memberProductCatalogueSql('p');
    expect(sql).toContain('p.deleted_at IS NULL');
    expect(sql).toContain('p.status = ?');
    expect(sql).toContain('p.enrollment_status = ?');
    // The order the fragment's placeholders appear in is the order the params
    // are passed in; a swap here would read the enrollment column as a status.
    expect(sql.indexOf('p.status = ?')).toBeLessThan(sql.indexOf('p.enrollment_status = ?'));
    expect(memberProductCatalogueParams()).toEqual([
      MEMBER_CATALOGUE_STATUS, MEMBER_CATALOGUE_ENROLLMENT,
    ]);
  });

  it('takes the alias it is given, so a caller can name the table its own way', () => {
    expect(memberProductCatalogueSql('gc')).toContain('gc.status = ?');
  });

  // `is_system` says a Product was seeded from `charge_types`, not that it is
  // internal — the Locker Rental and the Insurance Fee are both System rows and
  // only one of them is public (#1149). `mandatory` is a Membership Plan
  // question (#832/#893). Filtering on either would be this module overruling
  // what the gym configured.
  it('does not filter on is_system or mandatory', () => {
    const source = withoutComments(read(REPO, 'api', 'src', 'domain', 'memberProductCatalogue.ts'));
    expect(source).not.toContain('is_system');
    expect(source).not.toContain('mandatory');
    const loader = withoutComments(read(REPO, 'api', 'src', 'api', 'me-products.ts'));
    expect(loader).not.toContain('is_system');
    expect(loader).not.toContain('mandatory');
  });

  // The predicate module answers *visibility* and nothing else: stage 2's
  // purchase state is composed onto its result (`describeProductPurchase()`),
  // never folded into it, so "which Products may a member see" stays one
  // question with one answer.
  it('the predicate module says nothing about a purchase', () => {
    const source = withoutComments(read(REPO, 'api', 'src', 'domain', 'memberProductCatalogue.ts'));
    expect(source).not.toContain('member_products');
    expect(source).not.toContain('purchase');
  });
});

describe('what a member is shown of one Product (#1121 §4)', () => {
  it('reports the price the caller computed and nothing derived from it', () => {
    expect(shapeMemberProduct(row(), 18.15)).toMatchObject({
      id: 7, name: 'Locker Rental', type: 'fee',
      billing_frequency: 'month', price_incl_tax: 18.15, currency: 'EUR',
    });
  });

  it('an unpriced Product reports null, which is not €0.00', () => {
    expect(shapeMemberProduct(row(), null).price_incl_tax).toBeNull();
  });

  it('claims tax only where the item has a rate behind it', () => {
    expect(shapeMemberProduct(row({ tax_rate_percent: '21.00' }), 18.15).tax_included).toBe(true);
    expect(shapeMemberProduct(row({ tax_rate_percent: null }), 15).tax_included).toBe(false);
  });

  it('carries a Sessions package’s units, as a number', () => {
    const shaped = shapeMemberProduct(row({ type: 'sessions', units: '10' }), 500);
    expect(shaped).toMatchObject({ type: 'sessions', units: 10 });
  });

  it('a missing description and currency are null and EUR, never invented', () => {
    const shaped = shapeMemberProduct(row({ description: null, currency: null }), 15);
    expect(shaped.description).toBeNull();
    expect(shaped.currency).toBe('EUR');
  });

  // #942 — `amount` is the price of the whole package, so no surface may divide
  // it by the units it ships with.
  it('neither half derives a per-session price', () => {
    for (const file of [
      join(REPO, 'api', 'src', 'domain', 'memberProductCatalogue.ts'),
      join(REPO, 'api', 'src', 'api', 'me-products.ts'),
      join(MEMBER, 'src', 'lib', 'memberProducts.ts'),
    ]) {
      expect(withoutComments(read(file))).not.toMatch(/\/\s*(product\.)?units/);
    }
  });
});

describe('how the Members App words it (#1121 §4, #1128)', () => {
  it('names a recurring frequency from the one shared map', () => {
    expect(productFrequencyKey(product({ billing_frequency: 'month' }))).toBe('membership.frequency.month');
    expect(productFrequencyKey(product({ billing_frequency: 'four_weeks' }))).toBe('membership.frequency.four_weeks');
    expect(productFrequencyKey(product({ billing_frequency: 'year' }))).toBe('membership.frequency.year');
    // #821 retired `week` from the dropdown and left it stored, billed and
    // displayed — so it still reads.
    expect(productFrequencyKey(product({ billing_frequency: 'week' }))).toBe('membership.frequency.week');
  });

  // `€50 / Once` describes nothing: these two name no recurring period, which is
  // #1135's rule for a duration caption, one app over.
  it('a frequency that names no period gets no suffix', () => {
    expect(productFrequencyKey(product({ billing_frequency: 'once' }))).toBeNull();
    expect(productFrequencyKey(product({ billing_frequency: 'per_session' }))).toBeNull();
    expect(productFrequencyKey(product({ billing_frequency: null }))).toBeNull();
  });

  it('an unknown frequency reads as none rather than printing the key', () => {
    expect(productFrequencyKey(product({ billing_frequency: 'fortnight' }))).toBeNull();
  });

  it('formats the price in the member’s own locale, and null for an unpriced item', () => {
    expect(productPriceText(product({ price_incl_tax: 15 }), 'en')).toContain('15');
    expect(productPriceText(product({ price_incl_tax: null }), 'en')).toBeNull();
  });

  it('says a Sessions price covers the whole package, with its own count', () => {
    expect(productPackageNote(product({ type: 'sessions', units: 10 }))).toEqual({
      key: 'membership.product_sessions_price', values: { count: 10 },
    });
    // A session item whose nullable `units` is unset says so without inventing
    // a count (#942's own wording rule).
    expect(productPackageNote(product({ type: 'sessions', units: null }))).toEqual({
      key: 'membership.product_package_price',
    });
    expect(productPackageNote(product({ type: 'fee', units: null }))).toBeNull();
  });

  it('notes tax only where the server reported a rate', () => {
    expect(productTaxNoteKey(product({ tax_included: true }))).toBe('membership.product_tax_included');
    expect(productTaxNoteKey(product({ tax_included: false }))).toBeNull();
  });

  it('decides, and draws nothing: no t(), no JSX, no colour', () => {
    const lib = withoutComments(read(MEMBER, 'src', 'lib', 'memberProducts.ts'));
    expect(lib).not.toMatch(/\bt\(/);
    expect(lib).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(lib).not.toContain('react');
  });

  it('the card draws, and decides nothing: no t(), no colour of its own', () => {
    const card = withoutComments(read(MEMBER, 'src', 'components', 'MemberProductsSection.tsx'));
    expect(card).not.toMatch(/\buseTranslations\b/);
    expect(card).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    // #983 — every value it paints with is the one place that spells one.
    expect(card).toContain("from '@/lib/memberChrome'");
  });
});

describe('the route is gated by both flags (#1121 stage 1)', () => {
  // Platform-wide flags (`feature_flags` has no `gym_id`), so an integration
  // test cannot toggle one without changing what every file running beside it
  // sees. The guard is therefore asserted where it is declared.
  it('needs the section’s flag and the catalogue’s own', () => {
    const source = read(REPO, 'api', 'src', 'api', 'me.ts');
    const route = source.slice(source.indexOf("meRouter.get(\n  '/products'"));
    expect(route.slice(0, 600)).toContain("requireFeatureEnabled('member_web.my_membership')");
    expect(route.slice(0, 600)).toContain("requireFeatureEnabled('financials.products')");
    expect(route.slice(0, 600)).toContain("requireRole('member')");
  });
});

describe('the copy (#1121 §1, §3, §5)', () => {
  it('the section is My Products in every locale', () => {
    expect(messages('en').membership.title).toBe('My Products');
    expect(messages('es').membership.title).toBe('Mis Productos');
    expect(messages('ca').membership.title).toBe('Els Meus Productes');
  });

  // §1: "The new name should be used consistently throughout the Members App
  // wherever this section is displayed." `nav.membership` is the same section's
  // name, so a stale *My Membership* left there is drift waiting to be rendered.
  it('the navigation name says the same thing', () => {
    for (const code of LOCALES) {
      expect(messages(code).nav.membership, `${code}.nav.membership`)
        .toBe(messages(code).membership.title);
    }
  });

  it('every key the subsection resolves exists in all three locales', () => {
    for (const code of LOCALES) {
      const ns = messages(code).membership;
      for (const key of [
        'products_heading', 'products_empty',
        'product_sessions_price', 'product_package_price', 'product_tax_included',
      ]) {
        expect(ns[key], `${code}.membership.${key}`).toBeTruthy();
      }
    }
  });

  it('the Sessions price sentence is pluralised by the message, not by the page', () => {
    for (const code of LOCALES) {
      expect(messages(code).membership.product_sessions_price, `${code}`)
        .toMatch(/\{count, plural,/);
    }
  });

  // #1128 — the Members App's one frequency map is `membership.frequency`; a
  // second spelling added beside this subsection's copy is exactly the drift
  // that ticket removed.
  it('the new copy adds no second spelling of a billing frequency', () => {
    for (const code of LOCALES) {
      const ns = messages(code).membership;
      for (const value of STORED_PRODUCT_FREQUENCIES) {
        for (const prefix of ['frequency_', 'product_frequency_', 'products_frequency_']) {
          expect(ns[`${prefix}${value}`], `${code}.membership.${prefix}${value}`).toBeUndefined();
        }
      }
    }
  });
});

describe('the page reads the catalogue and offers nothing (#1121 stage 1)', () => {
  const page = () => read(MEMBER, 'src', 'app', '[locale]', 'membership', 'page.tsx');

  it('fetches the one route and renders the shared section', () => {
    const source = page();
    expect(source).toContain("'/me/products'");
    expect(source).toContain('MemberProductsSection');
  });

  it('a catalogue it could not read is absent, not an empty one', () => {
    // A gym with `financials.products` switched off answers 403; claiming it
    // offers nothing would be a different statement from saying nothing.
    expect(withoutComments(page())).toContain('products === null');
  });

  // #1121 stage 2 — the Buy action exists now, and the page is where it is
  // wired: the component takes it as one `action` node and decides neither
  // what it does nor whether it is there.
  it('the Buy action is the page’s, and the card only renders it', () => {
    expect(withoutComments(page())).toContain('/purchase');
    const card = withoutComments(read(MEMBER, 'src', 'components', 'MemberProductsSection.tsx'));
    expect(card).not.toMatch(/product_buy|\/purchase|apiFetch/);
    expect(card).toContain('item.action');
  });
});
