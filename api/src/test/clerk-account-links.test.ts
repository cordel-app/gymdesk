// #709: unit tests for the "is this Clerk account still linked?" definition.
// Pure function — no DB, no HTTP.

import { describe, expect, it, vi } from 'vitest';

vi.mock('../infra/db', () => ({ db: { query: vi.fn() } }));

import { classifyAccount, SIGNUP_GRACE_MS, type AccountLinks } from '../infra/clerk-account-links';

const NOW = Date.UTC(2026, 8, 23, 12, 0, 0);
const OLD = NOW - SIGNUP_GRACE_MS - 1;
const FRESH = NOW - 60_000;
const GYM = { gym_id: 'gym-a', gym_name: 'Gym A' };

const links = (over: Partial<AccountLinks> = {}): AccountLinks => ({
  staffGyms: [], activeMemberGyms: [], deletedMemberGyms: [], ...over,
});

describe('classifyAccount', () => {
  it.each([
    ['a superadmin', { publicMetadata: { platform_role: 'superadmin' }, createdAt: OLD }, links()],
    ['staff in a gym', { publicMetadata: {}, createdAt: OLD }, links({ staffGyms: [GYM] })],
    ['an active member', { publicMetadata: {}, createdAt: OLD }, links({ activeMemberGyms: [GYM] })],
    ['an active member whose sign-up metadata was never cleared', { publicMetadata: { gym_signup: {} }, createdAt: FRESH }, links({ activeMemberGyms: [GYM] })],
  ])('is linked for %s', (_label, user, l) => {
    expect(classifyAccount(user, l, NOW)).toEqual({ linked: true, reason: null, deletable: false });
  });

  it('a deleted member only → orphaned, member_deleted, deletable', () => {
    expect(classifyAccount({ publicMetadata: {}, createdAt: OLD }, links({ deletedMemberGyms: [GYM] }), NOW))
      .toEqual({ linked: false, reason: 'member_deleted', deletable: true });
  });

  it('no links at all → orphaned, no_links, deletable', () => {
    expect(classifyAccount({ publicMetadata: {}, createdAt: OLD }, links(), NOW))
      .toEqual({ linked: false, reason: 'no_links', deletable: true });
  });

  it.each(['gym_signup', 'gym_invite'])('%s metadata younger than the grace period → sign-up in progress, NOT deletable', (key) => {
    expect(classifyAccount({ publicMetadata: { [key]: { gym_id: 'x' } }, createdAt: FRESH }, links(), NOW))
      .toEqual({ linked: false, reason: 'signup_in_progress', deletable: false });
  });

  it.each(['gym_signup', 'gym_invite'])('%s metadata older than the grace period → sign-up incomplete, deletable', (key) => {
    expect(classifyAccount({ publicMetadata: { [key]: { gym_id: 'x' } }, createdAt: OLD }, links(), NOW))
      .toEqual({ linked: false, reason: 'signup_incomplete', deletable: true });
  });

  it('pending sign-up metadata wins over a deleted member as the reason', () => {
    expect(classifyAccount({ publicMetadata: { gym_signup: {} }, createdAt: OLD }, links({ deletedMemberGyms: [GYM] }), NOW).reason)
      .toBe('signup_incomplete');
  });

  it('missing metadata and createdAt are handled (treated as old, no metadata)', () => {
    expect(classifyAccount({}, links(), NOW)).toEqual({ linked: false, reason: 'no_links', deletable: true });
    expect(classifyAccount({ publicMetadata: { gym_signup: {} } }, links(), NOW).reason).toBe('signup_incomplete');
  });
});
