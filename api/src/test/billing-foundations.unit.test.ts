import { describe, expect, it } from 'vitest';
import { classifyProviderStatus, isKnownProviderStatus, normaliseProviderStatus } from '../domain/providerPaymentStatus';
import { blockingEvents, isEditLocked, LockEvent } from '../domain/billingEventEditLock';
import { chargeGuard } from '../domain/chargeGuard';
import { allocateSchedule, cadenceForFrequency, nextScheduleKey } from '../domain/scheduleAllocation';
import { daysBetween, periodDays, prorate } from '../domain/proration';
import { linesMatchTotal, linesTotal, lineFromSimulation, roundCents } from '../domain/billingEventLines';
import { verifyAndParseWebhook } from '../payments/providers/monei/webhook';
import crypto from 'crypto';

describe('provider payment status (#1325)', () => {
  it('keeps the provider status verbatim and classifies it without defaulting to failure', () => {
    expect(classifyProviderStatus('SUCCEEDED')).toBe('settled');
    expect(classifyProviderStatus('PAID_OUT')).toBe('settled');
    expect(classifyProviderStatus('REFUNDED')).toBe('returned');
    expect(classifyProviderStatus('PARTIALLY_REFUNDED')).toBe('returned');
    expect(classifyProviderStatus('PENDING_PROCESSING')).toBe('in_flight');
    expect(classifyProviderStatus('AUTHORIZED')).toBe('in_flight');
    expect(classifyProviderStatus('PROCESSING')).toBe('in_flight'); // legacy spelling
    expect(classifyProviderStatus('CANCELED')).toBe('unsuccessful');
    expect(classifyProviderStatus('SOMETHING_NEW')).toBe('unknown');
    expect(classifyProviderStatus(null)).toBe('unknown');
    expect(isKnownProviderStatus('SOMETHING_NEW')).toBe(false);
    expect(normaliseProviderStatus(' succeeded ')).toBe('SUCCEEDED');
    expect(normaliseProviderStatus('')).toBeNull();
  });

  it('the MONEI webhook carries the raw status next to the legacy mapping', () => {
    const secret = 'whsec';
    const body = Buffer.from(JSON.stringify({
      objectType: 'charge',
      id: 'pay_1',
      object: { id: 'pay_1', orderId: 'ORD-1', status: 'PENDING_PROCESSING' },
    }));
    const t = String(Math.floor(Date.now() / 1000));
    const v1 = crypto.createHmac('sha256', secret).update(`${t}.${body.toString('utf8')}`).digest('hex');
    const parsed = verifyAndParseWebhook({ 'monei-signature': `t=${t},v1=${v1}` }, body, secret);
    expect(parsed.providerStatus).toBe('PENDING_PROCESSING');
    // The internal mapping still collapses it — which is why the raw one exists.
    expect(parsed.status).toBe('failed');
  });
});

describe('ProductSet editing lock (#1325)', () => {
  const today = '2026-10-10';
  const ev = (over: Partial<LockEvent>): LockEvent => ({
    id: 1, billingDate: '2026-09-01', isScheduled: false, latestAttempt: null, ...over,
  });
  const provider = (providerStatus: string | null, status = 'completed') =>
    ({ method: 'provider' as const, providerStatus, status });

  it('does not block on resolved events', () => {
    for (const s of ['SUCCEEDED', 'PAID_OUT', 'REFUNDED', 'PARTIALLY_REFUNDED']) {
      expect(isEditLocked([ev({ latestAttempt: provider(s) })], today)).toBe(false);
    }
    expect(isEditLocked([ev({ latestAttempt: { method: 'waive', providerStatus: null, status: 'completed' } })], today)).toBe(false);
    expect(isEditLocked([ev({ latestAttempt: { method: 'cash', providerStatus: null, status: 'completed' } })], today)).toBe(false);
  });

  it('blocks on every unresolved past event', () => {
    for (const s of ['FAILED', 'EXPIRED', 'CANCELED', 'PENDING', 'PENDING_PROCESSING', 'AUTHORIZED']) {
      expect(isEditLocked([ev({ latestAttempt: provider(s, 'pending') })], today)).toBe(true);
    }
    // A timeout: an attempt with no status is an unknown outcome, never "not attempted".
    const unknown = blockingEvents([ev({ latestAttempt: provider(null, 'pending') })], today);
    expect(unknown[0].reason).toBe('unknown_outcome');
    // Past due, scheduled, never attempted.
    expect(blockingEvents([ev({ isScheduled: true })], today)[0].reason).toBe('not_attempted');
  });

  it('ignores events that are not yet due and unscheduled events with no attempt', () => {
    expect(isEditLocked([ev({ billingDate: today, isScheduled: true })], today)).toBe(false);
    expect(isEditLocked([ev({ billingDate: '2026-12-01', isScheduled: true })], today)).toBe(false);
    expect(isEditLocked([ev({ isScheduled: false })], today)).toBe(false);
  });
});

