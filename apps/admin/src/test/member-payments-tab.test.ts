import { describe, it, expect } from 'vitest';
import { splitPaymentsTabEvents, isUnresolvedEvent, type PaymentsTabEvent } from '../app/[locale]/members/paymentsTabView';

const ev = (id: number | null, status: string, date: string, type?: 'real' | 'virtual'): PaymentsTabEvent => ({
  id, type, status, billing_date: date, created_at: null, amount: '10.00', event_type: 'payment_recorded', plan_name: null,
});

describe('Member Payments tab (#2099)', () => {
  it('puts failed, pending and scheduled events on top and the rest under past', () => {
    const { unresolved, past } = splitPaymentsTabEvents([
      ev(1, 'paid', '2026-01-01'), ev(2, 'scheduled', '2026-12-01'), ev(3, 'failed', '2026-10-01'),
      ev(4, 'scheduled', '2026-11-01'), ev(5, 'recorded', '2026-02-01'), ev(6, 'pending', '2026-10-02'),
    ]);
    expect(unresolved.map((e) => e.id)).toEqual([3, 6, 4, 2]);
    expect(past.map((e) => e.id)).toEqual([5, 1]);
  });

  it('never shows a projected (virtual or id-less) event, whatever its status', () => {
    const { unresolved, past } = splitPaymentsTabEvents([
      ev(null, 'scheduled', '2026-12-01'), ev(9, 'failed', '2026-10-01', 'virtual'), ev(10, 'failed', '2026-10-01'),
    ]);
    expect(unresolved.map((e) => e.id)).toEqual([10]);
    expect(past).toEqual([]);
  });

  it('reads unresolved from the API-derived status only', () => {
    expect(isUnresolvedEvent('paid')).toBe(false);
    expect(isUnresolvedEvent('failed')).toBe(true);
  });
});
