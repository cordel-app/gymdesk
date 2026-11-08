import { describe, it, expect } from 'vitest';
import { resolveCenterAccess, centerAllowed, onlineAllowed, parseCenterAccessInput } from '../domain/planCenterAccess';

describe('resolveCenterAccess (#2383)', () => {
  it('specific centers grant only the selected ones', () => {
    const a = resolveCenterAccess([{ mode: 'specific_centers', centerIds: [1, 2] }], null);
    expect(centerAllowed(a, 1)).toBe(true);
    expect(centerAllowed(a, 3)).toBe(false);
  });
  it('a specific plan with no rows keeps its legacy meaning: no restriction', () => {
    expect(centerAllowed(resolveCenterAccess([{ mode: 'specific_centers', centerIds: [] }], null), 99)).toBe(true);
  });
  it('all_centers covers any center, including future ones', () => {
    expect(centerAllowed(resolveCenterAccess([{ mode: 'all_centers', centerIds: [] }], null), 12345)).toBe(true);
  });
  it('member_default_center follows the member and grants nothing without one', () => {
    const plan = [{ mode: 'member_default_center' as const, centerIds: [] }];
    expect(centerAllowed(resolveCenterAccess(plan, 5), 5)).toBe(true);
    expect(centerAllowed(resolveCenterAccess(plan, 5), 6)).toBe(false);
    expect(centerAllowed(resolveCenterAccess(plan, null), 5)).toBe(false);
  });
  it('several plans union: default center plus specific A and B', () => {
    const a = resolveCenterAccess([
      { mode: 'member_default_center', centerIds: [] },
      { mode: 'specific_centers', centerIds: [10, 11] },
    ], 7);
    expect([7, 10, 11].every((c) => centerAllowed(a, c))).toBe(true);
    expect(centerAllowed(a, 8)).toBe(false);
  });
  it('any all_centers plan wins', () => {
    const a = resolveCenterAccess([
      { mode: 'specific_centers', centerIds: [1] },
      { mode: 'all_centers', centerIds: [] },
    ], null);
    expect(centerAllowed(a, 50)).toBe(true);
  });
});

describe('parseCenterAccessInput', () => {
  it('keeps the pre-#2383 body (center_ids alone)', () => {
    expect(parseCenterAccessInput({ center_ids: [1] })).toEqual({ mode: null, centerIds: [1], online: null });
  });
  it('a dynamic mode needs no center_ids', () => {
    expect(parseCenterAccessInput({ center_access_mode: 'all_centers' })).toEqual({ mode: 'all_centers', centerIds: [], online: null });
  });
  it('rejects unknown modes and missing ids for specific', () => {
    expect('error' in parseCenterAccessInput({ center_access_mode: 'x', center_ids: [] })).toBe(true);
    expect('error' in parseCenterAccessInput({ center_access_mode: 'specific_centers' })).toBe(true);
  });
});

describe('On-line center (#2406)', () => {
  it('selecting On-line grants no physical center, and no legacy "unrestricted"', () => {
    const a = resolveCenterAccess([{ mode: 'specific_centers', centerIds: [], online: true }], null);
    expect(onlineAllowed(a)).toBe(true);
    expect(centerAllowed(a, 1)).toBe(false);
  });
  it('On-line combines with specific physical centers independently', () => {
    const a = resolveCenterAccess([{ mode: 'specific_centers', centerIds: [4], online: true }], null);
    expect(onlineAllowed(a) && centerAllowed(a, 4)).toBe(true);
    expect(centerAllowed(a, 5)).toBe(false);
  });
  it('All Centers does not include On-line; plans union', () => {
    expect(onlineAllowed(resolveCenterAccess([{ mode: 'all_centers', centerIds: [] }], null))).toBe(false);
    const a = resolveCenterAccess([
      { mode: 'all_centers', centerIds: [] },
      { mode: 'specific_centers', centerIds: [], online: true },
    ], null);
    expect(centerAllowed(a, 9) && onlineAllowed(a)).toBe(true);
  });
  it('parses online_access and rejects non-booleans', () => {
    expect(parseCenterAccessInput({ center_ids: [1], online_access: true })).toEqual({ mode: null, centerIds: [1], online: true });
    expect('error' in parseCenterAccessInput({ center_ids: [], online_access: 'yes' })).toBe(true);
  });
});

describe('#2420 On-line mode', () => {
  it('grants remote access and no physical center, and is not All Centers', () => {
    const a = resolveCenterAccess([{ mode: 'online', centerIds: [] }], 5);
    expect(onlineAllowed(a)).toBe(true);
    expect(a.all).toBe(false);
    expect(centerAllowed(a, 5)).toBe(false);
  });
  it('accepts online as a mode', () => {
    expect(parseCenterAccessInput({ center_access_mode: 'online' })).toEqual({ mode: 'online', centerIds: [], online: null });
  });
});
