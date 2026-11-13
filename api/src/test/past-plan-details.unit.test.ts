// #2779 — the pure halves of an expanded Past Plan: the server's shaping of the
// snapshot rows (`domain/pastPlanDetails.ts`) and the Members App's wording of them
// (`apps/member/src/lib/memberPlans.ts`). In the API suite because CI runs
// `npm test` in `api/` only.

import { describe, expect, it } from 'vitest';
import {
  shapePastPlanLines,
  shapePastPlanPromotion,
  type PastPlanLineRow,
} from '../domain/pastPlanDetails';
import {
  pastPlanHasDetails,
  pastPlanLineFacts,
  pastPlanPeriod,
  pastPromotionBenefitText,
  type PastPlanLine,
} from '../../../apps/member/src/lib/memberPlans';
import { DEFAULT_GYM_FORMAT } from '../../../apps/member/src/lib/gymFormat';

const row = (over: Partial<PastPlanLineRow>): PastPlanLineRow => ({
  plan_snapshot_id: 1, category: 'oneoff', product_id: 7, item_name: 'Towel', item_type: 'merchandise',
  item_billing_frequency: 'once', quantity: 1, mandatory: 1, action: 'no_benefit', value: null,
  direct_discount_percent: null, frequency: null, ...over,
});

describe('shapePastPlanLines', () => {
  it('merges a line split per member back into one, summing the quantity (#2657 stage 3)', () => {
    const lines = shapePastPlanLines([row({ quantity: 1 }), row({ quantity: 2 })]);
    expect(lines).toHaveLength(1);
    expect(lines[0].quantity).toBe(3);
  });

  it('keeps lines with a different treatment apart', () => {
    const lines = shapePastPlanLines([row({}), row({ action: 'waive' })]);
    expect(lines).toHaveLength(2);
  });

  it('orders session → one-off → period, then by name', () => {
    const lines = shapePastPlanLines([
      row({ category: 'periodical', item_name: 'Locker', product_id: 1 }),
      row({ category: 'oneoff', item_name: 'Zip', product_id: 2 }),
      row({ category: 'oneoff', item_name: 'Bag', product_id: 3 }),
      row({ category: 'session', item_name: 'PT', product_id: 4, frequency: 'week' }),
    ]);
    expect(lines.map((l) => l.product_name)).toEqual(['PT', 'Bag', 'Zip', 'Locker']);
    expect(lines[0].session_frequency).toBe('week');
    expect(lines[1].session_frequency).toBeNull();
  });

  it('reports no value for an action that takes none, and no zero direct discount', () => {
    const [line] = shapePastPlanLines([row({ action: 'waive', value: '5.00', direct_discount_percent: '0.00' })]);
    expect(line.value).toBeNull();
    expect(line.direct_discount_percent).toBeNull();
    expect(line.mandatory).toBe(true);
  });
});

describe('shapePastPlanPromotion', () => {
  it('reads the name from the snapshot and only fee benefits that do something', () => {
    const promo = shapePastPlanPromotion(
      { id: 3, status: 'revoked', snapshot: '{"name":"Spring"}', applied_at: '2026-03-01 10:00:00', revoked_at: new Date('2026-04-02T00:00:00Z') },
      [
        { enabled: true, action: 'waive', value: null, duration_months: 1 },
        { enabled: false, action: 'percentage_discount', value: 10, duration_months: null },
        { enabled: true, action: 'no_benefit', value: null, duration_months: null },
      ],
      [],
    );
    expect(promo).toMatchObject({ name: 'Spring', status: 'revoked', applied_at: '2026-03-01', revoked_at: '2026-04-02' });
    expect(promo.membership_fee_benefits).toEqual([{ action: 'waive', value: null, duration_months: 1 }]);
  });

  it('answers no name when the snapshot holds none, rather than the live one', () => {
    const promo = shapePastPlanPromotion({ id: 3, status: 'applied', snapshot: null, applied_at: null, revoked_at: null }, [], []);
    expect(promo.name).toBeNull();
  });
});

describe('Members App wording (lib/memberPlans.ts)', () => {
  const line: PastPlanLine = {
    category: 'periodical', product_name: 'Locker', product_type: 'service', billing_frequency: 'month',
    session_frequency: null, quantity: 2, mandatory: false, action: 'percentage_discount', value: 50,
    direct_discount_percent: 10,
  };

  it('lists a line\'s facts in reading order', () => {
    expect(pastPlanLineFacts(line).map((f) => f.key)).toEqual([
      'membership.past_plan_type_service',
      'membership.past_plan_quantity',
      'membership.frequency.month',
      'membership.plan_ov_optional',
      'membership.promotion_benefit_percentage',
      'membership.past_plan_direct_discount',
    ]);
  });

  it('reads a session line under its renewal frequency', () => {
    const facts = pastPlanLineFacts({ ...line, category: 'session', session_frequency: 'week', action: 'no_benefit', direct_discount_percent: null });
    expect(facts.map((f) => f.key)).toContain('membership.frequency.week');
    expect(facts.map((f) => f.key)).not.toContain('membership.promotion_benefit_percentage');
  });

  it('words the period from the dates the row carries', () => {
    const base = { id: 1, membership_plan_id: 1, plan_name: 'P', status: 'cancelled' };
    expect(pastPlanPeriod({ ...base, starts_at: '2026-03-01', ended_on: '2026-08-31' }, DEFAULT_GYM_FORMAT)?.key)
      .toBe('membership.past_plan_period');
    expect(pastPlanPeriod({ ...base, starts_at: '2026-03-01', ended_on: null }, DEFAULT_GYM_FORMAT)?.key)
      .toBe('membership.past_plan_period_start');
    expect(pastPlanPeriod({ ...base, starts_at: null, ended_on: null }, DEFAULT_GYM_FORMAT)).toBeNull();
  });

  it('has nothing to expand into for an empty snapshot', () => {
    expect(pastPlanHasDetails({ membership_fee_price: null, billing_interval: null, billing_unit: null, lines: [], promotions: [] })).toBe(false);
    expect(pastPlanHasDetails(undefined)).toBe(false);
  });

  it('words an amount-based Promotion treatment with the amount', () => {
    expect(pastPromotionBenefitText('fixed_price', 20, 'EUR', DEFAULT_GYM_FORMAT)?.key).toBe('membership.promotion_benefit_fixed_price');
    expect(pastPromotionBenefitText('no_benefit', null, 'EUR', DEFAULT_GYM_FORMAT)).toBeNull();
  });

  it('has every key it can produce in the three locales', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const keys = ['past_plan_period', 'past_plan_period_start', 'past_plan_period_end', 'past_plan_fee',
      'past_plan_quantity', 'past_plan_direct_discount', 'past_plan_promotion_revoked',
      ...['fee', 'service', 'sessions', 'merchandise', 'other'].map((t) => `past_plan_type_${t}`)];
    for (const locale of ['en', 'es', 'ca']) {
      const file = path.join(__dirname, '../../../apps/member/locales/base', `${locale}.json`);
      const messages = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const key of keys) expect(messages.membership[key], `${locale} ${key}`).toBeTruthy();
    }
  });
});
