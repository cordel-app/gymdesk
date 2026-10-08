// #1121 stage 2 — a member buying a Product: which Products may be bought,
// what state a purchase is in, what the purchase row is written with, and the
// three rules the money paths must not lose.
//
// Both halves are pure, which is why they are separate modules:
// `api/src/domain/memberProductPurchase.ts` owns the decisions and
// `apps/member/src/lib/memberProducts.ts` the labels, and neither needs a
// database, a provider or a browser to assert. What *is* asserted against the
// sources below is the handful of places where losing a line would be
// invisible at runtime — the webhook writing a card or a billing date for a
// purchase, a surface reading a purchase as an unpaid membership fee, a vocabulary
// drifting from its CHECK.
//
// It lives in the **API** suite because CI runs `npm test` in `api/` only
// (#1009's reason, the same one `member-products.unit.test.ts` gives).

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  MEMBER_PRODUCT_STATUSES,
  PENDING_PURCHASE_STATUS,
  PRODUCT_PURCHASE_SOURCE,
  PURCHASE_ACTOR_TYPES,
  type PurchasableProduct,
  describeProductPurchase,
  isPurchasable,
  productPurchaseBlock,
  purchaseBlockResponse,
  purchaseSnapshot,
  purchaseStateFor,
} from '../domain/memberProductPurchase';
import {
  type MemberProduct,
  PRODUCT_PURCHASE_SOURCE as MEMBER_APP_PURCHASE_SOURCE,
  isMembershipFeeRequest,
  purchaseErrorKey,
  purchaseStateKey,
  purchaseStateStatusWord,
  showsBuyAction,
} from '../../../apps/member/src/lib/memberProducts';
import { STORED_PRODUCT_FREQUENCIES } from '../domain/productFrequency';

const REPO = join(__dirname, '..', '..', '..');
const MEMBER = join(REPO, 'apps', 'member');
const LOCALES = ['en', 'es', 'ca'] as const;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const migration = require('../infra/migrations/228_member_product_purchases.js');

function read(...parts: string[]): string {
  return readFileSync(join(...parts), 'utf-8');
}

function messages(code: string): any {
  return JSON.parse(read(MEMBER, 'locales', 'base', `${code}.json`));
}

function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^\s*--.*$/gm, '');
}

function item(over: Partial<PurchasableProduct> = {}): PurchasableProduct {
  return {
    type: 'fee',
    billing_frequency: 'once',
    price_incl_tax: 50,
    units: null,
    name: 'Personal Training Session',
    currency: 'EUR',
    ...over,
  };
}

function product(over: Partial<MemberProduct> = {}): MemberProduct {
  return {
    id: 7,
    name: 'Personal Training Session',
    description: null,
    type: 'fee',
    units: null,
    billing_frequency: 'once',
    price_incl_tax: 50,
    currency: 'EUR',
    tax_included: true,
    purchase_state: 'available',
    purchasable: true,
    ...over,
  };
}

describe('which Products a member may buy (#1121 stage 2, Q3)', () => {
  it('a one-off is purchasable', () => {
    expect(productPurchaseBlock(item({ billing_frequency: 'once' }))).toBeNull();
    // A Product with no frequency at all, and a legacy `per_session` (#945),
    // bill exactly like `once` — `cadenceForProduct()` gives neither a
    // schedule — so both are one-offs here too.
    expect(productPurchaseBlock(item({ billing_frequency: null }))).toBeNull();
    expect(productPurchaseBlock(item({ billing_frequency: 'per_session' }))).toBeNull();
  });

  it('a recurring Product is refused, naming stage 2’s own boundary', () => {
    for (const frequency of ['week', 'four_weeks', 'month', 'year']) {
      expect(productPurchaseBlock(item({ billing_frequency: frequency })), frequency)
        .toBe('recurring_not_supported');
    }
  });

  // The recurring set is `isRecurringFrequency()`'s (#550), so a frequency
  // added to the catalogue cannot be purchasable here and periodical there.
  it('reads recurrence from the one classifier rather than a list of its own', () => {
    const source = withoutComments(read(REPO, 'api', 'src', 'domain', 'memberProductPurchase.ts'));
    expect(source).toContain('isRecurringFrequency');
    for (const frequency of STORED_PRODUCT_FREQUENCIES) {
      expect(source).not.toContain(`'${frequency}'`);
    }
  });

  it('an unpriced or free Product has nothing to charge', () => {
    expect(productPurchaseBlock(item({ price_incl_tax: null }))).toBe('no_price');
    expect(productPurchaseBlock(item({ price_incl_tax: 0 }))).toBe('no_price');
  });

  it('a checkout already in flight outranks every other answer', () => {
    expect(productPurchaseBlock(item(), true)).toBe('purchase_pending');
    expect(productPurchaseBlock(item({ billing_frequency: 'month' }), true)).toBe('purchase_pending');
    expect(isPurchasable(item(), true)).toBe(false);
  });

  it('refusals carry a code the member app can translate, with the right status', () => {
    expect(purchaseBlockResponse('purchase_pending')).toMatchObject({ status: 409, error: 'purchase_pending' });
    expect(purchaseBlockResponse('recurring_not_supported')).toMatchObject({ status: 400 });
    expect(purchaseBlockResponse('no_price')).toMatchObject({ status: 400 });
  });
});

