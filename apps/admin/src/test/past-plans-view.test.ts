// #2887 — the Past plans count is the number of entries the section lists.
import { describe, expect, it } from 'vitest';
import { pastPlans } from '../app/[locale]/members/membershipPlansView';

const plan = (id: number, over: Record<string, unknown> = {}) => ({
  id, membership_plan_id: 1, plan_name: `P${id}`, status: 'cancelled', is_live: false, is_current: false, ...over,
}) as any;
const set = (id: number, over: Record<string, unknown> = {}) => ({
  id, status: 'cancelled', plan_name: `S${id}`, membership_plan_id: 1, user_membership_id: null, ...over,
}) as any;

describe('pastPlans', () => {
  it('counts exactly the ended assignments and cancelled plan sets it lists', () => {
    const r = pastPlans([plan(1), plan(2, { is_live: true }), plan(3, { is_current: true })], [set(9)]);
    expect(r.history.map((p) => p.id)).toEqual([1]);
    expect(r.cancelledSets.map((s) => s.id)).toEqual([9]);
    expect(r.count).toBe(2);
  });

  it('lists and counts a plan read twice once', () => {
    const r = pastPlans([plan(1), plan(1)], [set(9), set(9)]);
    expect(r.count).toBe(2);
    expect(r.history).toHaveLength(1);
    expect(r.cancelledSets).toHaveLength(1);
  });

  it('leaves out, and does not count, a cancelled set with no plan to show', () => {
    const r = pastPlans([], [set(9, { membership_plan_id: null })]);
    expect(r).toEqual({ history: [], cancelledSets: [], count: 0 });
  });
});
