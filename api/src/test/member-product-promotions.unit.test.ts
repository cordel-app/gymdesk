// #1118 — the Promotion a member applies to a Product they are buying: which
// Promotions are offered, what applying one does to the price, what the
// purchase keeps of it, and how both apps word it.
//
// Every rule is pure, which is why they are in a module of their own
// (`api/src/domain/memberProductPromotion.ts`) rather than in the route: the
// eligibility, the arithmetic and the snapshot are all assertable with no
// database, no provider and no browser. The I/O halves
// (`api/src/api/member-product-promotions.ts`, `me-products.ts`) are covered by
// source assertions here and by the integration suite.
//
// It lives in the **API** suite because CI runs `npm test` in `api/` only
// (#1009's reason, the same one `member-products.unit.test.ts` gives).

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  PRODUCT_PROMOTION_TARGET,
  isOfferableBenefit,
  offerCategoryFor,
  promotionApplicationSnapshot,
  promotionDurationCycles,
  promotionGrantTableFor,
  promotionalPrice,
  shapeAppliedPromotion,
  shapePromotionOffer,
} from '../domain/memberProductPromotion';
import { PROMOTION_ITEM_ACTIONS } from '../domain/productBenefitActions';
import { benefitTableForCategory } from '../domain/productClassification';
import {
  promotionBenefitNote,
  promotionDurationNote,
  productFinalPrice,
  purchaseErrorKey,
  showsRegularProductPrice,
} from '../../../apps/member/src/lib/memberProducts';

const migration = require('../infra/migrations/229_member_product_promotions');

const REPO = join(__dirname, '..', '..', '..');
const LOCALES = ['en', 'es', 'ca'] as const;

function read(...parts: string[]): string {
  return readFileSync(join(...parts), 'utf-8');
}

function messages(app: 'admin' | 'member', code: string): any {
  return JSON.parse(read(REPO, 'apps', app, 'locales', 'base', `${code}.json`));
}

/**
 * Comments stripped, so a rule about the **code** is not satisfied or broken by
 * prose — both of these files quote the thread, `promotion_products` included,
 * in explaining why they do not have one.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const domainSrc = stripComments(read(__dirname, '..', 'domain', 'memberProductPromotion.ts'));
const ioSrc = stripComments(read(__dirname, '..', 'api', 'member-product-promotions.ts'));

/**
 * The SQL of one read, from its `FROM` to the end of the template literal — so
 * "this read joins nothing" is asserted about that statement rather than about
 * a file that also holds the live-catalogue query the offers come from.
 */
function statementFrom(src: string, from: string): string {
  const start = src.indexOf(from);
  expect(start, `no statement reading ${from}`).toBeGreaterThan(-1);
  const end = src.indexOf('`', start);
  return src.slice(start, end === -1 ? undefined : end);
}
const purchaseSrc = read(__dirname, '..', 'api', 'me-products.ts');
const membersRouterSrc = read(__dirname, '..', 'api', 'members.ts');

/** A grant row as the offer query hands it over. */
const grant = (over: Record<string, unknown> = {}) => ({
  promotion_id: 7,
  promotion_name: 'Summer Promotion',
  product_id: 42,
  action: 'percentage_discount',
  value: 50,
  quantity: 3,
  ...over,
});

