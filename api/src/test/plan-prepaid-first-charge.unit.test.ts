// #946 — the Pre-paid Duration is **collected**, not waived.
//
// A Plan sold as "€70/month, 3 months pre-paid" means the member pays €210 up
// front and is then charged nothing until the fourth period. Until this ticket
// every prepaid period priced at 0 with a `waive` benefit, so the Billing Event
// Simulation read `Membership Fee · Waived · €0.00` where the gym had sold €210
// — and, because `POST /payment-requests` refuses a cycle that owes nothing, a
// brand-new prepaid assignment could not raise its first payment at all, never
// stored a card, and was skipped by the nightly run for ever.
//
// Three pure layers, so these are unit tests (CLAUDE.md): the rule
// (`prepaidPeriodsDueOn`), the one implementation of what a cycle costs
// (`resolveMembershipFee`) and the projection the ticket is named after
// (`computePlanBillingEventSimulation`).

import { describe, expect, it } from 'vitest';
import {
  MembershipFeeContext,
  resolveMembershipFee,
} from '../domain/billingSimulation';
import {
  PlanDurationCadence,
  prepaidPeriodsDueOn,
  toPlanDuration,
} from '../domain/planDuration';
import { NO_PERSONAL_FEE_BENEFIT, PersonalFeeBenefit } from '../domain/personalFeeBenefit';
import { AppliedPromotionForBilling } from '../domain/promotionApplication';
import {
  PlanSimulationItem,
  computePlanBillingEventSimulation,
} from '../domain/planBillingEventSimulation';
import { NO_PRODUCT_BENEFIT } from '../domain/productBenefitActions';

const MONTH: PlanDurationCadence = { interval: 1, unit: 'month' };
const FOUR_WEEKS: PlanDurationCadence = { interval: 4, unit: 'week' };
const START = '2026-10-01';

const duration = (
  d: { free?: number; paid?: number; bonus?: number; prepaid?: number },
  cadence: PlanDurationCadence = MONTH,
) => toPlanDuration(d.free ?? 0, d.paid ?? 0, d.bonus ?? 0, d.prepaid ?? 0, cadence, false);

/* ── The rule ─────────────────────────────────────────────────────────────── */

describe('prepaidPeriodsDueOn', () => {
  it('is 0 for a Plan with no Pre-paid Duration', () => {
    const d = duration({ paid: 3 });
    expect(prepaidPeriodsDueOn(d, START, START)).toBe(0);
    expect(prepaidPeriodsDueOn(d, START, '2026-11-01')).toBe(0);
  });

  it('owes the whole duration on the first prepaid period, and nothing after it', () => {
    const d = duration({ paid: 3, prepaid: 3 });
    expect(prepaidPeriodsDueOn(d, START, START)).toBe(3);
    // Anywhere inside that first period, not only on its exact billing date —
    // a first payment raised two days late still owes the same €210.
    expect(prepaidPeriodsDueOn(d, START, '2026-10-03')).toBe(3);
    expect(prepaidPeriodsDueOn(d, START, '2026-10-31')).toBe(3);
    // The periods it paid for.
    expect(prepaidPeriodsDueOn(d, START, '2026-11-01')).toBe(0);
    expect(prepaidPeriodsDueOn(d, START, '2026-12-01')).toBe(0);
    // And the first period the contract charges normally.
    expect(prepaidPeriodsDueOn(d, START, '2027-01-01')).toBe(0);
  });

  it('is 0 before the contract starts', () => {
    expect(prepaidPeriodsDueOn(duration({ paid: 2, prepaid: 2 }), START, '2026-09-30')).toBe(0);
  });

  it('starts counting after the Free Period', () => {
    const d = duration({ free: 1, paid: 3, prepaid: 2 });
    expect(prepaidPeriodsDueOn(d, START, START)).toBe(0);          // free
    expect(prepaidPeriodsDueOn(d, START, '2026-11-01')).toBe(2);   // first prepaid
    expect(prepaidPeriodsDueOn(d, START, '2026-12-01')).toBe(0);   // covered
    expect(prepaidPeriodsDueOn(d, START, '2027-01-01')).toBe(0);   // paid
  });

  it('counts periods of the Plan\'s own Billing Frequency, not months (#892)', () => {
    const d = duration({ paid: 3, prepaid: 2 }, FOUR_WEEKS);
    expect(prepaidPeriodsDueOn(d, START, START)).toBe(2);
    // The first period runs 1–28 Oct; the second starts on the 29th.
    expect(prepaidPeriodsDueOn(d, START, '2026-10-28')).toBe(2);
    expect(prepaidPeriodsDueOn(d, START, '2026-10-29')).toBe(0);
    // A calendar month in, the lump is long collected — the point of #892 being
    // one unit for both halves of a period.
    expect(prepaidPeriodsDueOn(d, START, '2026-11-01')).toBe(0);
  });

  it('never owes more periods than the Paid Duration has', () => {
    // `toPlanDuration` clamps prepaid to paid, so a row edited straight in the DB
    // cannot prepay periods the contract never had.
    expect(prepaidPeriodsDueOn(duration({ paid: 2, prepaid: 5 }), START, START)).toBe(2);
  });
});

