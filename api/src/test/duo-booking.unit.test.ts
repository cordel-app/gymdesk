import { describe, it, expect } from 'vitest';
import { parseParticipantIds, newBookingGroupId } from '../domain/duoBooking';

describe('parseParticipantIds (#1984 stage 2b-1)', () => {
  it('treats an absent or empty list as a solo booking', () => {
    expect(parseParticipantIds(undefined, 1)).toEqual({ ok: true, partnerIds: [] });
    expect(parseParticipantIds([], 1)).toEqual({ ok: true, partnerIds: [] });
  });
  it('accepts one partner, coercing numeric strings', () => {
    expect(parseParticipantIds(['7'], 1)).toEqual({ ok: true, partnerIds: [7] });
  });
  it('refuses the booker, more than one partner and malformed values', () => {
    expect(parseParticipantIds([1], 1).ok).toBe(false);
    expect(parseParticipantIds([2, 3], 1).ok).toBe(false);
    expect(parseParticipantIds('2', 1).ok).toBe(false);
    expect(parseParticipantIds([0], 1).ok).toBe(false);
    expect(parseParticipantIds([1.5], 1).ok).toBe(false);
  });
  it('generates distinct group ids', () => {
    expect(newBookingGroupId()).not.toBe(newBookingGroupId());
  });
});