describe('which Promotions are about a Product (§4, the thread\'s Q4)', () => {
  it('reads the Promotion\'s own grant sections, never a second relation', () => {
    // `Q4`: "do not introduce a second `promotion_products` relation [...] the
    // Product selected inside the Promotion is already the source of truth".
    for (const category of ['session', 'oneoff', 'periodical'] as const) {
      expect(promotionGrantTableFor(category)).toBe(benefitTableForCategory(category));
    }
    expect(domainSrc).not.toContain('promotion_products');
    expect(ioSrc).not.toContain('promotion_products');
  });

  it('puts a Product\'s offers in the section it classifies into (#550)', () => {
    expect(offerCategoryFor({ type: 'sessions', billing_frequency: 'once' })).toBe('session');
    expect(offerCategoryFor({ type: 'other', billing_frequency: 'once' })).toBe('oneoff');
    expect(offerCategoryFor({ type: 'other', billing_frequency: 'month' })).toBe('periodical');
    // One mapping: the module asks `classifyProduct()` rather than testing the
    // columns for itself.
    expect(domainSrc).toContain('classifyProduct');
  });

  it('only offers a Promotion that is about a Product (#926)', () => {
    expect(PRODUCT_PROMOTION_TARGET).toBe('product');
    expect(ioSrc).toContain('p.applies_to = ?');
  });

  it('applies the window every other apply path already enforces', () => {
    // Compared in SQL, like `promotionExpiryWhereSql()` (#900), so no DATETIME
    // crosses a timezone conversion.
    expect(ioSrc).toContain("p.lifecycle_status = 'active'");
    expect(ioSrc).toContain('p.starts_at <= UTC_TIMESTAMP()');
    expect(ioSrc).toContain('p.ends_at >= UTC_TIMESTAMP()');
  });

  it('honours only_applicable_for_new_members through the one rule (#927)', () => {
    expect(ioSrc).toContain('only_applicable_for_new_members');
    // The Member-level answer: a purchase configures no assignment to exclude.
    expect(ioSrc).toContain('isNewMemberStatus');
    expect(ioSrc).not.toContain('isNewMemberForNewAssignment');
  });

  it('does not offer a grant that changes no price', () => {
    expect(isOfferableBenefit('no_benefit', null)).toBe(false);
    expect(isOfferableBenefit('waive', null)).toBe(true);
    expect(isOfferableBenefit('percentage_discount', 50)).toBe(true);
    expect(isOfferableBenefit('fixed_price', 10)).toBe(true);
    // An unusable pair reads as the neutral default and is not an offer either.
    expect(isOfferableBenefit('percentage_discount', null)).toBe(false);
    expect(isOfferableBenefit('nonsense', 5)).toBe(false);
  });

  it('offers only what prices the Product lower than its own price, above nothing', () => {
    // A €0 charge is not a purchase (§9/§16), and a `fixed_price` above the
    // Product's price is not a promotion — the one screen where presenting a
    // price increase as a benefit is never acceptable.
    expect(ioSrc).toContain('if (!(final > 0) || !(final < regular)) continue;');
  });
});

describe('what applying one does to the price (§5)', () => {
  it('prices through the one place a pair becomes an amount (#896)', () => {
    expect(domainSrc).toContain('applyLineBenefit');
    expect(promotionalPrice(100, { action: 'percentage_discount', value: 50 })).toBe(50);
    expect(promotionalPrice(100, { action: 'fixed_discount', value: 20 })).toBe(80);
    expect(promotionalPrice(100, { action: 'fixed_price', value: 35 })).toBe(35);
    expect(promotionalPrice(100, { action: 'waive', value: null })).toBe(0);
    expect(promotionalPrice(100, { action: 'no_benefit', value: null })).toBe(100);
  });

  it('answers null for a Product carrying no price, never €0.00', () => {
    expect(promotionalPrice(null, { action: 'percentage_discount', value: 50 })).toBeNull();
    expect(promotionalPrice(undefined, { action: 'waive', value: null })).toBeNull();
  });

  it('prices the Product once — a Sessions package is not multiplied by its units', () => {
    // #942: `amount` is the price of the whole package.
    expect(domainSrc).toContain('applyLineBenefit(regularPriceInclTax, 1, benefit)');
  });

  it('shapes an offer with both prices and the duration', () => {
    const offer = shapePromotionOffer(grant(), 'periodical', 100);
    expect(offer).toMatchObject({
      promotion_id: 7,
      promotion_name: 'Summer Promotion',
      product_id: 42,
      action: 'percentage_discount',
      value: 50,
      duration_cycles: 3,
      regular_price_incl_tax: 100,
      final_price_incl_tax: 50,
    });
  });

  it('reads a grant in the Promotion\'s own option set', () => {
    // A Promotion configures all five (#896 §16); read as a Plan's two, a
    // `fixed_discount` would normalize away and quote the full price.
    const offer = shapePromotionOffer(grant({ action: 'fixed_discount', value: 25 }), 'oneoff', 100);
    expect(offer.action).toBe('fixed_discount');
    expect(offer.final_price_incl_tax).toBe(75);
  });
});

describe('duration in billing cycles (§6, the thread\'s Q5)', () => {
  it('is a Periodic grant\'s own quantity (#1135)', () => {
    expect(promotionDurationCycles('periodical', 3)).toBe(3);
    expect(promotionDurationCycles('periodical', '4')).toBe(4);
  });

  it('is nothing at all for a one-off or session grant', () => {
    // `Q5`: a one-off Product has no billing periods, so there is no duration
    // to express — and its grant's quantity counts units, not periods.
    expect(promotionDurationCycles('oneoff', 3)).toBeNull();
    expect(promotionDurationCycles('session', 10)).toBeNull();
  });

  it('is nothing for a quantity that names no periods', () => {
    expect(promotionDurationCycles('periodical', 0)).toBeNull();
    expect(promotionDurationCycles('periodical', null)).toBeNull();
    expect(promotionDurationCycles('periodical', 'x')).toBeNull();
  });

  it('renders no caption where there is none', () => {
    expect(promotionDurationNote(null)).toBeNull();
    expect(promotionDurationNote(0)).toBeNull();
    expect(promotionDurationNote(3)).toEqual({
      key: 'membership.promotion_duration_cycles', values: { count: 3 },
    });
  });
});

