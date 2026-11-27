import { describe, expect, it } from 'vitest';
import {
  purchaseCancelMessageKey,
  cartCountdown,
  purchasePriceCell,
  isPurchaseExpiredError,
  billingEventPath,
  filterPurchasesByStatus,
  formatAppliedTax,
  orderPurchasesForTable,
  hasBillingEvent,
  paymentStatusKey,
  purchaseDate,
  purchaseErrorKey,
  showsAssigneeSelector,
  sharingTypeKey,
  yesNoKey,
  productTypeLabelKey,
  purchaseEndDisplay,
} from '@/app/[locale]/members/purchasedProductsView';

// #1521 — the Products card's pure rules: stored values only, `null` where the
// system never stored one, and the billing event named by the purchase itself.

describe('purchased products view (#1521)', () => {
  it('lists a purchase under when it was bought, else when it was created', () => {
    expect(purchaseDate({ purchased_at: '2026-10-01', created_at: '2026-09-30' })).toBe('2026-10-01');
    expect(purchaseDate({ purchased_at: null, created_at: '2026-09-30' })).toBe('2026-09-30');
    expect(purchaseDate({ purchased_at: null, created_at: null })).toBeNull();
  });

  it('reports the stored tax percentage and never invents one', () => {
    expect(formatAppliedTax(21)).toBe('21%');
    expect(formatAppliedTax(10.5)).toBe('10.5%');
    expect(formatAppliedTax(0)).toBe('0%');
    expect(formatAppliedTax(null)).toBeNull();
    expect(formatAppliedTax(undefined)).toBeNull();
  });

  it('only resolves the payment statuses the table can hold', () => {
    for (const s of ['pending', 'completed', 'failed', 'expired']) expect(paymentStatusKey(s)).toBe(s);
    expect(paymentStatusKey(null)).toBeNull();
    expect(paymentStatusKey('refunded')).toBeNull();
  });

  it('opens the purchase\'s own billing event, and nothing when it has none', () => {
    expect(billingEventPath('en', { billing_event_id: 42 })).toBe('/en/payments/billing-events?id=42');
    expect(billingEventPath('es', { billing_event_id: null })).toBeNull();
    expect(billingEventPath('es', {})).toBeNull();
    expect(hasBillingEvent({ billing_event_id: 0 })).toBe(false);
    expect(hasBillingEvent({ billing_event_id: 7 })).toBe(true);
  });
});

describe('filterPurchasesByStatus (#1654)', () => {
  const rows = [{ status: 'in_cart' }, { status: 'active' }, { status: 'pending_payment' }, { status: 'cancelled' }];
  it('defaults to draft + active + pending payment (#1657)', () => {
    expect(filterPurchasesByStatus(rows, 'open').map((r) => r.status)).toEqual(['in_cart', 'active', 'pending_payment']);
  });
  it('shows everything for all and one status when chosen', () => {
    expect(filterPurchasesByStatus(rows, '')).toHaveLength(4);
    expect(filterPurchasesByStatus(rows, 'cancelled')).toEqual([{ status: 'cancelled' }]);
  });
});

// #2609 stage 1 — the *Assigned to* selector exists only where there is a choice.
describe('assigned family member (#2609)', () => {
  const family = [{ member_id: 1, name: 'Owner', is_owner: true }, { member_id: 2, name: 'Kid', is_owner: false }];

  it('is offered for an individual Product of a member with a family, and nowhere else', () => {
    expect(showsAssigneeSelector(family, { sharing_type: 'individual' })).toBe(true);
    expect(showsAssigneeSelector(family, { sharing_type: null })).toBe(true);
    expect(showsAssigneeSelector(family, { sharing_type: 'shared' })).toBe(false);
    expect(showsAssigneeSelector([family[0]], { sharing_type: 'individual' })).toBe(false);
    expect(showsAssigneeSelector([], { sharing_type: 'individual' })).toBe(false);
    expect(showsAssigneeSelector(null, { sharing_type: 'individual' })).toBe(false);
    expect(showsAssigneeSelector(family, null)).toBe(false);
  });

  it('maps the server refusals to their own messages', () => {
    expect(purchaseErrorKey('assignee_not_in_family')).toBe('assignee_not_in_family');
    expect(purchaseErrorKey('assignee_not_allowed')).toBe('assignee_not_allowed');
    expect(purchaseErrorKey('assignee_invalid')).toBe('assignee_invalid');
  });
});

