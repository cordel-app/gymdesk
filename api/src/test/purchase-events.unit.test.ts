import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  isAwaitingAction,
  isNonObligationEvent,
  isReceiptableEvent,
  NON_OBLIGATION_EVENT_TYPES,
} from '../domain/billingEventStatus';

const src = (...p: string[]) => readFileSync(join(__dirname, '..', ...p), 'utf8');

describe('one-off purchase and card verification events (#1325 PR 2)', () => {
  it('a paid purchase earns a receipt, a pending or failed one does not', () => {
    expect(isReceiptableEvent('product_purchase', 'completed')).toBe(true);
    expect(isReceiptableEvent('product_purchase', 'pending')).toBe(false);
    expect(isReceiptableEvent('product_purchase', 'failed')).toBe(false);
  });

  it('a verification never earns a receipt: it moved no money', () => {
    expect(isReceiptableEvent('card_verification', 'completed')).toBe(false);
  });

  it('neither is an obligation or in the staff attention queue', () => {
    for (const type of NON_OBLIGATION_EVENT_TYPES) {
      expect(isNonObligationEvent(type)).toBe(true);
      expect(isAwaitingAction(type, 'failed')).toBe(false);
    }
    expect(isNonObligationEvent('recurring_payment')).toBe(false);
    expect(isAwaitingAction('failed_billing', null)).toBe(true);
  });

  it('the purchase writes its event with the request and the webhook settles it', () => {
    const me = src('api', 'me-products.ts');
    expect(me).toContain("'product_purchase', ?, ?, 'provider'");
    expect(me).toContain('UPDATE payment_requests SET billing_event_id = ?');
    expect(me).not.toContain('billing_event_id = ?, modified_at');
  });

  it('a card verification is an event of amount 0 linked to its request', () => {
    const cards = src('api', 'card-updates.ts');
    expect(cards).toContain("'card_verification', 0");
    expect(cards).toContain("status = 'active'");
    expect(cards).toContain('billing_event_id');
  });

  it('the revenue cards and the attention queue leave both out', () => {
    expect(src('api', 'payments-dashboard.ts')).toContain("NOT IN ('product_purchase', 'card_verification')");
    expect(src('api', 'payments.ts')).toContain("NOT IN ('product_purchase', 'card_verification')");
  });

  it('the snapshot tables carry the ProductSet names', () => {
    const migration = src('infra', 'migrations', '251_purchase_snapshot_tables.js');
    for (const name of [
      'member_products_oneoff_snapshot',
      'member_products_oneoff_promotion_snapshot',
      'member_products_recurrent_snapshot',
    ]) expect(migration).toContain(name);
  });
});
