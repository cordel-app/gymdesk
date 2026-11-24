// #3273 — which attempt of a purchase's Billing Event the Purchases tab reads, and its status.
import { describe, expect, it } from 'vitest';
import { purchasePayment, type PurchaseAttempt } from '../domain/purchasePayment';

const a = (id: number, status: string, created: string, extra: Partial<PurchaseAttempt> = {}): PurchaseAttempt => ({
  id, status, provider_status: null, method: 'cash', payment_method_name: `M${id}`, payment_method_code: null,
  created_at: created, completed_at: status === 'completed' ? created : null, ...extra,
});

describe('purchasePayment (#3273)', () => {
  it('reports nothing for an event with no attempt', () => {
    expect(purchasePayment([])).toMatchObject({ attempt_id: null, payment_status: null, paid_at: null, attempt_count: 0 });
  });

  it('shows the latest attempt, with no payment date, when none succeeded', () => {
    const p = purchasePayment([a(1, 'failed', '2026-11-01T10:00:00Z'), a(2, 'expired', '2026-11-02T10:00:00Z')]);
    // #3289: no provider status was received, so the provider status reads nothing.
    expect(p).toMatchObject({ attempt_id: 2, payment_method_name: 'M2', payment_status: null, paid_at: null, attempt_count: 2 });
  });

  it('prefers the provider\'s normalized status over the row status', () => {
    const p = purchasePayment([a(1, 'pending', '2026-11-01T10:00:00Z', { provider_status: 'PENDING_PROCESSING' })]);
    expect(p.payment_status).toBe('pending');
  });

  it('#3352: a refund never moves the payment status, which is the provider\'s alone', () => {
    const p = purchasePayment([a(1, 'completed', '2026-11-01T10:00:00Z', { provider_status: 'SUCCEEDED' })]);
    expect(p).toMatchObject({ payment_status: 'completed', paid_at: '2026-11-01T10:00:00.000Z' });
  });

  it('#3289: never falls back to the internal request status when the provider sent none', () => {
    expect(purchasePayment([a(1, 'pending', '2026-11-01T10:00:00Z', { method: 'provider' })]).payment_status).toBeNull();
    expect(purchasePayment([a(1, 'completed', '2026-11-01T10:00:00Z')]).payment_status).toBeNull();
  });

  it('#3289: an unrecognised raw provider status normalizes to nothing', () => {
    expect(purchasePayment([a(1, 'pending', '2026-11-01T10:00:00Z', { provider_status: 'WEIRD' })]).payment_status).toBeNull();
  });
});
