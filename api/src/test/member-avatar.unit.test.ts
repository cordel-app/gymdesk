import { describe, expect, it } from 'vitest';
import { AVATAR_PALETTE, memberAvatarColors, memberInitials } from '../../../apps/member/src/lib/memberAvatar';

// #1219 — the Members App profile avatar.
describe('memberInitials', () => {
  it('takes the first and second name words', () => {
    expect(memberInitials('Xavier Egea Vila')).toBe('XE');
    expect(memberInitials('John Smith')).toBe('JS');
    expect(memberInitials('Maria García López')).toBe('MG');
  });
  it('handles missing data', () => {
    expect(memberInitials('  ')).toBe('');
    expect(memberInitials(null)).toBe('');
    expect(memberInitials('madonna')).toBe('M');
  });
});

describe('memberAvatarColors', () => {
  it('is deterministic and from the palette', () => {
    expect(memberAvatarColors(42)).toEqual(memberAvatarColors(42));
    expect(AVATAR_PALETTE).toContainEqual(memberAvatarColors('x'));
  });
  it('can differ between members', () => {
    const set = new Set(Array.from({ length: 20 }, (_, i) => memberAvatarColors(i).background));
    expect(set.size).toBeGreaterThan(1);
  });
});