describe('what state a purchase is in (#1121 §6)', () => {
  it('no row at all means available', () => {
    expect(purchaseStateFor([])).toBe('available');
  });

  it('a cancelled attempt leaves the Product available again', () => {
    // The third status exists for exactly this: a payment that failed or
    // expired must not keep the member from trying again.
    expect(purchaseStateFor(['cancelled'])).toBe('available');
  });

  it('a pending checkout outranks a completed purchase', () => {
    expect(purchaseStateFor(['active', 'pending_payment'])).toBe('pending_payment');
    expect(purchaseStateFor(['active'])).toBe('purchased');
  });

  // An `active` purchase is deliberately not a block: nothing in `products`
  // says an item may be bought once (`Q1` is explicit that the catalogue is the
  // gym's two existing columns and no new flag), so a second session package
  // months later is a real purchase.
  it('only a pending purchase takes the Buy action away', () => {
    expect(describeProductPurchase(item(), ['pending_payment']))
      .toEqual({ purchase_state: 'pending_payment', purchasable: false });
    expect(describeProductPurchase(item(), ['active']))
      .toEqual({ purchase_state: 'purchased', purchasable: true });
    expect(describeProductPurchase(item(), []))
      .toEqual({ purchase_state: 'available', purchasable: true });
  });

  it('a recurring Product is not purchasable in any state', () => {
    expect(describeProductPurchase(item({ billing_frequency: 'month' }), []).purchasable).toBe(false);
  });
});

