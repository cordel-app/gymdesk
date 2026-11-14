import { describe, it, expect } from 'vitest';
import { describePlanAccess } from '../domain/planAccessBenefit';

// #2802 — the access a Membership Plan grants, per beneficiary, for display.
const names = new Map<number, string>([[1, 'North'], [2, 'South'], [3, 'West']]);
const ana = { member_id: 10, name: 'Ana', defaultCenterId: null };
const ben = { member_id: 11, name: 'Ben', defaultCenterId: null };

describe('describePlanAccess', () => {
  it('lists the plan\'s selected centers once per beneficiary, and no other center', () => {
    const out = describePlanAccess({ mode: 'specific_centers', centerIds: [2, 1] }, names, [ana, ben]);
    expect(out).toEqual([
      { member_id: 10, member_name: 'Ana', all_centers: false, online: false, centers: [{ id: 1, name: 'North' }, { id: 2, name: 'South' }] },
      { member_id: 11, member_name: 'Ben', all_centers: false, online: false, centers: [{ id: 1, name: 'North' }, { id: 2, name: 'South' }] },
    ]);
  });

  it('reads All Centers as all, with no center list', () => {
    const [entry] = describePlanAccess({ mode: 'all_centers', centerIds: [] }, names, [ana]);
    expect(entry).toMatchObject({ all_centers: true, centers: [], online: false });
  });

  it('keeps the legacy meaning of a Specific Centers plan with no rows: no restriction', () => {
    const [entry] = describePlanAccess({ mode: 'specific_centers', centerIds: [] }, names, [ana]);
    expect(entry.all_centers).toBe(true);
  });

  it('reads an On-line plan as online only', () => {
    const [entry] = describePlanAccess({ mode: 'online', centerIds: [] }, names, [ana]);
    expect(entry).toMatchObject({ all_centers: false, centers: [], online: true });
  });

  it('keeps a legacy plan that combines On-line with physical centers', () => {
    const [entry] = describePlanAccess({ mode: 'specific_centers', online: true, centerIds: [3] }, names, [ana]);
    expect(entry).toMatchObject({ online: true, centers: [{ id: 3, name: 'West' }] });
  });

  it('resolves Only Member Default Center per beneficiary and skips one with no default', () => {
    const out = describePlanAccess({ mode: 'member_default_center', centerIds: [] }, names, [
      { ...ana, defaultCenterId: 2 }, ben, { member_id: 12, name: 'Cai', defaultCenterId: 3 },
    ]);
    expect(out.map((e) => [e.member_id, e.centers.map((c) => c.name)])).toEqual([[10, ['South']], [12, ['West']]]);
  });

  it('does not list a center the lookup does not know (deleted or inactive)', () => {
    const [entry] = describePlanAccess({ mode: 'specific_centers', centerIds: [1, 99] }, names, [ana]);
    expect(entry.centers).toEqual([{ id: 1, name: 'North' }]);
  });
});