/* ── What a cycle costs ───────────────────────────────────────────────────── */

const context = (over: Partial<MembershipFeeContext> = {}): MembershipFeeContext => ({
  startsAt: START,
  planDuration: duration({ paid: 3, prepaid: 3 }),
  promotions: [],
  personalFeeBenefit: NO_PERSONAL_FEE_BENEFIT,
  ...over,
});

describe('resolveMembershipFee — a Pre-paid Duration', () => {
  it('charges the fee times the periods it covers, as a real payment', () => {
    const resolved = resolveMembershipFee(70, START, context());
    expect(resolved.amount).toBe(210);
    expect(resolved.prepaidPeriods).toBe(3);
    // Not waived and not discounted: this is the regular price of three periods.
    expect(resolved.benefits).toEqual([]);
  });

  it('charges nothing — and generates no billing event — for the periods it covers', () => {
    for (const date of ['2026-11-01', '2026-12-01']) {
      const resolved = resolveMembershipFee(70, date, context());
      expect(resolved.amount).toBe(0);
      // `quantity: 0` is `walkStream()`'s "not a billing event" (#918).
      expect(resolved.quantity).toBe(0);
      expect(resolved.benefits).toEqual([{
        source: 'membership_plan', name: null, action: 'waive', value: null, period_status: 'prepaid_plan',
      }]);
    }
  });

  it('resumes the regular fee once the prepaid periods are over', () => {
    const resolved = resolveMembershipFee(70, '2027-01-01', context());
    expect(resolved.amount).toBe(70);
    expect(resolved.prepaidPeriods).toBeUndefined();
    expect(resolved.benefits).toEqual([]);
  });

  it('keeps the projection running past the lump (#629 §6)', () => {
    // The lump is not this contract's recurring regular charge, so it must not
    // be the horizon's first regular milestone — otherwise the simulation would
    // stop at the Plan's own first event and never show the fee resuming.
    expect(resolveMembershipFee(70, START, context()).promotional).toBe(true);
  });

  it('still waives a Free Period before it', () => {
    const ctx = context({ planDuration: duration({ free: 1, paid: 3, prepaid: 3 }) });
    expect(resolveMembershipFee(70, START, ctx)).toMatchObject({
      amount: 0,
      benefits: [{ source: 'membership_plan', action: 'waive', period_status: 'free_plan' }],
    });
    expect(resolveMembershipFee(70, '2026-11-01', ctx).amount).toBe(210);
  });

  it('discounts every period the lump covers with the Personal Membership Fee Benefit (#772)', () => {
    const personal: PersonalFeeBenefit = { action: 'percentage_discount', value: 10 };
    const resolved = resolveMembershipFee(70, START, context({ personalFeeBenefit: personal }));
    expect(resolved.amount).toBe(189); // 3 x 70, less 10%
  });

  it('is outranked by a Promotion governing the date (#635 Q2)', () => {
    // A Promotion with a free month covering the same date decides the fee alone,
    // so the lump is not collected inside it — exactly as the Plan's own Free
    // Period is not stacked on a Promotion's paid one.
    const promo: AppliedPromotionForBilling = {
      name: 'Launch', appliedAt: START, revokedAt: null,
      freeMonths: 1, paidMonths: 0, payBeforehandMonths: 0, bonusMonths: 0,
      membershipFeeBenefits: [],
    };
    const resolved = resolveMembershipFee(70, START, context({ promotions: [promo] }));
    expect(resolved.amount).toBe(0);
    expect(resolved.benefits[0]).toMatchObject({ source: 'promotion', action: 'waive' });
  });
});

