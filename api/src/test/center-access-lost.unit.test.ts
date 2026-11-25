// #3358 stage 3 — `lostCenterIds()`: the centers a member uses now and not after the Draft.
import { describe, expect, it } from 'vitest';
import { lostCenterIds, resolveCenterAccess } from '../domain/planCenterAccess';

const spec = (ids: number[]) => ({ mode: 'specific_centers' as const, centerIds: ids });
const all = { mode: 'all_centers' as const, centerIds: [] };
const ACTIVE = [1, 2, 3];

describe('lostCenterIds', () => {
  it('loses the centers only the cancelled plan granted', () => {
    expect(lostCenterIds(resolveCenterAccess([spec([1, 2]), spec([2])], null), resolveCenterAccess([spec([2])], null), ACTIVE, true)).toEqual([1]);
  });
  it('an All Centers plan before and a restricted one after loses the rest', () => {
    expect(lostCenterIds(resolveCenterAccess([all], null), resolveCenterAccess([spec([3])], null), ACTIVE, true)).toEqual([1, 2]);
  });
  it('nothing is lost when All Centers remains, or when nothing was granted before', () => {
    expect(lostCenterIds(resolveCenterAccess([spec([1])], null), resolveCenterAccess([all], null), ACTIVE, true)).toEqual([]);
    expect(lostCenterIds(resolveCenterAccess([], null), resolveCenterAccess([], null), ACTIVE, false)).toEqual([]);
  });
  it('no plan left after the Draft loses every center used before', () => {
    expect(lostCenterIds(resolveCenterAccess([spec([2, 3])], null), resolveCenterAccess([], null), ACTIVE, true)).toEqual([2, 3]);
  });
});
