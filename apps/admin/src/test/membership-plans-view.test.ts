import { describe, it, expect } from 'vitest';
import { visiblePlans } from '../app/[locale]/members/membershipPlansView';

const plan = (id: number, status: string, is_live = true) => ({ id, status, is_live } as any);

describe('#1538 visiblePlans — one version of the plan at a time', () => {
  it('shows the Active plan and the in-progress list when nothing is being edited', () => {
    const v = visiblePlans([plan(1, 'active')]);
    expect(v.rows.map((r) => r.id)).toEqual([1]);
    expect(v.heading).toBe('active');
    expect(v.showInFlightList).toBe(true);
  });

  it('a Draft replaces the Active snapshot in the view, never both', () => {
    const v = visiblePlans([plan(1, 'active'), plan(2, 'draft')]);
    expect(v.rows.map((r) => r.id)).toEqual([2]);
    expect(v.heading).toBe('draft');
    expect(v.showInFlightList).toBe(false);
  });

  it('a Pending Payment version also replaces it, and is not listed twice', () => {
    const v = visiblePlans([plan(1, 'active'), plan(3, 'pending_payment')]);
    expect(v.rows.map((r) => r.id)).toEqual([3]);
    expect(v.showInFlightList).toBe(false);
  });

  it('with no plan the empty state is untouched', () => {
    const v = visiblePlans([]);
    expect(v.rows).toEqual([]);
    expect(v.heading).toBe('active');
  });

  it('past plans never enter the first table', () => {
    const v = visiblePlans([plan(1, 'cancelled', false)]);
    expect(v.rows).toEqual([]);
  });
});
