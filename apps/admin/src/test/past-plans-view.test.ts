// #2887 — Past plans are the plan snapshots ended before today; the count is the list.
import { describe, expect, it } from 'vitest';
import { pastPlans } from '../app/[locale]/members/membershipPlansView';

const plan = (id: number, over: Record<string, unknown> = {}) => ({
  id, membership_plan_id: 1, plan_name: `P${id}`, status: 'cancelled', is_live: false, is_past: true, ...over,
}) as any;

describe('pastPlans', () => {
  it('lists exactly the plans whose end date is before today', () => {
    const r = pastPlans([plan(1), plan(2, { is_past: false }), plan(3, { is_past: undefined })]);
    expect(r.map((p) => p.id)).toEqual([1]);
  });

  it('lists a plan read twice once', () => {
    expect(pastPlans([plan(1), plan(1)])).toHaveLength(1);
  });
});