describe('what a purchase row keeps (#1121 Q2, #635 §16)', () => {
  it('freezes what the member was shown, beside the link to the Product', () => {
    expect(purchaseSnapshot({
      name: 'Ten Sessions', type: 'sessions', billing_frequency: 'once', units: 10,
      price_incl_tax: 500, currency: 'EUR', tax_rate_percent: 21,
    })).toEqual({
      product_name: 'Ten Sessions',
      product_type: 'sessions',
      billing_frequency: 'once',
      units: 10,
      amount: 500,
      currency: 'EUR',
      tax_rate_percent: 21,
    });
  });

  // #942 — `amount` is the price of the whole package, so nothing divides by
  // the units it ships with.
  it('a Sessions package is charged for the package, not per session', () => {
    const snapshot = purchaseSnapshot({
      name: 'Ten Sessions', type: 'sessions', billing_frequency: 'once', units: 10,
      price_incl_tax: 500, currency: 'EUR', tax_rate_percent: null,
    });
    expect(snapshot.amount).toBe(500);
    expect(withoutComments(read(REPO, 'api', 'src', 'api', 'me-products.ts')))
      .not.toMatch(/\/\s*(item|product|snapshot)\.units/);
  });

  it('makes no claim about tax where the gym configured no rate', () => {
    expect(purchaseSnapshot({
      name: 'Locker', type: 'fee', billing_frequency: 'once', units: null,
      price_incl_tax: 15, currency: 'EUR', tax_rate_percent: null,
    }).tax_rate_percent).toBeNull();
  });

  // The route reads the Product through `memberProductCatalogueSql()`, the very
  // fragment that decided what the member was shown: a member must not be able
  // to buy what they cannot be shown, and two spellings of that is how it
  // happens (stage 1's reason for the fragment existing at all).
  it('is read through the catalogue’s own predicate', () => {
    const loader = read(REPO, 'api', 'src', 'api', 'me-products.ts');
    const purchase = loader.slice(loader.indexOf('export async function startProductPurchase'));
    expect(purchase).toContain("memberProductCatalogueSql('p')");
    expect(purchase).toContain('memberProductCatalogueParams()');
  });

  // The row exists before the member pays, so a closed tab loses nothing and a
  // webhook retry has one row to complete (#1118 §10). Its `status` is named in
  // the INSERT rather than left to the column default, so a second write path
  // cannot create an `active` purchase nobody paid for.
  it('is written pending, with its status named', () => {
    const loader = read(REPO, 'api', 'src', 'api', 'me-products.ts');
    const insert = loader.slice(loader.indexOf('INSERT INTO member_products'));
    expect(insert.slice(0, 400)).toContain('status');
    expect(loader).toContain('PENDING_PURCHASE_STATUS');
  });

  it('completion and cancellation are both constrained on the pending status', () => {
    const loader = read(REPO, 'api', 'src', 'api', 'me-products.ts');
    const updates = loader.match(/UPDATE member_products[\s\S]*?`/g) ?? [];
    expect(updates.length).toBeGreaterThanOrEqual(3);
    for (const update of updates) {
      expect(update).toMatch(/status = \?|status = 'cancelled'|mp\.status = \?/);
    }
    expect(loader).toContain('WHERE gym_id = ? AND payment_request_id = ? AND status = ?');
  });
});

describe('the vocabulary matches its CHECKs (migration 228)', () => {
  it('the statuses, the actor types and the source are the migration’s', () => {
    expect(migration.STATUSES).toEqual([...MEMBER_PRODUCT_STATUSES]);
    expect(migration.ACTOR_TYPES).toEqual([...PURCHASE_ACTOR_TYPES]);
    expect(migration.PURCHASE_SOURCE).toBe(PRODUCT_PURCHASE_SOURCE);
    // The Members App mirrors the value (the two apps share no module), so a
    // rename has to move both or the Pay-now prompt reads a purchase as a fee.
    expect(MEMBER_APP_PURCHASE_SOURCE).toBe(PRODUCT_PURCHASE_SOURCE);
    expect(MEMBER_PRODUCT_STATUSES).toContain(PENDING_PURCHASE_STATUS);
  });

  it('the UNIQUE key covers the pending status only', () => {
    const source = read(REPO, 'api', 'src', 'infra', 'migrations', '228_member_product_purchases.js');
    const generated = source.slice(source.indexOf('pending_purchase_key VARCHAR'));
    expect(generated.slice(0, 300)).toContain("IF(status = 'pending_payment'");
    expect(source).toContain('UNIQUE KEY ${PREFIX}_pending_purchase_key');
    expect(source).toContain('UNIQUE KEY ${PREFIX}_payment_request_key');
  });

  it('every domain table has gym_id, and this one is scoped by it', () => {
    const source = read(REPO, 'api', 'src', 'infra', 'migrations', '228_member_product_purchases.js');
    expect(source).toContain('gym_id               CHAR(36)      NOT NULL');
    const loader = read(REPO, 'api', 'src', 'api', 'me-products.ts');
    for (const statement of loader.match(/FROM member_products[\s\S]*?`/g) ?? []) {
      expect(statement).toContain('gym_id = ?');
    }
  });
});