describe('the snapshot (§7, §13, §14, §15)', () => {
  it('keeps the name, the pair, the duration and both amounts', () => {
    const snapshot = promotionApplicationSnapshot(shapePromotionOffer(grant(), 'periodical', 100));
    expect(snapshot).toEqual({
      promotion_name: 'Summer Promotion',
      benefit_action: 'percentage_discount',
      benefit_value: 50,
      duration_cycles: 3,
      regular_amount: 100,
      final_amount: 50,
    });
  });

  it('is nothing for an offer that could not be priced', () => {
    expect(promotionApplicationSnapshot(shapePromotionOffer(grant(), 'oneoff', null))).toBeNull();
  });

  it('is written in the purchase\'s own transaction (§7, §10)', () => {
    expect(purchaseSrc).toContain('writePurchasePromotion(tx,');
  });

  it('is re-resolved server-side at purchase time, never trusted from the client', () => {
    expect(purchaseSrc).toContain('resolvePurchasePromotion');
    // The one refusal: a Promotion that lapsed between the quote and the Buy.
    expect(purchaseSrc).toContain('throw new PromotionRefused()');
    expect(ioSrc).toContain('loadPromotionOffers(gymId, memberId, [product])');
  });

  it('is read back without touching the live Promotion (#635 §16)', () => {
    // Asserted of the two reads themselves: the same file holds the
    // live-catalogue query the *offers* come from, which legitimately joins
    // `promotions`.
    expect(statementFrom(ioSrc, 'FROM member_products_oneoff_promotion_snapshot mpp')).not.toMatch(/JOIN/);
    // Nor does the purchase read touch the live Product: every column of a
    // purchase is its own snapshot (migration 228).
    expect(statementFrom(ioSrc, 'FROM member_products_oneoff_snapshot mp')).not.toMatch(/JOIN/);
    expect(membersRouterSrc).toContain('loadMemberPurchases(gymId, memberId)');
  });

  it('reports a stored pair in the Promotion\'s option set', () => {
    const applied = shapeAppliedPromotion({
      id: 1, promotion_id: 7, promotion_name: 'Summer Promotion',
      benefit_action: 'fixed_price', benefit_value: '35.00',
      duration_cycles: null, regular_amount: '100.00', final_amount: '35.00',
      applied_at: '2026-10-06T10:00:00Z',
    });
    expect(applied).toMatchObject({
      benefit_action: 'fixed_price', benefit_value: 35,
      regular_amount: 100, final_amount: 35, duration_cycles: null,
    });
  });
});

describe('migration 229', () => {
  it('mirrors the Promotion\'s own action vocabulary', () => {
    expect(migration.ACTIONS).toEqual([...PROMOTION_ITEM_ACTIONS]);
  });

  it('states the amount rule the loader enforces', () => {
    const src = read(__dirname, '..', 'infra', 'migrations', '229_member_product_promotions.js');
    expect(src).toContain('final_amount <= regular_amount');
  });

  it('holds at most one Promotion per purchase', () => {
    const src = read(__dirname, '..', 'infra', 'migrations', '229_member_product_promotions.js');
    expect(src).toContain('UNIQUE KEY ${PREFIX}_purchase_key (member_product_id)');
    // The prefix is its own, not `membership_plan_prices`' `mpp_` (migration 005).
    expect(migration.PREFIX).toBe('mprodp');
    // The record of money that moved: neither the Product nor the Promotion may
    // be hard-deleted under it.
    expect(src).toContain('REFERENCES promotions(id) ON DELETE RESTRICT');
    expect(src).toContain('REFERENCES member_products(id) ON DELETE CASCADE');
  });

  it('is cleaned up before the catalogue tables it points at', () => {
    const helpers = read(__dirname, 'helpers.ts');
    const applications = helpers.indexOf('DELETE FROM member_products_oneoff_promotion_snapshot');
    const purchases = helpers.indexOf('DELETE FROM member_products_oneoff_snapshot');
    const promotions = helpers.indexOf('DELETE FROM promotions WHERE');
    expect(applications).toBeGreaterThan(-1);
    expect(applications).toBeLessThan(purchases);
    // The RESTRICT half, which is the one that actually matters: a gym delete
    // fans CASCADE into `promotions` and into this table at once and MySQL does
    // not order the cascades one DELETE produces (the hazard `helpers.ts`
    // already documents for `workout_block_logs`), so the suite must take the
    // applications out before the Promotions they point at.
    expect(promotions).toBeGreaterThan(-1);
    expect(applications).toBeLessThan(promotions);
  });
});

