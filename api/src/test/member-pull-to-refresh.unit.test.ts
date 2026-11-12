import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  canStartPull,
  gestureIntent,
  isRefreshSettled,
  MAX_PULL_PX,
  MAX_REFRESH_MS,
  MIN_REFRESH_MS,
  pullDistance,
  PULL_RESISTANCE,
  PULL_THRESHOLD_PX,
  refreshIndicatorStyle,
  releaseRefreshes,
} from '../../../apps/member/src/lib/pullToRefresh';
import { endRequest, requestsInFlight, trackRequest } from '../../../apps/member/src/lib/requestActivity';

// #2683 — pull-to-refresh in the native apps. The ticket's acceptance criteria
// that a rule can state: only from the top, only a downward pull, never a
// horizontal swipe or a nested scroller's own gesture, one refresh at a time,
// and an indicator that always goes away.

const member = join(__dirname, '../../../apps/member/src');
const read = (p: string) => readFileSync(join(member, p), 'utf8');

describe('gestureIntent', () => {
  it('waits for a decisive movement', () => {
    expect(gestureIntent(2, 3)).toBe('undecided');
  });
  it('is a pull when mostly downward', () => {
    expect(gestureIntent(3, 20)).toBe('pull');
  });
  it('ignores a horizontal swipe, a diagonal one and an upward drag', () => {
    expect(gestureIntent(30, 5)).toBe('ignore');
    expect(gestureIntent(-20, 20)).toBe('ignore');
    expect(gestureIntent(0, -20)).toBe('ignore');
  });
});

describe('canStartPull', () => {
  const base = { pageScrollTop: 0, ancestors: [], refreshing: false };
  it('starts at the top of the page', () => {
    expect(canStartPull(base)).toBe(true);
  });
  it('does not start below the top', () => {
    expect(canStartPull({ ...base, pageScrollTop: 40 })).toBe(false);
  });
  it('leaves a scrolled nested scroller its own gesture', () => {
    const scrolled = { scrollsVertically: true, scrollTop: 120, isDialog: false };
    expect(canStartPull({ ...base, ancestors: [scrolled] })).toBe(false);
    expect(canStartPull({ ...base, ancestors: [{ ...scrolled, scrollTop: 0 }] })).toBe(true);
    // An element that cannot scroll is not a scroller, whatever its offset says.
    expect(canStartPull({ ...base, ancestors: [{ ...scrolled, scrollsVertically: false }] })).toBe(true);
  });
  it('never refreshes from under a dialog', () => {
    expect(canStartPull({ ...base, ancestors: [{ scrollsVertically: false, scrollTop: 0, isDialog: true }] })).toBe(false);
  });
  it('never starts a second refresh while one is in flight', () => {
    expect(canStartPull({ ...base, refreshing: true })).toBe(false);
  });
});

describe('pull distance and release', () => {
  it('resists the finger and caps the travel', () => {
    expect(pullDistance(-10)).toBe(0);
    expect(pullDistance(40)).toBe(40 / PULL_RESISTANCE);
    expect(pullDistance(10_000)).toBe(MAX_PULL_PX);
  });
  it('refreshes only past the threshold', () => {
    expect(releaseRefreshes(PULL_THRESHOLD_PX - 1)).toBe(false);
    expect(releaseRefreshes(PULL_THRESHOLD_PX)).toBe(true);
    expect(releaseRefreshes(pullDistance(PULL_THRESHOLD_PX * PULL_RESISTANCE))).toBe(true);
  });
});

describe('isRefreshSettled', () => {
  it('holds the indicator for the minimum time', () => {
    expect(isRefreshSettled(0, MIN_REFRESH_MS - 1, 0)).toBe(false);
    expect(isRefreshSettled(0, MIN_REFRESH_MS, 0)).toBe(true);
  });
  it('waits for the page requests to settle', () => {
    expect(isRefreshSettled(0, MIN_REFRESH_MS + 100, 2)).toBe(false);
  });
  it('always ends, even when a request hangs', () => {
    expect(isRefreshSettled(0, MAX_REFRESH_MS, 3)).toBe(true);
  });
});

describe('request activity', () => {
  it('counts a request out when it fails', async () => {
    const before = requestsInFlight();
    await expect(trackRequest(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(requestsInFlight()).toBe(before);
  });
  it('never goes negative', () => {
    endRequest();
    endRequest();
    expect(requestsInFlight()).toBeGreaterThanOrEqual(0);
  });
});

describe('platform indicator', () => {
  it('draws iOS spokes on iOS and the Material indicator elsewhere', () => {
    expect(refreshIndicatorStyle('ios')).toBe('ios');
    expect(refreshIndicatorStyle('android')).toBe('material');
    expect(refreshIndicatorStyle(null)).toBe('material');
  });
});

describe('wiring', () => {
  it('is mounted once, by the locale layout, around the page', () => {
    expect(read('app/[locale]/layout.tsx')).toMatch(/<PullToRefresh>\s*<MemberLocalePreference>\{children\}<\/MemberLocalePreference>\s*<\/PullToRefresh>/);
  });
  it('is native only', () => {
    expect(read('components/PullToRefresh.tsx')).toMatch(/if \(!isNative\(\)\) return;/);
  });
  it('counts every API request the app makes', () => {
    const client = read('lib/apiClient.ts');
    const fetches = client.match(/fetch\(`\/api\/proxy/g) ?? [];
    const tracked = client.match(/trackRequest\(\(\) => fetch\(`\/api\/proxy/g) ?? [];
    expect(fetches.length).toBeGreaterThan(0);
    expect(tracked.length).toBe(fetches.length);
  });
});
