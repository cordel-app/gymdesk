// #2663 — My Plans and My Products read one Product Set, chosen once by
// `currentSetId()`: the member's own version before a family version they are
// covered by, a newer Draft before a version awaiting payment before the
// Active one, and never a superseded version as a fallback.
import { describe, expect, it } from 'vitest';
import { currentSetId, setPlans, setLineStatusKey, setProductLines } from '../../../apps/member/src/lib/memberProducts';

describe('currentSetId', () => {
  it('prefers the Draft over an older Active version (issue example)', () => {
    expect(currentSetId([{ id: 3, status: 'draft' }, { id: 2, status: 'active' }, { id: 1, status: 'superseded' }])).toBe(3);
  });
  it('takes the version awaiting payment before the Active one', () => {
    expect(currentSetId([{ id: 6, status: 'pending_payment' }, { id: 5, status: 'active' }])).toBe(6);
  });
  it('falls back to the Active version once a Draft is discarded', () => {
    expect(currentSetId([{ id: 5, status: 'active' }, { id: 4, status: 'superseded' }])).toBe(5);
  });
  it('never selects a superseded version', () => {
    expect(currentSetId([{ id: 4, status: 'superseded' }])).toBeNull();
    expect(currentSetId([])).toBeNull();
  });
  it("reads the member's own version before a family version they are covered by", () => {
    expect(currentSetId([{ id: 9, status: 'active', own: false }, { id: 7, status: 'active', own: true }])).toBe(7);
    expect(currentSetId([{ id: 9, status: 'active', own: false }])).toBe(9);
  });
});

describe('the two sections read the same view', () => {
  it('takes plans and lines from that one view', () => {
    const view = { id: 3, status: 'draft', lines: [{ id: 1, product_id: 10, change: 'added' as const }],
      plans: [{ plan_snapshot_id: 8, membership_plan_id: 2, plan_name: 'C', change: 'added' as const }] };
    expect(setPlans(view).map((p) => p.plan_name)).toEqual(['C']);
    expect(setProductLines(view).map((l) => l.product_id)).toEqual([10]);
    expect(setPlans(null)).toEqual([]);
  });
});

// #2781 — each Product card shows its own status chip, never the version's.
describe('setLineStatusKey', () => {
  it("reads the line's own status in the plans' status map", () => {
    expect(setLineStatusKey({ status: 'active' })).toBe('membership.status.active');
    expect(setLineStatusKey({ status: 'cancels_on_end_date' })).toBe('membership.status.cancels_on_end_date');
    expect(setLineStatusKey({ status: 'draft' })).toBe('membership.status.draft');
  });
  it('shows no chip for a missing or unknown status', () => {
    expect(setLineStatusKey({})).toBeNull();
    expect(setLineStatusKey({ status: 'superseded' })).toBeNull();
  });
});
