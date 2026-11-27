import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  billingEventPaymentItems, paymentItemLabel, paymentModalAmountLabel, paymentModalUnchanged,
} from '../lib/paymentModal';

// #3498 — Save & Pay and Pay now draw one payment modal. No component-test infra exists for
// apps/admin, so the wiring is read from the source; the rules are the pure module's.

const APP = join(__dirname, '..', 'app', '[locale]');
const REVIEW = readFileSync(join(APP, 'members', 'ReviewChangesModal.tsx'), 'utf8');
const PAY_NOW = readFileSync(join(APP, 'payments', 'billing-events', 'PayNowModal.tsx'), 'utf8');
const SHARED = readFileSync(join(__dirname, '..', 'components', 'PaymentModal.tsx'), 'utf8');

describe('#3498 headline amount', () => {
  it('reads 0 € for nothing owed and — when unknown', () => {
    expect(paymentModalAmountLabel(0)).toBe('0 €');
    expect(paymentModalAmountLabel('0.00')).toBe('0 €');
    expect(paymentModalAmountLabel(null)).toBe('—');
    expect(paymentModalAmountLabel(undefined)).toBe('—');
    expect(paymentModalAmountLabel('abc')).toBe('—');
  });

  it('formats a positive amount with the gym formatter', () => {
    expect(paymentModalAmountLabel(1234.5)).toMatch(/1[.,]234[.,]50 €/);
    expect(paymentModalAmountLabel('40.00')).toMatch(/40[.,]00 €/);
  });
});

describe('#3498 items', () => {
  it('maps the event lines in their stored order, quantity appended above one', () => {
    const items = billingEventPaymentItems([
      { id: 2, item_name: 'Gold Plan', quantity: 1, amount: '30.00' },
      { id: 5, item_name: 'Locker Rental', quantity: '2', amount: '10.00' },
      { id: 7, item_name: null, quantity: null, amount: null },
    ]);
    expect(items.map((i) => i.key)).toEqual(['2', '5', '7']);
    expect(items.map(paymentItemLabel)).toEqual(['Gold Plan', 'Locker Rental × 2', '—']);
    expect(items.map((i) => i.amount)).toEqual([30, 10, 0]);
    expect(billingEventPaymentItems(undefined)).toEqual([]);
  });

  it('treats a moved amount or a changed item as stale', () => {
    const items = billingEventPaymentItems([{ id: 1, item_name: 'Fee', quantity: 1, amount: '40.00' }]);
    expect(paymentModalUnchanged({ amount: '40.00', items }, { amount: 40, items })).toBe(true);
    expect(paymentModalUnchanged({ amount: '40.00', items }, { amount: '39.99', items })).toBe(false);
    const other = billingEventPaymentItems([{ id: 1, item_name: 'Fee', quantity: 2, amount: '40.00' }]);
    expect(paymentModalUnchanged({ amount: '40.00', items }, { amount: '40.00', items: other })).toBe(false);
    expect(paymentModalUnchanged({ amount: '40.00', items }, { amount: '40.00', items: [] })).toBe(false);
  });
});

describe('#3498 both flows render the shared modal', () => {
  it('Save & Pay and Pay now use PaymentModal and its method selector, not CrudModal', () => {
    for (const src of [REVIEW, PAY_NOW]) {
      expect(src).toContain('<PaymentModal');
      expect(src).toContain('<PaymentMethodSelect');
      expect(src).not.toContain('<CrudModal');
      expect(src).not.toContain('<select');
    }
  });

  it('the headline is the authoritative amount, never the forecast', () => {
    expect(REVIEW).toMatch(/amount=\{review\?\.amount_due \?\? null\}/);
    expect(REVIEW).not.toMatch(/amount=\{[^}]*forecast/);
    expect(PAY_NOW).toMatch(/const headline = shown\?\.amount \?\? amount;/);
  });

  it('Pay now lists the event lines and re-reads them before collecting', () => {
    expect(PAY_NOW).toContain('<PaymentItemsTable');
    const pay = PAY_NOW.slice(PAY_NOW.indexOf('async function pay()'));
    expect(pay.indexOf('paymentModalUnchanged(')).toBeGreaterThan(0);
    expect(pay.indexOf('paymentModalUnchanged(')).toBeLessThan(pay.indexOf('payNowRequest('));
  });

  it('the shared modal puts the amount in the header aside and the items under one heading', () => {
    expect(SHARED).toContain('headerAside={');
    expect(SHARED).toContain('paymentModalAmountLabel(amount, fmt)');
    expect(SHARED).toContain('{itemsLabel}');
  });
});