describe('editableDraftLineId (#2856)', () => {
  it('offers Edit/Delete only on a recurring row the open Draft carries', async () => {
    const { editableDraftLineId } = await import('@/app/[locale]/members/purchasedProductsView');
    expect(editableDraftLineId({ source: 'recurring', draft_line_id: 12 })).toBe(12);
    // A committed line with no open Draft, a line the Draft removed, a one-time purchase: nothing
    // (#3358 stage 2: the API answers `draft_line_id: null` for a line the Draft removed or cancels).
    expect(editableDraftLineId({ source: 'recurring', draft_line_id: null })).toBeNull();
    expect(editableDraftLineId({ source: 'one_off', draft_line_id: 12 })).toBeNull();
  });

  // #3358 stage 2 — the shared cancellation lifecycle: a Product the cart cancels, and one
  // cancelling at its End Date, are still open work; only `cancelled` leaves the default filter.
  it('keeps every live cancellation state in the default open filter', async () => {
    const { filterPurchasesByStatus, PURCHASE_STATUS_FILTER_DEFAULT } =
      await import('@/app/[locale]/members/purchasedProductsView');
    const rows = [
      { status: 'active' }, { status: 'in_cart' }, { status: 'pending_payment' },
      { status: 'to_be_canceled' }, { status: 'to_be_canceled_immediately' },
      { status: 'active_cancel_at_period_end' }, { status: 'cancelled' },
    ];
    expect(filterPurchasesByStatus(rows, PURCHASE_STATUS_FILTER_DEFAULT).map((r) => r.status)).toEqual([
      'active', 'in_cart', 'pending_payment',
      'to_be_canceled', 'to_be_canceled_immediately', 'active_cancel_at_period_end',
    ]);
    expect(filterPurchasesByStatus(rows, 'cancelled').map((r) => r.status)).toEqual(['cancelled']);
  });
});

describe('#2962 — cartCountdown', () => {
  const at = '2026-11-16T12:00:00.000Z';
  const now = Date.parse(at);
  it('formats the time left as H:MM:SS', () => {
    expect(cartCountdown(at, now - (2 * 3600 - 1) * 1000)).toEqual({ remainingMs: (2 * 3600 - 1) * 1000, expired: false, label: '1:59:59' });
    expect(cartCountdown(at, now - 61_000)?.label).toBe('0:01:01');
  });
  it('is expired at and after the instant, never negative', () => {
    expect(cartCountdown(at, now)).toEqual({ remainingMs: 0, expired: true, label: '0:00:00' });
    expect(cartCountdown(at, now + 5000)?.expired).toBe(true);
  });
  it('is null with no or an unreadable instant', () => {
    expect(cartCountdown(null, now)).toBeNull();
    expect(cartCountdown('not a date', now)).toBeNull();
  });
  it('recognises the server refusal to pay an expired purchase', () => {
    expect(isPurchaseExpiredError({ status: 410, body: { error: 'purchase_expired' } })).toBe(true);
    expect(isPurchaseExpiredError({ status: 410, body: { error: 'draft_expired' } })).toBe(false);
  });
});

describe('expanded product row facts (#3021)', () => {
  it('maps booleans to yes/no and leaves an unreadable Product as null', () => {
    expect(yesNoKey(true)).toBe('yes');
    expect(yesNoKey(false)).toBe('no');
    expect(yesNoKey(null)).toBeNull();
    expect(yesNoKey(undefined)).toBeNull();
  });
  it('knows only the two sharing types, never printing a missing key', () => {
    expect(sharingTypeKey('individual')).toBe('individual');
    expect(sharingTypeKey('shared')).toBe('shared');
    expect(sharingTypeKey('family_x')).toBeNull();
    expect(sharingTypeKey(null)).toBeNull();
  });
});

