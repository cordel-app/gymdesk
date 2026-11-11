// #2496 stage 4 — what a plan card offers while the member builds a Draft.
import { describe, expect, it } from 'vitest';
import { draftAddedCount, draftErrorKey, draftPlanState, type MemberSetView } from '../lib/memberProducts';

const view = (over: Partial<MemberSetView>): MemberSetView => ({ id: 1, status: 'draft', lines: [], plans: [], ...over });

describe('draftPlanState', () => {
  it('keeps the card\'s own purchase when there is no Draft', () => {
    expect(draftPlanState(5, null)).toEqual({ state: 'no_draft' });
    expect(draftPlanState(5, view({ status: 'active' }))).toEqual({ state: 'no_draft' });
  });

  it('offers Add on a Draft with no plan', () => {
    expect(draftPlanState(5, view({}))).toEqual({ state: 'none' });
  });

  it('offers Remove for the plan this Draft added, and nothing for another plan', () => {
    const v = view({ plans: [{ plan_snapshot_id: 9, membership_plan_id: 5, plan_name: 'Gold', change: 'added' }] });
    expect(draftPlanState(5, v)).toEqual({ state: 'added', planSnapshotId: 9 });
    expect(draftPlanState(6, v)).toEqual({ state: 'taken' });
  });

  it('offers nothing while the Draft carries the plan the member holds', () => {
    const v = view({ plans: [{ plan_snapshot_id: 9, membership_plan_id: 5, plan_name: 'Gold', change: 'inherited' }] });
    expect(draftPlanState(5, v)).toEqual({ state: 'taken' });
  });
});

describe('draftAddedCount', () => {
  it('counts the added plan beside the added lines, never an inherited one', () => {
    const v = view({
      lines: [{ id: 1, product_id: 2, change: 'added' }, { id: 3, product_id: 4, change: 'inherited' }],
      plans: [{ plan_snapshot_id: 9, membership_plan_id: 5, plan_name: null, change: 'added' }],
    });
    expect(draftAddedCount(v)).toBe(2);
    expect(draftAddedCount(view({ plans: [{ plan_snapshot_id: 9, membership_plan_id: 5, plan_name: null, change: 'inherited' }] }))).toBe(0);
  });
});

describe('draftErrorKey', () => {
  it('words the plan refusals', () => {
    expect(draftErrorKey('draft_has_plan')).toBe('membership.draft_error_has_plan');
    expect(draftErrorKey('plan_change_via_gym')).toBe('membership.draft_error_plan_via_gym');
    expect(draftErrorKey('plan_not_removable')).toBe('membership.draft_error_plan_via_gym');
  });
});