/* ── The projection the ticket names ──────────────────────────────────────── */

const item = (over: Partial<PlanSimulationItem> = {}): PlanSimulationItem => ({
  productId: 1,
  name: 'Item',
  category: 'periodical',
  billingFrequency: 'month',
  unitPriceInclTax: 15,
  quantity: 1,
  sessionFrequency: null,
  benefit: NO_PRODUCT_BENEFIT,
  mandatory: false,
  ...over,
});

const simulate = (
  d: { free?: number; paid?: number; bonus?: number; prepaid?: number },
  items: PlanSimulationItem[] = [],
  fee: number | null = 70,
) => computePlanBillingEventSimulation({
  planName: 'Full Access',
  duration: duration(d),
  cadence: { interval: 1, unit: 'month' },
  membershipFeeInclTax: fee,
  items,
  anchorDate: START,
});

const feeLine = (r: ReturnType<typeof simulate>, date: string) =>
  r.dates.find((g) => g.date === date)?.lines.find((l) => l.kind === 'membership_fee');

describe('computePlanBillingEventSimulation — the ticket\'s example', () => {
  // €70/month, Paid Duration 3, Pre-paid Duration 3.
  const result = simulate({ paid: 3, prepaid: 3 });

  it('bills the whole prepaid Membership Fee in the first billing event', () => {
    expect(feeLine(result, START)).toMatchObject({
      kind: 'membership_fee',
      quantity: 3,
      unit_price: 70,
      // The regular price of that event is the three periods it pays for, so the
      // card reads "Regular price · €210.00" rather than a €210 charge against a
      // €70 regular price.
      regular_price: 210,
      actual_charge: 210,
      prepaid_periods: 3,
      benefits: [],
    });
  });

  it('generates no further Membership Fee event for the periods it covers', () => {
    expect(feeLine(result, '2026-11-01')).toBeUndefined();
    expect(feeLine(result, '2026-12-01')).toBeUndefined();
  });

  it('resumes the regular fee once the prepaid period has been consumed', () => {
    expect(feeLine(result, '2027-01-01')).toMatchObject({
      quantity: 1, regular_price: 70, actual_charge: 70, prepaid_periods: null,
    });
  });

  it('includes the prepaid amount in that billing event\'s total', () => {
    const withItems = simulate({ paid: 3, prepaid: 3 }, [
      item({ productId: 2, name: 'Registration Fee', category: 'oneoff', billingFrequency: 'once', unitPriceInclTax: 100 }),
      item({ productId: 3, name: 'Locker Rental', unitPriceInclTax: 15 }),
    ]);
    const first = withItems.dates.find((g) => g.date === START)!;
    expect(first.total).toBe(325); // 210 + 100 + 15
    // §4 — every other rule is untouched: the one-off is billed once and the
    // monthly item keeps billing while the fee is covered.
    expect(first.lines.map((l) => l.label)).toContain('Registration Fee');
    const covered = withItems.dates.find((g) => g.date === '2026-11-01')!;
    expect(covered.lines.map((l) => l.label)).toEqual(['Locker Rental']);
    expect(covered.total).toBe(15);
  });

  it('works for any Pre-paid Duration, not only three', () => {
    for (const periods of [1, 2, 6]) {
      const r = simulate({ paid: 12, prepaid: periods });
      expect(feeLine(r, START)).toMatchObject({
        actual_charge: 70 * periods, prepaid_periods: periods,
      });
    }
  });

  it('changes nothing for a Plan with no Pre-paid Duration', () => {
    const r = simulate({ paid: 3 });
    expect(feeLine(r, START)).toMatchObject({
      quantity: 1, regular_price: 70, actual_charge: 70, prepaid_periods: null,
    });
  });
});
