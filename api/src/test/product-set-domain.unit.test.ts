import { describe, expect, it } from 'vitest';
import {
  DRAFT_TTL_MINUTES, canCancelPending, canTransition, isDraftExpired, isInFlight, isProductSetStatus,
} from '../domain/productSet';
import {
  RESET_AUDIT_ENTITY_TYPES, RESET_CONFIRMATION, RESET_STEPS, evaluateResetGuard,
} from '../domain/devBillingReset';

describe('ProductSet lifecycle (#1325)', () => {
  it('allows only the agreed transitions', () => {
    expect(canTransition('draft', 'pending_payment')).toBe(true);
    expect(canTransition('draft', 'active')).toBe(true);
    expect(canTransition('pending_payment', 'active')).toBe(true);
    expect(canTransition('active', 'superseded')).toBe(true);
    expect(canTransition('pending_payment', 'draft')).toBe(false);
    expect(canTransition('active', 'draft')).toBe(false);
    expect(canTransition('superseded', 'active')).toBe(false);
    expect(canTransition('draft', 'superseded')).toBe(false);
  });

  it('knows its vocabulary and the in-flight slot', () => {
    expect(isProductSetStatus('cancelled')).toBe(false);
    expect(isProductSetStatus('active')).toBe(true);
    expect(isInFlight('draft')).toBe(true);
    expect(isInFlight('pending_payment')).toBe(true);
    expect(isInFlight('active')).toBe(false);
  });

  it('expires a Draft only after more than two hours of inactivity', () => {
    const now = Date.UTC(2026, 9, 10, 12, 0, 0);
    const limit = DRAFT_TTL_MINUTES * 60_000;
    expect(DRAFT_TTL_MINUTES).toBe(120);
    expect(isDraftExpired(now - limit, now)).toBe(false);
    expect(isDraftExpired(now - limit - 1, now)).toBe(true);
    expect(isDraftExpired(now, now)).toBe(false);
  });

  describe('cancelling a Pending Payment set', () => {
    it('allows it when nothing was ever sent to the provider', () => {
      expect(canCancelPending([])).toBe(true);
      expect(canCancelPending([{ providerRef: null, providerStatus: null, status: 'pending' }])).toBe(true);
    });
    it('allows it when every attempt is definitively unsuccessful', () => {
      expect(canCancelPending([
        { providerRef: 'p1', providerStatus: 'FAILED', status: 'failed' },
        { providerRef: 'p2', providerStatus: 'EXPIRED', status: 'expired' },
        { providerRef: 'p3', providerStatus: 'CANCELED', status: 'failed' },
      ])).toBe(true);
    });
    it('refuses an unknown outcome — submitted, no provider status', () => {
      expect(canCancelPending([{ providerRef: 'p1', providerStatus: null, status: 'pending' }])).toBe(false);
    });
    it('refuses anything that may still settle or already did', () => {
      for (const s of ['SUCCEEDED', 'PENDING', 'PENDING_PROCESSING', 'AUTHORIZED', 'PAID_OUT', 'REFUNDED']) {
        expect(canCancelPending([{ providerRef: 'p', providerStatus: s, status: 'completed' }])).toBe(false);
      }
      expect(canCancelPending([{ providerRef: null, providerStatus: null, status: 'completed' }])).toBe(false);
    });
  });
});

describe('development billing reset (#1325)', () => {
  it('deletes children before parents and never lists a preserved table', () => {
    const order = RESET_STEPS.map((s) => s.table);
    const before = (a: string, b: string) => order.indexOf(a) < order.indexOf(b);
    expect(before('payment_requests', 'billing_events')).toBe(true);
    expect(before('member_products_oneoff_snapshot', 'payment_requests')).toBe(true);
    expect(before('user_membership_promotions', 'user_memberships')).toBe(true);
    expect(before('user_membership_members', 'user_memberships')).toBe(true);
    expect(before('product_set_members', 'product_sets')).toBe(true);
    for (const kept of ['members', 'membership_plans', 'promotions', 'products', 'tax_rates', 'charge_types',
      'payment_methods', 'receipt_sequences', 'audit_logs', 'gyms', 'centers']) {
      expect(order).not.toContain(kept);
    }
  });

  it('removes the audit rows of the removed entities and of no catalogue', () => {
    expect([...RESET_AUDIT_ENTITY_TYPES].sort()).toEqual(
      ['billing_event', 'member_product', 'payment_request', 'product_set', 'user_membership']);
    for (const catalogue of ['membership_plan', 'promotion', 'product']) {
      expect(RESET_AUDIT_ENTITY_TYPES).not.toContain(catalogue);
    }
  });

  it('always allows a dry run', () => {
    expect(evaluateResetGuard({ connectedHost: undefined, confirmation: undefined, dryRun: true })).toEqual({ allowed: true });
  });

  it('fails closed without a target or the confirmation', () => {
    expect(evaluateResetGuard({ connectedHost: undefined, confirmation: RESET_CONFIRMATION, dryRun: false }).allowed).toBe(false);
    expect(evaluateResetGuard({ connectedHost: 'db.internal', confirmation: undefined, dryRun: false }).allowed).toBe(false);
    expect(evaluateResetGuard({ connectedHost: 'db.internal', confirmation: 'yes', dryRun: false }).allowed).toBe(false);
    expect(evaluateResetGuard({ connectedHost: 'db.internal', confirmation: RESET_CONFIRMATION, dryRun: false }).allowed).toBe(true);
  });
});
