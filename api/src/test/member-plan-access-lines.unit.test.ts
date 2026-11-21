// #3099 — My Products' current plan card words a plan's access as the Admin does
// (`Access to [center]`) per beneficiary. Pure rule in the Members App's lib.
import { describe, it, expect } from 'vitest';
import { planAccessLines } from '../../../apps/member/src/lib/memberPlans';

describe('planAccessLines', () => {
  it('names the centers and the beneficiary', () => {
    expect(planAccessLines([{ member_id: 1, member_name: 'Ana', all_centers: false, centers: [{ id: 1, name: 'North' }, { id: 2, name: 'South' }], online: false }]))
      .toEqual([{ key: 'plan_access_centers', values: { centers: 'North, South' }, beneficiary: 'Ana' }]);
  });
  it('reads all centers and on-line, and drops an entry that grants nothing', () => {
    expect(planAccessLines([
      { member_id: 1, member_name: null, all_centers: true, centers: [], online: true },
      { member_id: 2, member_name: 'Bo', all_centers: false, centers: [], online: false },
    ])).toEqual([{ key: 'plan_access_all_online', beneficiary: null }]);
  });
  it('tolerates a missing list', () => {
    expect(planAccessLines(undefined)).toEqual([]);
  });
});
