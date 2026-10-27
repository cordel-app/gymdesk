import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const { planLegacyFamilies } = createRequire(import.meta.url)('../infra/migrations/344_families.js');
const row = (root: number, member: number, owner: number, gym = 'g') => ({ gym_id: gym, root_product_set_id: root, member_id: member, is_owner: owner });

describe('planLegacyFamilies (#2123 migration 344)', () => {
  it('migrates a chain with one owner and covered members', () => {
    const { families, ambiguous } = planLegacyFamilies([row(1, 10, 1), row(1, 11, 0), row(1, 12, 0)]);
    expect(ambiguous).toEqual([]);
    expect(families).toEqual([{ gym_id: 'g', owner_member_id: 10, member_ids: [10, 11, 12] }]);
  });
  it('ignores single-member chains (an individual plan is not a family)', () => {
    expect(planLegacyFamilies([row(1, 10, 1)])).toEqual({ families: [], ambiguous: [] });
  });
  it('merges several chains of one owner', () => {
    const { families } = planLegacyFamilies([row(1, 10, 1), row(1, 11, 0), row(2, 10, 1), row(2, 12, 0)]);
    expect(families).toHaveLength(1);
    expect(families[0].member_ids.sort()).toEqual([10, 11, 12]);
  });
  it('never guesses an owner: no owner or several owners are ambiguous', () => {
    const { families, ambiguous } = planLegacyFamilies([row(1, 10, 0), row(1, 11, 0), row(2, 20, 1), row(2, 21, 1)]);
    expect(families).toEqual([]);
    expect(ambiguous.map((a: any) => a.reason).sort()).toEqual(['no_owner', 'several_owners']);
  });
  it('a member covered under two owners is ambiguous for both groups', () => {
    const { families, ambiguous } = planLegacyFamilies([row(1, 10, 1), row(1, 12, 0), row(2, 11, 1), row(2, 12, 0)]);
    expect(families).toEqual([]);
    expect(ambiguous).toHaveLength(2);
  });
  it('does not merge across gyms', () => {
    const { families } = planLegacyFamilies([row(1, 10, 1, 'a'), row(1, 11, 0, 'a'), row(2, 10, 1, 'b'), row(2, 11, 0, 'b')]);
    expect(families).toHaveLength(2);
  });
});