describe('the Members App half', () => {
  it('words every treatment, and nothing else', () => {
    const en = messages('member', 'en').membership;
    expect(promotionBenefitNote('waive', null, 'EUR', 'en')?.key)
      .toBe('membership.promotion_benefit_waive');
    expect(promotionBenefitNote('percentage_discount', 50, 'EUR', 'en'))
      .toEqual({ key: 'membership.promotion_benefit_percentage', values: { value: '50' } });
    expect(promotionBenefitNote('fixed_discount', 20, 'EUR', 'en')?.key)
      .toBe('membership.promotion_benefit_fixed_discount');
    expect(promotionBenefitNote('fixed_price', 35, 'EUR', 'en')?.key)
      .toBe('membership.promotion_benefit_fixed_price');
    // `no_benefit` is never offered, so it has no sentence — and a treatment
    // with no value has nothing to say rather than a key with a hole in it.
    expect(promotionBenefitNote('no_benefit', null, 'EUR', 'en')).toBeNull();
    expect(promotionBenefitNote('percentage_discount', null, 'EUR', 'en')).toBeNull();
    expect(en.promotion_benefit_waive).toBeTruthy();
  });

  it('carries every key it names, in every locale', () => {
    const keys = [
      'promotion_heading', 'promotion_apply', 'promotion_applied',
      'promotion_benefit_waive', 'promotion_benefit_percentage',
      'promotion_benefit_fixed_discount', 'promotion_benefit_fixed_price',
      'promotion_duration_cycles', 'promotion_unavailable_error',
    ];
    for (const code of LOCALES) {
      const ns = messages('member', code).membership;
      for (const key of keys) {
        expect(ns[key], `${code}.json is missing membership.${key}`).toBeTruthy();
      }
    }
  });

  it('shows the applied Promotion\'s own final price, and no arithmetic of its own', () => {
    const product = {
      id: 42, name: 'Personal Training', description: null, type: 'other', units: null,
      billing_frequency: 'once', price_incl_tax: 100, currency: 'EUR', tax_included: true,
      purchase_state: 'available' as const, purchasable: true,
    };
    const applied = shapePromotionOffer(grant(), 'oneoff', 100);
    expect(productFinalPrice(product, applied)).toBe(50);
    expect(productFinalPrice(product, null)).toBe(100);
    expect(showsRegularProductPrice(product, applied)).toBe(true);
    // A Promotion that leaves the price alone shows one figure, not two — the
    // server does not offer such a grant at all, and the card would not draw a
    // struck-through price for it either.
    expect(showsRegularProductPrice(
      product, shapePromotionOffer(grant({ action: 'fixed_discount', value: 0 }), 'oneoff', 100),
    )).toBe(false);
  });

  it('explains the one refusal in the member\'s own language', () => {
    expect(purchaseErrorKey('promotion_not_applicable'))
      .toBe('membership.promotion_unavailable_error');
  });
});

describe('the Admin half (§11, §12, §13)', () => {
  it('renames the Member card\'s section in every locale', () => {
    // #1118 §11 named it *Products & Services*; #1185 renamed the section and
    // the tab beside it to *Products*. The key is untouched either time.
    const EXPECTED: Record<string, string> = {
      en: 'Products', es: 'Productos', ca: 'Productes',
    };
    for (const code of LOCALES) {
      expect(messages('admin', code).members.section_additional_services).toBe(EXPECTED[code]);
    }
  });

  it('leaves the Assigned Plan card\'s own section alone (§11 names Members only)', () => {
    for (const code of LOCALES) {
      expect(messages('admin', code).assigned_plans_page.section_additional_services)
        .not.toBe(messages('admin', code).members.section_additional_services);
    }
  });

  it('carries every key the purchased-products block names, in every locale', () => {
    const keys = [
      'purchased_products_label', 'purchased_products_none', 'periodic_services_label',
      'purchase_price', 'purchase_final_price', 'purchase_status', 'purchase_date',
      'purchase_status_pending_payment', 'purchase_status_active', 'purchase_status_cancelled',
      'purchase_promotion', 'purchase_promotion_cycles',
    ];
    for (const code of LOCALES) {
      const ns = messages('admin', code).members;
      for (const key of keys) {
        expect(ns[key], `${code}.json is missing members.${key}`).toBeTruthy();
      }
    }
  });

  it('reads the treatment through the one place a pair becomes words', () => {
    const src = read(
      REPO, 'apps', 'admin', 'src', 'app', '[locale]', 'members', 'MemberPurchasedProducts.tsx',
    );
    expect(src).toContain('benefitTreatmentLabel');
    // In the Promotion's own voice (§3), which is the namespace those labels
    // were written in — never a second vocabulary in `members`.
    expect(src).toContain("useTranslations('promotions')");
    // Read-only: a purchase is money that moved and no route edits one.
    expect(src).not.toContain('<button');
    expect(src).not.toContain('<select');
    expect(src).not.toContain('<input');
  });
});