describe('charge guard (#1325)', () => {
  const a = (providerStatus: string | null, over = {}) => ({
    id: 1, method: 'provider' as const, providerStatus, providerRef: 'p', status: 'failed', ...over,
  });

  it('allows a retry only after definitively unsuccessful attempts', () => {
    expect(chargeGuard([]).allowed).toBe(true);
    expect(chargeGuard([a('FAILED'), a('EXPIRED', { id: 2 }), a('CANCELED', { id: 3 })]).allowed).toBe(true);
    // Never submitted is "not started", not an unknown outcome.
    expect(chargeGuard([a(null, { providerRef: null, status: 'failed' })]).allowed).toBe(true);
  });

  it('refuses when an earlier attempt settled, is in flight, is unknown or was refunded', () => {
    const reason = (s: string | null, over = {}) => {
      const d = chargeGuard([a('FAILED', { id: 9 }), a(s, over)]);
      return d.allowed ? 'allowed' : d.reason;
    };
    expect(reason('SUCCEEDED')).toBe('already_settled');
    expect(reason('PAID_OUT')).toBe('already_settled');
    expect(reason('AUTHORIZED')).toBe('in_flight');
    expect(reason('PENDING')).toBe('in_flight');
    // PENDING_PROCESSING must not be eligible for a retry however the adapter maps it.
    expect(reason('PENDING_PROCESSING', { status: 'failed' })).toBe('in_flight');
    expect(reason(null, { status: 'pending' })).toBe('unknown_outcome');
    expect(reason('REFUNDED')).toBe('refunded_requires_review');
  });

  it('a completed cash or waive settles the obligation', () => {
    const d = chargeGuard([{ id: 5, method: 'waive', providerStatus: null, providerRef: null, status: 'completed' }]);
    expect(d.allowed).toBe(false);
  });
});

describe('schedule allocation (#1325)', () => {
  const plan = { id: 1, key: 'plan', anchorDate: '2026-10-01', cadence: { interval: 1, unit: 'month' as const } };

  it('maps frequencies to cadences; once and unknown have none', () => {
    expect(cadenceForFrequency('month')).toEqual({ interval: 1, unit: 'month' });
    expect(cadenceForFrequency('four_weeks')).toEqual({ interval: 4, unit: 'week' });
    expect(cadenceForFrequency('year')).toEqual({ interval: 1, unit: 'year' });
    expect(cadenceForFrequency('week')).toEqual({ interval: 1, unit: 'week' });
    expect(cadenceForFrequency('once')).toBeNull();
    expect(cadenceForFrequency('per_session')).toBeNull();
    expect(cadenceForFrequency(null)).toBeNull();
  });

  it('joins the plan schedule, then an existing one, then creates an independent one', () => {
    expect(allocateSchedule({ cadence: { interval: 1, unit: 'month' }, purchaseDate: '2026-10-10', schedules: [plan] }))
      .toEqual({ kind: 'plan', key: 'plan', prorate: true });

    const yearly = { id: 2, key: 's1', anchorDate: '2026-06-01', cadence: { interval: 1, unit: 'year' as const } };
    expect(allocateSchedule({ cadence: { interval: 1, unit: 'year' }, purchaseDate: '2026-10-10', schedules: [plan, yearly] }))
      .toEqual({ kind: 'existing', key: 's1', prorate: true });

    const fresh = allocateSchedule({ cadence: { interval: 4, unit: 'week' }, purchaseDate: '2026-10-10', schedules: [plan, yearly] });
    expect(fresh).toEqual({ kind: 'new', key: 's2', anchorDate: '2026-10-10', prorate: false, warn: true });
  });

  it('a plan-less set allocates its first schedule as s1', () => {
    expect(nextScheduleKey([])).toBe('s1');
    expect(allocateSchedule({ cadence: { interval: 1, unit: 'month' }, purchaseDate: '2026-10-10', schedules: [] }).kind).toBe('new');
  });
});

