import { describe, it, expect } from 'vitest';
import { tabBadgeText } from '@/lib/memberTabBadges';

describe('tabBadgeText (#2182)', () => {
  it('shows no badge for zero, absent or unusable counts', () => {
    expect(tabBadgeText(0)).toBeNull();
    expect(tabBadgeText(undefined)).toBeNull();
    expect(tabBadgeText(-2)).toBeNull();
    expect(tabBadgeText(Number.NaN)).toBeNull();
    expect(tabBadgeText('3')).toBeNull();
  });
  it('shows the count, capped', () => {
    expect(tabBadgeText(3)).toBe('3');
    expect(tabBadgeText(99)).toBe('99');
    expect(tabBadgeText(100)).toBe('99+');
  });
});