describe('orderPurchasesForTable (#3161)', () => {
  const row = (id: number, created_at: string | null) => ({ id, created_at });
  it('lists oldest first, so a Product saved from the bottom draft row stays the last row', () => {
    const before = [row(3, '2026-11-20T10:00:00Z'), row(1, '2026-11-01T10:00:00Z'), row(7, '2026-11-10T10:00:00Z')];
    const saved = [row(9, '2026-11-22T00:10:00Z'), ...before]; // the API lists newest first
    expect(orderPurchasesForTable(before).map((r) => r.id)).toEqual([1, 7, 3]);
    expect(orderPurchasesForTable(saved).map((r) => r.id)).toEqual([1, 7, 3, 9]);
  });
  it('breaks a created_at tie by id and puts a row with no date first, without mutating the input', () => {
    const input = [row(5, '2026-11-01T10:00:00Z'), row(4, '2026-11-01T10:00:00Z'), row(8, null)];
    expect(orderPurchasesForTable(input).map((r) => r.id)).toEqual([8, 4, 5]);
    expect(input.map((r) => r.id)).toEqual([5, 4, 8]);
  });
});

describe('productTypeLabelKey (#3190)', () => {
  it('answers the Products page key for every Product Type', () => {
    expect(productTypeLabelKey('fee')).toBe('type_fee');
    expect(productTypeLabelKey('sessions')).toBe('type_sessions');
    expect(productTypeLabelKey('merchandise')).toBe('type_merchandise');
  });

  it('answers null for an absent or unknown type, so the cell reads a dash', () => {
    expect(productTypeLabelKey(null)).toBeNull();
    expect(productTypeLabelKey('')).toBeNull();
    expect(productTypeLabelKey('locker')).toBeNull();
  });
});

// #3189 — Merchandise reads — in the End date column; other types keep theirs.
describe('purchaseEndDisplay', () => {
  it('reads a dash for Merchandise, whatever dates it holds', () => {
    expect(purchaseEndDisplay({ product_type: 'merchandise', valid_until: null, cancelled_on: null })).toEqual({ kind: 'dash' });
    expect(purchaseEndDisplay({ product_type: 'merchandise', valid_until: '2026-12-01', cancelled_on: null })).toEqual({ kind: 'dash' });
  });
  it('keeps the date or Open-ended for other types', () => {
    expect(purchaseEndDisplay({ product_type: 'fee', valid_until: null, cancelled_on: null })).toEqual({ kind: 'open_ended' });
    expect(purchaseEndDisplay({ product_type: 'sessions', valid_until: '2026-12-01', cancelled_on: null })).toEqual({ kind: 'date', value: '2026-12-01' });
    expect(purchaseEndDisplay({ product_type: 'other', valid_until: null, cancelled_on: '2026-11-02' })).toEqual({ kind: 'date', value: '2026-11-02' });
  });
});

describe('purchasePriceCell (#3359)', () => {
  const line = { amount: 27, regular_amount: 30, quantity: 2, unit_amount: 13.5, regular_unit_amount: 15 };
  it('shows the line totals with a quantity × unit breakdown', () => {
    expect(purchasePriceCell(line, 'base')).toEqual({ total: 30, breakdown: { quantity: 2, unit: 15 } });
    expect(purchasePriceCell(line, 'final')).toEqual({ total: 27, breakdown: { quantity: 2, unit: 13.5 } });
  });
  it('shows no breakdown for a quantity of 1, or when the API gave no unit figure', () => {
    expect(purchasePriceCell({ ...line, quantity: 1 }, 'final').breakdown).toBeNull();
    expect(purchasePriceCell({ amount: 27, regular_amount: 30, quantity: 2 }, 'base')).toEqual({ total: 30, breakdown: null });
  });
});

describe('purchaseCancelMessageKey (#3508)', () => {
  it('words a recurring Product like a plan cancellation, naming the date once it is known', () => {
    expect(purchaseCancelMessageKey({ source: 'recurring' }, '2026-11-30')).toBe('purchase_cancel_confirm_recurring_until');
    expect(purchaseCancelMessageKey({ source: 'recurring' }, null)).toBe('purchase_cancel_confirm_recurring');
  });
  it('keeps the one-time Product wording', () => {
    expect(purchaseCancelMessageKey({ source: 'one_time' }, '2026-11-30')).toBe('purchase_cancel_confirm');
    expect(purchaseCancelMessageKey({}, null)).toBe('purchase_cancel_confirm');
  });
});