describe('proration — monthly price over 31 days (#1325 D)', () => {
  const month = { interval: 1, unit: 'month' as const };

  it('counts whole days and uses a 31-day month', () => {
    expect(daysBetween('2026-10-10', '2026-11-01')).toBe(22);
    expect(periodDays(month)).toBe(31);
    // 62.00 / 31 = 2.00 a day × 22 days
    expect(prorate(62, month, '2026-10-10', '2026-11-01')).toEqual({ proratedDays: 22, periodDays: 31, amount: 44 });
  });

  it('rounds to the cent and never exceeds one period', () => {
    expect(prorate(29.99, month, '2026-10-10', '2026-11-01').amount).toBe(21.28);
    const long = prorate(40, month, '2026-10-01', '2026-12-31');
    expect(long.proratedDays).toBe(31);
    expect(long.amount).toBe(40);
  });

  it('is zero when the join date is the billing date', () => {
    expect(prorate(40, month, '2026-11-01', '2026-11-01').amount).toBe(0);
  });
});

describe('billing event lines (#1325)', () => {
  const sim = (over: any = {}) => ({
    kind: 'product' as const, label: 'Locker', user_membership_id: 1, plan_name: null, product_id: 7,
    quantity: 1, unit_price: 10, regular_price: 10, benefits: [], actual_charge: 10,
    price_may_change: false, prepaid_periods: null, ...over,
  });

  it('restates the engine output without repricing it', () => {
    const row = lineFromSimulation(sim({ benefits: [{ source: 'promotion', name: 'Autumn', action: 'percentage_discount', value: 20 }], actual_charge: 8 }));
    expect(row).toMatchObject({
      kind: 'product', product_id: 7, item_name: 'Locker', regular_unit_price: 10,
      treatment_action: 'percentage_discount', treatment_value: 20, promotion_name: 'Autumn', amount: 8,
    });
  });

  it('records proration evidence and uses the prorated amount', () => {
    const row = lineFromSimulation(sim(), { proration: { proratedDays: 22, periodDays: 31, amount: 7.1 } });
    expect(row).toMatchObject({ prorated_days: 22, period_days: 31, amount: 7.1 });
  });

  it('a legacy "included" benefit reads as waive', () => {
    const row = lineFromSimulation(sim({ benefits: [{ source: 'promotion', name: 'Free', action: 'included', value: null }], actual_charge: 0 }));
    expect(row.treatment_action).toBe('waive');
  });

  it('checks that lines sum to the event amount to the cent', () => {
    const lines = [{ amount: 19.99 }, { amount: 0.01 }, { amount: 5.5 }];
    expect(linesTotal(lines)).toBe(25.5);
    expect(linesMatchTotal(lines, 25.5)).toBe(true);
    expect(linesMatchTotal(lines, 25.49)).toBe(false);
    expect(roundCents(1.005)).toBe(1.01);
  });
});