describe('a purchase is not a membership cycle (the money paths)', () => {
  const webhook = () => {
    const source = read(REPO, 'api', 'src', 'api', 'webhooks.ts');
    const start = source.indexOf("payload.status === 'completed' && pr.source === PRODUCT_PURCHASE_SOURCE");
    expect(start).toBeGreaterThan(0);
    return source.slice(start, source.indexOf("} else if (payload.status === 'completed') {", start));
  };

  // Each of these would be wrong in a way nothing fails on: a card stored from
  // a one-off authorisation, a billing date invented for an assignment the
  // purchase does not name, or #785's dunning pair cleared by a member buying a
  // locker while their rejected fee is still owed.
  it('stores no card, stamps no billing date and clears no dunning state', () => {
    const branch = withoutComments(webhook());
    expect(branch).not.toContain('payment_methods');
    expect(branch).not.toContain('stampFirstNextBillingDate');
    expect(branch).not.toContain('failed_attempts');
  });

  it('writes the Billing Event the ledger reads, with no assignment', () => {
    const branch = webhook();
    expect(branch).toContain('INSERT INTO billing_events');
    expect(branch).toContain("'payment_recorded'");
    expect(branch).toContain('NULL, ?');
    expect(branch).toContain('completeProductPurchase');
  });

  it('a failed or expired payment cancels the purchase', () => {
    const source = read(REPO, 'api', 'src', 'api', 'webhooks.ts');
    const branch = source.slice(source.indexOf("payload.status === 'failed' || payload.status === 'expired'"));
    expect(branch.slice(0, 900)).toContain('cancelProductPurchase');
  });

  // The pending key is UNIQUE, so a purchase left pending by a missed webhook
  // would block that member from ever buying the Product again.
  it('the cleanup run frees a purchase whose payment is over', () => {
    const billing = read(REPO, 'api', 'src', 'api', 'billing.ts');
    expect(billing).toContain('cancelAbandonedPurchases');
    // `expired` stays the total the workflow parses (#778/#780), and the
    // purchases are reported beside it rather than folded into it.
    expect(billing).toContain('const expired = unopened + abandoned;');
    expect(billing).toContain('purchases_cancelled: purchasesCancelled');
  });

  // #1235 reversed the Members list's `payment_status` from "the membership
  // fee" to the worst status across every billable concept, so a purchase is
  // counted there; the Pay-now prompt below is still about the fee alone.
  it('a purchase counts in the member’s aggregated payment status', () => {
    expect(read(REPO, 'api', 'src', 'api', 'members.ts'))
      .toContain('memberPaymentStatusSql');
    // The page asks the shared rule rather than spelling the source: the
    // member's history keeps listing a purchase (it is money), and what the
    // Pay-now prompt is about is the *fee*.
    expect(isMembershipFeeRequest('customer')).toBe(true);
    expect(isMembershipFeeRequest(MEMBER_APP_PURCHASE_SOURCE)).toBe(false);
    const page = withoutComments(read(MEMBER, 'src', 'app', '[locale]', 'membership', 'page.tsx'));
    const pending = page.slice(page.indexOf('const pendingRequest'));
    expect(pending.slice(0, 200)).toContain('isMembershipFeeRequest(r.source)');
    expect(page).not.toContain("'product_purchase'");
  });

  // The hosted page's consent sentence is a statement about what is being
  // authorised, and the fee's promises a recurring charge.
  it('the hosted page words a one-off purchase as one', () => {
    const checkout = read(REPO, 'apps', 'payment', 'js', 'checkout.js');
    expect(checkout).toContain("data.purpose === 'product_purchase'");
    expect(checkout).toContain('Es un pago único.');
    const page = read(REPO, 'api', 'src', 'api', 'payment-page.ts');
    expect(page).toContain('PRODUCT_PURCHASE_SOURCE');
    // An INNER JOIN on the assignment answered "token not found" for every
    // purchase, which is indistinguishable from a real expiry.
    expect(page).toContain('LEFT JOIN user_memberships um ON um.id = pr.user_membership_id');
  });
});

describe('the route (#1121 stage 2 §5)', () => {
  const route = () => {
    const source = read(REPO, 'api', 'src', 'api', 'me.ts');
    const start = source.indexOf("meRouter.post(\n  '/products/:id/purchase'");
    expect(start).toBeGreaterThan(0);
    return source.slice(start, start + 900);
  };

  it('is the member’s own, behind both flags and a limiter', () => {
    const source = route();
    expect(source).toContain("requireRole('member')");
    expect(source).toContain("requireFeatureEnabled('member_web.my_membership')");
    expect(source).toContain("requireFeatureEnabled('financials.products')");
    expect(source).toContain('memberPurchaseRateLimit');
  });

  // #1036's rule: the member is resolved from the session, never named by the
  // request, so another member's purchase is unreachable whatever the payload.
  it('never takes a member id from the request', () => {
    const source = route();
    expect(source).toContain('resolveMemberId');
    expect(source).not.toContain('member_id');
  });
});

describe('how the Members App words it', () => {
  it('a pill reads from the app’s one status-tone map', () => {
    expect(purchaseStateStatusWord('pending_payment')).toBe('pending');
    expect(purchaseStateStatusWord('purchased')).toBe('active');
    expect(purchaseStateStatusWord('available')).toBeNull();
    // Both words are ones `statusTone()` answers for, or the pill would read
    // neutral grey for a state the rest of the app colours (#983).
    const chrome = read(MEMBER, 'src', 'lib', 'memberChrome.ts');
    const tone = chrome.slice(chrome.indexOf('export function statusTone'));
    expect(tone).toContain("case 'pending':");
    expect(tone).toContain("case 'active':");
  });

  it('only an available, purchasable Product offers Buy', () => {
    expect(showsBuyAction(product())).toBe(true);
    expect(showsBuyAction(product({ purchasable: false }))).toBe(false);
    expect(showsBuyAction(product({ purchase_state: 'pending_payment', purchasable: false }))).toBe(false);
    expect(showsBuyAction(product({ purchase_state: 'purchased' }))).toBe(false);
  });

  it('a state with nothing to report renders no pill', () => {
    expect(purchaseStateKey('available')).toBeNull();
    expect(purchaseStateKey('pending_payment')).toBe('membership.product_state_pending');
    expect(purchaseStateKey('purchased')).toBe('membership.product_state_purchased');
  });

  it('a refusal is read in the member’s language, never the route’s English', () => {
    expect(purchaseErrorKey('purchase_pending')).toBe('membership.product_purchase_pending_error');
    expect(purchaseErrorKey('recurring_not_supported')).toBe('membership.product_purchase_recurring_error');
    expect(purchaseErrorKey('no_price')).toBe('membership.product_purchase_unpriced_error');
    // A 500, a network failure or a rate limit is not a code — the generic key
    // is decided here rather than by `t()`, which prints a missing key verbatim.
    expect(purchaseErrorKey('Too many purchase attempts. Please try again later.'))
      .toBe('membership.product_purchase_error');
    expect(purchaseErrorKey(undefined)).toBe('membership.product_purchase_error');
  });

  it('every key the purchase flow resolves exists in all three locales', () => {
    for (const code of LOCALES) {
      const ns = messages(code).membership;
      for (const key of [
        'product_buy', 'product_state_pending', 'product_state_purchased',
        'product_purchase_title', 'product_purchase_body', 'product_purchase_once',
        'product_purchase_confirm', 'product_purchase_cancel', 'product_purchase_submitting',
        'product_purchase_error', 'product_purchase_pending_error',
        'product_purchase_recurring_error', 'product_purchase_unpriced_error',
      ]) {
        expect(ns[key], `${code}.membership.${key}`).toBeTruthy();
      }
    }
  });

  it('the confirmation names the item and its price', () => {
    for (const code of LOCALES) {
      const body = messages(code).membership.product_purchase_body;
      expect(body, code).toContain('{name}');
      expect(body, code).toContain('{price}');
    }
  });

  // #983 — the Members App spells a visual value in exactly one place, and
  // #1115 — the app has one dialog shell rather than a second overlay.
  it('neither half spells a colour, and the dialog is the app’s own', () => {
    const lib = withoutComments(read(MEMBER, 'src', 'lib', 'memberProducts.ts'));
    const card = withoutComments(read(MEMBER, 'src', 'components', 'MemberProductsSection.tsx'));
    for (const source of [lib, card]) {
      expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(source).not.toMatch(/\bt\(/);
    }
    expect(read(MEMBER, 'src', 'app', '[locale]', 'membership', 'page.tsx'))
      .toContain('MemberDialog');
  });
});
